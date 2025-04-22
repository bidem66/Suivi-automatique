// script.js
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const STABLES = ["BTC","ETH","USDT","USDC","DAI","TUSD","BNB","XRP","BCH","LTC"];

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

function debug(msg) {
  const el = document.getElementById('debugConsole');
  el.innerHTML += `${new Date().toLocaleTimeString()} - ${msg}<br>`;
}

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const data = await res.json();
    const change = data.pc && data.pc !== 0
      ? ((data.c - data.pc) / data.pc) * 100
      : 0;
    return { price: data.c, change, currency: 'USD' };
  } catch (err) {
    debug(`fetchAction ${sym} error: ${err.message}`);
    return null;
  }
}

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
  } catch (err) {
    debug(`fetchCrypto ${sym} error: ${err.message}`);
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
  const key = 'coinpaprika_cache';
  const cache = JSON.parse(localStorage.getItem(key) || '{}');
  const now = Date.now();
  const maxAge = 6 * 60 * 60 * 1000;
  if (cache.timestamp && now - cache.timestamp < maxAge) return cache.data;
  try {
    const res = await fetch(`${PROXY}coinpaprika`);
    const data = await res.json();
    localStorage.setItem(key, JSON.stringify({ timestamp: now, data }));
    return data;
  } catch (err) {
    debug('getCachedPaprikaData error: ' + err.message);
    return cache.data || [];
  }
}

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '<li>Analyse IA des cryptos à fort potentiel sur 30 jours...</li>';
  try {
    const all = (await getCachedPaprikaData()).slice(0, 1000);
    const candidates = [];
    for (const t of all) {
      const sym = t.symbol.toUpperCase();
      if (STABLES.includes(sym)) continue;
      const change = t.quotes?.USD?.percent_change_24h || 0;
      const vol = t.quotes?.USD?.volume_24h || 0;
      if (change > 10 && vol > 100000 && t.rank <= 1000) candidates.push(t);
    }
    const enriched = [];
    for (let t of candidates) {
      const sym = t.symbol.toUpperCase();
      debug(`IA analyse start for ${sym}`);
      try {
        const [newsRes, rsiRes, macdRes, eventRes, onchainRes] = await Promise.all([
          fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`),
          fetch(`${PROXY}rsi?symbol=${sym}`),
          fetch(`${PROXY}macd?symbol=${sym}`),
          fetch(`${PROXY}events?coins=${sym}`),
          fetch(`${PROXY}onchain?symbol=${sym}`)
        ]);
        const news = await newsRes.json();
        const rsi = (await rsiRes.json()).value;
        const macdData = await macdRes.json();
        const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
        const events = await eventRes.json();
        const onchain = await onchainRes.json();
        const hasEvent = events?.body?.length > 0;
        const activeAddr = onchain?.data?.value || 0;
        const boosts = [
          news.articles?.length ? 1.2 : 1,
          rsi < 30 && macdSignal > 0 ? 1.2 : 1,
          hasEvent ? 1.2 : 1,
          activeAddr > 1000 ? 1.2 : 1
        ];
        const forecast = t.quotes.USD.percent_change_24h * boosts.reduce((a,b)=>a*b,1);
        if (forecast < 15) { debug(`IA skip ${sym} forecast ${forecast.toFixed(1)}`); continue; }
        enriched.push({ name: sym, forecast: `+${forecast.toFixed(1)}%`, horizon: '30j', reason: news.articles?.[0]?.title || '' });
        debug(`IA keep ${sym} forecast ${forecast.toFixed(1)}`);
      } catch (e) {
        debug(`IA error for ${sym}: ${e.message}`);
      }
    }
    ul.innerHTML = '';
    if (!enriched.length) ul.innerHTML = '<li>Aucune crypto explosive détectée.</li>';
    enriched.sort((a,b)=>parseFloat(b.forecast)-parseFloat(a.forecast)).slice(0,5)
      .forEach(e=> ul.innerHTML += `<li><strong>${e.name}</strong> ${e.forecast} (${e.horizon})<br/><em>${e.reason}</em></li>`);
  } catch (e) {
    debug('fetchOpportunities error: ' + e.message);
    document.getElementById('opportunities').innerHTML = '<li>Erreur IA globale</li>';
  }
}

async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf = document.getElementById("globalPerf");
  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = '';
  let inv = 0, val = 0;
  for (let a of portfolio) {
    const info = a.type === 'crypto' ? await fetchCrypto(a.sym, a.curr) : await fetchAction(a.sym);
    if (!info) { debug(`No info for ${a.sym}`); continue; }
    const value = info.price * a.qty;
    const gain = value - a.inv;
    const change = info.change?.toFixed(2) || '0.00';
    const cls = gain>=0?'gain':'perte';
    const sign = gain>=0?'+':'';
    inv += a.inv; val += value;
    tbodyA.innerHTML += `<tr><td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td><td>${info.price.toFixed(2)}</td><td>${value.toFixed(2)}</td><td class="${cls}">${sign}${change}%</td><td>${info.currency}</td></tr>`;
    advice.innerHTML += `<li><strong>${a.sym}</strong> : ${gain>=20?'Vendre':gain<=-15?'À risque':'Garder'}</li>`;
  }
  const totalGain = val - inv;
  const totalPct = inv?((totalGain/inv*100).toFixed(2)):0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain>=0?'green':'red';
  await fetchOpportunities();
}

window.onload = refreshAll;
