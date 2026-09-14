/* Authored lessons and a small pure progress model. No AI or network needed. */
(function(root){
  'use strict';
  var MP=root.MP=root.MP||{};
  var lessons={
    returns:{title:'Price versus return',goal:'See how much a stock gained or lost.',
      steps:['Choose a stock','Compare two chart ranges','Check your understanding'],
      question:'Which number tells you how the stock performed?',
      answers:['Its price today.','Its percentage gain or loss over the period.','Its price compared with another stock.'],correct:1,
      explanation:'Return is the percentage gain or loss over a period. Price alone does not tell you that.'},
    risk:{title:'Volatility versus drawdown',goal:'Compare price swings with a fall from a peak.',
      steps:['Choose a stock and inspect VOL','Inspect DD for the same stock','Check your understanding'],
      question:'What is the difference?',
      answers:['Volatility measures swings; drawdown measures a fall from a peak.','Both measure the same loss.','Both predict the next price.'],correct:0,
      explanation:'Volatility measures swings up and down. Drawdown measures a fall from a peak. Neither predicts the future.'},
    mix:{title:'Build a mix',goal:'See what changes when you change the mix.',
      steps:['Simulate a two-stock portfolio','Change its weights and compare','Check your understanding'],
      question:'What affects how much your mix moves?',
      answers:['Two stocks always make it safer.','Each stock’s swings, how they move together, and your weights.','The stock with the highest price.'],correct:1,
      explanation:'The weights and how the stocks move together matter. Adding a stock does not guarantee less risk.'}
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
