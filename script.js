// === Bloc 1 : constantes, outils et pré-sélection ===
// === 1. CONST & VARIABLES GLOBALES ===
const PROXY            = 'https://proxi-api-crypto.onrender.com/proxy/';
let   portfolio         = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN  = 60 * 60 * 1000;   // 1 h
const SLEEP_SHORT      = 300;              // ms
const SLEEP_LONG       = 500;

// === 2. OUTILS DE FETCH SÉCURISÉ ===
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

// === 3. FETCH ACTIONS & CRYPTOS ===
async function fetchExchangeRate(){
  const res = await safeFetch(
    'https://api.exchangerate.host/latest?base=USD&symbols=CAD',
    'ExchangeRate'
  );
  const j = await safeJson(res,'ExchangeRate');
  return j?.rates?.CAD || 1.35;
}

async function fetchAction(sym){
  const res = await safeFetch(`${PROXY}finnhub?symbol=${sym}`,'Finnhub');
  const d   = await safeJson(res,'Finnhub');
  if(!d) return null;
  const change = d.pc ? ((d.c-d.pc)/d.pc)*100 : 0;
  return { price:d.c, change, currency:'USD' };
}

async function fetchCrypto(sym,curr){
  const res = await safeFetch(`${PROXY}binance?symbol=${sym}USDT`,'Binance');
  const d   = await safeJson(res,'Binance');
  if(!d) return null;
  const price  = +d.lastPrice;
  const change = +d.priceChangePercent;
  if(curr==='CAD'){
    const rate = await fetchExchangeRate();
    return { price:price*rate, change, currency:'CAD' };
  }
  return { price, change, currency:'USD' };
}

// === 4. PRÉ-SÉLECTION (1000 tickers) ===
async function fetchGeckoTickers(perPage=100,pages=5){
  const all=[];
  for(let p=1;p<=pages;p++){
    const res = await safeFetch(
      `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}&sparkline=false&price_change_percentage=24h`,
      `Gecko page ${p}`
    );
    const arr = await safeJson(res,`Gecko page ${p}`);
    if(!Array.isArray(arr)){ debug(`⚠️ CoinGecko page ${p} pas tableau`); break; }
    all.push(...arr);
    debug(`✅ CoinGecko page ${p}: ${arr.length}`);
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList(){
  const results=[];

  // 4.1 – CoinPaprika
  {
    const r = await safeFetch(`${PROXY}coinpaprika`,'CoinPaprika');
    const d = await safeJson(r,'CoinPaprika');
    if(Array.isArray(d)){ results.push(...d.slice(0,1000)); debug(`✅ CoinPaprika: ${results.length}`);}
    else debug('⚠️ CoinPaprika bad format');
  }

  // 4.2 – Compléter avec CoinGecko
  const need = 1000-results.length;
  if(need>0){
    const pages = Math.ceil(need/100);
    const geo   = await fetchGeckoTickers(100,pages);
    const slice = geo.slice(0,need).map(d=>({ id:d.id,
      symbol:d.symbol?.toUpperCase()||'',
      name:d.name,
      quotes:{ USD:{ market_cap:d.market_cap, volume_24h:d.total_volume, percent_change_24h:d.price_change_percentage_24h }},
      started_at:d.genesis_date,
      rank:d.market_cap_rank
    }));
    results.push(...slice);
    debug(`✅ CoinGecko ajouté: ${slice.length}`);
  }
  debug(`Total tickers : ${results.length}`);
  return results;
}

// === Bloc 2 : enrichissement IA & affichage ===
async function fetchOpportunities(){
  const ul = document.getElementById('opportunities');
  if(!ul){ console.warn('#opportunities manquant'); return; }
  ul.innerHTML='<li>Analyse IA des cryptos…</li>';
  debug('--- Début fetchOpportunities ---');

  const all      = await getTickerList();
  debug(`Brut : ${all.length}`);
  const filtered = all.filter(t=>{
    const u = t.quotes.USD;
    const oneY = Date.now()-365*24*60*60*1000;
    return u.market_cap>=5e6 && u.volume_24h>=1e6 &&
           (t.started_at? new Date(t.started_at).getTime():0)<oneY &&
           t.rank<500 && !t.id.includes('testnet') &&
           !['elon','cum','baby','moon','trump'].some(w=>t.name.toLowerCase().includes(w));
  });
  debug(`Après filtres : ${filtered.length}`);

  const maxMC  = Math.max(...filtered.map(t=>t.quotes.USD.market_cap));
  const maxVol = Math.max(...filtered.map(t=>t.quotes.USD.volume_24h));
  const candidates = filtered.map(t=>({
      ...t,
      preScore:(t.quotes.USD.market_cap/maxMC)*0.7 + (t.quotes.USD.volume_24h/maxVol)*0.3
    }))
    .sort((a,b)=>b.preScore-a.preScore)
    .slice(0,100);

  debug(`Top 100 présélectionnés (≥${candidates.at(-1)?.preScore.toFixed(3)})`);

  const enriched=[];
  for(let i=0;i<candidates.length && enriched.length<50;i++){
    const sym=candidates[i].symbol;
    debug(`▶️ Enrichissement ${i+1}/100 : ${sym}`);
    try{
      const resNews = await safeFetch(`${PROXY}news?q=${encodeURIComponent(candidates[i].name)}&limit=1`,`News ${sym}`);
      const news    = await safeJson(resNews,`News ${sym}`);

      const resRsi  = await safeFetch(`${PROXY}cryptocompare/rsi?fsym=${sym}&tsym=USD&timePeriod=14`,'CryptoCompare RSI');
      const dataRsi = await safeJson(resRsi,'CryptoCompare RSI');
      const rsi     = dataRsi?.Data?.Data?.[0]?.value||0;

      const resMacd = await safeFetch(`${PROXY}cryptocompare/macd?fsym=${sym}&tsym=USD&fastPeriod=12&slowPeriod=26&signalPeriod=9`,'CryptoCompare MACD');
      const dataMacd= await safeJson(resMacd,'CryptoCompare MACD');
      const p=dataMacd?.Data?.Data?.[0]||{}; const macd=p.MACD||0, signal=p.Signal||0;

      const [resEvt,resOn] = await Promise.all([
        safeFetch(`${PROXY}events?coins=${sym}`,'Events'),
        safeFetch(`${PROXY}onchain?symbol=${sym}`,'Onchain')
      ]);
      const evt=await safeJson(resEvt,'Events');
      const on =await safeJson(resOn ,'Onchain');

      const boosts=[ news?.articles?.length?1.2:1,
                     (rsi<30&&macd>signal)?1.2:1,
                     (evt?.body?.length>0)?1.2:1,
                     ((on?.data?.value||0)>500)?1.2:1 ];
      const rawPct   = candidates[i].quotes.USD.percent_change_24h||0;
      const forecast = rawPct*boosts.reduce((a,b)=>a*b,1)*7;
      const confidence=((boosts.filter(b=>b>1).length/boosts.length)*10).toFixed(1);

      const art=news?.articles?.[0]||{};
      const hl = art.title||'Pas d’actualité';
      const dt = art.published_at?` (${new Date(art.published_at).toLocaleString('fr-FR')})`:'';

      if(forecast>=0){
        enriched.push({ name:sym, forecast:forecast.toFixed(1), confidence, headline:hl, dateStr:dt, url:art.url||'' });
      }
    }catch(err){ debug(`❌ IA ${sym} : ${err.message}`); }
    await sleep(SLEEP_LONG);
  }
  debug(`✅ Enrichies : ${enriched.length} (cible 50)`);

  ul.innerHTML='';
  enriched.sort((a,b)=>+b.forecast-+a.forecast).slice(0,50).forEach(e=>{
    ul.innerHTML+=`<li>* ${e.name}: +${e.forecast}% (7j)<br>
      Confiance IA : ${e.confidence}/10<br>
      ${e.headline}${e.dateStr}<br>
      ${e.url?`<a href=\"${e.url}\" target=\"_blank\">Lien</a>`:''}</li>`;
  });
}

// === 6. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll(){
  const tA=document.getElementById('tableAction'),
        tC=document.getElementById('tableCrypto'),
        adv=document.getElementById('adviceList'),
        perf=document.getElementById('globalPerf');
  if(!(tA&&tC&&adv&&perf)){ console.error('DOM missing'); return; }
  tA.innerHTML=tC.innerHTML=adv.innerHTML='';

  let inv=0,val=0;
  for(const a of portfolio){
    const inf=a.type==='crypto'?await fetchCrypto(a.sym,a.curr):await fetchAction(a.sym);
    if(!inf) continue;
    const v=inf.price*a.qty, gain=v-a.inv, cls=gain>=0?'gain':'perte';
    const sign=gain>=0?'+':'';
    inv+=a.inv; val+=v;
    tA.innerHTML+=`<tr class=\"${cls}\"><td>${a.sym}</td><td>${a.qty}</td>
      <td>${a.inv.toFixed(2)}</td><td>${inf.price.toFixed(2)}</td>
      <td>${v.toFixed(2)}</td><td>${sign}${(inf.change||0).toFixed(2)}% ${inf.currency}</td></tr>`;
    adv.innerHTML+=`<li>* ${a.sym}: ${gain>=20?'Vendre':gain<=-15?'À risque':'Garder'}</li>`;
  }
  const totalGain=val-inv, totalPct=inv?((totalGain/inv)*100).toFixed(2):0;
  perf.textContent=`Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color=totalGain>=0?'green':'red';

  await fetchOpportunities();
}

window.onload=refreshAll;
// — suite script.js —

document.getElementById('refreshBtn')?.addEventListener('click',async()=>{
  const btn=document.getElementById('refreshBtn');
  if(!btn) return;
  btn.disabled=true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(()=>{
    btn.disabled=false;
    debug('✅ Bouton réactivé');
  },BUTTON_COOLDOWN);
});

/* =======  Patch non-destructif pour fetchOpportunities ======= */

// 0. Verrou anticollision
let isFetchingOpportunities=false;

// 1. Wrap de la fonction originale
const _origFetchOpp=fetchOpportunities;
fetchOpportunities=async function(){
  if(isFetchingOpportunities){ debug('⏳ Opportunities déjà en cours'); return; }
  isFetchingOpportunities=true;
  try{ await _origFetchOpp(); }
  finally{ isFetchingOpportunities=false; }
};

// 2. Fallback CryptoPanic : élargir filtre si pas d’articles
const _origSafeJson=safeJson;
safeJson=async function(res,label){
  const j=await _origSafeJson(res,label);
  if(label.startsWith('News') && j?.articles?.length===0 && res?.url?.includes('filter=hot')){
    const alt=await safeFetch(res.url.replace('filter=hot','filter=trending'),label+' (FB)');
    return (await _origSafeJson(alt,label+' (FB)'))||j;
  }
  return j;
};

// 3. Affichage confiance plus lisible (0-4 boosts)
function confidenceFromBoosts(b){ return `${b.filter(x=>x>1).length} / 4`; }

// 4. Injector pour stopper la boucle quand enriched==50
const _push=Array.prototype.push;
Array.prototype.push=function(...args){
  const r=_push.apply(this,args);
  if(this===enriched && enriched.length>=50){
    throw new Error('STOP_LOOP'); // stoppe le for sans casser le reste
  }
  return r;
};

// FIN SCRIPT
