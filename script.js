// script.js

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

// Réinitialise le cache et relance l'analyse IA, avec blocage du bouton
async function resetTickers() {
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true;
  debug('🔄 Bouton désactivé – purge du cache et relance IA');
  localStorage.removeItem('coinpaprika_cache');
  await fetchOpportunities();
  setTimeout(() => {
    btn.disabled = false;
    debug('✅ Bouton réactivé – nouvelle analyse IA possible');
  }, BUTTON_COOLDOWN);
}

// Hook du bouton au chargement
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

async function getCachedPaprikaData() {
  const key = 'coinpaprika_cache';
  const cache = JSON.parse(localStorage.getItem(key) || '{}');
  const now = Date.now();
  const maxAge = 1 * 60 * 60 * 1000; // 1 heure
  if (cache.timestamp && (now - cache.timestamp) < maxAge) {
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
    // 1. Pré-filtre des 1000 tickers
    const tickers = (await getCachedPaprikaData()).slice(0, 1000);
    debug(`Chargés: ${tickers.length} tickers`);
    const candidates = [];
    for (const t of tickers) {
      const sym = t.symbol.toUpperCase();
      const q = t.quotes?.USD || {};
      debug(`Vérification ${sym}: cap=${q.market_cap}, vol=${q.volume_24h}`);
      if (q.market_cap < 5e6) { debug(`⛔ ${sym} cap < 5M`); continue; }
      if (q.volume_24h < 1e6) { debug(`⛔ ${sym} vol < 1M`); continue; }
      // Récup marchés via proxy
      debug(`🔍 Marchés pour ${sym}`);
      let markets = [];
      try {
        const url = `${PROXY}coinpaprika-markets?id=${t.id}`;
        debug(`URL: ${url}`);
        const resM = await fetch(url);
        debug(`HTTP status marchés ${sym}: ${resM.status}`);
        markets = await resM.json();
      } catch (e) {
        debug(`Erreur marchés ${sym}: ${e.message}`);
      }
      await sleep(100);
      if (!Array.isArray(markets)) {
        debug(`📦 Response marchés ${sym}: ${JSON.stringify(markets)}`);
        continue;
      }
      debug(`🔢 Marchés count ${sym}: ${markets.length}`);
      if (!markets.some(m => ['NDAX','Binance','Wealthsimple'].includes(m.exchange_name))) continue;
      const liq = markets.reduce((sum, m) => sum + (m.quote?.USD?.liquidity || 0), 0);
      debug(`💧 Liquidité ${sym}: ${liq}`);
      if (liq < 5e6) { debug(`⛔ ${sym} liquidité < 5M`); continue; }
      debug(`✅ ${sym} retenu`);
      candidates.push(t);
      if (candidates.length >= 50) break;
    }
    debug(`Nombre de candidats: ${candidates.length}`);
    
    // 2. Enrichissement IA en batch de 5
    const enriched = [];
    for (let i = 0; i < candidates.length; i += 5) {
      const batch = candidates.slice(i, i + 5);
      debug(`🔄 Enrichissement batch ${i/5+1}: ${batch.map(x=>x.symbol).join(', ')}`);
      await Promise.all(batch.map(async t => {
        debug(`🚀 IA start ${t.symbol}`);
        try {
          const [newsR, rsiR, macdR, evtR, onchR] = await Promise.all([
            fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`),
            fetch(`${PROXY}rsi?symbol=${t.symbol}`),
            fetch(`${PROXY}macd?symbol=${t.symbol}`),
            fetch(`${PROXY}events?coins=${t.symbol}`),
            fetch(`${PROXY}onchain?symbol=${t.symbol}`)
          ]);
          const news = await newsR.json();
          const rsi = (await rsiR.json()).value;
          const macdData = await macdR.json();
          const signal = macdData.valueMACD - macdData.valueMACDSignal;
          const events = await evtR.json();
          const onch = await onchR.json();

          const boosts = [
            news.articles?.length ? 1.2 : 1,
            (rsi < 30 && signal > 0) ? 1.2 : 1,
            (events.body?.length > 0) ? 1.2 : 1,
            (onch.data?.value || 0) > 500 ? 1.2 : 1
          ];
          const rawPct = t.quotes.USD.percent_change_24h;
          const forecast = rawPct * boosts.reduce((a,b)=>a*b,1);
          const confidence = ((boosts.reduce((a,b)=>a+b,0)/4)*5).toFixed(1);
          if (forecast < 20) { debug(`⏭ skip ${t.symbol}: ${forecast.toFixed(1)}%`); return; }
          enriched.push({ name: t.symbol, forecast: `${forecast.toFixed(1)}%`, confidence, reason: news.articles?.[0]?.title || 'Pas d’actualité' });
          debug(`✅ keep ${t.symbol}: ${forecast.toFixed(1)}%`);
        } catch (e) {
          debug(`❌ error ${t.symbol}: ${e.message}`);
        }
      }));
      await sleep(500);
    }
    debug(`Total enrichies: ${enriched.length}`);

    // 3. Affichage Top 5
    ul.innerHTML = '';
    if (enriched.length === 0) {
      ul.innerHTML = '<li>Aucune opportunité détectée.</li>';
      return;
    }
    enriched
      .sort((a,b)=>parseFloat(b.forecast)-parseFloat(a.forecast))
      .slice(0,5)
      .forEach(e => ul.innerHTML += `<li><strong>${e.name}</strong>: ${e.forecast}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em></li>`);
  } catch (err) {
    debug('fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
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
