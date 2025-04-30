/* ================================================================
   Dashboard Portefeuille IA – FRONTEND
   © 2025 – version full-stack Render
   ============================================================== */

/* == 1. CONFIG GÉNÉRALE ========================================= */
const API_BASE = 'https://dashboard-ia-backend.onrender.com';   // back Render
const WS_URL   = API_BASE.replace(/^http/, 'ws') + '/ws/prices';

const PROXY           = 'https://proxi-api-crypto.onrender.com/proxy/'; // proxy public
let   portfolio        = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;   // 1 h
const SLEEP_SHORT     = 300;              // ms
const SLEEP_LONG      = 500;

/* == 2. OUTILS GÉNÉRIQUES ======================================= */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function debug(msg){
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
async function safeFetch(url, label){
  try{
    const res = await fetch(url);
    debug(`${label} HTTP ${res.status}`);
    return res;
  }catch(err){
    debug(`${label} fetch error: ${err.message}`);
    return null;
  }
}
async function safeJson(res, label){
  if(!res) return null;
  if(!res.ok){
    debug(`${label} non-OK status: ${res.status}`);
    return null;
  }
  try{
    const j = await res.json();
    if(!j) debug(`${label} JSON vide`);
    return j;
  }catch(err){
    debug(`${label} JSON parse error: ${err.message}`);
    return null;
  }
}

/* == 3. PRIX TEMPS-RÉEL VIA WEBSOCKET =========================== */
const live = {};   // ex : { BTC:{p:64500, ts:Date.now(), src:'binance'} }

(() => {
  const ws = new WebSocket(WS_URL);
  ws.onopen    = () => debug('🔌 WebSocket connecté');
  ws.onerror   = () => debug('⚠️ WebSocket error');
  ws.onclose   = () => debug('❌ WebSocket fermé');
  ws.onmessage = (e)=>{
    try{
      const d = JSON.parse(e.data);
      if(d.type!=='price') return;
      live[d.symbol] = { p:d.price, ts:Date.now(), src:d.src };
      const td = document.querySelector(
        `td[data-sym="${d.symbol}"][data-col="price"]`
      );
      if(td) td.textContent = d.price.toFixed(2);
    }catch{}
  };
})();
/* == 4. FETCH PRIX & DONNÉES =================================== */
async function fetchExchangeRate(){
  const r = await safeFetch('https://api.exchangerate.host/latest?base=USD&symbols=CAD','FX');
  const j = await safeJson(r,'FX');
  return j?.rates?.CAD || 1.35;
}

async function fetchAction(sym){
  const l = live[sym];
  if(l && Date.now()-l.ts < 15_000)
    return { price:l.p, change:0, currency:'USD', live:true };

  const r = await safeFetch(`${API_BASE}/api/stocks/quote/${sym}`,'Polygon');
  const j = await safeJson(r,'Polygon');
  const p = j?.results?.[0];
  if(!p) return null;
  return {
    price:  p.c,
    change: ((p.c - p.o)/p.o)*100,
    currency:'USD',
    live:false
  };
}

/* --- fallback REST via proxy Binance si pas de données live ---- */
async function fetchCrypto(sym, curr){
  const l = live[sym];
  if(l && Date.now()-l.ts < 15_000){
    const rate = curr==='CAD' ? await fetchExchangeRate() : 1;
    return { price:l.p*rate, change:0, currency:curr, live:true };
  }

  const r = await safeFetch(`${PROXY}binance?symbol=${sym}USDT`,'Binance');
  const j = await safeJson(r,'Binance');
  if(!j) return null;

  const price  = +j.lastPrice;
  const change = +j.priceChangePercent;
  const rate   = curr==='CAD' ? await fetchExchangeRate() : 1;

  return { price:price*rate, change, currency:curr, live:false };
}

async function fetchMetal(code='gold'){
  const r = await safeFetch(`${API_BASE}/api/metals/${code}`,'Metal');
  const j = await safeJson(r,'Metal');
  return j?.rates?.USD || null;
}

async function fetchNews(q='BTC', lim=5){
  const r = await safeFetch(`${API_BASE}/api/news?q=${q}&limit=${lim}`,'News');
  const j = await safeJson(r,'News');
  return j?.results || [];
}

/* == 5. PRÉ-SÉLECTION TICKERS (Paprika / Gecko) ================= */
async function fetchGeckoTickers(perPage=100, pages=5){
  const all=[];
  for(let p=1;p<=pages;p++){
    const r = await safeFetch(
      `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}&sparkline=false&price_change_percentage=24h`,
      `Gecko page ${p}`
    );
    const arr = await safeJson(r,`Gecko page ${p}`);
    if(!Array.isArray(arr)){ debug(`⚠️ Gecko p${p} pas tableau`); break; }
    all.push(...arr);
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList(){
  const results=[];
  const r = await safeFetch(`${PROXY}coinpaprika`,'Paprika');
  const d = await safeJson(r,'Paprika');
  if(Array.isArray(d)) results.push(...d.slice(0,1000));

  const need = 1000 - results.length;
  if(need>0){
    const geo = await fetchGeckoTickers(100, Math.ceil(need/100));
    const slice = geo.slice(0,need).map(d=>({
      id:d.id,
      symbol:d.symbol?.toUpperCase()||'',
      name:d.name,
      quotes:{USD:{market_cap:d.market_cap,volume_24h:d.total_volume,percent_change_24h:d.price_change_percentage_24h}},
      started_at:d.genesis_date,
      rank:d.market_cap_rank
    }));
    results.push(...slice);
  }
  return results;
}
/* == 6. ENRICHISSEMENT IA & OPPORTUNITÉS ======================= */
let isFetchingOpportunities = false;

const _origFetchOpp = fetchOpportunities ?? async ()=>{};
fetchOpportunities = async function(){
  if(isFetchingOpportunities){ debug('⏳ déjà en cours'); return; }
  isFetchingOpportunities = true;
  try{ await _origFetchOpp(); }
  finally{ isFetchingOpportunities = false; }
};

const _origSafeJson = safeJson;
safeJson = async function(res,label){
  const j = await _origSafeJson(res,label);
  if(label.startsWith('News') && j?.results?.length===0 && res?.url?.includes('filter=hot')){
    const alt = await safeFetch(res.url.replace('filter=hot','filter=trending'), label+'(FB)');
    return (await _origSafeJson(alt,label+'(FB)')) || j;
  }
  return j;
};

async function _fetchOppInner(){
  const ul = document.getElementById('opportunities');
  if(!ul){ console.warn('#opportunities manquant'); return; }
  ul.innerHTML = '<li>Analyse IA des cryptos…</li>';
  debug('--- Début fetchOpportunities ---');

  const all = await getTickerList();
  const filtered = all.filter(t=>{
    const u = t.quotes.USD, oneY = Date.now() - 365*24*60*60*1000;
    return u.market_cap>=5e6 && u.volume_24h>=1e6 &&
           (t.started_at ? new Date(t.started_at).getTime():0) < oneY &&
           t.rank < 500 && !t.id.includes('testnet') &&
           !['elon','cum','baby','moon','trump'].some(w=>t.name.toLowerCase().includes(w));
  });

  const maxMC  = Math.max(...filtered.map(t=>t.quotes.USD.market_cap));
  const maxVol = Math.max(...filtered.map(t=>t.quotes.USD.volume_24h));
  const candidates = filtered.map(t=>({
      ...t,
      preScore:(t.quotes.USD.market_cap/maxMC)*0.7 + (t.quotes.USD.volume_24h/maxVol)*0.3
    }))
    .sort((a,b)=>b.preScore-a.preScore)
    .slice(0,100);

  const enriched=[];
  for(let i=0;i<candidates.length && enriched.length<50;i++){
    const sym = candidates[i].symbol;
    debug(`▶️ ${sym} (${i+1}/100)`);
    try{
      const [newsR,rsiR,macdR,evtR,onR] = await Promise.all([
        safeFetch(`${API_BASE}/api/news?q=${encodeURIComponent(candidates[i].name)}&limit=1`, `News ${sym}`),
        safeFetch(`${PROXY}cryptocompare/rsi?fsym=${sym}&tsym=USD&timePeriod=14`, 'RSI'),
        safeFetch(`${PROXY}cryptocompare/macd?fsym=${sym}&tsym=USD&fastPeriod=12&slowPeriod=26&signalPeriod=9`, 'MACD'),
        safeFetch(`${PROXY}events?coins=${sym}`, 'Events'),
        safeFetch(`${PROXY}onchain?symbol=${sym}`, 'Onchain')
      ]);
      const news = await safeJson(newsR, `News ${sym}`);
      const rsi  = (await safeJson(rsiR,'RSI'))?.Data?.Data?.[0]?.value || 0;
      const macdData = await safeJson(macdR,'MACD');
      const macd   = macdData?.Data?.Data?.[0]?.MACD   || 0;
      const signal = macdData?.Data?.Data?.[0]?.Signal || 0;
      const evt = await safeJson(evtR,'Events');
      const on  = await safeJson(onR,'Onchain');

      const boosts = [
        news?.results?.length ? 1.2 : 1,
        (rsi < 30 && macd > signal) ? 1.2 : 1,
        (evt?.body?.length > 0) ? 1.2 : 1,
        ((on?.data?.value || 0) > 500) ? 1.2 : 1
      ];
      const rawPct  = candidates[i].quotes.USD.percent_change_24h || 0;
      const forecast = rawPct * boosts.reduce((a,b)=>a*b,1) * 7;
      const conf = ((boosts.filter(b=>b>1).length/boosts.length)*10).toFixed(1);

      const art = news?.results?.[0] || {};
      const hl  = art.title || 'Pas d’actualité';
      const dStr = art.published_at ? ` (${new Date(art.published_at).toLocaleString('fr-FR')})` : '';

      if(forecast >= 0){
        enriched.push({
          name:sym,
          forecast:forecast.toFixed(1),
          confidence:conf,
          headline:hl,
          dateStr:dStr,
          url:art.url||''
        });
      }
    }catch(err){ debug(`❌ IA ${sym}: ${err.message}`); }
    await sleep(SLEEP_LONG);
  }

  debug(`✅ Enrichies : ${enriched.length}`);
  ul.innerHTML = '';
  enriched
    .sort((a,b)=> +b.forecast - +a.forecast)
    .forEach(e=>{
      ul.innerHTML += `<li>* ${e.name}: +${e.forecast}% (7j)<br>
        Confiance IA : ${e.confidence}/10<br>
        ${e.headline}${e.dateStr}<br>
        ${e.url ? `<a href="${e.url}" target="_blank">Lien</a>` : ''}</li>`;
    });
}
fetchOpportunities = _fetchOppInner;
/* == 7. TABLEAUX & RAFRAÎCHISSEMENT ============================= */
async function refreshAll(){
  const tA=document.getElementById('tableAction'),
        tC=document.getElementById('tableCrypto'),
        adv=document.getElementById('adviceList'),
        perf=document.getElementById('globalPerf');
  if(!(tA&&tC&&adv&&perf)){ console.error('DOM missing'); return; }

  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';
  let inv=0,val=0;

  for(const a of portfolio){
    const info = a.type==='crypto' ? await fetchCrypto(a.sym,a.curr)
                                   : await fetchAction(a.sym);
    if(!info) continue;

    const v     = info.price * a.qty;
    const gain  = v - a.inv;
    const cls   = gain >= 0 ? 'gain':'perte';
    const sign  = gain >= 0 ? '+' : '';
    const liveTag = info.live ? '⚡' : '';

    inv += a.inv; val += v;

    const row = `<tr class="${cls}">
      <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
      <td data-sym="${a.sym}" data-col="price">${info.price.toFixed(2)}</td>
      <td>${v.toFixed(2)}</td>
      <td>${sign}${info.change.toFixed(2)}% ${liveTag} ${info.currency}</td>
    </tr>`;
    (a.type==='crypto' ? tC : tA).innerHTML += row;

    adv.innerHTML += `<li>* ${a.sym}: ${gain>=20?'Vendre':gain<=-15?'À risque':'Garder'}</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? ((totalGain/inv)*100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green':'red';

  await fetchOpportunities();
}
window.onload = refreshAll;

/* Bouton “Rafraîchir opportunités IA” --------------------------- */
document.getElementById('refreshBtn')?.addEventListener('click', async ()=>{
  const btn = document.getElementById('refreshBtn');
  if(!btn) return;
  btn.disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(()=>{ btn.disabled = false; debug('✅ Bouton réactivé'); }, BUTTON_COOLDOWN);
});

/* === FIN DU FICHIER =========================================== */
