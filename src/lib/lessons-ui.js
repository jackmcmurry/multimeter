/* Guided tasks stay in the open drawer as students use the instrument. */
(function(root){
  'use strict';
  var MP=root.MP=root.MP||{}, state, KEY='guidedLessons', request=0;
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
    el('learnEntryGo').textContent=allDone?'Review lessons':going?'Continue learning':'Start learning';
    el('learnEntryTitle').textContent=going?(allDone?'All three lessons complete':'Pick up where you left off'):'New here?';
    el('learnEntryNote').textContent=allDone?'Review any lesson, or keep exploring the instrument.'
      :going?l.title+' · step '+(p.step+1)+' of 3':'Three short lessons. About five minutes each.';
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
    var next=el('lessonDockNext');
    next.hidden=p.complete||p.step===2;
    next.disabled=!p.done;
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
      body='<p>'+(state.active==='risk'?'Choose a stock to see its swings (VOL).':'Choose a stock to see its price.')+'</p><label for="lessonStockSearch">Stock name or symbol</label><input id="lessonStockSearch" class="probe-search" type="search" autocomplete="off" placeholder="Search a stock"><ul class="rows picks" id="lessonStockResults"></ul><ul>'+observations(p)+'</ul>';
    } else if(state.active==='returns'){
      body='<p>Tap both periods. How did '+esc(p.stock)+'’s return change?</p><div class="lesson-actions"><button class="pill" type="button" data-lesson-action="month">View 1 month</button><button class="pill" type="button" data-lesson-action="year">View 1 year</button></div><ul>'+observations(p)+'</ul>';
    } else {body='<p>See how far '+esc(p.stock)+' fell from its peak.</p><button class="pill" type="button" data-lesson-action="drawdown">View DD</button><ul>'+observations(p)+'</ul>';}
    el('lessonBody').innerHTML=body;
    el('lessonNext').hidden=p.complete||p.step===2;el('lessonNext').disabled=!p.done;
    save();
  }
  function showTask(){el('lessonGuide').scrollIntoView({block:'start',behavior:'instant'});el('lessonTitle').focus({preventScroll:true});}
  function start(id,restart){request++;MP.lessons.start(state,id,restart);render();MP.meter.openDrawer(true);note('');showTask();}
  function exit(){request++;state.active=null;render();save();MP.router.go('learn');MP.router.show('learn');MP.router.overridePanel(null);MP.meter.openDrawer(true);var back=el('learnEntryGo')||el('guidedLessonsOpen');if(back)back.focus({preventScroll:true});}
  function search(){var q=el('lessonStockSearch').value;el('lessonStockResults').innerHTML=MP.search.query(MP.app.stockChoices(),q,6).map(function(c){return '<li><button class="pick" type="button" data-lesson-stock="'+esc(c.symbol)+'">'+esc(c.symbol)+' — '+esc(c.name)+'</button></li>';}).join('')||'<li>No matching supported stocks.</li>';}
  function selectStock(symbol){
    var p=current(),id=state.active,run=++request;if(!p||p.step!==0||id==='mix')return;
    if(!MP.app.stockChoices().some(function(c){return c.symbol===symbol;}))return;
    if(MP.app.state.watch.list.length>=MP.watch.MAX&&!MP.app.isWatched(symbol))return note('WATCH is full. Choose a stock already on it, or remove one before adding another.');
    note('Loading '+symbol+'…');
    Promise.resolve(MP.app.ensureStock(symbol,true)).then(function(){
      if(run!==request)return;
      var series=MP.app.stockSeries(symbol);
      if(!series||series.length<32)throw new Error('This lesson needs at least 32 daily closes. Try a stock with more available history.');
      MP.app.addWatch(symbol);MP.app.setStats({coin:symbol});MP.app.setWatchRange(21);
      p.stock=symbol;p.observations={};p.done=false;
      if(id==='risk'){
        MP.router.go('vol');MP.router.show('vol');var m=MP.app.learnMeasure('volatility','vol');
        if(!m)throw new Error('VOL cannot be measured yet. Wait for daily history, then select the stock again.');
        p.observations.vol={text:symbol+' · VOL: '+m.text+' annualized, over 30 sessions.'};
      } else {MP.router.go('subject');MP.router.show('subject');p.observations.price={text:symbol+' · latest close: '+MP.fmt.usd(series[series.length-1].price,2)+' on '+series[series.length-1].date+'.'};}
      p.done=true;MP.meter.openDrawer(true);render();note('Measurement ready. Inspect the instrument, then continue.');
    }).catch(function(e){if(run===request)note(e.message);});
  }
  function inspect(action){
    var p=current();if(!p||p.step!==1||!p.stock)return;
    MP.app.setStats({coin:p.stock});
    if(state.active==='returns'){
      var n=action==='month'?21:252;MP.app.setWatchRange(n);MP.router.go('subject');MP.router.show('subject');
      var series=MP.app.stockSeries(p.stock),slice=series&&series.slice(-(n+1));if(!slice||slice.length<3)return note('Closing prices are unavailable. Retry after they load.');
      var change=(slice[slice.length-1].price/slice[0].price-1)*100;
      p.observations[action]={text:p.stock+' · '+(action==='month'?'1-month':'1-year')+' chart: '+percent(change)+' price return, '+slice[0].date+' to '+slice[slice.length-1].date+(slice.length<n+1?' (available history is shorter).':'.')};
      p.done=!!(p.observations.month&&p.observations.year);
    } else {
      MP.router.go('dd');MP.router.show('dd');var m=MP.app.learnMeasure('drawdown','dd');if(!m)return note('Drawdown is unavailable. Wait for daily history and try again.');
      p.observations.dd={text:p.stock+' · DD: '+m.text+' from its running peak.'};p.done=true;
    }
    MP.meter.openDrawer(true);render();note(p.done?'Both measurements are recorded. Continue when you are ready.':'Inspect the other range to continue.');
  }
  function init(){
    state=MP.lessons.read(MP.store.get(KEY,null));render();
    if(root.ResizeObserver)new ResizeObserver(function(entries){
      document.documentElement.style.setProperty('--lesson-dock-space',(Math.ceil(entries[0].target.getBoundingClientRect().height)+20)+'px');
    }).observe(el('lessonDock'));
    el('guidedLessonsOpen').addEventListener('click',function(){var lib=el('lessonLibrary');lib.hidden=!lib.hidden;this.setAttribute('aria-expanded',String(!lib.hidden));});
    /* The standing entry under the instrument, and the dock that follows the
     * reader down the page. Both act on the lesson they would resume. */
    var entryGo=el('learnEntryGo');
    if(entryGo)entryGo.addEventListener('click',function(){startResume();});
    el('learnBelowBtn').addEventListener('click',function(){
      MP.meter.openDrawer(true);
      if(state.active){showTask();return;}
      MP.router.go('learn');MP.router.show('learn');MP.router.overridePanel(null);
      el('lessonLibrary').hidden=false;
      var heading=el('guidedLessonsOpen');
      heading.setAttribute('aria-expanded','true');
      heading.scrollIntoView({block:'start',behavior:'instant'});
      heading.focus({preventScroll:true});
    });
    var taskBtn=el('lessonDockTaskBtn');
    if(taskBtn)taskBtn.addEventListener('click',function(){
      MP.meter.openDrawer(true);
      var guide=el('lessonGuide');
      if(guide&&!guide.hidden){guide.scrollIntoView({block:'center',behavior:'smooth'});el('lessonTitle').focus({preventScroll:true});}
    });
    var dockNext=el('lessonDockNext');
    if(dockNext)dockNext.addEventListener('click',function(){
      if(MP.lessons.next(state)){request++;render();note('');MP.meter.openDrawer(true);showTask();}
    });
    var dockExit=el('lessonDockExit');
    if(dockExit)dockExit.addEventListener('click',function(){exit();});
    el('lessonLibrary').addEventListener('click',function(e){var b=e.target.closest('[data-start-lesson]');if(b)start(b.dataset.startLesson,false);});
    el('lessonGuide').addEventListener('input',function(e){if(e.target.id==='lessonStockSearch')search();});
    el('lessonGuide').addEventListener('click',function(e){var stock=e.target.closest('[data-lesson-stock]');if(stock)return selectStock(stock.dataset.lessonStock);var b=e.target.closest('[data-lesson-action]');if(!b)return;var a=b.dataset.lessonAction;
      if(a==='exit')return exit();if(a==='restart')return start(state.active,true);
      if(a==='instrument'){document.querySelector('.meter').scrollIntoView({block:'start',behavior:'smooth'});return;}
      if(a==='next'){if(MP.lessons.next(state)){request++;render();note('');el('lessonTitle').focus({preventScroll:true});}return;}
      if(a==='portfolio'){MP.practice.open();return;}
      if(a==='month'||a==='year'||a==='drawdown')return inspect(a);
      if(a==='library'){exit();el('lessonLibrary').hidden=false;el('guidedLessonsOpen').setAttribute('aria-expanded','true');return;}
      if(a==='answer'){var answer=el('lessonBody').querySelector('input[name="lessonAnswer"]:checked');if(!answer)return note('Choose an answer first.');var correct=MP.lessons.answer(state,Number(answer.value));render();note(correct?'Correct. Lesson completed.':'Read the explanation and try again.');el('lessonTitle').focus({preventScroll:true});}
    });
    document.addEventListener('practice:simulated',function(e){if(state.active!=='mix'||current().step>1)return;var message=MP.lessons.recordMix(state,e.detail);render();note(message||'Simulation recorded. Press Continue on the lesson bar when you are ready.');});
    if(state.active)MP.meter.openDrawer(true);
  }
  function startResume(){
    if(order().every(function(id){return state.progress[id].complete;})){
      exit();el('lessonLibrary').hidden=false;el('guidedLessonsOpen').setAttribute('aria-expanded','true');
      el('guidedLessonsOpen').scrollIntoView({block:'start',behavior:'instant'});el('guidedLessonsOpen').focus({preventScroll:true});return;
    }
    start(resumeId(),false);
  }
  MP.guided={state:function(){return state;},start:start,startResume:startResume,exit:exit,resumeId:resumeId};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof globalThis!=='undefined'?globalThis:this);
