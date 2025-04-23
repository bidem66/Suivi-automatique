// === 1. CONST & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
let marketApiIndex = 0;
const marketApis = ['paprika', 'gecko'];

// === 2. OUTILS ===
function getNextMarketApi() {
  const api = marketApis[marketApiIndex % marketApis.length];
  marketApiIndex++;
  return api;
}
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
function clearMarketCaches() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('market_cache_')) localStorage.removeItem(key);
  });
}

// === 3. APPELS API DE BASE ===
async function fetchExchangeRate() {
  try {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch {
    debug('fetchExchangeRate failed, using 1.35');
    return 1.35;
  }
}

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const d = await res.json();
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
    const res = await fetch(`${PROXY}binance?symbol=${pair}`);
    const d = await res.json();
    const usdPrice  = parseFloat(d.lastPrice);
    const usdChange = parseFloat(d.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: usdPrice * rate, change: usdChange, currency: 'CAD' };
    }
    return { price: usdPrice, change: usdChange, currency: 'USD' };
  } catch {
    debug(`fetchCrypto error for ${sym}`);
    return null;
  }
}

// === 4. PRÉ-SÉLECTION AVANCÉE ===
// 4.1. Récupère 500 tickers Gecko en 5 pages
async function fetchGeckoTickers(perPage = 100, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=${p}` +
      `&sparkline=false&price_change_percentage=24h`
    );
    const arr = await res.json();
    if (!Array.isArray(arr)) break;
    all.push(...arr);
    await sleep(300);
  }
  return all.slice(0, perPage * pages);
}

// 4.2. Appelle Paprika OU Gecko pour valider les marchés
async function fetchMarkets(id, symbol) {
  const cacheKey = `market_cache_${id}`;
  const cached  = JSON.parse(localStorage.getItem(cacheKey) || '{}');
  const now     = Date.now();
  if (cached.timestamp && now - cached.timestamp < 3600000) {
    return cached.data;
  }

  const api = getNextMarketApi();
  await sleep(300);

  try {
    let json;
    if (api === 'paprika') {
      const r = await fetch(`${PROXY}coinpaprika-markets?id=${id}`);
      if (!r.ok) throw new Error(`Paprika HTTP ${r.status}`);
      json = await r.json();
    } else {
      const r = await fetch(
        `${PROXY}coingecko?endpoint=coins/${encodeURIComponent(id)}/tickers`
      );
      if (!r.ok) throw new Error(`Gecko HTTP ${r.status}`);
      json = await r.json();
    }

    // normalisation en tableau
    let arr;
    if (Array.isArray(json)) {
      arr = json;
    } else if (Array.isArray(json.data)) {
      arr = json.data;
    } else if (Array.isArray(json.tickers)) {
      arr = json.tickers;
    } else {
      debug(`⚠️ fetchMarkets ${symbol}: format inattendu`);
      return { isValid: false, liquidity: 0, exchanges: [] };
    }

    const exchanges = api === 'paprika'
      ? arr.map(m => m.exchange_name)
      : arr.map(t => t.market.name);
    const liquidity = api === 'paprika'
      ? arr.reduce((s, m) => s + (m.quote?.USD?.liquidity || 0), 0)
      : 0;

    const isValid = exchanges.some(e =>
      ['NDAX', 'Binance', 'Wealthsimple'].includes(e)
    ) && (api === 'gecko' || liquidity >= 5e6);

    const result = { isValid, liquidity, exchanges };
    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data: result }));
    return result;

  } catch (err) {
    debug(`❌ fetchMarkets error for ${symbol} via ${api}: ${err.message}`);
    return { isValid: false, liquidity: 0, exchanges: [] };
  }
}
// === 5. PRÉ-SÉLECTION COMPLÈTE ===
async function getTickerList() {
  const results = [];

  // CoinPaprika (500 tickers)
  try {
    const r1 = await fetch(`${PROXY}coinpaprika`);
    if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
    await sleep(500);
    const d1 = await r1.json();
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 500));
      debug(`✅ CoinPaprika : ${d1.length} tickers (top 500)`);
    } else {
      debug('⚠️ CoinPaprika non-array');
    }
  } catch (e) {
    debug('⚠️ CoinPaprika échoué : ' + e.message);
  }

  // CoinGecko (500 tickers via 5 pages)
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
    results.push(...fmt);
    debug(`✅ CoinGecko : ${fmt.length} tickers (pages 1–5)`);
  } catch (e) {
    debug('⚠️ CoinGecko échoué : ' + e.message);
  }

  debug(`🔄 Total combiné pour préfiltrage : ${results.length}`);
  return results;
}

// === 6. ENRICHISSEMENT IA ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  try {
    const all     = await getTickerList();
    const tickers = all.filter(t => {
      const usd = t.quotes?.USD || {};
      const started    = t.started_at ? new Date(t.started_at).getTime() : 0;
      const oneYearAgo = Date.now() - 365*24*60*60*1000;
      const banned     = ['elon','cum','baby','moon','trump'];
      return usd.market_cap   >= 5e6 &&
             usd.volume_24h   >= 1e6 &&
             started          < oneYearAgo &&
             t.rank           < 500 &&
             !t.id.includes('testnet') &&
             !banned.some(w => t.name.toLowerCase().includes(w));
    });

    const enriched = [];
    for (let i = 0; i < tickers.length && enriched.length < 50; i++) {
      const t   = tickers[i];
      const sym = t.symbol;
      try {
        const mInfo = await fetchMarkets(t.id, sym);
        if (!mInfo.isValid) {
          debug(`⏭ ${sym} exclu – marché non valide`);
          continue;
        }

        const [newsR, rsiR, macdR, evtR, onchR, socR] = await Promise.all([
          fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`),
          fetch(`${PROXY}rsi?symbol=${sym}`),
          fetch(`${PROXY}macd?symbol=${sym}`),
          fetch(`${PROXY}events?coins=${sym}`),
          fetch(`${PROXY}onchain?symbol=${sym}`),
          fetch(`${PROXY}community?symbol=${sym}`)
        ]);

        const news       = await newsR.json();
        const rsi        = (await rsiR.json()).value;
        const macdData   = await macdR.json();
        const evt        = await evtR.json();
        const onch       = await onchR.json();
        const soc        = await socR.json();
        const macdSignal = macdData.valueMACDSignal;
        const macdVal    = macdData.valueMACD;

        const boosts = [
          news.articles?.length                            ? 1.2 : 1,
          (rsi < 30 && (macdVal - macdSignal) > 0)         ? 1.2 : 1,
          evt.body?.length > 0                             ? 1.2 : 1,
          (onch.data?.value || 0) > 500                    ? 1.2 : 1,
          soc.score > 70                                   ? 1.2 : 1
        ];

        const raw      = t.quotes?.USD?.percent_change_24h || 0;
        const forecast = raw * boosts.reduce((a,b) => a*b, 1);
        const confidence = ((boosts.reduce((a,b) => a+b, 0)/5)*5).toFixed(1);

        if (forecast < 20) continue;
        enriched.push({ name: sym, forecast: forecast.toFixed(1), confidence, reason: news.articles?.[0]?.title || 'Pas d’actualité' });

      } catch(err) {
        debug(`❌ Erreur enrichissement ${sym}: ${err.message}`);
      }
      await sleep(500);
    }

    ul.innerHTML = '';
    debug(`✅ Total enrichies : ${enriched.length}`);
    enriched
      .sort((a,b) => parseFloat(b.forecast) - parseFloat(a.forecast))
      .slice(0,5)
      .forEach(e => {
        ul.innerHTML += `<li><strong>${e.name}</strong>: ${e.forecast}%<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`;
      });

  } catch(err) {
    debug('❌ fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
  }
}

// === 7. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf   = document.getElementById("globalPerf");
  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = '';
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

    tbodyA.innerHTML += `
      <tr>
        <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td><td>${value.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td><td>${info.currency}</td>
      </tr>`;
    advice.innerHTML += `<li><strong>${a.sym}</strong>: ${
      gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'
    }</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? ((totalGain/inv)*100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = () => refreshAll();
document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  clearMarketCaches();
  localStorage.removeItem('coinpaprika_cache');
  await fetchOpportunities();
  setTimeout(() => {
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
