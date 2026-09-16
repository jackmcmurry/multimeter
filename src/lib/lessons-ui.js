/* Guided tasks stay in the open drawer as students use the instrument. */
(function(root){
  'use strict';
  var MP=root.MP=root.MP||{}, state, KEY='guidedLessons', request=0, loader, busy=false, failure=null, changing=false;
  function el(id){return document.getElementById(id);}
  function esc(s){return MP.fmt.escapeHtml(String(s));}
  function percent(n){return typeof n==='number'&&isFinite(n)?n.toFixed(2)+'%':'Unavailable';}
  function save(){el('lessonSave').textContent=MP.store.set(KEY,state)?'Saved on this device.':'Progress could not be saved. You can still finish this session.';}
  function note(text){el('lessonNotice').textContent=text;}
  function current(){return state.active?state.progress[state.active]:null;}
  function library(){
    el('lessonLibrary').innerHTML=Object.keys(MP.lessons.definitions).map(function(id){var l=MP.lessons.definitions[id],p=state.progress[id];
      return '<article class="lesson-card"><h3>'+esc(l.title)+'</h3><p>'+esc(l.goal)+'</p><button class="pill" type="button" data-start-lesson="'+id+'">'+(p.complete?'Review':(p.stock||p.observations.first||p.step?'Resume':'Start'))+'</button> '+(p.complete?'<span class="lesson-complete">Completed</span>':'')+'</article>';
    }).join('');
  }
  function pairComparison(p){
    var a=p.observations.first,b=p.observations.second;if(!a||!b)return '';
    return '<div class="lesson-comparison"><p>First mix → New mix</p><dl>'+['returnPct','volatilityPct','maxDrawdownPct'].map(function(k,i){return '<div><dt>'+['Gain or loss (return)','Swings (annualized volatility)','Biggest fall (drawdown)'][i]+'</dt><dd>'+percent(a[k])+' → '+percent(b[k])+'</dd></div>';}).join('')+'</dl><details class="explanation-details"><summary>Dates and weights</summary><p>'+esc(a.start)+' to '+esc(a.end)+'</p><p>First mix: '+a.holdings.map(function(h){return esc(h.symbol)+' '+h.weight+'%';}).join(', ')+'</p><p>New mix: '+b.holdings.map(function(h){return esc(h.symbol)+' '+h.weight+'%';}).join(', ')+'</p></details></div>';
  }
  function observations(p){
    if(state.active==='mix')return pairComparison(p);
    return Object.keys(p.observations).map(function(k){var o=p.observations[k];if(!o||typeof o.text!=='string')return '';return '<li>'+esc(o.text)+'</li>';}).join('');
  }
  /* ---- the way in ---------------------------------------------------------
   * A student arriving with no instructions needs one obvious next action.
   * The entry bar under the instrument is it: "Start learning" until any
   * progress exists, then "Continue learning" and where they left off. */
  function order(){return Object.keys(MP.lessons.definitions);}
  function started(p){return !!(p&&(p.step>0||p.complete||p.stock||p.observations&&Object.keys(p.observations).length));}
  function resumeId(){
    if(state.active)return state.active;
    var ids=order();
    var going=ids.filter(function(id){return started(state.progress[id])&&!state.progress[id].complete;})[0];
    if(going)return going;
    var untouched=ids.filter(function(id){return !started(state.progress[id]);})[0];
    return untouched||ids[0];
  }
  function anyProgress(){return order().some(function(id){return started(state.progress[id]);});}
  function entry(){
    var bar=el('learnEntry');if(!bar)return;
    /* While a lesson is open the dock carries the same job, so the bar steps
     * aside rather than repeating it. */
    bar.hidden=!!state.active;
    if(state.active)return;
    var id=resumeId(),p=state.progress[id],l=MP.lessons.definitions[id],going=anyProgress();
    var allDone=order().every(function(k){return state.progress[k].complete;});
    el('learnEntryGo').textContent=allDone?'Review lessons':going?'Continue experiment':'Start experiment';
    el('learnEntryTitle').textContent=going?(allDone?'All three lessons complete':'Pick up where you left off'):'Try your first market experiment · About 5 minutes.';
    el('learnEntryNote').textContent=allDone?'Review any lesson, or keep exploring the instrument.'
      :going?l.title+' · step '+(p.step+1)+' of 3':'Does a stock’s price tell you how well it performed?';
  }

  /* ---- the dock -----------------------------------------------------------
   * The step stays on screen while the instrument is being used, so a task
   * and the reading it asks about are never separated by a scroll. The full
   * task text stays in the drawer; this is the part you must not lose. */
  function dock(){
    var bar=el('lessonDock');if(!bar)return;
    var p=current();
    bar.hidden=!p;
    document.body.classList.toggle('has-dock',!!p);
    if(!p)return;
    var l=MP.lessons.definitions[state.active];
    el('lessonPips').innerHTML=[0,1,2].map(function(i){
      return '<li class="'+(p.complete||i<p.step?'is-done':i===p.step?'is-now':'')+'"></li>';}).join('');
    el('lessonDockStep').textContent=p.complete?'Lesson complete':'Step '+(p.step+1)+' of 3';
    el('lessonDockTask').textContent=p.complete?l.title:l.steps[p.step];
    var context=p.observations.selection&&p.observations.selection.text?p.observations.selection.text.split(' · ')[0]:p.stock?companyName(p.stock)+' ('+p.stock+')':'';
    var recorded=(MP.app.state.watch.sessions===252?p.observations.year:p.observations.month)||p.observations.selection||p.observations.price;
    el('lessonDockContext').textContent=recorded&&recorded.text?(recorded.text.indexOf(context)===0?'':context+' · ')+recorded.text:context;
    var next=el('lessonDockNext');
    next.hidden=p.complete||p.step===2;
    next.disabled=!p.done||busy;
  }
  function render(){
    library();entry();dock();var p=current(),host=el('lessonGuide');host.hidden=!p;if(!p)return;
    var l=MP.lessons.definitions[state.active],body='';
    el('lessonTitle').textContent=l.title;
    el('lessonStep').textContent=p.complete?'Completed':'Step '+(p.step+1)+' of 3 · '+l.steps[p.step];
    el('lessonGoal').textContent=l.goal;el('lessonGoal').hidden=true;
    if(p.complete){body='<h4>You finished this lesson.</h4><p>'+esc(l.explanation)+'</p><details class="explanation-details"><summary>Your measurements</summary>'+(state.active==='mix'?observations(p):'<ul>'+observations(p)+'</ul>')+'</details><button class="pill" type="button" data-lesson-action="library">Back to guided lessons</button>';}
    else if(p.step===2){body='<fieldset><legend>'+esc(l.question)+'</legend>'+l.answers.map(function(a,i){return '<label class="lesson-answer"><input type="radio" name="lessonAnswer" value="'+i+'"> '+esc(a)+'</label>';}).join('')+'</fieldset><button class="pill" type="button" data-lesson-action="answer">Check answer</button>'+(p.feedback?'<p role="status">Try again. '+esc(l.explanation)+'</p>':'');}
    else if(state.active==='mix'){
      body='<p>'+(p.step===0?'Choose two stocks. Start with 50% each and run your mix.':'Change the weights and run again. Keep the same stocks and dates.')+'</p><button class="pill" type="button" data-lesson-action="portfolio">Open practice portfolio</button>'+pairComparison(p);
      if(p.step===0&&p.done)body+='<p>First simulation recorded. Continue before changing the weights.</p>';
    } else if(p.step===0){
      body='<p>'+(state.active==='risk'?'Inspect how much this company’s daily changes have varied, then compare its decline from a high.':'Look at the company’s closing price. In the next step, compare how it performed over two periods.')+'</p><ul>'+observations(p)+'</ul>';
    } else if(state.active==='returns'){
      body='<p>Compare '+esc(p.stock)+' over one month and one year. Use the buttons below to change the instrument’s chart.</p><div class="lesson-actions"><button class="pill" type="button" data-lesson-action="month">View 1 month</button><button class="pill" type="button" data-lesson-action="year">View 1 year</button></div><ul>'+observations(p)+'</ul>';
    } else {body='<p>Now inspect DD for '+esc(p.stock)+'. Compare its fall from its peak with the volatility reading you just saw.</p><button class="pill" type="button" data-lesson-action="drawdown">View DD</button><ul>'+observations(p)+'</ul>';}
    if(state.active!=='mix'){
      body+='<div class="lesson-company"><button class="pill" type="button" data-lesson-action="change">'+(p.stock?'Change company':'Choose a company')+'</button></div>';
      if(!p.stock&&!busy)body+='<button class="pill" type="button" data-lesson-action="example">Use an available example</button>';
      if(changing)body+='<label for="lessonStockSearch">Company name or stock symbol</label><input id="lessonStockSearch" class="probe-search" type="search" autocomplete="off" placeholder="Search a company"><ul class="rows picks" id="lessonStockResults"></ul>';
    }
    if(failure)body+='<div class="lesson-recovery" role="group" aria-label="Recover lesson data"><button class="pill" type="button" data-lesson-action="retry">Retry</button><button class="pill" type="button" data-lesson-action="change">Choose another company</button><button class="pill" type="button" data-lesson-action="example">Use an available example</button></div>';
    el('lessonBody').innerHTML=body;
    el('lessonBody').setAttribute('aria-busy',String(busy));
    el('lessonNext').hidden=p.complete||p.step===2;el('lessonNext').disabled=!p.done||busy;
    save();
  }
  function cancelSelection(){request++;if(loader)loader.cancel();busy=false;failure=null;changing=false;}
  function showTask(){
    MP.meter.openDrawer(true);
    el('lessonGuide').scrollIntoView({block:'start',behavior:'smooth'});
    el('lessonTitle').focus({preventScroll:true});
  }
  function start(id,restart){
    cancelSelection();if(!MP.lessons.start(state,id,restart))return;
    render();note('');showTask();
    var p=current();
    if(id!=='mix'&&!started(p))return selectStock(null);
    if(p.stock&&!p.complete)return selectStock(p.stock);
  }
  function exit(){cancelSelection();state.active=null;render();save();MP.router.go('learn');MP.router.show('learn');MP.router.overridePanel(null);MP.meter.openDrawer(true);var back=el('learnEntryGo')||el('guidedLessonsOpen');if(back)back.focus({preventScroll:true});}
  function openLibrary(){
    cancelSelection();render();note('');
    MP.router.overridePanel('lessons');MP.meter.openDrawer(true);
    el('lessonLibrary').hidden=false;el('guidedLessonsOpen').setAttribute('aria-expanded','true');
    el('lessonsTitle').scrollIntoView({block:'start',behavior:'smooth'});el('lessonsTitle').focus({preventScroll:true});
  }
  function search(){var q=el('lessonStockSearch').value;el('lessonStockResults').innerHTML=MP.search.query(MP.app.stockChoices(),q,6).map(function(c){return '<li><button class="pick" type="button" data-lesson-stock="'+esc(c.symbol)+'">'+esc(c.symbol)+' — '+esc(c.name)+'</button></li>';}).join('')||'<li>No matching companies. Try Apple, Microsoft, or NVIDIA.</li>';}
  function companyName(symbol){var row=MP.app.stockRow(symbol),file=MP.app.state.stocks.files[symbol];return row&&row.name||file&&file.name||symbol;}
  function showReading(p,index){
    MP.app.setStats(Object.assign({coin:p.stock},index?{index:index}:{}));
    MP.app.setWatchRange(p.observations.year?252:21);
    var stop=state.active==='risk'?(p.step>0?'dd':'vol'):'subject';
    MP.router.go(stop);MP.router.show(stop);MP.router.overridePanel(null);MP.meter.setScreen('reading');
  }
  async function selectStock(symbol,action){
    var id=state.active,p=current(),run=++request;if(!p||id==='mix')return;
    busy=true;failure=null;render();note(symbol?'Loading '+companyName(symbol)+'…':'Finding an example with enough history…');
    try{
      var candidate=await (symbol?loader.load(symbol,id):loader.example(id));
      if(!candidate||run!==request||state.active!==id)return;
      var series=candidate.series,last=series[series.length-1],name=companyName(candidate.symbol);
      var obs={selection:{text:name+' ('+candidate.symbol+') · Historical closes: '+MP.fmt.shortDate(series[0].date)+' to '+MP.fmt.shortDate(last.date)+'.',index:candidate.index||null}};
      if(id==='risk')obs.vol={text:name+' · Volatility: '+MP.fmt.pct(candidate.analytics.currentCoinVol,1)+' on a yearly scale, from the latest 30 shared trading days. Comparison: '+(candidate.index==='ixic'?'Nasdaq Composite':'S&P 500')+'.'};
      else obs.price={text:name+' · Latest close: '+MP.fmt.usd(last.price,2)+' on '+MP.fmt.shortDate(last.date)+'.'};
      var changed=MP.lessons.acceptSelection(state,id,candidate.symbol,obs);
      p=current();if(p.step===0&&!p.done){Object.assign(p.observations,obs);p.done=true;}busy=false;changing=false;failure=null;
      showReading(p,candidate.index);
      if(action&&!changed&&p.step===1){inspectReady(action,candidate);return;}
      render();note(changed?'Example ready. Inspect the price or measurement, then continue.':'Your company and recorded observations are restored.');showTask();
    }catch(e){
      if(run!==request||state.active!==id)return;
      busy=false;failure={symbol:symbol,action:action};render();note(e.message+' Your lesson progress is unchanged.');showTask();
    }
  }
  function inspectReady(action,candidate){
    var p=current();
    if(state.active==='returns'){
      var n=action==='month'?21:252;MP.app.setWatchRange(n);MP.router.go('subject');MP.router.show('subject');
      var slice=candidate.series.slice(-(n+1));
      var change=(slice[slice.length-1].price/slice[0].price-1)*100;
      p.observations[action]={text:companyName(p.stock)+' ('+p.stock+') · '+(action==='month'?'1-month':'1-year')+' chart: '+percent(change)+' price return, '+MP.fmt.shortDate(slice[0].date)+' to '+MP.fmt.shortDate(slice[slice.length-1].date)+'.'};
      p.done=!!(p.observations.month&&p.observations.year);
    }else{
      MP.router.go('dd');MP.router.show('dd');
      p.observations.dd={text:p.stock+' · Decline below its previous high: '+MP.fmt.signedPct(candidate.analytics.coinDd.now,1)+'.'};p.done=true;
    }
    render();note(p.done?'Both measurements are recorded. Continue when you are ready.':'Inspect the other range to continue.');showTask();
  }
  function inspect(action){var p=current();if(!p||p.step!==1||!p.stock||busy)return;return selectStock(p.stock,action);}
  function init(){
    state=MP.lessons.read(MP.store.get(KEY,null));
    loader=MP.lessons.selectionLoader({ensureStock:MP.app.ensureStock,stockSeries:MP.app.stockSeries,history:function(){return MP.app.state.history;},analyticsFor:MP.app.analyticsFor});
    render();
    if(root.ResizeObserver){new root.ResizeObserver(function(entries){document.documentElement.style.setProperty('--lesson-dock-height',Math.ceil(entries[0].target.getBoundingClientRect().height)+'px');}).observe(el('lessonDock'));}
    el('guidedLessonsOpen').addEventListener('click',openLibrary);
    /* The standing entry under the instrument, and the dock that follows the
     * reader down the page. Both act on the lesson they would resume. */
    var entryGo=el('learnEntryGo');
    if(entryGo)entryGo.addEventListener('click',function(){startResume();});
    var taskBtn=el('lessonDockTaskBtn');
    if(taskBtn)taskBtn.addEventListener('click',function(){
      MP.meter.openDrawer(true);
      var guide=el('lessonGuide');
      if(guide&&!guide.hidden){guide.scrollIntoView({block:'center',behavior:'smooth'});el('lessonTitle').focus({preventScroll:true});}
    });
    var dockNext=el('lessonDockNext');
    if(dockNext)dockNext.addEventListener('click',function(){
      if(!busy&&MP.lessons.next(state)){cancelSelection();render();note('');showTask();}
    });
    var dockExit=el('lessonDockExit');
    if(dockExit)dockExit.addEventListener('click',function(){exit();});
    el('lessonLibrary').addEventListener('click',function(e){var b=e.target.closest('[data-start-lesson]');if(b)start(b.dataset.startLesson,false);});
    el('lessonGuide').addEventListener('input',function(e){if(e.target.id==='lessonStockSearch')search();});
    el('lessonGuide').addEventListener('click',function(e){var stock=e.target.closest('[data-lesson-stock]');if(stock)return selectStock(stock.dataset.lessonStock);var b=e.target.closest('[data-lesson-action]');if(!b)return;var a=b.dataset.lessonAction;
      if(a==='retry')return selectStock(failure&&failure.symbol,failure&&failure.action);
      if(a==='example')return selectStock(null);
      if(a==='change'){cancelSelection();changing=true;render();note('Choose a company. Your current work stays until its data is ready.');el('lessonStockSearch').focus();return;}
      if(a==='exit')return exit();if(a==='restart')return start(state.active,true);
      if(a==='instrument'){document.querySelector('.meter').scrollIntoView({block:'start',behavior:'smooth'});return;}
      if(a==='next'){if(!busy&&MP.lessons.next(state)){cancelSelection();render();note('');showTask();}return;}
      if(a==='portfolio'){MP.practice.open();return;}
      if(a==='month'||a==='year'||a==='drawdown')return inspect(a);
      if(a==='library')return openLibrary();
      if(a==='answer'){if(busy)return;var answer=el('lessonBody').querySelector('input[name="lessonAnswer"]:checked');if(!answer)return note('Choose an answer first.');var correct=MP.lessons.answer(state,Number(answer.value));render();note(correct?'Correct. Lesson completed.':'Read the explanation and try again.');el('lessonTitle').focus({preventScroll:true});}
    });
    document.addEventListener('practice:simulated',function(e){if(state.active!=='mix'||current().step>1)return;var message=MP.lessons.recordMix(state,e.detail);render();note(message||'Simulation recorded. Press Continue on the lesson bar when you are ready.');});
    if(state.active){MP.meter.openDrawer(true);if(!root.location.hash&&current().stock)selectStock(current().stock);}
  }
  function startResume(){if(order().every(function(id){return state.progress[id].complete;}))return openLibrary();start(resumeId(),false);}
  MP.guided={state:function(){return state;},start:start,startResume:startResume,exit:exit,resumeId:resumeId,openLibrary:openLibrary,selectCompany:selectStock};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof globalThis!=='undefined'?globalThis:this);
