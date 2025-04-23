// script.js

// === 1. CONST & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
const SLEEP_SHORT = 300;
const SLEEP_LONG  = 500;

// === 2. OUTILS DE FETCH SÉCURISÉ ===
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
async function safeFetch(url, label) {
  try {
    const res = await fetch(url);
    debug(`${label} HTTP ${res.status}`);
    return res;
  } catch (err) {
    debug(`${label} fetch error: ${err.message}`);
    return null;
  }
}
async function safeJson(res, label) {
  if (!res) return null;
  if (!res.ok) {
    debug(`${label} non-OK status: ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    debug(`${label} JSON parse error: ${err.message}`);
    return null;
  }
}

// === 3. FETCH ACTIONS & CRYPTOS ===
async function fetchExchangeRate() {
  const url = "https://api.exchangerate.host/latest?base=USD&symbols=CAD";
  const res = await safeFetch(url, 'ExchangeRate');
  const j   = await safeJson(res, 'ExchangeRate');
  return j?.rates?.CAD || 1.35;
}

async function fetchAction(sym) {
  const url = `${PROXY}finnhub?symbol=${sym.toUpperCase()}`;
  const res = await safeFetch(url, 'Finnhub');
  const d   = await safeJson(res, 'Finnhub');
  if (!d) return null;
  const change = d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0;
  return { price: d.c, change, currency: 'USD' };
}

async function fetchCrypto(sym, curr) {
  const url = `${PROXY}binance?symbol=${sym.toUpperCase()}USDT`;
  const res = await safeFetch(url, 'Binance');
  const d   = await safeJson(res, 'Binance');
  if (!d) return null;
  const price  = parseFloat(d.lastPrice);
  const change = parseFloat(d.priceChangePercent);
  if (curr === 'CAD') {
    const rate = await fetchExchangeRate();
    return { price: price * rate, change, currency: 'CAD' };
  }
  return { price, change, currency: 'USD' };
}

// === 4. PRÉ-SÉLECTION (1000 tickers) ===
async function fetchGeckoTickers(perPage = 100, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url =
      `${PROXY}coingecko?endpoint=coins/markets` +
      `&vs_currency=usd&order=market_cap_desc` +
      `&per_page=${perPage}&page=${p}` +
      `&sparkline=false&price_change_percentage=24h`;
    const res = await safeFetch(url, `Gecko page ${p}`);
    const arr = await safeJson(res, `Gecko page ${p}`);
    if (!Array.isArray(arr)) break;
    all.push(...arr);
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList() {
  const results = [];

  // 4.1 – CoinPaprika (top 1000)
  {
    const res = await safeFetch(`${PROXY}coinpaprika`, 'CoinPaprika');
    const d1  = await safeJson(res, 'CoinPaprika');
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 1000));
      debug(`✅ CoinPaprika: ${results.length} tickers`);
    } else {
      debug('⚠️ CoinPaprika returned non-array');
    }
  }

  // 4.2 – Compléter jusqu’à 1000 avec Gecko
  const need = 1000 - results.length;
  if (need > 0) {
    const pages = Math.ceil(need / 100);
    const geo   = await fetchGeckoTickers(100, pages);
    const slice = geo.slice(0, need);
    const fmt   = slice.map(d => ({
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
    debug(`✅ CoinGecko: ${fmt.length} tickers (pages 1–${pages})`);
  }

  debug(`🔄 Total combiné pour préfiltrage: ${results.length}`);
  return results;
}

// === 5. ENRICHISSEMENT IA (50 tickers max) ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  // **AJOUTÉ** : log du total brut
  const all     = await getTickerList();
  debug(`🔄 Total combiné pour préfiltrage : ${all.length}`);

  // 5.1 – filtres
  const tickers = all.filter(t => {
    const u    = t.quotes.USD;
    const born = t.started_at ? new Date(t.started_at).getTime() : 0;
    const oneY = Date.now() - 365*24*60*60*1000;
    const ban  = ['elon','cum','baby','moon','trump'];
    return u.market_cap   >= 5e6 &&
           u.volume_24h   >= 1e6 &&
           born           < oneY &&
           t.rank          < 500 &&
           !t.id.includes('testnet') &&
           !ban.some(w => t.name.toLowerCase().includes(w));
  });

  // **AJOUTÉ** : log du nombre après filtres
  debug(`🔍 Cryptos retenues après filtres : ${tickers.length}`);

  // 5.2 – enrichissement séquentiel des 50 premiers
  const enriched = [];
  for (let i = 0; i < tickers.length && enriched.length < 50; i++) {
    const t   = tickers[i];
    const sym = t.symbol;

    // on espace chaque appel pour éviter le throttling
    let news, rsi, macdData, evt, onch;
    try {
      let res;

      res  = await safeFetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`, 'News');
      news = await safeJson(res, 'News');
      await sleep(200);

      res  = await safeFetch(`${PROXY}rsi?symbol=${sym}`, 'RSI');
      const rsiObj = await safeJson(res, 'RSI');
      rsi  = rsiObj?.value;
      await sleep(200);

      res       = await safeFetch(`${PROXY}macd?symbol=${sym}`, 'MACD');
      macdData  = await safeJson(res, 'MACD');
      await sleep(200);

      res  = await safeFetch(`${PROXY}events?coins=${sym}`, 'Events');
      evt  = await safeJson(res, 'Events');
      await sleep(200);

      res   = await safeFetch(`${PROXY}onchain?symbol=${sym}`, 'Onchain');
      onch  = await safeJson(res, 'Onchain');
    } catch (err) {
      debug(`❌ fetch IA loop ${sym}: ${err.message}`);
      continue;
    }

    // calcul des boosts
    const sig    = macdData?.valueMACDSignal ?? 0;
    const val    = macdData?.valueMACD       ?? 0;
    const boosts = [
      news?.articles?.length            ? 1.2 : 1,
      (rsi < 30 && val > sig)           ? 1.2 : 1,
      (evt?.body?.length > 0)           ? 1.2 : 1,
      ((onch?.data?.value||0) > 500)    ? 1.2 : 1
    ];

    const raw      = t.quotes.USD.percent_change_24h || 0;
    const forecast = raw * boosts.reduce((a,b)=>a*b,1);
    const confidence = ((boosts.reduce((a,b)=>a+b,0)/4)*10).toFixed(1);

    if (forecast >= 20) {
      enriched.push({
        name: sym,
        forecast: forecast.toFixed(1),
        confidence,
        reason: news?.articles?.[0]?.title || 'Pas d’actualité'
      });
    }

    await sleep(SLEEP_LONG);
  }

  // 5.3 – affichage du top 5
  ul.innerHTML = '';
  debug(`✅ Total enrichies: ${enriched.length}`);
  enriched
    .sort((a,b)=>parseFloat(b.forecast)-parseFloat(a.forecast))
    .slice(0,5)
    .forEach(e => {
      ul.innerHTML += `
        <li>
          <strong>${e.name}</strong>: ${e.forecast}%<br/>
          Confiance IA: ${e.confidence}/10<br/>
          <em>${e.reason}</em>
        </li>`;
    });
}

// === 6. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll() {
  const tA   = document.getElementById("tableAction"),
        tC   = document.getElementById("tableCrypto"),
        adv  = document.getElementById("adviceList"),
        perf = document.getElementById("globalPerf");
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';
  let inv = 0, val = 0;

  for (const a of portfolio) {
    const info = a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym);
    if (!info) continue;
    const v      = info.price * a.qty;
    const gain   = v - a.inv;
    const change = info.change?.toFixed(2) || '0.00';
    const cls    = gain >= 0 ? 'gain' : 'perte';
    const sign   = gain >= 0 ? '+' : '';
    inv += a.inv; val += v;

    tA.innerHTML += `
      <tr>
        <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td><td>${v.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td><td>${info.currency}</td>`
    ;
    adv.innerHTML += `<li><strong>${a.sym}</strong>: ${
      gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'
    }</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? ((totalGain / inv) * 100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color   = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = refreshAll;
document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(() => {
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
