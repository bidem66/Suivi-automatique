// script.js complet avec socialBoost intégré et préfiltrage amélioré

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000; // 1 heure

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}

function clearMarketCaches() {
  Object.keys(localStorage).forEach(key => {
    if (key.startsWith('market_cache_')) {
      localStorage.removeItem(key);
    }
  });
}

async function resetTickers() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  debug('🔄 Bouton désactivé – purge des caches et relance IA');
  localStorage.removeItem('coinpaprika_cache');
  clearMarketCaches();
  await fetchOpportunities();
  setTimeout(() => {
    btn.disabled = false;
    debug('✅ Bouton réactivé – nouvelle analyse IA possible');
  }, BUTTON_COOLDOWN);
}

window.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('refreshBtn');
  if (btn) btn.addEventListener('click', resetTickers);
});

async function fetchExchangeRate() {
  try {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch (err) {
    debug('fetchExchangeRate error: ' + err.message);
    return 1.35;
  }
}

async function fetchMarkets(id, symbol) {
  const cacheKey = `market_cache_${id}`;
  const cached = JSON.parse(localStorage.getItem(cacheKey) || '{}');
  const now = Date.now();
  const ttl = 60 * 60 * 1000;
  if (cached.timestamp && now - cached.timestamp < ttl) {
    return cached.data;
  }

  try {
    const res = await fetch(`${PROXY}coinpaprika-markets?id=${id}`);
    if (!res.ok) throw new Error('Paprika failed');
    const data = await res.json();
    const exchanges = data.map(m => m.exchange_name);
    const liquidity = data.reduce((sum, m) => sum + (m.quote?.USD?.liquidity || 0), 0);
    const isValid = data.some(m => ['NDAX', 'Binance', 'Wealthsimple'].includes(m.exchange_name)) && liquidity >= 5e6;
    const result = { isValid, liquidity, exchanges };
    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data: result }));
    return result;
  } catch (err) {
    debug(`Paprika failed for ${symbol}, trying CoinGecko`);
    try {
      const res = await fetch(`https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/tickers`);
      if (!res.ok) throw new Error('Gecko failed');
      const data = await res.json();
      const exchanges = data.tickers.map(t => t.market.name);
      const isValid = exchanges.some(e => ['NDAX', 'Binance', 'Wealthsimple'].includes(e));
      const result = { isValid, liquidity: 0, exchanges };
      localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data: result }));
      return result;
    } catch (err2) {
      debug(`Markets failed for ${symbol}: ${err2.message}`);
      return { isValid: false, liquidity: 0, exchanges: [] };
    }
  }
}

async function getCachedPaprikaData() {
  const key = 'coinpaprika_cache';
  const cache = JSON.parse(localStorage.getItem(key) || '{}');
  const now = Date.now();
  const maxAge = 1 * 60 * 60 * 1000;
  if (cache.timestamp && now - cache.timestamp < maxAge) {
    debug('🔁 Utilisation du cache CoinPaprika');
    return cache.data;
  }
  try {
    debug('🌐 Récupération des tickers CoinPaprika');
    const res = await fetch(`${PROXY}coinpaprika`);
    const data = await res.json();
    localStorage.setItem(key, JSON.stringify({ timestamp: now, data }));
    return data;
  } catch (err) {
    debug('Paprika cache error: ' + err.message);
    return cache.data || [];
  }
}

async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  if (!ul) return;
  ul.innerHTML = '<li>Détection des opportunités IA...</li>';
  debug('--- Début fetchOpportunities ---');

  try {
    const tickers = (await getCachedPaprikaData()).slice(0, 1000).filter(t => {
      const usd = t.quotes?.USD || {};
      const started = t.started_at ? new Date(t.started_at).getTime() : 0;
      const oneYearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
      const bannedWords = ['elon', 'baby', 'moon', 'cum', 'trump', 'fart', 'hawk', 'libra', 'peanut'];
      return (
        usd.market_cap >= 5e6 &&
        usd.volume_24h >= 1e6 &&
        !bannedWords.some(word => t.name.toLowerCase().includes(word)) &&
        !t.id.toLowerCase().includes('testnet') &&
        t.rank && t.rank < 500 &&
        started && started < oneYearAgo
      );
    });

    const enriched = [];
    let i = 0;
    while (i < tickers.length && enriched.length < 50) {
      const t = tickers[i];
      i++;
      const sym = t.symbol;
      const markets = await fetchMarkets(t.id, sym);
      if (!markets.isValid) {
        debug(`⏭ ${sym} exclu – marchés non valides`);
        continue;
      }

      debug(`✅ ${sym} – marchés valides, enrichissement IA`);
      try {
        const [newsR, rsiR, macdR, evtR, onchR, socialR] = await Promise.all([
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
        const events = await evtR.json();
        const onch = await onchR.json();
        const social = await socialR.json();

        const boosts = [
          news.articles?.length ? 1.2 : 1,
          (rsi < 30 && (macd.valueMACD - macd.valueMACDSignal) > 0) ? 1.2 : 1,
          events.body?.length > 0 ? 1.2 : 1,
          (onch.data?.value || 0) > 500 ? 1.2 : 1,
          social.score > 70 ? 1.2 : 1
        ];

        debug(`${sym} social score: ${social.score} → boost ${boosts[4]}`);

        const raw = t.quotes?.USD?.percent_change_24h || 0;
        const forecast = raw * boosts.reduce((a,b)=>a*b,1);
        const confidence = ((boosts.reduce((a,b)=>a+b,0)/5)*5).toFixed(1);
        if (forecast < 20) {
          debug(`⏩ ${sym} forecast trop bas: ${forecast.toFixed(1)}%`);
          continue;
        }
        enriched.push({ name: sym, forecast: forecast.toFixed(1), confidence, reason: news.articles?.[0]?.title || 'Pas d’actualité' });
      } catch (err) {
        debug(`❌ Erreur enrichissement ${sym}: ${err.message}`);
      }
      await sleep(500);
    }

    debug(`✅ Total cryptos enrichies avec marché valide : ${enriched.length}/50`);
    ul.innerHTML = '';
    if (!enriched.length) return ul.innerHTML = '<li>Aucune opportunité détectée.</li>';

    enriched
      .sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast))
      .slice(0, 5)
      .forEach(e => ul.innerHTML += `<li><strong>${e.name}</strong>: ${e.forecast}%<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`);
  } catch (err) {
    debug('fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
  }
}

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const data = await res.json();
    const change = data.pc && data.pc !== 0 ? ((data.c - data.pc) / data.pc) * 100 : 0;
    return { price: data.c, change, currency: 'USD' };
  } catch (err) {
    debug(`fetchAction ${sym} error: ${err.message}`);
    return null;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const pair = `${sym.toUpperCase()}USDT`;
    const res = await fetch(`${PROXY}binance?symbol=${pair}`);
    const data = await res.json();
    const usdPrice = parseFloat(data.lastPrice);
    const usdChange = parseFloat(data.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: usdPrice * rate, change: usdChange, currency: 'CAD' };
    }
    return { price: usdPrice, change: usdChange, currency: 'USD' };
  } catch (err) {
    debug(`fetchCrypto ${sym} error: ${err.message}`);
    return null;
  }
}

async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf = document.getElementById("globalPerf");
  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = '';
  let inv = 0, val = 0;
  for (const a of portfolio) {
    const info = a.type === 'crypto' ? await fetchCrypto(a.sym, a.curr) : await fetchAction(a.sym);
    if (!info) { debug(`No info for ${a.sym}`); continue; }
    const value = info.price * a.qty;
    const gain = value - a.inv;
    const change = info.change?.toFixed(2) || '0.00';
    const cls = gain >= 0 ? 'gain' : 'perte';
    const sign = gain >= 0 ? '+' : '';
    inv += a.inv; val += value;
    tbodyA.innerHTML += `<tr><td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td><td>${info.price.toFixed(2)}</td><td>${value.toFixed(2)}</td><td class="${cls}">${sign}${change}%</td><td>${info.currency}</td></tr>`;
    advice.innerHTML += `<li><strong>${a.sym}</strong>: ${gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'}</li>`;
  }
  const totalGain = val - inv;
  const totalPct = inv ? ((totalGain / inv * 100).toFixed(2)) : 0;
  perf.textContent = `Performance globale: ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';
  await fetchOpportunities();
}

window.onload = refreshAll;
