// script.js v8
// • Analyse 2 pages x 250 = 500 cryptos
// • safeFetch + fallback pour TOUTE requête
// • Aucune exception : tout passe en silence
// • Logs clairs pour page1/page2 + total + opportunités

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

// safeFetch générique avec fallback
async function safeFetch(url, fallback) {
  try {
    console.log('[safeFetch] GET', url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[safeFetch] fallback for', url, e.message);
    return fallback;
  }
}

// Supprimer un actif du portefeuille
function removeAsset() {
  const sym = document.getElementById('removeSymbol').value.trim().toUpperCase();
  portfolio = portfolio.filter(a => a.sym !== sym);
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  refreshAll();
}

// Ajouter un actif au portefeuille
async function addAsset() {
  const type = document.getElementById('type').value;
  const sym  = document.getElementById('symbol').value.trim().toUpperCase();
  const qty  = parseFloat(document.getElementById('quantity').value);
  const inv  = parseFloat(document.getElementById('invested').value);
  const curr = document.getElementById('devise').value.toUpperCase();
  if (!sym || !qty || !inv) return alert('Tous les champs sont requis.');
  portfolio.push({ type, sym, qty, inv, curr });
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  await refreshAll();
}

// Récupérer le prix et la variation d'une action (USD)
async function fetchAction(sym) {
  const data = await safeFetch(`${PROXY}finnhub?symbol=${sym}`, {});
  const c  = data.c || 0;
  const pc = data.pc || 0;
  const change = pc ? ((c - pc) / pc) * 100 : 0;
  return { price: c, change, currency: 'USD' };
}

// Récupérer le prix et la variation d'une crypto (USD ou CAD)
async function fetchCrypto(sym, curr) {
  const binance = await safeFetch(
    `https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`,
    { lastPrice: 0, priceChangePercent: 0 }
  );
  const usdP = parseFloat(binance.lastPrice);
  const usdC = parseFloat(binance.priceChangePercent);
  if (curr === 'CAD') {
    const ex = await safeFetch(
      'https://api.exchangerate.host/latest?base=USD&symbols=CAD',
      { rates: { CAD: 1.35 } }
    );
    return { price: usdP * (ex.rates.CAD || 1.35), change: usdC, currency: 'CAD' };
  }
  return { price: usdP, change: usdC, currency: 'USD' };
}

// Construire et afficher la liste des opportunités
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '';

  // Charger 2 pages de 250 cryptos (500 au total)
  const pages = [1, 2];
  const tickersArr = await Promise.all(
    pages.map(p =>
      safeFetch(
        `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`,
        []
      )
    )
  );
  const allTickers = tickersArr.flat();
  console.log('[OPP] cryptos chargés:', allTickers.length);

  if (allTickers.length === 0) {
    ul.innerHTML = '<li>Erreur CoinGecko : aucune crypto chargée.</li>';
    return;
  }

  const enriched = [];
  for (const t of allTickers) {
    const sym = t.symbol.toUpperCase();
    const id  = t.id;

    // Appels IA/news/events/on-chain avec fallback
    const news      = await safeFetch(`${PROXY}news?q=${id}`, { articles: [] });
    const rsiData   = await safeFetch(`${PROXY}rsi?symbol=${sym}`, { value: 0 });
    const macdData  = await safeFetch(`${PROXY}macd?symbol=${sym}`, { valueMACD: 0, valueMACDSignal: 0 });
    const comm      = await safeFetch(`${PROXY}coingecko?endpoint=coins/${id}`, { community_score: 0 });
    const events    = await safeFetch(`${PROXY}events?coins=${sym}`, { body: [], data: [] });
    const onchain   = await safeFetch(`${PROXY}onchain?symbol=${sym}`, { data: { value: 0 } });

    // Extraction sécurisée des indicateurs
    const rsi        = rsiData.value;
    const macdSig    = (macdData.valueMACD || 0) - (macdData.valueMACDSignal || 0);
    const socScore   = comm.community_score || 0;
    const evList     = Array.isArray(events.body) ? events.body : Array.isArray(events.data) ? events.data : [];
    const hasEvent   = evList.length > 0;
    const actAddr    = onchain.data.value || 0;

    // Calcul des boosts
    const sB  = (Array.isArray(news.articles) && news.articles.length > 0) ? 1.2 : 1;
    const iB  = (rsi < 30 && macdSig > 0) ? 1.2 : 1;
    const soB = socScore > 60 ? 1.2 : 1;
    const eB  = hasEvent ? 1.2 : 1;
    const oB  = actAddr > 1000 ? 1.2 : 1;

    const boostScore = sB * iB * soB * eB * oB;
    const forecast   = (boostScore - 1) * 25;
    if (forecast < 1) continue;

    console.log(`[OPP] ${sym}: +${forecast.toFixed(1)}%`, { sB, iB, soB, eB, oB });

    const factors = [
      sB > 1 ? 'News' : null,
      iB > 1 ? 'RSI+MACD' : null,
      soB > 1 ? 'Social' : null,
      eB > 1 ? 'Event' : null,
      oB > 1 ? 'On-chain' : null
    ].filter(x => x).join(', ');

    enriched.push({
      name:       sym,
      forecast,
      article:    news.articles[0]?.title || 'Pas d’info',
      confidence: ((sB + iB + soB + eB + oB) / 5 * 10).toFixed(1),
      extra:      hasEvent ? `Événement: ${evList[0].title}` : '',
      why:        factors
    });
  }

  if (!enriched.length) {
    ul.innerHTML = '<li>Aucune opportunité ≥ 1 % détectée.</li>';
    return;
  }

  enriched
    .sort((a, b) => b.forecast - a.forecast)
    .slice(0, 5)
    .forEach(e => {
      const horizon = e.forecast > 30 ? '7-30 jours' : '3-7 jours';
      ul.innerHTML += `
        <li>
          <strong>${e.name}</strong> : +${e.forecast.toFixed(1)}% d'ici ${horizon}<br>
          Confiance IA: ${e.confidence}/10<br>
          <em>${e.article}</em><br>
          ${e.extra}<br>
          <small>${e.why}</small>
        </li>`;
    });
}

// Rafraîchissement du dashboard
async function refreshAll() {
  const tA  = document.getElementById('tableAction');
  const tC  = document.getElementById('tableCrypto');
  const adv = document.getElementById('adviceList');
  const gp  = document.getElementById('globalPerf');
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';

  let inv = 0, val = 0;
  const list = await Promise.all(portfolio.map(async a => ({
    ...a,
    info: a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym)
  })));

  list
    .filter(e => e.info)
    .sort((a, b) => b.info.change - a.info.change)
    .forEach(a => {
      const p = a.info.price;
      const v = p * a.qty;
      const g = v - a.inv;
      inv += a.inv;
      val += v;
      const pct = a.info.change.toFixed(2);
      const row = `
        <tr>
          <td>${a.sym}</td>
          <td>${a.qty}</td>
          <td>${a.inv.toFixed(2)}</td>
          <td>${p.toFixed(2)}</td>
          <td>${v.toFixed(2)}</td>
          <td class="${g >= 0 ? 'gain' : 'perte'}">
            ${g >= 0 ? '+' : ''}${pct}%
          </td>
          <td>${a.info.currency}</td>
        </tr>`;
      (a.type === 'crypto' ? tC : tA).innerHTML += row;
      adv.innerHTML += `<li><strong>${a.sym}</strong> : ${
        g >= 20 ? 'Vendre' :
        g <= -15 ? 'À risque' :
        'Garder'
      }</li>`;
    });

  const totalGain = val - inv;
  const totalPct  = inv ? (totalGain / inv * 100).toFixed(2) : '0.00';
  gp.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  gp.style.color = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

// Initialisation
window.onload = () => {
  refreshAll();
  setInterval(refreshAll, 60000);
};
