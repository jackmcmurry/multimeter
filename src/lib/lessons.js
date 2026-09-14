/* Authored lessons and a small pure progress model. No AI or network needed. */
(function(root){
  'use strict';
  var MP=root.MP=root.MP||{};
  var lessons={
    returns:{title:'Price versus return',goal:'Find out why a stock’s price and its percentage return answer different questions.',
      steps:['Choose a stock','Compare two chart ranges','Check your understanding'],
      question:'What tells you how this stock performed over a period?',
      answers:['Its dollar price alone.','Its percentage change between the beginning and end of that period.','Whether one share costs more than another company’s share.'],correct:1,
      explanation:'Return compares the ending price with the starting price. The same stock can have different returns over one month and one year. A share price alone does not tell you how well it performed.'},
    risk:{title:'Volatility versus drawdown',goal:'Use the same stock to distinguish movement along the way from a fall below a peak.',
      steps:['Choose a stock and inspect VOL','Inspect DD for the same stock','Check your understanding'],
      question:'Which description matches the two measurements you inspected?',
      answers:['Volatility describes variation in returns; drawdown describes the fall from a prior peak.','Volatility and drawdown are two names for the same loss.','Volatility predicts tomorrow’s return; drawdown predicts a recovery date.'],correct:0,
      explanation:'Volatility measures how much returns vary, including upward and downward moves. Drawdown measures a decline from a running peak. Neither predicts what happens next.'},
    mix:{title:'Build a mix',goal:'See how changing starting weights changes a hypothetical portfolio’s historical behavior.',
      steps:['Simulate a two-stock portfolio','Change its weights and compare','Check your understanding'],
      question:'What determines whether a mix reduces historical volatility?',
      answers:['Any two stocks always reduce risk by the same amount.','How their returns move together, their individual variability, and the weights you choose.','A larger dollar price guarantees a steadier mix.'],correct:1,
      explanation:'A mix’s behavior depends on its weights and on how the assets’ returns move together. Diversification can reduce some risk, but adding a second stock does not guarantee lower volatility or prevent losses.'}
  };
  function fresh(){return {step:0,done:false,complete:false,stock:null,observations:{},feedback:null};}
  function blank(){return {version:1,active:null,progress:{returns:fresh(),risk:fresh(),mix:fresh()}};}
  function read(value){
    var out=blank();
    if(!value||value.version!==1||!value.progress)return out;
    Object.keys(lessons).forEach(function(id){var p=value.progress[id];if(!p||![0,1,2].includes(p.step))return;
      // Observations are local snapshots; ignore malformed saved data rather than break navigation.
      var obs=p.observations;
      if(id==='mix'&&obs){
        var valid=function(s){return s&&Array.isArray(s.holdings)&&s.holdings.length===2&&s.holdings.every(function(h){return h&&typeof h.symbol==='string'&&Number.isFinite(h.weight);})&&typeof s.start==='string'&&typeof s.end==='string'&&Number.isFinite(s.returnPct)&&Number.isFinite(s.maxDrawdownPct)&&(s.volatilityPct===null||Number.isFinite(s.volatilityPct));};
        if((obs.first&&!valid(obs.first))||(obs.second&&!valid(obs.second))||(p.step>0&&!valid(obs.first)))return;
      }
      out.progress[id]={step:p.step,done:p.done===true,complete:p.complete===true,
        stock:typeof p.stock==='string'&&/^[A-Z][A-Z0-9.-]{0,9}$/.test(p.stock)?p.stock:null,
        observations:obs&&typeof obs==='object'&&!Array.isArray(obs)?obs:{},feedback:null};
    });
    out.active=lessons[value.active]?value.active:null;return out;
  }
  function start(state,id,restart){if(!lessons[id])return false;if(restart)state.progress[id]=fresh();state.active=id;return true;}
  function next(state){var p=state.progress[state.active];if(!p||!p.done||p.step>=2)return false;p.step++;p.done=false;p.feedback=null;return true;}
  function answer(state,index){var id=state.active,p=state.progress[id],lesson=lessons[id];if(!lesson||!p||p.step!==2||!Number.isInteger(index)||index<0||index>=lesson.answers.length)return false;
    var correct=index===lesson.correct;p.feedback={correct:correct};if(correct)p.complete=true;return correct;}
  function snapshot(detail){return {holdings:detail.holdings.map(function(h){return {symbol:h.symbol,weight:h.weight};}).sort(function(a,b){return a.symbol.localeCompare(b.symbol);}),range:detail.range,start:detail.result.start,end:detail.result.end,returnPct:detail.result.returnPct,volatilityPct:detail.result.volatilityPct,maxDrawdownPct:detail.result.maxDrawdownPct};}
  function recordMix(state,detail){
    var p=state.progress.mix;if(state.active!=='mix'||p.step>1||!detail||!detail.result||!Array.isArray(detail.holdings)||detail.holdings.length!==2)return 'Use exactly two stocks for this lesson.';
    var now=snapshot(detail);
    if(p.step===0){p.observations.first=now;p.done=true;return null;}
    var before=p.observations.first;
    if(!before)return 'Restart this lesson to record the first simulation.';
    if(before.range!==now.range||before.start!==now.start||before.end!==now.end||before.holdings.map(function(h){return h.symbol;}).join()!==now.holdings.map(function(h){return h.symbol;}).join())return 'Keep the same two stocks, range and dates so only the weights change.';
    if(before.holdings.every(function(h,i){return h.weight===now.holdings[i].weight;}))return 'Change the weights, then run the simulation again.';
    p.observations.second=now;p.done=true;return null;
  }
  MP.lessons={definitions:lessons,blank:blank,read:read,start:start,next:next,answer:answer,recordMix:recordMix};
})(typeof globalThis!=='undefined'?globalThis:this);
