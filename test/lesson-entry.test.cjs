const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function boot(saved){
 const nodes=new Map();let loads=0,writes=0;
 function node(id){if(!nodes.has(id))nodes.set(id,{hidden:false,textContent:'',innerHTML:'',addEventListener(){},setAttribute(){},scrollIntoView(){},focus(){},querySelector(){return null;}});return nodes.get(id);}
 const context=vm.createContext({document:{readyState:'complete',getElementById:node,addEventListener(){},body:{classList:{toggle(){}}}},location:{hash:'#corr'},MP:{fmt:{escapeHtml:String},store:{get(){return saved;},set(){writes++;return true;}},app:{ensureStock(){loads++;return new Promise(()=>{});},stockSeries(){return [];},state:{history:{}},analyticsFor(){}},meter:{openDrawer(){}},router:{go(){},show(){},overridePanel(){}}}});
 vm.runInContext(fs.readFileSync('src/lib/lessons.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/lib/lessons-ui.js','utf8'),context);
 return {context,node,loads:()=>loads,writes:()=>writes};
}
test('fresh entry is quiet; explicit start reveals the task',()=>{
 const app=boot(null);assert.equal(app.node('studentControls').hidden,true);assert.equal(app.node('lessonGuide').hidden,true);assert.equal(app.node('exploreStart').textContent,'Start experiment');assert.equal(app.loads(),0);
 app.context.MP.guided.start('mix',false);assert.equal(app.node('studentControls').hidden,false);assert.equal(app.node('lessonGuide').hidden,false);
 app.context.MP.guided.exit();assert.equal(app.node('studentControls').hidden,true);
});
test('saved lesson stays dormant across reload and resumes without losing observations',()=>{
 const initial=boot(null);const state=initial.context.MP.lessons.blank();state.active='mix';state.progress.mix.step=1;state.progress.mix.observations.first={holdings:[{symbol:'AAPL',weight:50},{symbol:'MSFT',weight:50}],returnPct:5,volatilityPct:12,maxDrawdownPct:-3,range:'1y',start:'2025-01-01',end:'2026-01-01'};
 const saved=JSON.parse(JSON.stringify(state));const app=boot(saved);
 assert.equal(app.node('studentControls').hidden,true);assert.equal(app.node('lessonGuide').hidden,true);assert.equal(app.loads(),0);assert.equal(app.writes(),0);assert.equal(app.node('exploreStart').textContent,'Continue experiment');
 app.context.MP.guided.openLibrary();assert.equal(app.node('studentControls').hidden,true);
 app.context.MP.guided.startResume();assert.equal(app.node('studentControls').hidden,false);assert.equal(app.context.MP.guided.state().progress.mix.step,1);
 const after=JSON.parse(JSON.stringify(app.context.MP.guided.state()));assert.deepEqual(after.progress,saved.progress);
 const reload=boot(after);assert.equal(reload.node('studentControls').hidden,true);assert.deepEqual(JSON.parse(JSON.stringify(reload.context.MP.guided.state().progress)),saved.progress);
 app.context.MP.guided.exit();assert.equal(app.node('studentControls').hidden,true);assert.deepEqual(JSON.parse(JSON.stringify(app.context.MP.guided.state().progress)),saved.progress);
});
