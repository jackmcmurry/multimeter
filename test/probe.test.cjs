const test=require('node:test'),assert=require('node:assert/strict');
require('../src/lib/probe.js');
const P=global.MP.probe;
function context(mask,mode){return {mode,subject:{symbol:'TEST'},comparison:{name:'Index'},
  move:mask&1?{percentile:.7,return:.02,comparedWith:30}:null,
  volatility:mask&2?{value:.3}:null,indexVolatility:mask&4?{value:.2}:null,
  drawdown:mask&8?{now:-.2,worst:-.3}:null,correlation:mask&16?{value:-.4,window:90}:null};}
test('all suggestions and their follow-ups answer with full or partial data',()=>{
  for(let mask=0;mask<32;mask++)for(const mode of ['subject','vol','dd','corr']){
    const c=context(mask,mode),questions=P.questionsFor(c);assert.ok(questions.length);
    for(const q of questions){const f=P.answer(c,q);assert.equal(f.status,'answered',q);
      for(const next of f.followUps)assert.equal(P.answer(c,next).status,'answered',next);}
  }
});
test('the recorded usual-move question routes to volatility',()=>{
  assert.equal(P.topicOf('How much does it usually move?',context(2)), 'volatility');
  assert.equal(P.answer(context(2),'How much does it usually move?').status,'answered');
});
test('unsupported custom questions offer supported next questions',()=>{
  for(const mode of ['vol','dd','corr','subject']){
    const c=context(31,mode),f=P.answer(c,'Who is the chief executive?');
    assert.equal(f.status,'unavailable');assert.ok(f.followUps.length);
    for(const q of f.followUps)assert.equal(P.answer(c,q).status,'answered');
  }
});
test('conceptual causation works without prices; event causes stay unsupported',()=>{
  assert.equal(P.answer(context(0),'Does moving together prove one caused the other?').status,'answered');
  assert.equal(P.answer(context(31),'Why did it fall?').status,'insufficient');
  assert.equal(P.answer(context(31),'Should I buy it?').status,'refused');
  assert.equal(P.answer(context(31),'Will it rise tomorrow?').status,'refused');
});
