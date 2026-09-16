/* Browser geometry checks, included only in the debug build. */
(function(root){
 'use strict';var MP=root.MP=root.MP||{};
 async function run(){
  var failures=[],passed=0;function check(name,ok){if(ok)passed++;else failures.push(name);}
  var el=function(id){return document.getElementById(id);},rect=function(id){return el(id).getBoundingClientRect();};
  var entry=el('studentControls'),dock=el('lessonDock'),next=el('lessonDockNext'),task=el('lessonDockTask'),step=el('lessonDockStep');
  var saved={entry:entry.hidden,dock:dock.hidden,next:next.hidden,disabled:next.disabled,task:task.textContent,step:step.textContent,y:scrollY};
  var scenarios=[['inactive',false,'Start experiment'],['active',true,'Compare two chart ranges'],['loading',true,'Loading company history…'],['completed',true,'Price versus return'],['resumed',true,'Compare two chart ranges'],['long task',true,'Compare volatility and drawdown for the selected company']];
  check('single lesson strip',document.querySelectorAll('#lessonDock').length===1);
  check('menu initially closed',el('studentNav').hidden);
  check('opening lesson hidden',entry.hidden&&dock.hidden);
  try {for(var scenario of scenarios){
   entry.hidden=!scenario[1];dock.hidden=!scenario[1];next.hidden=scenario[0]==='completed';next.disabled=scenario[0]==='loading';task.textContent=scenario[2];step.textContent=scenario[0]==='completed'?'Lesson complete':'Step 1 of 3';
   MP.meter.fitToWindow();await new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(r);});});
   for(var bottom of [false,true]){window.scrollTo(0,bottom?document.documentElement.scrollHeight:0);await new Promise(requestAnimationFrame);
    var prefix=scenario[0]+(bottom?' scrolled':' top'),controls=rect('studentControls'),foot=rect('utilityFooter');
    check(prefix+': inactive header reserves no space',scenario[1]||controls.height===0);
    check(prefix+': header and footer do not overlap',controls.bottom<=foot.top+1);
    check(prefix+': no horizontal overflow',document.documentElement.scrollWidth<=innerWidth+1);
    check(prefix+': footer remains at viewport bottom',Math.abs(foot.bottom-innerHeight)<=2);
    ['howBtn','feedbackBtn','shareBtn'].forEach(function(id){var r=rect(id);check(prefix+': '+id+' visible and touchable',r.top>=0&&r.bottom<=innerHeight+2&&r.left>=0&&r.right<=innerWidth+1&&r.height>=43);});
    if(matchMedia('(min-width:860px) and (min-aspect-ratio:6/5)').matches)check(prefix+': meter stays readable',document.querySelector('.meter').getBoundingClientRect().width>=Math.min(900,innerWidth-40)-2);
    check(prefix+': footer space reserved',parseFloat(getComputedStyle(document.querySelector('.stage')).paddingBottom)>=foot.height);
   }
  }
   entry.hidden=true;dock.hidden=true;MP.meter.fitToWindow();window.scrollTo(0,0);el('exploreToggle').click();await new Promise(requestAnimationFrame);
   var menu=rect('studentNav'),foot=rect('utilityFooter');
   check('open menu within viewport',menu.left>=0&&menu.right<=innerWidth&&menu.top>=0&&menu.bottom<=foot.top);
   el('exploreToggle').click();
  }finally{entry.hidden=saved.entry;dock.hidden=saved.dock;next.hidden=saved.next;next.disabled=saved.disabled;task.textContent=saved.task;step.textContent=saved.step;MP.meter.fitToWindow();window.scrollTo(0,saved.y);}
  return {passed:passed,failed:failures.length,failures:failures};
 }
 MP.layoutTest={run:run};
})(globalThis);
