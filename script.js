const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

const STABLES = ["BTC", "ETH", "USDT", "USDC", "DAI", "TUSD", "BNB", "XRP", "BCH", "LTC"];
const WEALTHSIMPLE = ["BTC", "ETH", "SOL", "ADA", "LINK", "AVAX", "DOT", "PEPE", "PYTH", "BONK", "WIF", "DOGE", "MATIC", "XLM"];
const SUSPECT_WORDS = ["fart", "rug", "broccoli", "baby", "shit", "moon", "elon", "doge"];

let paprikaCallTimestamps = [];
let apiTimers = { taapi: [], news: [], events: [], onchain: [] };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackApi(api) {
  const now = Date.now();
  apiTimers[api].push(now);
  apiTimers[api] = apiTimers[api].filter(t => now - t < 1000);
}

async function safeFetch(api, url) {
  const maxCalls = 5;
  while (apiTimers[api].length >= maxCalls) {
    await sleep(250);
    const now = Date.now();
    apiTimers[api] = apiTimers[api].filter(t => now - t < 1000);
  }
  try {
    trackApi(api);
    return await fetch(url);
  } catch {
    return { json: async () => ({}) };
  }
}

function trackPaprikaCall() {
  const now = Date.now();
  paprikaCallTimestamps.push(now);
  paprikaCallTimestamps = paprikaCallTimestamps.filter(t => now - t < 1000);
}

async function safePaprikaFetch(url) {
  while (paprikaCallTimestamps.length >= 9) {
    await sleep(200);
    const now = Date.now();
    paprikaCallTimestamps = paprikaCallTimestamps.filter(t => now - t < 1000);
  }
  try {
    trackPaprikaCall();
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
    const pair = sym.toUpperCase() + 'USDT';
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
    const data = await res.json();
    const usd = parseFloat(data.lastPrice);
    const change = parseFloat(data.priceChangePercent);
    if (curr.toUpperCase() === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: usd * rate, change, currency: 'CAD' };
    }
    return { price: usd, change, currency: 'USD' };
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
  progress.max = 100;
  progress.value = 0;
  progress.style.width = "100%";
  progress.style.height = "10px";
  ul.appendChild(progress);

  const listContainer = document.createElement("div");
  listContainer.innerHTML = "<strong>Cryptos analysées :</strong><ul id='analyzedList'></ul>";
  ul.appendChild(listContainer);
  const debugList = document.getElementById("analyzedList");

  let response = await safePaprikaFetch(`${PROXY}coinpaprika`);
  const all = (await response.json()).slice(0, 2000);
  const candidates = [];

  for (const t of all) {
    const sym = t.symbol.toUpperCase();
    const name = t.name?.toLowerCase() || "";
    if (STABLES.includes(sym)) continue;
    if (sym.length < 3 || SUSPECT_WORDS.some(word => name.includes(word))) continue;
    const vol = t.quotes?.USD?.volume_24h || 0;
    const change = t.quotes?.USD?.percent_change_24h || 0;
    const ratio = (vol / t.quotes?.USD?.market_cap) || 0;
    if (change < 2 || vol < 500000 || t.rank > 300 || ratio < 0.01) continue;

    try {
      const mres = await safePaprikaFetch(`https://api.coinpaprika.com/v1/coins/${t.id}/markets`);
      const markets = await mres.json();
      const found = markets.find(m =>
        m.exchange_name?.toLowerCase().includes('binance') ||
        m.exchange_name?.toLowerCase().includes('ndax')
      );
      const isOnWealthsimple = WEALTHSIMPLE.includes(sym);
      if (found || isOnWealthsimple) {
        candidates.push({ ...t, exchange: found?.exchange_name || 'Wealthsimple' });
      }
    } catch {}
    if (candidates.length >= 100) break;
  }

  const enriched = [];
  for (let i = 0; i < candidates.length; i++) {
    const t = candidates[i];
    const sym = t.symbol.toUpperCase();
    const name = t.name.toLowerCase().replace(/\s+/g, '-');

    progress.value = i + 1;
    const item = document.createElement("li");
    item.textContent = sym;
    debugList.appendChild(item);

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

      if (rsi > 70 || macdSignal < 0) continue;

      const sentimentBoost = news.articles?.length > 0 ? 1.2 : 1;
      const indicatorBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
      const eventBoost = hasEvent ? 1.2 : 1;
      const onchainBoost = activeAddresses > 1000 ? 1.2 : 1;

      const forecast = t.quotes.USD.percent_change_24h * sentimentBoost * indicatorBoost * eventBoost * onchainBoost;
      const confidence = ((sentimentBoost + indicatorBoost + eventBoost + onchainBoost) / 4 * 5).toFixed(1);

      if (forecast < 15) continue;

      enriched.push({
        name: sym,
        forecast: `+${forecast.toFixed(1)}%`,
        horizon: "dans les 30 jours",
        confidence,
        platform: t.exchange,
        reason: news.articles?.[0]?.title || "Aucune info récente.",
        extra: hasEvent ? `Événement: ${events.body[0].title}` : ""
      });

      await sleep(800); // protège les API de surcharge
    } catch (e) {
      console.warn(`Erreur enrichissement pour ${sym}`);
    }
  }

  ul.innerHTML = '';
  if (enriched.length === 0) {
    ul.innerHTML = '<li>Aucune crypto explosive détectée pour le moment.</li>';
    return;
  }

  enriched
    .sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast))
    .slice(0, 5)
    .forEach(e => {
      ul.innerHTML += `<li><strong>${e.name}</strong> (${e.platform}) : ${e.forecast} attendu ${e.horizon}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em><br/>${e.extra}</li>`;
    });
}

async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf = document.getElementById("globalPerf");
  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = "";

  let inv = 0, val = 0;
  const enriched = await Promise.all(portfolio.map(async (a) => {
    const info = a.type === 'crypto' ? await fetchCrypto(a.sym, a.curr) : await fetchAction(a.sym);
    return { ...a, info };
  }));

  const sorted = enriched.filter(e => e.info).sort((a, b) => b.info.change - a.info.change);

  for (let a of sorted) {
    const info = a.info;
    const value = info.price * a.qty;
    const gain = value - a.inv;
    const change = info.change?.toFixed(2) || "0.00";
    const gainClass = gain >= 0 ? 'gain' : 'perte';
    const sign = gain >= 0 ? '+' : '-';
    inv += a.inv;
    val += value;
    const row = `<tr>
      <td>${a.sym.toUpperCase()}</td>
      <td>${a.qty}</td>
      <td>${a.inv.toFixed(2)}</td>
      <td>${info.price.toFixed(2)}</td>
      <td>${value.toFixed(2)}</td>
      <td class="${gainClass}">${sign}${Math.abs(change)}%</td>
      <td>${info.currency}</td>
    </tr>`;
    (a.type === 'crypto' ? tbodyC : tbodyA).innerHTML += row;
    advice.innerHTML += `<li><strong>${a.sym.toUpperCase()}</strong> : ${gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'}</li>`;
  }

  const totalGain = val - inv;
  const totalPct = inv ? (totalGain / inv * 100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = () => {
  refreshAll();
};
