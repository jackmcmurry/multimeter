const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/lib/lessons');
const L = global.MP.lessons;
function series(n) { return Array.from({length:n},(_,i)=>({date:new Date(Date.UTC(2025,0,i+1)).toISOString().slice(0,10),price:100+i})); }
function adapter(overrides={}) {
  return Object.assign({ensureStock:async()=>{},stockSeries:()=>series(253),history:()=>({ixic:'nasdaq',spx:'sp500'}),
    analyticsFor:()=>({currentCoinVol:.2,coinDd:{now:-.1}})},overrides);
}
test('starter accepts exactly 253 closes and rejects a shortened year',async()=>{
  assert.equal((await L.selectionLoader(adapter()).load('AAPL','returns')).series.length,253);
  await assert.rejects(L.selectionLoader(adapter({stockSeries:()=>series(252)})).load('AAPL','returns'),/full year/);
});
test('available examples are tried in Apple, Microsoft, NVIDIA order',async()=>{
  const seen=[];
  const loader=L.selectionLoader(adapter({ensureStock:async s=>{seen.push(s);},stockSeries:s=>s==='NVDA'?series(253):null}));
  assert.equal((await loader.example('returns')).symbol,'NVDA');
  assert.deepEqual(seen,['AAPL','MSFT','NVDA']);
});
test('network failure falls through to the next example; all failures produce recovery',async()=>{
  const loader=L.selectionLoader(adapter({ensureStock:async s=>{if(s==='AAPL')throw Error('offline');}}));
  assert.equal((await loader.example('returns')).symbol,'MSFT');
  await assert.rejects(L.selectionLoader(adapter({stockSeries:()=>null})).example('returns'),/None of the example/);
});
test('risk validates shared measurements and tries Nasdaq before S&P',async()=>{
  const seen=[];
  const loader=L.selectionLoader(adapter({stockSeries:()=>series(32),analyticsFor:(s,index)=>{
    seen.push(index);return index==='sp500'?{currentCoinVol:0,coinDd:{now:0}}:null;
  }}));
  const c=await loader.load('AAPL','risk');
  assert.equal(c.index,'spx');assert.deepEqual(seen,['nasdaq','sp500']);
  await assert.rejects(L.selectionLoader(adapter({analyticsFor:()=>({currentCoinVol:NaN,coinDd:{now:0}})})).load('AAPL','risk'),/shared history/);
});
test('new selections and cancellation ignore late successful loads',async()=>{
  let resolve;
  const loader=L.selectionLoader(adapter({ensureStock:s=>s==='AAPL'?new Promise(r=>{resolve=r;}):Promise.resolve()}));
  const first=loader.load('AAPL','returns');
  assert.equal((await loader.load('MSFT','returns')).symbol,'MSFT');
  resolve();assert.equal(await first,null);
  const second=loader.load('AAPL','returns');loader.cancel();resolve();assert.equal(await second,null);
});
test('cancelled example fallback stops after an old request rejects',async()=>{
  let reject;const calls=[];
  const loader=L.selectionLoader(adapter({ensureStock:s=>{calls.push(s);return new Promise((r,j)=>{reject=j;});}}));
  const old=loader.example('returns');loader.cancel();reject(Error('old failure'));
  assert.equal(await old,null);assert.deepEqual(calls,['AAPL']);
});
test('loading and failed replacements do not change existing progress',async()=>{
  const state=L.blank();L.start(state,'returns');state.progress.returns={step:1,done:false,complete:false,stock:'MSFT',observations:{month:{text:'Recorded result'}},feedback:null};
  const before=JSON.stringify(state);
  await assert.rejects(L.selectionLoader(adapter({stockSeries:()=>null})).load('AAPL','returns'));
  assert.equal(JSON.stringify(state),before);
});
test('same company keeps observations; another resets only the active lesson',()=>{
  const state=L.blank();L.start(state,'returns');state.progress.returns={step:2,done:true,complete:true,stock:'AAPL',observations:{year:{text:'Old year'}},feedback:null};
  state.progress.risk.stock='NVDA';const risk=JSON.stringify(state.progress.risk),before=JSON.stringify(state.progress.returns);
  assert.equal(L.acceptSelection(state,'returns','AAPL',{}),false);assert.equal(JSON.stringify(state.progress.returns),before);
  assert.equal(L.acceptSelection(state,'returns','MSFT',{price:{text:'New price'}}),true);
  assert.equal(state.progress.returns.step,0);assert.equal(state.progress.returns.complete,false);
  assert.deepEqual(state.progress.returns.observations,{price:{text:'New price'}});assert.equal(JSON.stringify(state.progress.risk),risk);
});
