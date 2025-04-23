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
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
function clearMarketCaches() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('market_cache_')) localStorage.removeItem(key);
  });
}

// === 3. APPELS API ===
async function fetchExchangeRate() {
  try {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch { return 1.35; }
}

async function fetchMarkets(id, symbol) {
  const cacheKey = `market_cache_${id}`;
  const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
  const now = Date.now();
  if (cached.timestamp && now - cached.timestamp < 3600000) return cached.data;

  const api = getNextMarketApi();
  await sleep(300); // limiter surcharge API

  try {
    if (api === 'paprika') {
      const res = await fetch(`${PROXY}coinpaprika-markets?id=${id}`);
      if (!res.ok) throw new Error('Paprika failed');
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('data.map is not a function');
      const exchanges = data.map(m => m.exchange_name);
      const liquidity = data.reduce((s, m) => s + (m.quote?.USD?.liquidity || 0), 0);
      const isValid = exchanges.some(e => ['NDAX', 'Binance', 'Wealthsimple'].includes(e)) && liquidity >= 5e6;
      const result = { isValid, liquidity, exchanges };
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data: result }));
      return result;
    } else {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/tickers`);
      if (!res.ok) throw new Error('Gecko failed');
      const data = await res.json();
      if (!Array.isArray(data.tickers)) throw new Error('data.tickers is not a function');
      const exchanges = data.tickers.map(t => t.market.name);
      const isValid = exchanges.some(e => ['NDAX', 'Binance', 'Wealthsimple'].includes(e));
      const result = { isValid, liquidity: 0, exchanges };
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data: result }));
      return result;
    }
  } catch (err) {
    debug(`❌ fetchMarkets error for ${symbol}: ${err.message}`);
    return { isValid: false, liquidity: 0, exchanges: [] };
  }
}

async function getTickerList() {
  const results = [];

  try {
    const res1 = await fetch(`${PROXY}coinpaprika`);
    await sleep(500);
    const data1 = await res1.json();
    if (Array.isArray(data1)) {
      results.push(...data1.slice(0, 500));
      debug(`✅ CoinPaprika : ${data1.length} cryptos (top 500 utilisées)`);
    }
  } catch (err) {
    debug('⚠️ CoinPaprika échoué : ' + err.message);
  }

  try {
    await sleep(500);
    const res2 = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=500&page=1&sparkline=false&price_change_percentage=24h");
    const data2 = await res2.json();
    if (Array.isArray(data2)) {
      const geckoFormatted = data2.map(d => ({
        id: d.id,
        symbol: d.symbol.toUpperCase(),
        name: d.name,
        quotes: {
          USD: {
            market_cap: d.market_cap,
            volume_24h: d.total_volume,
            percent_change_24h: d.price_change_percentage_24h
          }
        },
        started_at: d.genesis_date,
        rank: d.market_cap_rank
      }));
      results.push(...geckoFormatted);
      debug(`✅ CoinGecko : ${data2.length} cryptos (top 500 utilisées)`);
    }
  } catch (e) {
    debug('⚠️ CoinGecko échoué : ' + e.message);
  }

  debug(`🔄 Total combiné pour préfiltrage : ${results.length}`);
  return results;
}
// === 4. ENRICHISSEMENT IA ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  try {
    const all = await getTickerList();
    const tickers = all.filter(t => {
      const usd = t.quotes?.USD || {};
      const started = t.started_at ? new Date(t.started_at).getTime() : 0;
      const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const banned = ['elon', 'cum', 'baby', 'moon', 'trump'];
      return usd.market_cap >= 5e6 && usd.volume_24h >= 1e6 &&
             !banned.some(w => t.name.toLowerCase().includes(w)) &&
             !t.id.includes('testnet') && t.rank < 500 && started < oneYearAgo;
    });

    const enriched = [];
    let i = 0;
    while (i < tickers.length && enriched.length < 50) {
      const t = tickers[i++];
      const sym = t.symbol;
      try {
        const marketInfo = await fetchMarkets(t.id, sym);
        if (!marketInfo.isValid) {
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

        const news = await newsR.json();
        const rsi = (await rsiR.json()).value;
        const macd = await macdR.json();
        const evt = await evtR.json();
        const onch = await onchR.json();
        const soc = await socR.json();

        const boosts = [
          news.articles?.length ? 1.2 : 1,
          (rsi < 30 && (macd.valueMACD - macd.valueMACDSignal) > 0) ? 1.2 : 1,
          evt.body?.length > 0 ? 1.2 : 1,
          (onch.data?.value || 0) > 500 ? 1.2 : 1,
          soc.score > 70 ? 1.2 : 1
        ];

        const raw = t.quotes?.USD?.percent_change_24h || 0;
        const forecast = raw * boosts.reduce((a,b)=>a*b,1);
        const confidence = ((boosts.reduce((a,b)=>a+b,0)/5)*5).toFixed(1);

        if (forecast < 20) continue;
        enriched.push({
          name: sym,
          forecast: forecast.toFixed(1),
          confidence,
          reason: news.articles?.[0]?.title || 'Pas d’actualité'
        });

      } catch (err) {
        debug(`Erreur enrichissement ${sym}: ${err.message}`);
      }

      await sleep(500);
    }

    ul.innerHTML = '';
    debug(`✅ Total enrichies : ${enriched.length}`);
    enriched.sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast))
      .slice(0, 5)
      .forEach(e => {
        ul.innerHTML += `<li><strong>${e.name}</strong>: ${e.forecast}%<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`;
      });

  } catch (err) {
    debug('fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
  }
}

// === 5. FONCTIONS PRINCIPALES ===
async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf = document.getElementById("globalPerf");
  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = '';
  let inv = 0, val = 0;

  for (const a of portfolio) {
    const info = a.type === 'crypto' ? await fetchCrypto(a.sym, a.curr) : await fetchAction(a.sym);
    if (!info) continue;
    const value = info.price * a.qty;
    const gain = value - a.inv;
    const change = info.change?.toFixed(2) || '0.00';
    const cls = gain >= 0 ? 'gain' : 'perte';
    const sign = gain >= 0 ? '+' : '';
    inv += a.inv; val += value;

    tbodyA.innerHTML += `
      <tr>
        <td>${a.sym}</td>
        <td>${a.qty}</td>
        <td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td>
        <td>${value.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td>
        <td>${info.currency}</td>
      </tr>`;
    
    advice.innerHTML += `<li><strong>${a.sym}</strong>: ${gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'}</li>`;
  }

  const totalGain = val - inv;
  const totalPct = inv ? ((totalGain / inv) * 100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

// === 6. ÉVÉNEMENTS ===
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
