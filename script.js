// script.js avec barre de progression IA pendant l'enrichissement des opportunités

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const STABLES = ["BTC", "ETH", "USDT", "USDC", "DAI", "TUSD", "BNB", "XRP", "BCH", "LTC"];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    const symbolPair = sym.toUpperCase() + 'USDT';
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbolPair}`);
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

async function getCachedPaprikaData() {
  const cacheKey = 'coinpaprika_cache';
  const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
  const now = Date.now();
  const maxAge = 6 * 60 * 60 * 1000;
  if (cache.timestamp && now - cache.timestamp < maxAge && cache.data) return cache.data;
  try {
    const res = await fetch(`${PROXY}coinpaprika`);
    const data = await res.json();
    localStorage.setItem(cacheKey, JSON.stringify({ timestamp: now, data }));
    return data;
  } catch (e) {
    return cache.data || [];
  }
}

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '<li>Analyse IA des cryptos à fort potentiel sur 30 jours...</li>';

  const progress = document.createElement("progress");
  progress.max = 30;
  progress.value = 0;
  progress.style.width = "100%";
  progress.style.height = "10px";
  ul.appendChild(progress);

  try {
    const all = (await getCachedPaprikaData()).slice(0, 1000);
    const candidates = [];

    for (const t of all) {
      const sym = t.symbol.toUpperCase();
      if (STABLES.includes(sym)) continue;
      const change = t.quotes?.USD?.percent_change_24h || 0;
      const vol = t.quotes?.USD?.volume_24h || 0;
      if (change > 10 && vol > 100000 && t.rank <= 1000) {
        try {
          const mres = await fetch(`https://api.coinpaprika.com/v1/coins/${t.id}/markets`);
          const markets = await mres.json();
          const found = markets.find(m => m.exchange_name?.toLowerCase().includes('binance') || m.exchange_name?.toLowerCase().includes('ndax'));
          if (found) candidates.push({ ...t, exchange: found.exchange_name });
        } catch {}
      }
      if (candidates.length >= 30) break;
    }

    const enriched = [];
    for (let i = 0; i < candidates.length; i++) {
      progress.value = i + 1;
      const t = candidates[i];
      const sym = t.symbol.toUpperCase();
      const name = t.name.toLowerCase().replace(/\s+/g, '-');

      try {
        let news = {};
        try {
          news = await (await fetch(`${PROXY}news?q=${sym}`)).json();
          if (!news.articles?.length) {
            news = await (await fetch(`${PROXY}news?q=${name}`)).json();
          }
        } catch {
          news = { articles: [] };
        }

        const rsiData = await (await fetch(`${PROXY}rsi?symbol=${sym}`)).json();
        const macdData = await (await fetch(`${PROXY}macd?symbol=${sym}`)).json();
        const events = await (await fetch(`${PROXY}events?coins=${sym}`)).json();
        const onchain = await (await fetch(`${PROXY}onchain?symbol=${t.symbol}`)).json();

        const rsi = rsiData.value;
        const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
        const hasEvent = events?.body?.length > 0;
        const activeAddresses = onchain?.data?.value || 0;

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
          reason: news.articles?.[0]?.title || "Aucune info récente.",
          extra: hasEvent ? `Événement: ${events.body[0].title}` : ""
        });
      } catch (e) {
        console.warn(`Erreur enrichissement pour ${sym}`);
      }
    }

    ul.innerHTML = '';
    if (enriched.length === 0) {
      ul.innerHTML = '<li>Aucune crypto explosive détectée pour le moment.</li>';
      return;
    }

    enriched.sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast)).slice(0, 5).forEach(e => {
      ul.innerHTML += `<li><strong>${e.name}</strong> : ${e.forecast} attendu ${e.horizon}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em><br/>${e.extra}</li>`;
    });
  } catch (err) {
    ul.innerHTML = '<li>Erreur globale lors de l\'analyse IA.</li>';
  }
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
