// === Bloc 1 : constantes et outils ===
const PROXY            = 'https://proxi-api-crypto.onrender.com/proxy/';
let   portfolio         = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN  = 60 * 60 * 1_000;     // 1 h
const SLEEP_SHORT      = 300;                 // ms
const SLEEP_LONG       = 500;

// === 2 : helpers ===
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function debug(msg){
  const el = document.getElementById('debugConsole');
  if(el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
async function safeFetch(url, label){
  try{ const res = await fetch(url); debug(`${label} HTTP ${res.status}`); return res; }
  catch(err){ debug(`${label} fetch error: ${err.message}`); return null; }
}
async function safeJson(res, label){
  if(!res) return null;
  if(!res.ok){ debug(`${label} non-OK ${res.status}`); return null; }
  try{ return await res.json(); }
  catch(e){ debug(`${label} JSON error: ${e.message}`); return null; }
}

// === 3 : données boursières ===
async function fetchExchangeRate(){
  const r = await safeFetch('https://api.exchangerate.host/latest?base=USD&symbols=CAD','FX');
  const j = await safeJson(r,'FX');  return j?.rates?.CAD ?? 1.35;
}
async function fetchAction(sym){
  const r = await safeFetch(`${PROXY}finnhub?symbol=${sym}`,'Finnhub');
  const d = await safeJson(r,'Finnhub');
  if(!d) return null;
  const change = d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0;
  return { price:d.c, change, currency:'USD' };
}
async function fetchCrypto(sym, curr){
  const r = await safeFetch(`${PROXY}binance?symbol=${sym}USDT`,'Binance');
  const d = await safeJson(r,'Binance');
  if(!d) return null;
  const price  = +d.lastPrice;
  const change = +d.priceChangePercent;
  if(curr === 'CAD'){
    const rate = await fetchExchangeRate();
    return { price: price * rate, change, currency:'CAD' };
  }
  return { price, change, currency:'USD' };
}

// === 4 : 1000 tickers (CoinPaprika + CoinGecko) ===
async function fetchGeckoTickers(perPage=100, pages=5){
  const all=[];
  for(let p=1;p<=pages;p++){
    const r = await safeFetch(`${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}&sparkline=false&price_change_percentage=24h`,`Gecko p${p}`);
    const arr = await safeJson(r,`Gecko p${p}`);
    if(!Array.isArray(arr)) break;
    all.push(...arr);
    debug(`✅ Gecko p${p}: ${arr.length}`);
    await sleep(SLEEP_SHORT);
  }
  return all;
}
async function getTickerList(){
  const res=[];
  // CoinPaprika
  { const r=await safeFetch(`${PROXY}coinpaprika`,'Paprika');
    const d=await safeJson(r,'Paprika');
    if(Array.isArray(d)){ res.push(...d.slice(0,1000)); debug(`✅ Paprika : ${res.length}`);}
  }
  // CoinGecko si besoin
  const need = 1000 - res.length;
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
    res.push(...slice);  debug(`✅ Gecko +${slice.length}`);
  }
  return res;
}

// === Bloc 2 : Opportunités IA ===
let isFetchingOpportunities=false;
async function fetchOpportunities(){
  if(isFetchingOpportunities){ debug('⏳ déjà en cours'); return; }
  isFetchingOpportunities=true;
  try{
    const ul=document.getElementById('opportunities');
    if(!ul){ console.warn('#opportunities absent'); return; }
    ul.innerHTML='<li>Analyse IA des cryptos…</li>';
    debug('--- Début fetchOpportunities ---');

    const all = await getTickerList();
    const filtered = all.filter(t=>{
      const u=t.quotes.USD, oneY=Date.now()-365*24*60*60*1e3;
      return u.market_cap>=5e6 && u.volume_24h>=1e6 &&
             (t.started_at?new Date(t.started_at).getTime():0)<oneY &&
             t.rank<500 && !t.id.includes('testnet') &&
             !['elon','cum','baby','moon','trump'].some(w=>t.name.toLowerCase().includes(w));
    });

    const maxMC = Math.max(...filtered.map(t=>t.quotes.USD.market_cap));
    const maxVol= Math.max(...filtered.map(t=>t.quotes.USD.volume_24h));
    const candidates = filtered.map(t=>({
        ...t,
        preScore:(t.quotes.USD.market_cap/maxMC)*0.7 + (t.quotes.USD.volume_24h/maxVol)*0.3
      }))
      .sort((a,b)=>b.preScore-a.preScore)
      .slice(0,100);

    const enriched=[];
    for(let i=0;i<candidates.length && enriched.length<50;i++){
      const c=candidates[i], sym=c.symbol;
      debug(`▶️ ${sym} (${i+1}/100)`);

      // News
      let nRes = await safeFetch(`${PROXY}news?q=${encodeURIComponent(c.name)}&limit=1`, `News ${sym}`);
      let news = await safeJson(nRes,`News ${sym}`);
      if(!news?.articles?.length){
        const altURL = nRes?.url?.replace('filter=hot','filter=trending') || '';
        const altRes = altURL ? await safeFetch(altURL,`News ${sym} FB`) : null;
        news = await safeJson(altRes,`News ${sym} FB`);
      }

      // RSI & MACD
      const rsiVal = (await safeJson(await safeFetch(`${PROXY}cryptocompare/rsi?fsym=${sym}&tsym=USD&timePeriod=14`,'RSI'),'RSI'))?.Data?.Data?.[0]?.value||0;
      const macdObj= (await safeJson(await safeFetch(`${PROXY}cryptocompare/macd?fsym=${sym}&tsym=USD&fastPeriod=12&slowPeriod=26&signalPeriod=9`,'MACD'),'MACD'))?.Data?.Data?.[0]||{};
      const macd=macdObj.MACD||0, signal=macdObj.Signal||0;

      const [evtRes,onRes]=await Promise.all([
        safeFetch(`${PROXY}events?coins=${sym}`,'Events'),
        safeFetch(`${PROXY}onchain?symbol=${sym}`,'Onchain')
      ]);
      const evt=await safeJson(evtRes,'Events');
      const on =await safeJson(onRes ,'Onchain');

      const boosts=[
        news?.articles?.length?1.2:1,
        (rsiVal<30&&macd>signal)?1.2:1,
        (evt?.body?.length>0)?1.2:1,
        ((on?.data?.value||0)>500)?1.2:1
      ];
      const rawPct   = c.quotes.USD.percent_change_24h || 0;
      const forecast = rawPct * boosts.reduce((a,b)=>a*b,1) * 7;
      const conf     = ((boosts.filter(b=>b>1).length/boosts.length)*10).toFixed(1);

      const art=news?.articles?.[0]||{};
      const hl = art.title||'Pas d’actualité';
      const dt = art.published_at?` (${new Date(art.published_at).toLocaleString('fr-FR')})`:'';

      if(forecast>=0){
        enriched.push({ name:sym, forecast:forecast.toFixed(1), conf, hl, dt, url:art.url||'' });
      }
      await sleep(SLEEP_LONG);
    }

    ul.innerHTML='';
    enriched.sort((a,b)=>+b.forecast-+a.forecast).forEach(e=>{
      ul.innerHTML += `<li>* ${e.name}: +${e.forecast}% (7j)<br>
        Confiance IA : ${e.conf}/10<br>
        ${e.hl}${e.dt}<br>
        ${e.url?`<a href=\"${e.url}\" target=\"_blank\">Lien</a>`:''}</li>`;
    });
    debug(`✅ Enrichies : ${enriched.length}`);
  }finally{
    isFetchingOpportunities=false;
  }
}
// === Bloc 3 : Dashboard ===
async function refreshAll(){
  const tA=document.getElementById('tableAction'),
        tC=document.getElementById('tableCrypto'),
        adv=document.getElementById('adviceList'),
        perf=document.getElementById('globalPerf');
  if(!(tA&&tC&&adv&&perf)){ console.error('DOM missing'); return; }

  tA.innerHTML=tC.innerHTML=adv.innerHTML='';
  let inv=0,val=0;

  for(const a of portfolio){
    const info = a.type==='crypto' ? await fetchCrypto(a.sym,a.curr)
                                   : await fetchAction(a.sym);
    if(!info) continue;
    const v=info.price*a.qty, gain=v-a.inv, sign=gain>=0?'+':'';
    inv+=a.inv; val+=v;
    tA.innerHTML+=`<tr class=\"${gain>=0?'gain':'perte'}\"><td>${a.sym}</td><td>${a.qty}</td>
      <td>${a.inv.toFixed(2)}</td><td>${info.price.toFixed(2)}</td>
      <td>${v.toFixed(2)}</td><td>${sign}${(info.change||0).toFixed(2)}% ${info.currency}</td></tr>`;
    adv.innerHTML+=`<li>* ${a.sym}: ${gain>=20?'Vendre':gain<=-15?'À risque':'Garder'}</li>`;
  }

  const totGain=val-inv, totPct=inv?((totGain/inv)*100).toFixed(2):0;
  perf.textContent=`Performance globale : ${totGain.toFixed(2)} CAD (${totPct}%)`;
  perf.style.color=totGain>=0?'green':'red';

  await fetchOpportunities();  // opportunités IA
}

// — init et événements —
window.onload = refreshAll;

document.getElementById('refreshBtn')?.addEventListener('click', async ()=>{
  const btn=document.getElementById('refreshBtn');
  if(!btn) return;
  btn.disabled=true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(()=>{ btn.disabled=false; debug('✅ Bouton réactivé'); }, BUTTON_COOLDOWN);
});

// FIN SCRIPT
