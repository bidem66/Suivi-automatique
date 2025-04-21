// script.js v7
// • Analyse 2 pages x 250 = 500 cryptos
// • Gestion safeFetch pour chaque appel IA/news/events
// • Skip silencieux des données manquantes
// • Logs clairs pour debug

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym}`);
    const d   = await res.json();
    const change = d.pc ? ((d.c - d.pc)/d.pc)*100 : 0;
    return { price: d.c, change, currency: 'USD' };
  } catch {
    return null;
  }
}

async function fetchExchangeRate() {
  try {
    const r = await fetch('https://api.exchangerate.host/latest?base=USD&symbols=CAD');
    const d = await r.json();
    return d.rates?.CAD || 1.35;
  } catch {
    return 1.35;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${sym}USDT`);
    const d    = await res.json();
    const usdP = parseFloat(d.lastPrice);
    const usdC = parseFloat(d.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: usdP * rate, change: usdC, currency: 'CAD' };
    }
    return { price: usdP, change: usdC, currency: 'USD' };
  } catch {
    return null;
  }
}

function removeAsset() {
  const sym = document.getElementById('removeSymbol').value.trim().toUpperCase();
  portfolio = portfolio.filter(a => a.sym !== sym);
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  refreshAll();
}

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

// safeFetch avec fallback
async function safeFetch(url, fallback) {
  try {
    console.log('[safeFetch] GET', url);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`status ${r.status}`);
    const j = await r.json();
    return j;
  } catch (e) {
    console.warn('[safeFetch] fallback for', url, e.message);
    return fallback;
  }
}

async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '';

  // 500 cryptos au total
  const urls = [1,2].map(p =>
    `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`
  );
  // Charge pages
  const pagesData = await Promise.all(
    urls.map(u => safeFetch(u, []))
  );
  const allTickers = pagesData.flat();
  console.log('[OPP] cryptos chargés:', allTickers.length);
  if (!allTickers.length) {
    ul.innerHTML = '<li>Erreur CoinGecko : aucune crypto chargée.</li>';
    return;
  }

  const enriched = [];
  for (const t of allTickers) {
    const sym = t.symbol.toUpperCase();
    const id  = t.id;
    // Appels IA/news/event/onchain avec fallback
    const news      = await safeFetch(`${PROXY}news?q=${id}`, { articles: [] });
    const rsiData   = await safeFetch(`${PROXY}rsi?symbol=${sym}`, { value: 0 });
    const macdData  = await safeFetch(`${PROXY}macd?symbol=${sym}`, { valueMACD: 0, valueMACDSignal: 0 });
    const community = await safeFetch(`${PROXY}coingecko?endpoint=coins/${id}`, { community_score: 0 });
    const events    = await safeFetch(`${PROXY}events?coins=${sym}`, { body: [], data: [] });
    const onchain   = await safeFetch(`${PROXY}onchain?symbol=${t.symbol}`, { data: { value: 0 } });

    // Calcule boosts
    const rsi        = rsiData.value;
    const macdSig    = (macdData.valueMACD || 0) - (macdData.valueMACDSignal || 0);
    const socScore   = community.community_score || 0;
    const evList     = (events.body || events.data) || [];
    const hasEvent   = evList.length > 0;
    const actAddr    = onchain.data.value || 0;

    const sB = news.articles.length > 0 ? 1.2 : 1;
    const iB = (rsi < 30 && macdSig > 0) ? 1.2 : 1;
    const soB= socScore > 60 ? 1.2 : 1;
    const eB = hasEvent ? 1.2 : 1;
    const oB = actAddr > 1000 ? 1.2 : 1;

    const boostScore = sB * iB * soB * eB * oB;
    const forecast   = (boostScore - 1) * 25;
    if (forecast < 1) continue;

    console.log(`[OPP] ${sym}: +${forecast.toFixed(1)}%`,
      `{s:${sB},i:${iB},so:${soB},e:${eB},o:${oB}}`
    );

    const why = [
      sB>1 ? 'News récentes' : null,
      iB>1 ? 'RSI<30+MACD+' : null,
      soB>1? 'Communauté'      : null,
      eB>1 ? 'Événement'       : null,
      oB>1 ? 'On-chain'        : null
    ].filter(Boolean).join(', ');

    enriched.push({
      name:       sym,
      forecast,
      article:    news.articles[0]?.title || 'Pas d’info',
      confidence: ((sB+iB+soB+eB+oB)/5*10).toFixed(1),
      extra:      hasEvent ? `Événement: ${evList[0].title}` : '',
      why
    });
  }

  if (!enriched.length) {
    ul.innerHTML = '<li>Aucune opportunité ≥1 % détectée.</li>';
    return;
  }

  enriched
    .sort((a,b)=>b.forecast - a.forecast)
    .slice(0,5)
    .forEach(e => {
      const hor = e.forecast>30 ? '7-30 jours' : '3-7 jours';
      ul.innerHTML += `
        <li>
          <strong>${e.name}</strong> : +${e.forecast.toFixed(1)}% d'ici ${hor}<br>
          Confiance IA: ${e.confidence}/10<br>
          <em>${e.article}</em><br>
          ${e.extra}<br>
          <small>${e.why}</small>
        </li>`;
    });
}

async function refreshAll() {
  const tA  = document.getElementById('tableAction');
  const tC  = document.getElementById('tableCrypto');
  const adv = document.getElementById('adviceList');
  const gp  = document.getElementById('globalPerf');
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';

  let inv=0, val=0;
  const enriched = await Promise.all(
    portfolio.map(async a => ({
      ...a,
      info: a.type==='crypto'
        ? await fetchCrypto(a.sym, a.curr)
        : await fetchAction(a.sym)
    }))
  );

  enriched
    .filter(e=>e.info)
    .sort((a,b)=>b.info.change - a.info.change)
    .forEach(a=>{
      const p = a.info.price;
      const v = p * a.qty;
      const g = v - a.inv;
      inv += a.inv; val+=v;
      const pct = a.info.change.toFixed(2);
      const row = `
        <tr>
          <td>${a.sym}</td><td>${a.qty}</td>
          <td>${a.inv.toFixed(2)}</td>
          <td>${p.toFixed(2)}</td>
          <td>${v.toFixed(2)}</td>
          <td class='${g>=0?'gain':'perte'}'>${g>=0?'+':''}${pct}%</td>
          <td>${a.info.currency}</td>
        </tr>`;
      (a.type==='crypto'?tC:tA).innerHTML += row;
      adv.innerHTML += `<li><strong>${a.sym}</strong> : ${
        g>=20?'Vendre':g<=-15?'À risque':'Garder'
      }</li>`;
    });

  const totalGain = val - inv;
  const totalPct  = inv ? (totalGain/inv*100).toFixed(2) : '0.00';
  gp.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  gp.style.color = totalGain>=0?'green':'red';

  await fetchOpportunities();
}

window.onload = () => {
  refreshAll();
  setInterval(refreshAll, 60000);
};
