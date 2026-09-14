/* One browser-local practice allocation, using the app's stock catalogue/cache. */
(function (root) {
  'use strict';
  var MP = root.MP = root.MP || {}, KEY = 'practicePortfolio';
  var holdings = [], range = '1y', result = null, revision = 0, saved = true;
  function el(id) {return document.getElementById(id);}
  function esc(s) {return MP.fmt.escapeHtml(String(s));}
  function money(n) {return n.toLocaleString('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});}
  function pct(n) {return n === null ? 'Unavailable' : n.toFixed(2) + '%';}
  function say(text) {el('portfolioNotice').textContent = text;}
  function persist() {
    saved = !!(MP.store && MP.store.set(KEY,{version:1,holdings:holdings,range:range}));
    el('portfolioSave').textContent = saved ? 'Saved in this browser only.' : 'Changes work for this session but could not be saved in this browser.';
  }
  function invalidate() {
    revision++; result = null; el('portfolioResult').innerHTML = '';
    say('Set your weights, then run the simulation.'); persist();
  }
  function rows() {
    el('portfolioHoldings').innerHTML = holdings.map(function (h, i) {
      return '<div class="practice-holding"><label for="portfolioWeight'+i+'">'+esc(h.symbol)+' <span>weight (%)</span></label>'+
        '<input id="portfolioWeight'+i+'" type="number" min="0.01" max="100" step="0.01" value="'+h.weight+'" data-weight="'+i+'">'+
        '<button class="pill" type="button" data-remove-holding="'+i+'" aria-label="Remove '+esc(h.symbol)+'">Remove</button></div>';
    }).join('') || '<p>No stocks yet. Search below to add your first one.</p>';
    el('portfolioTotal').textContent = 'Total allocation: '+Number(holdings.reduce(function (s,h) {return s+h.weight;},0).toFixed(2))+'% of 100%';
  }
  function search() {
    var q = el('portfolioSearch').value;
    var choices = MP.search.query(MP.app.stockChoices(),q,7);
    el('portfolioChoices').innerHTML = choices.map(function (c) {
      return '<li><button type="button" class="pick" data-add-holding="'+esc(c.symbol)+'">'+esc(c.symbol)+' — '+esc(c.name)+'</button></li>';
    }).join('') || '<li>No matching supported stocks. Try a ticker or company name.</li>';
  }
  function add(symbol) {
    if (holdings.some(function (h) {return h.symbol===symbol;})) return say(symbol+' is already in this portfolio.');
    if (holdings.length>=5) return say('The portfolio holds up to 5 stocks. Remove one before adding another.');
    if (!MP.app.stockChoices().some(function (c) {return c.symbol===symbol;})) return say('Choose a stock from the search results.');
    var remainder = 100-holdings.reduce(function (s,h) {return s+h.weight;},0);
    holdings.push({symbol:symbol,weight:holdings.length ? Math.max(0,remainder) : 100});
    invalidate(); rows(); el('portfolioSearch').value=''; el('portfolioChoices').innerHTML='';
    el('portfolioWeight'+(holdings.length-1)).focus();
  }
  function renderResult(r) {
    var warning = r.shortened ? 'The available common history is shorter than the selected range. ' : '';
    if(r.incompleteCalendar) warning += 'Some trading dates are missing for a holding. The chart uses shared dates; volatility is unavailable because daily returns cannot be verified. ';
    var daysOld = Math.floor((Date.now()-Date.parse(r.end+'T00:00:00Z'))/86400000);
    if(daysOld>4) warning += 'These closing prices are '+daysOld+' calendar days old. ';
    el('portfolioResult').innerHTML = '<h3 tabindex="-1" id="portfolioResultTitle">Your historical simulation</h3>'+
      '<dl class="practice-metrics"><div><dt>Ending value</dt><dd>'+money(r.endingValue)+'</dd></div><div><dt>Price return</dt><dd>'+pct(r.returnPct)+'</dd></div>'+
      '<div><dt>Annualized volatility</dt><dd>'+pct(r.volatilityPct)+'</dd></div><div><dt>Maximum drawdown</dt><dd>'+pct(r.maxDrawdownPct)+'</dd></div></dl>'+
      '<div class="chartbox" role="img" aria-label="Portfolio value from '+r.start+' to '+r.end+'">'+MP.geom.smoothLine({values:r.series.map(function(p){return p.price;}),color:r.returnPct<0?'var(--down)':'var(--meter-mint)',w:700,h:200})+'</div>'+
      '<p>Actual period: '+r.start+' to '+r.end+' · '+r.sessions+' shared closes. Starting value: $10,000.</p>'+
      '<p class="practice-warning">'+esc(warning)+'</p><h4>Allocation at the start</h4><ul>'+r.allocation.map(function(h){return '<li>'+esc(h.symbol)+': '+h.weight+'% · '+h.shares.toFixed(4)+' simulated shares</li>';}).join('')+'</ul>'+
      '<p class="foot">Latest available close by stock: '+r.freshness.map(function(f){return esc(f.symbol)+' '+f.latest;}).join('; ')+'.</p>';
  }
  function simulate() {
    try {MP.portfolio.validate(holdings);} catch(e) {say(e.message); return Promise.resolve(null);}
    var snapshot = holdings.map(function(h){return {symbol:h.symbol,weight:h.weight};}), chosenRange=range, run=++revision;
    el('portfolioRun').disabled=true; say('Loading closing prices for every holding…');
    return Promise.all(snapshot.map(function(h) {return MP.app.ensureStock(h.symbol,true);})).then(function(){
      if(run!==revision) return null;
      var histories={}; snapshot.forEach(function(h){
        histories[h.symbol]=MP.app.stockSeries(h.symbol);
        if(!histories[h.symbol]) throw new Error(h.symbol+': '+(MP.app.stockReason(h.symbol)||'Price history is unavailable. Try again later.'));
      });
      result=MP.portfolio.calculate(snapshot,histories,chosenRange); renderResult(result); persist(); say('Simulation complete. Historical results do not predict future returns.');
      document.dispatchEvent(new CustomEvent('practice:simulated',{detail:{holdings:snapshot,range:chosenRange,result:result}}));
      return result;
    }).catch(function(e){if(run===revision){result=null;el('portfolioResult').innerHTML='';say(e.message+' No holdings have been omitted.');}return null;})
      .finally(function(){el('portfolioRun').disabled=false;});
  }
  function open() {
    MP.router.overridePanel('portfolio'); MP.meter.openDrawer(true); rows(); persist();
    el('portfolioRange').value=range;
    el('portfolioTitle').focus();
    if(!holdings.length) search();
  }
  function init() {
    var data = MP.store.get(KEY,null);
    if(data && data.version===1 && Array.isArray(data.holdings) && data.holdings.length<=5) {
      holdings=data.holdings.filter(function(h){return h && /^[A-Z][A-Z0-9.-]{0,9}$/.test(h.symbol) && typeof h.weight==='number' && isFinite(h.weight) && h.weight>=0 && h.weight<=100;});
      if(MP.portfolio.RANGES[data.range]) range=data.range;
    }
    el('portfolioOpen').addEventListener('click',open);
    el('portfolioBack').addEventListener('click',function(){MP.router.overridePanel(null);el('portfolioOpen').focus();});
    el('portfolioSearch').addEventListener('input',search);
    el('portfolioChoices').addEventListener('click',function(e){var b=e.target.closest('[data-add-holding]');if(b)add(b.dataset.addHolding);});
    el('portfolioHoldings').addEventListener('input',function(e){if(e.target.hasAttribute('data-weight')){holdings[Number(e.target.dataset.weight)].weight=Number(e.target.value);invalidate();el('portfolioTotal').textContent='Total allocation: '+Number(holdings.reduce(function(s,h){return s+h.weight;},0).toFixed(2))+'% of 100%';}});
    el('portfolioHoldings').addEventListener('click',function(e){var b=e.target.closest('[data-remove-holding]');if(b){holdings.splice(Number(b.dataset.removeHolding),1);invalidate();rows();el('portfolioSearch').focus();}});
    el('portfolioRange').addEventListener('change',function(e){range=e.target.value;invalidate();});
    el('portfolioRun').addEventListener('click',simulate);
    el('portfolioEqual').addEventListener('click',function(){if(!holdings.length)return;holdings.forEach(function(h,i){h.weight=i===holdings.length-1?100-Math.floor(10000/holdings.length)/100*(holdings.length-1):Math.floor(10000/holdings.length)/100;});invalidate();rows();});
  }
  MP.practice = {open:open,simulate:simulate,current:function(){return {holdings:holdings.map(function(h){return Object.assign({},h);}),range:range,result:result};}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
