// script.js complet avec cache CoinPaprika, debug visuel mobile, enrichissement IA et protections API
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
let cachedPaprika = null;

const STABLES = ["BTC", "ETH", "USDT", "USDC", "DAI", "TUSD", "BNB", "XRP", "BCH", "LTC"];
const WEALTHSIMPLE = ["BTC", "ETH", "SOL", "ADA", "LINK", "AVAX", "DOT", "PEPE", "PYTH", "BONK", "WIF", "DOGE", "MATIC", "XLM"];
const SUSPECT_WORDS = ["fart", "rug", "broccoli", "baby", "shit", "moon", "elon", "doge"];

let paprikaCallTimestamps = [];
let apiTimers = { taapi: [], news: [], events: [], onchain: [] };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackCall(list) {
  const now = Date.now();
  list.push(now);
  return list.filter(t => now - t < 1000);
}

async function safeFetch(api, url) {
  while (apiTimers[api].length >= 5) {
    await sleep(300);
    apiTimers[api] = trackCall(apiTimers[api]);
  }
  try {
    apiTimers[api] = trackCall(apiTimers[api]);
    return await fetch(url);
  } catch {
    return { json: async () => ({}) };
  }
}

async function safePaprikaFetch(url) {
  while (paprikaCallTimestamps.length >= 9) {
    await sleep(300);
    paprikaCallTimestamps = trackCall(paprikaCallTimestamps);
  }
  try {
    paprikaCallTimestamps = trackCall(paprikaCallTimestamps);
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(3000);
      return safePaprikaFetch(url);
    }
    return res;
  } catch {
    return { json: async () => [] };
  }
}

async function fetchExchangeRate() {
  try {
    const res = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch {
    return 1.35;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym.toUpperCase()}USDT`);
    const data = await res.json();
    const usdPrice = parseFloat(data.lastPrice);
    const usdChange = parseFloat(data.priceChangePercent);
    if (curr.toUpperCase() === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: usdPrice * rate, change: usdChange, currency: 'CAD' };
    }
    return { price: usdPrice, change: usdChange, currency: 'USD' };
  } catch {
    return null;
  }
}

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const data = await res.json();
    const change = data.pc && data.pc !== 0 ? ((data.c - data.pc) / data.pc) * 100 : 0;
    return { price: data.c, change, currency: 'USD' };
  } catch {
    return null;
  }
}

function removeAsset() {
  const sym = document.getElementById('removeSymbol').value.trim().toLowerCase();
  portfolio = portfolio.filter(a => a.sym.toLowerCase() !== sym);
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  refreshAll();
}

async function addAsset() {
  const type = document.getElementById('type').value;
  const symInput = document.getElementById('symbol').value.trim();
  const qty = parseFloat(document.getElementById('quantity').value);
  const inv = parseFloat(document.getElementById('invested').value);
  const curr = document.getElementById('devise').value.toUpperCase();
  if (!symInput || !qty || !inv) return alert('Tous les champs sont requis.');
  const sym = symInput.toUpperCase();
  portfolio.push({ type, sym, qty, inv, curr });
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  await refreshAll();
}

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '<li>Analyse IA en cours...</li>';
  const progress = document.createElement("progress");
  progress.style.width = "100%";
  ul.appendChild(progress);

  const debugBox = document.createElement("div");
  debugBox.innerHTML = "<h4>Debug :</h4><div id='debugText' style='white-space:pre-wrap; font-size:12px; background:#222; color:#0f0; padding:10px; max-height:300px; overflow:auto;'></div>";
  ul.appendChild(debugBox);

  setTimeout(() => {
    window.debug = document.getElementById("debugText");
  }, 50);

  let all;
  if (cachedPaprika) {
    window.debug.innerText += "Cache CoinPaprika utilisé\n";
    all = cachedPaprika;
  } else {
    const response = await safePaprikaFetch(`${PROXY}coinpaprika`);
    all = (await response.json()).slice(0, 2000);
    cachedPaprika = all;
  }

  const candidates = [];
  for (const t of all) {
    const sym = t.symbol.toUpperCase();
    const name = (t.name || "").toLowerCase();
    if (STABLES.includes(sym)) continue;
    if (sym.length < 3 || SUSPECT_WORDS.some(word => name.includes(word))) continue;
    const vol = t.quotes?.USD?.volume_24h || 0;
    const change = t.quotes?.USD?.percent_change_24h || 0;
    const ratio = (vol / t.quotes?.USD?.market_cap) || 0;
    if (change < 1 || vol < 200000 || t.rank > 600 || ratio < 0.005) continue;

    try {
      const mres = await safePaprikaFetch(`https://api.coinpaprika.com/v1/coins/${t.id}/markets`);
      const markets = await mres.json();
      const found = markets.find(m => m.exchange_name?.toLowerCase().includes('binance') || m.exchange_name?.toLowerCase().includes('ndax'));
      const isOnWealthsimple = WEALTHSIMPLE.includes(sym);
      if (found || isOnWealthsimple) {
        candidates.push({ ...t, exchange: found?.exchange_name || 'Wealthsimple' });
      }
    } catch (e) {
      window.debug.innerText += `Erreur marché pour ${sym}\n`;
    }
    if (candidates.length >= 100) break;
  }

  progress.max = candidates.length;
  const enriched = [];
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const sym = t.symbol.toUpperCase();
    const name = (t.name || '').toLowerCase().replace(/\s+/g, '-');
    progress.value = i + 1;
    window.debug.innerText += `Analyse ${i + 1} : ${sym}\n`;

    try {
      const [rsiData, macdData, events, onchain, news1, news2] = await Promise.all([
        safeFetch("taapi", `${PROXY}rsi?symbol=${sym}`).then(r => r.json()),
        safeFetch("taapi", `${PROXY}macd?symbol=${sym}`).then(r => r.json()),
        safeFetch("events", `${PROXY}events?coins=${sym}`).then(r => r.json()),
        safeFetch("onchain", `${PROXY}onchain?symbol=${t.symbol}`).then(r => r.json()),
        safeFetch("news", `${PROXY}news?q=${sym}`).then(r => r.json()),
        safeFetch("news", `${PROXY}news?q=${name}`).then(r => r.json())
      ]);

      const news = news1.articles?.length ? news1 : news2;
      const rsi = rsiData.value;
      const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
      const hasEvent = events?.body?.length > 0;
      const activeAddresses = onchain?.data?.value || 0;

      if (rsi > 70 || macdSignal < 0) {
        window.debug.innerText += `Rejeté ${sym} (RSI/MACD)\n`;
        continue;
      }

      const sentimentBoost = news.articles?.length > 0 ? 1.2 : 1;
      const indicatorBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
      const eventBoost = hasEvent ? 1.2 : 1;
      const onchainBoost = activeAddresses > 1000 ? 1.2 : 1;

      const forecast = t.quotes.USD.percent_change_24h * sentimentBoost * indicatorBoost * eventBoost * onchainBoost;
      const confidence = ((sentimentBoost + indicatorBoost + eventBoost + onchainBoost) / 4 * 5).toFixed(1);

      if (forecast < 15) {
        window.debug.innerText += `Rejeté ${sym} (Prévision ${forecast.toFixed(1)}%)\n`;
        continue;
      }

      enriched.push({
        name: sym,
        forecast: `+${forecast.toFixed(1)}%`,
        horizon: "dans les 30 jours",
        confidence,
        platform: t.exchange,
        reason: news.articles?.[0]?.title || "Aucune info récente.",
        extra: hasEvent ? `Événement: ${events.body[0].title}` : ""
      });

      await sleep(1200);
    } catch (e) {
      window.debug.innerText += `Erreur enrichissement ${sym}\n`;
    }
  }

  ul.innerHTML = '';
  if (enriched.length === 0) {
    ul.innerHTML = '<li>Aucune crypto explosive détectée pour le moment.</li>';
    return;
  }

  enriched.sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast)).slice(0, 5).forEach(e => {
    ul.innerHTML += `<li><strong>${e.name}</strong> (${e.platform}) : ${e.forecast} attendu ${e.horizon}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em><br/>${e.extra}</li>`;
  });
}

window.onload = () => {
  refreshAll();
};
