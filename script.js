// script.js avec affichage des erreurs IA visibles dans le dashboard (mobile friendly)

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

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

  if (cache.timestamp && now - cache.timestamp < maxAge && cache.data) {
    return cache.data;
  }

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
  ul.innerHTML = '<li>Analyse IA en cours sur 500 cryptos...</li>';

  const progressBar = document.createElement('progress');
  progressBar.max = 20;
  progressBar.value = 0;
  ul.appendChild(progressBar);

  const progressText = document.createElement('div');
  progressText.style.marginTop = '10px';
  progressText.textContent = '0 / 20 analysées';
  ul.appendChild(progressText);

  const debugDiv = document.createElement('div');
  debugDiv.style.marginTop = '15px';
  debugDiv.style.fontSize = '0.8rem';
  debugDiv.style.color = 'darkred';
  ul.appendChild(debugDiv);

  try {
    const all = (await getCachedPaprikaData()).slice(0, 500);
    const filtered = all
      .filter(c => c.quotes?.USD?.percent_change_24h)
      .sort((a, b) => b.quotes.USD.percent_change_24h - a.quotes.USD.percent_change_24h)
      .slice(0, 20);

    const enriched = [];

    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      const sym = t.symbol.toUpperCase();
      const name = t.name.toLowerCase().replace(/\s+/g, '-');

      debugDiv.innerHTML += `<div style='font-weight:bold;'>→ Analyse ${sym}</div>`;
      let success = 0;
      let news = {}, rsiData = {}, macdData = {}, events = {}, onchain = {};

      try {
        const res = await fetch(`${PROXY}news?q=${name}`);
        news = await res.json();
        debugDiv.innerHTML += `<div>[${sym}] ✓ News OK</div>`; success++;
      } catch (e) {
        debugDiv.innerHTML += `<div>[${sym}] ✗ News: ${e.message}</div>`;
      }

      try {
        const res = await fetch(`${PROXY}rsi?symbol=${sym}`);
        rsiData = await res.json();
        debugDiv.innerHTML += `<div>[${sym}] ✓ RSI OK</div>`; success++;
      } catch (e) {
        debugDiv.innerHTML += `<div>[${sym}] ✗ RSI: ${e.message}</div>`;
      }

      try {
        const res = await fetch(`${PROXY}macd?symbol=${sym}`);
        macdData = await res.json();
        debugDiv.innerHTML += `<div>[${sym}] ✓ MACD OK</div>`; success++;
      } catch (e) {
        debugDiv.innerHTML += `<div>[${sym}] ✗ MACD: ${e.message}</div>`;
      }

      try {
        const res = await fetch(`${PROXY}events?coins=${sym}`);
        events = await res.json();
        debugDiv.innerHTML += `<div>[${sym}] ✓ Events OK</div>`; success++;
      } catch (e) {
        debugDiv.innerHTML += `<div>[${sym}] ✗ Events: ${e.message}</div>`;
      }

      try {
        const res = await fetch(`${PROXY}onchain?symbol=${t.symbol}`);
        onchain = await res.json();
        debugDiv.innerHTML += `<div>[${sym}] ✓ Onchain OK</div>`; success++;
      } catch (e) {
        debugDiv.innerHTML += `<div>[${sym}] ✗ Onchain: ${e.message}</div>`;
      }

      if (success < 3) {
        debugDiv.innerHTML += `<div>[${sym}] Trop peu de données, crypto ignorée.</div><br/>`;
        progressBar.value = i + 1;
        progressText.textContent = `${i + 1} / 20 analysées`;
        await sleep(1500);
        continue;
      }

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

      enriched.push({
        name: sym,
        forecast: `+${forecast.toFixed(1)}%`,
        horizon: "2-4 jours",
        confidence,
        reason: news.articles?.[0]?.title || "Aucune info récente.",
        extra: hasEvent ? `Événement: ${events.body[0].title}` : ""
      });

      debugDiv.innerHTML += `<div>[${sym}] Ajouté avec succès (${success}/5)</div><hr/>`;

      progressBar.value = i + 1;
      progressText.textContent = `${i + 1} / 20 analysées`;
      await sleep(1500);
    }

    ul.innerHTML = '';
    if (enriched.length === 0) {
      ul.innerHTML = '<li>Aucune opportunité IA détectée pour le moment.</li>';
      return;
    }

    enriched.sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast)).slice(0, 5).forEach(e => {
      ul.innerHTML += `<li><strong>${e.name}</strong> : ${e.forecast} attendu d'ici ${e.horizon}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em><br/>${e.extra}</li>`;
    });

    ul.appendChild(debugDiv);
  } catch (err) {
    ul.innerHTML = '<li>Erreur lors de l\'analyse des opportunités.</li>';
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
}

window.onload = () => {
  refreshAll();
};
