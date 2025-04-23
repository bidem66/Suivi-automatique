// === 1. CONST & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
const SLEEP_SHORT = 300;
const SLEEP_LONG  = 500;

// client-side rate limiter
const lastCall = { paprika: 0, gecko: 0 };
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
async function rateLimitedFetch(url, apiType) {
  const now = Date.now();
  const minInterval = apiType === 'gecko'
    ? 2000    // 30 calls/min ⇒ ~1 every 2000 ms
    : 100;    // 10 calls/s ⇒ ~1 every 100 ms
  const wait = minInterval - (now - lastCall[apiType]);
  if (wait > 0) await sleep(wait);
  lastCall[apiType] = Date.now();
  return fetch(url);
}

function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
function clearMarketCaches() {
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('market_cache_')) localStorage.removeItem(k);
  });
}

// === 2. APPELS ACTIONS & CRYPTO ===
async function fetchExchangeRate() {
  try {
    const r = await rateLimitedFetch(
      "https://api.exchangerate.host/latest?base=USD&symbols=CAD",
      'paprika'
    );
    const d = await r.json();
    return d.rates?.CAD || 1.35;
  } catch {
    debug('fetchExchangeRate failed, using 1.35');
    return 1.35;
  }
}

async function fetchAction(sym) {
  try {
    const r = await rateLimitedFetch(
      `${PROXY}finnhub?symbol=${sym.toUpperCase()}`,
      'paprika'
    );
    const d = await r.json();
    const change = d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0;
    return { price: d.c, change, currency: 'USD' };
  } catch {
    debug(`fetchAction error for ${sym}`);
    return null;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const pair = sym.toUpperCase() + 'USDT';
    const r = await rateLimitedFetch(
      `${PROXY}binance?symbol=${pair}`,
      'paprika'
    );
    const d = await r.json();
    const price  = parseFloat(d.lastPrice);
    const change = parseFloat(d.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: price * rate, change, currency: 'CAD' };
    }
    return { price, change, currency: 'USD' };
  } catch {
    debug(`fetchCrypto error for ${sym}`);
    return null;
  }
}
// === 3. PRÉ-SÉLECTION – ratio 10:1 (Paprika:Gecko) ===
async function fetchGeckoTickers(perPage = 100, pages = 1) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const r = await rateLimitedFetch(
      `${PROXY}coingecko?endpoint=coins/markets` +
      `&vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}` +
      `&sparkline=false&price_change_percentage=24h`,
      'gecko'
    );
    const arr = await r.json();
    if (!Array.isArray(arr)) break;
    all.push(...arr);
    await sleep(SLEEP_SHORT);
  }
  return all.slice(0, perPage * pages);
}

async function getTickerList() {
  const results = [];

  // ––– 1 appel CoinPaprika pour 500 tickers
  try {
    const r1 = await rateLimitedFetch(`${PROXY}coinpaprika`, 'paprika');
    const d1 = await r1.json();
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 500));
      debug(`✅ CoinPaprika : ${d1.length} tickers (top 500)`);
    } else {
      debug('⚠️ CoinPaprika non-array');
    }
  } catch (e) {
    debug('⚠️ CoinPaprika failed: ' + e.message);
  }

  // ––– 1 appel Gecko pour 100 tickers
  try {
    const geckoArr = await fetchGeckoTickers(100, 1);
    const fmt = geckoArr.map(d => ({
      id: d.id,
      symbol: d.symbol.toUpperCase(),
      name: d.name,
      quotes: { USD: {
        market_cap: d.market_cap,
        volume_24h: d.total_volume,
        percent_change_24h: d.price_change_percentage_24h
      }},
      started_at: d.genesis_date,
      rank: d.market_cap_rank
    }));
    results.push(...fmt);
    debug(`✅ CoinGecko : ${fmt.length} tickers (page 1)`);
  } catch (e) {
    debug('⚠️ CoinGecko failed: ' + e.message);
  }

  debug(`🔄 Total combiné pour préfiltrage : ${results.length}`);
  return results;
}

// === 4. VALIDATION DES MARCHÉS – ratio 10:1 ===
// Génère un tableau de 10 "paprika" suivis d'1 "gecko"
const marketApis = Array(10).fill('paprika').concat('gecko');
let marketApiIndex = 0;

async function fetchMarkets(id, symbol) {
  const key = `market_cache_${id}`;
  const c   = JSON.parse(localStorage.getItem(key) || '{}');
  const now = Date.now();
  if (c.timestamp && now - c.timestamp < 3600000) return c.data;

  const api = marketApis[marketApiIndex % marketApis.length];
  marketApiIndex++;
  await sleep(SLEEP_SHORT);

  try {
    let json;
    if (api === 'paprika') {
      const r = await rateLimitedFetch(
        `${PROXY}coinpaprika-markets?id=${id}`,
        'paprika'
      );
      json = await r.json();
    } else {
      const r = await rateLimitedFetch(
        `${PROXY}coingecko?endpoint=coins/${encodeURIComponent(id)}/tickers`,
        'gecko'
      );
      json = await r.json();
    }

    // normalisation en tableau
    let arr = Array.isArray(json)
      ? json
      : Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.tickers)
          ? json.tickers
          : null;

    if (!arr) {
      debug(`⚠️ fetchMarkets ${symbol}: format inattendu`);
      return { isValid: false, liquidity: 0, exchanges: [] };
    }

    const exchanges = api === 'paprika'
      ? arr.map(m => m.exchange_name)
      : arr.map(t => t.market.name);
    const liquidity = api === 'paprika'
      ? arr.reduce((s,m)=>s+(m.quote?.USD?.liquidity||0),0)
      : 0;
    const valid = exchanges.some(e =>
      ['NDAX','Binance','Wealthsimple'].includes(e)
    ) && (api==='gecko' || liquidity >= 5e6);

    const res = { isValid: valid, liquidity, exchanges };
    localStorage.setItem(key, JSON.stringify({ timestamp: now, data: res }));
    return res;

  } catch (err) {
    debug(`❌ fetchMarkets error for ${symbol} via ${api}: ${err.message}`);
    return { isValid:false, liquidity:0, exchanges:[] };
  }
}

// === 5. ENRICHISSEMENT IA ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  try {
    const all     = await getTickerList();
    const tickers = all.filter(t => {
      const u = t.quotes.USD;
      const age = t.started_at ? new Date(t.started_at).getTime() : 0;
      const oneY = Date.now() - 365*24*60*60*1000;
      const ban  = ['elon','cum','baby','moon','trump'];
      return u.market_cap >= 5e6 &&
             u.volume_24h >= 1e6 &&
             age < oneY &&
             t.rank < 500 &&
             !t.id.includes('testnet') &&
             !ban.some(w => t.name.toLowerCase().includes(w));
    });

    const enriched = [];
    for (let i=0; i<tickers.length && enriched.length<50; i++) {
      const t   = tickers[i], sym = t.symbol;
      try {
        const mk = await fetchMarkets(t.id, sym);
        if (!mk.isValid) {
          debug(`⏭ ${sym} exclu – marché non valide`);
          continue;
        }
        const [newsR,rsiR,macdR,evtR,onR,socR] = await Promise.all([
          rateLimitedFetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`, 'paprika'),
          rateLimitedFetch(`${PROXY}rsi?symbol=${sym}`, 'paprika'),
          rateLimitedFetch(`${PROXY}macd?symbol=${sym}`, 'paprika'),
          rateLimitedFetch(`${PROXY}events?coins=${sym}`, 'paprika'),
          rateLimitedFetch(`${PROXY}onchain?symbol=${sym}`, 'paprika'),
          rateLimitedFetch(`${PROXY}community?symbol=${sym}`, 'paprika')
        ]);
        const news    = await newsR.json();
        const rsi     = (await rsiR.json()).value;
        const macdJ   = await macdR.json();
        const evt     = await evtR.json();
        const onch    = await onR.json();
        const soc     = await socR.json();
        const macdSig = macdJ.valueMACDSignal;
        const macdVal = macdJ.valueMACD;

        const boosts = [
          news.articles?.length       ? 1.2 : 1,
          (rsi<30 && macdVal>macdSig) ? 1.2 : 1,
          evt.body?.length > 0        ? 1.2 : 1,
          (onch.data?.value||0) > 500 ? 1.2 : 1,
          soc.score > 70              ? 1.2 : 1
        ];

        const raw      = t.quotes.USD.percent_change_24h || 0;
        const forecast = raw * boosts.reduce((a,b)=>a*b,1);
        const conf     = ((boosts.reduce((a,b)=>a+b,0)/5)*5).toFixed(1);
        if (forecast < 20) continue;

        enriched.push({
          name: sym,
          forecast: forecast.toFixed(1),
          confidence: conf,
          reason: news.articles?.[0]?.title || 'Pas d’actualité'
        });

      } catch (e) {
        debug(`❌ enrich ${sym}: ${e.message}`);
      }
      await sleep(SLEEP_LONG);
    }

    ul.innerHTML = '';
    debug(`✅ Total enrichies : ${enriched.length}`);
    enriched.sort((a,b)=>b.forecast-a.forecast)
      .slice(0,5)
      .forEach(e => {
        ul.innerHTML +=
          `<li><strong>${e.name}</strong>: ${e.forecast}%<br/>` +
          `Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`;
      });

  } catch(err) {
    debug('❌ fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
  }
}

// === 6. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll() {
  const tA  = document.getElementById("tableAction"),
        tC  = document.getElementById("tableCrypto"),
        adv = document.getElementById("adviceList"),
        perf= document.getElementById("globalPerf");
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';
  let inv=0, val=0;
  for (const a of portfolio) {
    const info = a.type==='crypto'
      ? await fetchCrypto(a.sym,a.curr)
      : await fetchAction(a.sym);
    if (!info) continue;
    const v    = info.price*a.qty,
          g    = v - a.inv,
          ch   = info.change.toFixed(2),
          cls  = g>=0?'gain':'perte',
          sign = g>=0?'+':'';
    inv+=a.inv; val+=v;
    tA.innerHTML +=
      `<tr><td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>`+
      `<td>${info.price.toFixed(2)}</td><td>${v.toFixed(2)}</td>`+
      `<td class="${cls}">${sign}${ch}%</td><td>${info.currency}</td></tr>`;
    adv.innerHTML += `<li><strong>${a.sym}</strong>: ${
      g>=20?'Vendre':g<=-15?'À risque':'Garder'
    }</li>`;
  }
  const totalGain = val-inv,
        totalPct  = inv?((totalGain/inv)*100).toFixed(2):0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain>=0?'green':'red';
  await fetchOpportunities();
}

window.onload = () => refreshAll();
document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  clearMarketCaches();
  await fetchOpportunities();
  setTimeout(() => {
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
