const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/lib/stats.js'); require('../src/lib/portfolio.js');
const P = global.MP.portfolio;
const points = prices => prices.map((price,i)=>({date:'2026-09-'+String(i+1).padStart(2,'0'),price}));
const near = (a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);
test('single stock buys fractional shares and preserves return',()=>{
 const r=P.calculate([{symbol:'AAPL',weight:100}],{AAPL:points([30,33,36])},'1m');
 near(r.allocation[0].shares,10000/30);near(r.endingValue,12000);near(r.returnPct,20);
});
test('equal weights and unequal returns hold fixed quantities, not daily rebalancing',()=>{
 const r=P.calculate([{symbol:'AAPL',weight:50},{symbol:'MSFT',weight:50}],{AAPL:points([100,200,100]),MSFT:points([100,100,200])},'1m');
 assert.deepEqual(r.series.map(p=>p.price),[10000,15000,15000]);near(r.returnPct,50);
});
test('unequal allocation and known drawdown',()=>{
 const r=P.calculate([{symbol:'AAPL',weight:75},{symbol:'MSFT',weight:25}],{AAPL:points([100,200,100]),MSFT:points([100,100,100])},'1y');
 near(r.series[1].price,17500);near(r.maxDrawdownPct,(10000/17500-1)*100);
});
test('flat prices have zero return, volatility and drawdown',()=>{
 const r=P.calculate([{symbol:'AAPL',weight:100}],{AAPL:points([100,100,100,100])},'1m');
 near(r.returnPct,0);near(r.volatilityPct,0);near(r.maxDrawdownPct,0);
});
test('known peak-to-trough drawdown is 40 percent',()=>{
 const r=P.calculate([{symbol:'AAPL',weight:100}],{AAPL:points([100,120,72,108])},'1m'); near(r.maxDrawdownPct,-40);
});
test('invalid totals, duplicate stocks, empty, six holdings and invalid weights fail',()=>{
 for(const h of [[],[{symbol:'AAPL',weight:90}],[{symbol:'AAPL',weight:50},{symbol:'AAPL',weight:50}],[{symbol:'AAPL',weight:NaN}],[{symbol:'AAPL',weight:-1},{symbol:'MSFT',weight:101}],Array.from({length:6},(_,i)=>({symbol:'A'+i,weight:100/6}))]) assert.throws(()=>P.validate(h));
});
test('missing holding history is never dropped',()=>assert.throws(()=>P.calculate([{symbol:'AAPL',weight:50},{symbol:'MSFT',weight:50}],{AAPL:points([1,2,3])},'1m'),/MSFT/));
test('short and invalid price history fails',()=>{
 assert.throws(()=>P.calculate([{symbol:'AAPL',weight:100}],{AAPL:points([1,2])},'1m'),/3 common/);
 assert.throws(()=>P.calculate([{symbol:'AAPL',weight:100}],{AAPL:points([1,0,3])},'1m'),/Invalid/);
});
test('common dates align before purchasing, and missing sessions suppress annualization',()=>{
 const a=points([10,20,30,40]), b=points([20,30,40,50]);b.splice(1,1);
 const r=P.calculate([{symbol:'AAPL',weight:50},{symbol:'MSFT',weight:50}],{AAPL:a,MSFT:b},'1m');
 assert.deepEqual(r.series.map(p=>p.date),['2026-09-01','2026-09-03','2026-09-04']);assert.equal(r.volatilityPct,null);assert.equal(r.incompleteCalendar,true);
});
test('ranges use calendar days and report shortened history',()=>{
 const series=Array.from({length:100},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),price:100+i}));
 const r=P.calculate([{symbol:'AAPL',weight:100}],{AAPL:series},'1m');assert.equal(r.sessions,31);assert.equal(r.shortened,false);
 assert.equal(P.calculate([{symbol:'AAPL',weight:100}],{AAPL:series},'1y').shortened,true);
});
