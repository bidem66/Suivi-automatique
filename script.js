// === Bloc 1 : constantes & helpers =======================================
const PROXY            = 'https://proxi-api-crypto.onrender.com/proxy/';
let   portfolio         = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN  = 60 * 60 * 1_000;        // 1 h
const SLEEP_SHORT      = 300;                    // ms
const SLEEP_LONG       = 500;                    // ms
const STABLES          = [
  'USDT','USDC','DAI','FDUSD','USDE','USDS','sUSDS',
  'USDC.E','BUSD','TUSD','XAUT'
];

// -------------------------------------------------------------------------
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function debug(msg){
  const box = document.getElementById('debugConsole');
  if(box) box.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
async function safeFetch(url, label){
  try{
    const res = await fetch(url);
    debug(`${label} HTTP ${res.status}`);
    return res;
  }catch(e){
    debug(`${label} fetch error: ${e.message}`);
    return null;
  }
}
async function safeJson(res, label){
  if(!res) return null;
  if(!res.ok){ debug(`${label} non-OK ${res.status}`); return null; }
  try{ return await res.json(); }
  catch(e){ debug(`${label} JSON error: ${e.message}`); return null; }
}

// === Bloc 2 : données marché =============================================
async function fetchExchangeRate(){
  const r = await safeFetch(
    'https://api.exchangerate.host/latest?base=USD&symbols=CAD','FX');
  return (await safeJson(r,'FX'))?.rates?.CAD ?? 1.35;
}

async function fetchAction(sym){
  const r = await safeFetch(`${PROXY}finnhub?symbol=${sym}`,'Finnhub');
  const d = await safeJson(r,'Finnhub'); if(!d) return null;
  const change = d.pc ? ((d.c-d.pc)/d.pc)*100 : 0;
  return { price:d.c, change, currency:'USD' };
}

async function fetchCrypto(sym, curr){
  const r = await safeFetch(`${PROXY}binance?symbol=${sym}USDT`,'Binance');
  const d = await safeJson(r,'Binance'); if(!d) return null;
  const price  = +d.lastPrice;
  const change = +d.priceChangePercent;
  if(curr==='CAD'){ return { price:price*(await fetchExchangeRate()), change, currency:'CAD' }; }
  return { price, change, currency:'USD' };
}

// === Bloc 3 : liste de 1000 tickers ======================================
async function fetchGeckoTickers(perPage=100,pages=5){
  const all=[];
  for(let p=1;p<=pages;p++){
    const r=await safeFetch(`${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}&sparkline=false&price_change_percentage=24h`,`Gecko p${p}`);
    const arr=await safeJson(r,`Gecko p${p}`);
    if(!Array.isArray(arr)) break;
    all.push(...arr);
    debug(`✅ Gecko p${p}: ${arr.length}`);
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList(){
  const list=[];
  // CoinPaprika
  {
    const r=await safeFetch(`${PROXY}coinpaprika`,'Paprika');
    const d=await safeJson(r,'Paprika');
    if(Array.isArray(d)){ list.push(...d.slice(0,1000)); debug(`✅ Paprika : ${list.length}`); }
  }
  // CoinGecko complément
  const need=1000-list.length;
  if(need>0){
    const geo=await fetchGeckoTickers(100,Math.ceil(need/100));
    list.push(...geo.slice(0,need).map(d=>({
      id:d.id,
      symbol:d.symbol?.toUpperCase()||'',
      name:d.name,
      quotes:{ USD:{ market_cap:d.market_cap, volume_24h:d.total_volume, percent_change_24h:d.price_change_percentage_24h }},
      started_at:d.genesis_date,
      rank:d.market_cap_rank
    })));
    debug(`✅ Gecko +${need}`);
  }
  return list;
}

// === Bloc 4 : Opportunités IA ============================================
let isFetchingOpportunities = false;
async function fetchOpportunities(){
  if(isFetchingOpportunities){ debug('⏳ déjà en cours'); return; }
  isFetchingOpportunities = true;
  try{
    const ul=document.getElementById('opportunities');
    if(!ul){ console.warn('#opportunities absent'); return; }
    ul.innerHTML='<li>Analyse IA des cryptos…</li>';
    debug('--- fetchOpportunities ---');

    /* 1. Pré-filtres vol/MCap + exclusion stables + |Δ24h| ≥ 1 % */
    const raw   = await getTickerList();
    const filt  = raw.filter(t=>{
      const u=t.quotes.USD, oneY=Date.now()-365*24*60*60*1e3;
      return !STABLES.includes(t.symbol) &&
             Math.abs(u.percent_change_24h||0) >= 1 &&
             u.market_cap>=5e6 && u.volume_24h>=1e6 &&
             (t.started_at?new Date(t.started_at).getTime():0) < oneY &&
             t.rank < 500 && !t.id.includes('testnet');
    });
    debug(`Après filtres : ${filt.length}`);

    /* 2. Score volume+MC → 300 candidats */
    const maxMC = Math.max(...filt.map(t=>t.quotes.USD.market_cap));
    const maxVl = Math.max(...filt.map(t=>t.quotes.USD.volume_24h));
    const cand  = filt.map(t=>({
        ...t,
        preScore:(t.quotes.USD.market_cap/maxMC)*0.7 +
                 (t.quotes.USD.volume_24h/maxVl)*0.3
      }))
      .sort((a,b)=>b.preScore-a.preScore)
      .slice(0,300);

    /* 3. Enrichissement IA */
    const enriched=[];
    for(let i=0;i<cand.length && enriched.length<50;i++){
      const c=cand[i], sym=c.symbol;
      debug(`▶️ ${sym} (${i+1}/300)`);

      // 3-a News (hot → trending)
      let newsRes=await safeFetch(`${PROXY}news?q=${encodeURIComponent(c.name)}&limit=1`,`News ${sym}`);
      let news   =await safeJson(newsRes,`News ${sym}`);
      if(!news?.articles?.length){
        const alt=newsRes?.url?.replace('filter=hot','filter=trending')||'';
        news=await safeJson(await safeFetch(alt,`News ${sym} FB`),`News ${sym} FB`);
      }

      /* 3-b RSI ---------------------------------------------------------- */
      let rsi=0;
      try{
        const rsiJson=await safeJson(
          await safeFetch(`${PROXY}cryptocompare/rsi?fsym=${sym}&tsym=USD&timePeriod=14`,'RSI'),
          'RSI');
        if(rsiJson?.Type==='ok' && rsiJson?.Data?.Data?.length){
          rsi = rsiJson.Data.Data[0].value;
        }else{
          debug(`⚠️ RSI vide ${sym}: ${rsiJson?.Message||'format'}`);
        }
      }catch(e){ debug(`⚠️ RSI ex ${sym}: ${e.message}`); }

      /* 3-c MACD --------------------------------------------------------- */
      let macd=0, signal=0;
      try{
        const macdJson=await safeJson(
          await safeFetch(`${PROXY}cryptocompare/macd?fsym=${sym}&tsym=USD&fastPeriod=12&slowPeriod=26&signalPeriod=9`,'MACD'),
          'MACD');
        if(macdJson?.Type==='ok' && macdJson?.Data?.Data?.length){
          const p=macdJson.Data.Data[0]; macd=p.MACD||0; signal=p.Signal||0;
        }else{
          debug(`⚠️ MACD vide ${sym}: ${macdJson?.Message||'format'}`);
        }
      }catch(e){ debug(`⚠️ MACD ex ${sym}: ${e.message}`); }

      /* 3-d Events & on-chain ------------------------------------------- */
      const [evtRes,onRes]=await Promise.all([
        safeFetch(`${PROXY}events?coins=${sym}`,'Events'),
        safeFetch(`${PROXY}onchain?symbol=${sym}`,'Onchain')
      ]);
      const evt=await safeJson(evtRes,'Events');
      const on =await safeJson(onRes ,'Onchain');

      /* 3-e Boosts et forecast ------------------------------------------ */
      const boosts=[
        news?.articles?.length ? 1.2 : 1,
        (rsi<30 && macd>signal) ? 1.2 : 1,
        (evt?.body?.length>0) ? 1.2 : 1,
        ((on?.data?.value||0) > 500) ? 1.2 : 1
      ];
      const conf = boosts.filter(b=>b>1).length;      // 0-4 signaux
      if(conf===0) continue;                          // saute si aucun signal

      const rawPct = c.quotes.USD.percent_change_24h || 0;
      const fcst   = rawPct * boosts.reduce((a,b)=>a*b,1) * 7;
      if(fcst < 0) continue;                          // on veut des hausses

      const art=news?.articles?.[0]||{};
      enriched.push({
        name:sym,
        forecast:fcst.toFixed(1),
        conf:`${conf} / 4`,
        hl:art.title||'Pas d’actualité',
        dt:art.published_at?` (${new Date(art.published_at).toLocaleString('fr-FR')})`:'',
        url:art.url||''
      });
      await sleep(SLEEP_LONG);
    }

    /* 4. Affichage ------------------------------------------------------ */
    ul.innerHTML='';
    enriched.sort((a,b)=>+b.forecast-+a.forecast).forEach(e=>{
      ul.innerHTML += `<li>* ${e.name}: +${e.forecast}% (7j)<br>
        Confiance IA : ${e.conf}<br>
        ${e.hl}${e.dt}<br>
        ${e.url?`<a href=\"${e.url}\" target=\"_blank\">Lien</a>`:''}</li>`;
    });
    debug(`✅ Enrichies : ${enriched.length}`);
  }finally{
    isFetchingOpportunities = false;
  }
                                 }
// === Bloc 5 : Dashboard & UI =============================================
async function refreshAll(){
  const tA=document.getElementById('tableAction'),
        tC=document.getElementById('tableCrypto'),
        adv=document.getElementById('adviceList'),
        perf=document.getElementById('globalPerf');
  if(!(tA&&tC&&adv&&perf)){ console.error('DOM missing'); return; }

  tA.innerHTML=tC.innerHTML=adv.innerHTML='';
  let inv=0,val=0;

  for(const a of portfolio){
    const info=a.type==='crypto' ? await fetchCrypto(a.sym,a.curr)
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
  perf.textContent=`Performance globale : ${totGain.toFixed(2)} CAD (${totPct} %)`;
  perf.style.color=totGain>=0?'green':'red';

  await fetchOpportunities();
}

// Init + bouton « Rafraîchir opportunités IA »
window.onload=refreshAll;
document.getElementById('refreshBtn')?.addEventListener('click',async()=>{
  const btn=document.getElementById('refreshBtn'); if(!btn) return;
  btn.disabled=true; debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(()=>{ btn.disabled=false; debug('✅ Bouton réactivé'); },BUTTON_COOLDOWN);
});

// === FIN SCRIPT ==========================================================
