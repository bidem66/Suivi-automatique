// script.js

// === 1. CONSTANTES & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
const SLEEP_SHORT = 300;
const SLEEP_LONG  = 500;

// Ratio d’alternance pour tous les appels Paprika vs Gecko (10:1)
const apiSequence = Array(10).fill('paprika').concat('gecko');
let apiSeqIndex = 0;

// === 2. RATE LIMITER CLIENT-SIDE ===
const lastCall = { paprika: 0, gecko: 0 };
const minInterval = { paprika: 100, gecko: 2000 }; // ms

async function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function rateLimitedFetch(url, apiType) {
  const now = Date.now();
  const wait = minInterval[apiType] - (now - lastCall[apiType]);
  if (wait > 0) await sleep(wait);
  lastCall[apiType] = Date.now();
  return fetch(url);
}

function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}

// === 3. FETCH ACTIONS & CRYPTOS ===
async function fetchExchangeRate() {
  try {
    const r = await rateLimitedFetch(
      "https://api.exchangerate.host/latest?base=USD&symbols=CAD",
      'paprika'
    );
    const j = await r.json();
    return j.rates?.CAD || 1.35;
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

// === 4. PRÉ-SÉLECTION DES TICKERS (1000) ===
async function fetchGeckoTickers(perPage = 100, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url =
      `${PROXY}coingecko?endpoint=coins/markets` +
      `&vs_currency=usd&order=market_cap_desc` +
      `&per_page=${perPage}&page=${p}` +
      `&sparkline=false&price_change_percentage=24h`;
    try {
      const r = await rateLimitedFetch(url, 'gecko');
      debug(`🌐 Gecko page ${p} HTTP ${r.status}`);
      const arr = await r.json();
      if (!Array.isArray(arr)) {
        debug(`⚠️ Gecko page ${p} non-array`);
        break;
      }
      all.push(...arr);
    } catch (e) {
      debug(`❌ Gecko page ${p} fetch error: ${e.message}`);
      break;
    }
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList() {
  const results = [];

  // 4.1 – 1 appel CoinPaprika → 500 tickers
  try {
    const r1 = await rateLimitedFetch(`${PROXY}coinpaprika`, 'paprika');
    debug(`🌐 Paprika tickers HTTP ${r1.status}`);
    const d1 = await r1.json();
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 500));
      debug(`✅ Paprika : ${results.length} tickers`);
    } else {
      debug('⚠️ Paprika returned non-array');
    }
  } catch (e) {
    debug('⚠️ Paprika failed: ' + e.message);
  }

  // 4.2 – 5 appels Gecko → 500 tickers
  try {
    const geckoArr = await fetchGeckoTickers(100, 5);
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
    results.push(...fmt.slice(0, 500));
    debug(`✅ Gecko : ${fmt.length} tickers`);
  } catch (e) {
    debug('⚠️ Gecko failed: ' + e.message);
  }

  debug(`🔄 Total tickers combinés : ${results.length}`);
  return results;
}

// === 5. VALIDATION DES MARCHÉS ===
async function fetchMarkets(id, symbol) {
  const key = `market_cache_${id}`;
  const c   = JSON.parse(localStorage.getItem(key) || '{}');
  const now = Date.now();
  if (c.timestamp && now - c.timestamp < 3600000) return c.data;

  const apiType = apiSequence[apiSeqIndex % apiSequence.length];
  apiSeqIndex++;
  await sleep(SLEEP_SHORT);

  let url;
  if (apiType === 'paprika') {
    url = `${PROXY}coinpaprika-markets?id=${id}`;
  } else {
    url = `${PROXY}coingecko?endpoint=coins/${encodeURIComponent(id)}/tickers`;
  }

  try {
    const r = await rateLimitedFetch(url, apiType);
    debug(`🌐 fetchMarkets ${symbol} via ${apiType} HTTP ${r.status}`);
    const json = await r.json();
    let arr = Array.isArray(json) ? json
      : Array.isArray(json.data)     ? json.data
      : Array.isArray(json.tickers)  ? json.tickers
      : null;
    if (!arr) {
      debug(`⚠️ fetchMarkets ${symbol}: format inattendu`);
      return { isValid: false, liquidity: 0, exchanges: [] };
    }
    const exchanges = apiType === 'paprika'
      ? arr.map(m => m.exchange_name)
      : arr.map(t => t.market.name);
    const liquidity = apiType === 'paprika'
      ? arr.reduce((s,m) => s + (m.quote?.USD?.liquidity||0), 0)
      : 0;
    const isValid = exchanges.some(e =>
      ['NDAX','Binance','Wealthsimple'].includes(e)
    ) && (apiType==='gecko' || liquidity >= 5e6);
    const res = { isValid, liquidity, exchanges };
    localStorage.setItem(key, JSON.stringify({ timestamp: now, data: res }));
    return res;
  } catch (err) {
    debug(`❌ fetchMarkets error ${symbol} via ${apiType}: ${err.message}`);
    return { isValid: false, liquidity: 0, exchanges: [] };
  }
}

// === 6. ENRICHISSEMENT IA ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  const all = await getTickerList();
  const filtered = all.filter(t => {
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
  for (let t of filtered) {
    if (enriched.length >= 50) break;
    const sym = t.symbol;
    const mInfo = await fetchMarkets(t.id, sym);
    if (!mInfo.isValid) {
      debug(`⏭ ${sym} exclu – marché non valide`);
      continue;
    }
    try {
      const [newsR, rsiR, macdR, evtR, onR, socR] = await Promise.all([
        fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`),
        fetch(`${PROXY}rsi?symbol=${sym}`),
        fetch(`${PROXY}macd?symbol=${sym}`),
        fetch(`${PROXY}events?coins=${sym}`),
        fetch(`${PROXY}onchain?symbol=${sym}`),
        fetch(`${PROXY}community?symbol=${sym}`)
      ]);
      const news     = await newsR.json();
      const rsi      = (await rsiR.json()).value;
      const macdJ    = await macdR.json();
      const evt      = await evtR.json();
      const onch     = await onR.json();
      const soc      = await socR.json();
      const macdSig  = macdJ.valueMACDSignal;
      const macdVal  = macdJ.valueMACD;
      const boosts   = [
        news.articles?.length           ? 1.2 : 1,
        (rsi < 30 && macdVal > macdSig) ? 1.2 : 1,
        (evt.body?.length > 0)          ? 1.2 : 1,
        ((onch.data?.value||0) > 500)    ? 1.2 : 1,
        (soc.score > 70)                ? 1.2 : 1
      ];
      const raw      = t.quotes.USD.percent_change_24h || 0;
      const forecast = raw * boosts.reduce((a,b)=>a*b,1);
      const confidence = ((boosts.reduce((a,b)=>a+b,0)/5)*5).toFixed(1);
      if (forecast < 20) continue;
      enriched.push({
        name: sym,
        forecast: forecast.toFixed(1),
        confidence,
        reason: news.articles?.[0]?.title || 'Pas d’actualité'
      });
    } catch (e) {
      debug(`❌ enrichissement ${sym}: ${e.message}`);
    }
    await sleep(SLEEP_LONG);
  }

  ul.innerHTML = '';
  debug(`✅ Total enrichies : ${enriched.length}`);
  enriched
    .sort((a,b)=>parseFloat(b.forecast)-parseFloat(a.forecast))
    .slice(0,5)
    .forEach(e=>{
      ul.innerHTML +=
        `<li><strong>${e.name}</strong>: ${e.forecast}%<br/>`+
        `Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`;
    });
}

// === 7. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll() {
  const tA  = document.getElementById("tableAction"),
        tC  = document.getElementById("tableCrypto"),
        adv = document.getElementById("adviceList"),
        perf= document.getElementById("globalPerf");
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';
  let inv = 0, val = 0;

  for (const a of portfolio) {
    const info = a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym);
    if (!info) continue;
    const value = info.price * a.qty;
    const gain  = value - a.inv;
    const change= info.change?.toFixed(2) || '0.00';
    const cls   = gain >= 0 ? 'gain' : 'perte';
    const sign  = gain >= 0 ? '+' : '';
    inv += a.inv; val += value;

    tA.innerHTML += `
      <tr>
        <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td><td>${value.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td><td>${info.currency}</td>
      </tr>`;
    adv.innerHTML += `<li><strong>${a.sym}</strong>: ${
      gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'
    }</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? ((totalGain / inv) * 100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = () => refreshAll();
document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(() => {
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
