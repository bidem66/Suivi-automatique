// script.js v3
// - safeFetch pour charger chaque page CoinGecko indépendamment
// - skip des pages en erreur sans tout stopper
// - logs détaillés + catch(err) avec messages clairs

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';

let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

// API helpers inchangés...
async function fetchAction(sym) {
  try {
    const res  = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const data = await res.json();
    const change = data.pc && data.pc !== 0
      ? ((data.c - data.pc) / data.pc) * 100
      : 0;
    return { price: data.c, change, currency: 'USD' };
  } catch {
    return null;
  }
}

async function fetchExchangeRate() {
  try {
    const res  = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch {
    return 1.35;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym.toUpperCase()}USDT`);
    const data = await res.json();
    const usdPrice  = parseFloat(data.lastPrice);
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
  const type     = document.getElementById('type').value;
  const symInput = document.getElementById('symbol').value.trim();
  const qty      = parseFloat(document.getElementById('quantity').value);
  const inv      = parseFloat(document.getElementById('invested').value);
  const curr     = document.getElementById('devise').value.toUpperCase();

  if (!symInput || !qty || !inv) {
    return alert('Tous les champs sont requis.');
  }

  portfolio.push({ type, sym: symInput.toUpperCase(), qty, inv, curr });
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  await refreshAll();
}

// safeFetch : renvoie null en cas d'erreur, logue l'erreur
async function safeFetch(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`safeFetch error pour ${url}`, err);
    return null;
  }
}

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '';

  // Construire les URLs pour les pages
  const urls = [1,2,3,4].map(page =>
    `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`
  );

  // Charger chaque page en safeFetch
  const pagesData = await Promise.all(urls.map(u => safeFetch(u)));
  // Aplatir les tableaux valides
  const allTickers = pagesData
    .filter(d => Array.isArray(d))
    .flat();

  if (!allTickers.length) {
    ul.innerHTML = '<li>Erreur CoinGecko : impossible de récupérer aucune page.</li>';
    return;
  }

  let enriched = [];

  for (const t of allTickers) {
    try {
      const id  = t.id;
      const sym = t.symbol.toUpperCase();

      // Appels IA / news / TA / on-chain
      const [
        newsRes,
        rsiRes,
        macdRes,
        communityRes,
        eventRes,
        onchainRes
      ] = await Promise.all([
        fetch(`${PROXY}news?q=${id}`),
        fetch(`${PROXY}rsi?symbol=${sym}`),
        fetch(`${PROXY}macd?symbol=${sym}`),
        fetch(`${PROXY}coingecko?endpoint=coins/${id}`),
        fetch(`${PROXY}events?coins=${sym}`),
        fetch(`${PROXY}onchain?symbol=${t.symbol}`)
      ]);

      const news      = await newsRes.json();
      const rsiData   = await rsiRes.json();
      const macdData  = await macdRes.json();
      const community = await communityRes.json();
      const events    = await eventRes.json();
      const onchain   = await onchainRes.json();

      // Calcul des boosts
      const rsi           = rsiData.value;
      const macdSignal    = macdData.valueMACD - macdData.valueMACDSignal;
      const socialScore   = community.community_score || 30;
      const eventList     = events?.body || events?.data || [];
      const hasEvent      = eventList.length > 0;
      const activeAddress = onchain?.data?.value || 0;

      const sentimentBoost = news.articles.length > 0 ? 1.2 : 1;
      const indicatorBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
      const socialBoost    = socialScore > 60 ? 1.2 : 1;
      const eventBoost     = hasEvent ? 1.2 : 1;
      const onchainBoost   = activeAddress > 1000 ? 1.2 : 1;

      const boostScore = sentimentBoost * indicatorBoost * socialBoost * eventBoost * onchainBoost;
      const forecast   = (boostScore - 1) * 25;

      // Seuil abaissé à 1%
      if (forecast < 1) continue;

      console.log(
        `[OPP] ${sym}: forecast=${forecast.toFixed(1)}%`,
        `boosts={news:${sentimentBoost}, RSI+MACD:${indicatorBoost}, social:${socialBoost}, event:${eventBoost}, onchain:${onchainBoost}}`
      );

      const whyArr = [
        sentimentBoost > 1 ? "News récentes"        : null,
        indicatorBoost > 1 ? "RSI < 30 + MACD positif": null,
        socialBoost > 1    ? "Communauté active"     : null,
        eventBoost > 1     ? "Événement à venir"     : null,
        onchainBoost > 1   ? "Activité on-chain élevée": null
      ].filter(Boolean);

      enriched.push({
        name:       sym,
        forecast,
        article:    news.articles[0]?.title || "Pas d'info récente",
        confidence: ((sentimentBoost + indicatorBoost + socialBoost + eventBoost + onchainBoost)/5*10).toFixed(1),
        extra:      hasEvent ? `Événement: ${eventList[0].title}` : '',
        why:        whyArr.join(', ')
      });

    } catch (err) {
      console.error("Erreur enrichment pour", t.symbol, err);
    }
  }

  enriched = enriched
    .sort((a, b) => b.forecast - a.forecast)
    .slice(0, 5);

  if (!enriched.length) {
    ul.innerHTML = '<li>Aucune opportunité forte détectée (forecast < 1%).</li>';
    return;
  }

  enriched.forEach(e => {
    const horizon = e.forecast > 30 ? "7-30 jours" : "3-7 jours";
    ul.innerHTML += `
      <li>
        <strong>${e.name}</strong> : +${e.forecast.toFixed(1)}% d'ici ${horizon}<br/>
        Confiance IA: ${e.confidence}/10<br/>
        <em>${e.article}</em><br/>
        ${e.extra}<br/>
        <small>Facteurs: ${e.why}</small>
      </li>`;
  });
}

async function refreshAll() {
  const tbodyA = document.getElementById("tableAction");
  const tbodyC = document.getElementById("tableCrypto");
  const advice = document.getElementById("adviceList");
  const perf   = document.getElementById("globalPerf");

  tbodyA.innerHTML = tbodyC.innerHTML = advice.innerHTML = "";
  let inv = 0, val = 0;

  const enriched = await Promise.all(
    portfolio.map(async (a) => ({
      ...a,
      info: a.type === 'crypto' 
        ? await fetchCrypto(a.sym, a.curr) 
        : await fetchAction(a.sym)
    }))
  );

  const sorted = enriched
    .filter(e => e.info)
    .sort((a, b) => b.info.change - a.info.change);

  for (let a of sorted) {
    const info   = a.info;
    const value  = info.price * a.qty;
    const gain   = value - a.inv;
    const pct    = info.change?.toFixed(2) || "0.00";
    inv  += a.inv;
    val  += value;

    const row = `
      <tr>
        <td>${a.sym}</td>
        <td>${a.qty}</td>
        <td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td>
        <td>${value.toFixed(2)}</td>
        <td class="${gain>=0?'gain':'perte'}">${gain>=0?'+':''}${pct}%</td>
        <td>${info.currency}</td>
      </tr>`;
    (a.type==='crypto'?tbodyC:tbodyA).innerHTML += row;
    advice.innerHTML += `<li><strong>${a.sym}</strong> : ${
      gain>=20   ? 'Vendre' :
      gain<=-15  ? 'À risque' :
                   'Garder'
    }</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? (totalGain/inv*100).toFixed(2) : "0.00";
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color = totalGain>=0?'green':'red';

  await fetchOpportunities();
}

window.onload = () => {
  refreshAll();
  setInterval(refreshAll, 60000);
};
