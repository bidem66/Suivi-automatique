// script.js

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

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
    const res = await fetch(`${PROXY}exchangerate?base=USD&symbols=CAD`);
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch (err) {
    debug('fetchExchangeRate error: ' + err.message);
    return 1.35;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const symbolPair = sym.toUpperCase() + 'USDT';
    const res = await fetch(`${PROXY}binance?symbol=${symbolPair}`);
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
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos à fort potentiel...</li>';
  try {
    // 1. Pré-filtre (1000 tickers)
    const all = (await getCachedPaprikaData()).slice(0, 1000);
    const candidates = [];
    for (const t of all) {
      const sym = t.symbol.toUpperCase();
      const quotes = t.quotes?.USD || {};
      const mc = quotes.market_cap || 0;
      const vol = quotes.volume_24h || 0;
      const pct = quotes.percent_change_24h || 0;
      if (mc < 50e6 || vol < 20e6 || pct < 10) continue;
      // 2. Vérifier marchés et liquidité
      const markets = await fetch(`${PROXY}coinpaprika-markets?id=${t.id}`)
        .then(r => r.json()).catch(() => []);
      await sleep(100);
      const allowedEx = ['NDAX','Binance','Wealthsimple'];
      if (!markets.some(m => allowedEx.includes(m.exchange_name))) continue;
      const liq = markets.reduce((s, m) => s + (m.quote?.USD?.liquidity || 0), 0);
      if (liq < 5e6) continue;
      candidates.push(t);
      if (candidates.length >= 50) break;
    }
    
    // 3. Enrichissement IA en batchs de 5
    const enriched = [];
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5);
      await Promise.all(batch.map(async t => {
        debug(`IA start ${t.symbol}`);
        try {
          const [newsRes, rsiRes, macdRes, eventRes, onchainRes] = await Promise.all([
            fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`),
            fetch(`${PROXY}rsi?symbol=${t.symbol}`),
            fetch(`${PROXY}macd?symbol=${t.symbol}`),
            fetch(`${PROXY}events?coins=${t.symbol}`),
            fetch(`${PROXY}onchain?symbol=${t.symbol}`)
          ]);
          const news = await newsRes.json();
          const rsi = (await rsiRes.json()).value;
          const macdData = await macdRes.json();
          const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
          const events = await eventRes.json();
          const onchain = await onchainRes.json();
          const sBoost = news.articles?.length ? 1.2 : 1;
          const iBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
          const eBoost = events?.body?.length > 0 ? 1.2 : 1;
          const oBoost = (onchain.data?.value || 0) > 500 ? 1.2 : 1;
          const rawPct = t.quotes.USD.percent_change_24h;
          const forecast = rawPct * sBoost * iBoost * eBoost * oBoost;
          const confidence = ((sBoost + iBoost + eBoost + oBoost)/4 * 5).toFixed(1);
          if (forecast < 20) { debug(`skip ${t.symbol}: ${forecast.toFixed(1)}%`); return; }
          enriched.push({
            name: t.symbol,
            forecast: `${forecast.toFixed(1)}% en 30 jours`,
            confidence,
            reason: news.articles?.[0]?.title || 'Pas d’actualité'
          });
          debug(`keep ${t.symbol}: ${forecast.toFixed(1)}%`);
        } catch (err) {
          debug(`error ${t.symbol}: ${err.message}`);
        }
      }));
      await sleep(500);
    }

    // 4. Affichage Top 5
    ul.innerHTML = '';
    enriched.sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast))
      .slice(0, 5)
      .forEach(e => {
        ul.innerHTML += `
          <li>
            <strong>${e.name}</strong> : ${e.forecast}<br/>
            Confiance IA : ${e.confidence}/10<br/>
            <em>${e.reason}</em>
          </li>`;
      });
  } catch (err) {
    debug('fetchOpportunities error: ' + err.message);
    document.getElementById('opportunities').innerHTML = '<li>Erreur IA</li>';
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
    const info = a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym);
    if (!info) {
      debug(`No info for ${a.sym}`);
      continue;
    }
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
    advice.innerHTML += `<li><strong>${a.sym}</strong> : ${gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'}</li>`;
  }
  const totalGain = val - inv;
  const totalPct = inv ? ((totalGain / inv * 100).toFixed(2)) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain >= 0 ? 'green' : 'red';
  await fetchOpportunities();
}

window.onload = refreshAll;
