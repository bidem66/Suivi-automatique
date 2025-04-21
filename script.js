// script.js v5
// - Analyse au moins 500 cryptos (2 pages x 250)
// - Seuil opportunités ≥ 1%
// - safeFetch pour chaque page CoinGecko
// - Logs debug et error handling détaillé

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

// Helpers inchangés
async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}finnhub?symbol=${sym}`);
    const d   = await res.json();
    const ch  = d.pc ? ((d.c - d.pc)/d.pc)*100 : 0;
    return { price: d.c, change: ch, currency: 'USD' };
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
    const pair = sym + 'USDT';
    const res  = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
    const d    = await res.json();
    const priceUSD = parseFloat(d.lastPrice);
    const chUSD    = parseFloat(d.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: priceUSD * rate, change: chUSD, currency: 'CAD' };
    }
    return { price: priceUSD, change: chUSD, currency: 'USD' };
  } catch {
    return null;
  }
}

// CRUD portfolio
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

// safeFetch pour CoinGecko
async function safeFetch(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`status ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error('safeFetch error:', url, e);
    return null;
  }
}

async function fetchOpportunities() {
  const ul    = document.getElementById('opportunities');
  ul.innerHTML = '';

  // 2 pages de 250 => 500 cryptos
  const pages = [1, 2];
  const urls  = pages.map(p =>
    `${PROXY}coingecko?endpoint=coins/markets&vs_currency=usd&order=market_cap_desc&per_page=250&page=${p}`
  );

  // Charger chaque page
  const dataArr = await Promise.all(urls.map(u => safeFetch(u)));
  const allTickers = dataArr.filter(d => Array.isArray(d)).flat();

  if (!allTickers.length) {
    ul.innerHTML = '<li>Erreur CoinGecko : aucune page reçue.</li>';
    return;
  }

  const enriched = [];
  for (const t of allTickers) {
    try {
      const sym = t.symbol.toUpperCase();
      const id  = t.id;
      // fetch IA + news + événements + onchain
      const [newsR, rsiR, macdR, comR, evtR, onR] = await Promise.all([
        fetch(`${PROXY}news?q=${id}`),
        fetch(`${PROXY}rsi?symbol=${sym}`),
        fetch(`${PROXY}macd?symbol=${sym}`),
        fetch(`${PROXY}coingecko?endpoint=coins/${id}`),
        fetch(`${PROXY}events?coins=${sym}`),
        fetch(`${PROXY}onchain?symbol=${t.symbol}`)
      ]);
      const news      = await newsR.json();
      const rsiData   = await rsiR.json();
      const macdData  = await macdR.json();
      const community = await comR.json();
      const events    = await evtR.json();
      const onchain   = await onR.json();

      const rsi        = rsiData.value;
      const macdSig    = macdData.valueMACD - macdData.valueMACDSignal;
      const socScore   = community.community_score || 30;
      const evList     = events.body || events.data || [];
      const hasEvent   = evList.length > 0;
      const activeAddr = onchain.data?.value || 0;

      const sB = news.articles.length>0 ? 1.2 : 1;
      const iB = (rsi<30 && macdSig>0)?1.2:1;
      const soB= socScore>60?1.2:1;
      const eB = hasEvent?1.2:1;
      const oB = activeAddr>1000?1.2:1;

      const boostScore = sB * iB * soB * eB * oB;
      const forecast   = (boostScore - 1) * 25;
      if (forecast < 1) continue;
      console.log(
        `[OPP] ${sym}: +${forecast.toFixed(1)}%`,
        `{s:${sB},i:${iB},so:${soB},e:${eB},o:${oB}}`
      );
      const why = [
        sB>1?'News réc.':null,
        iB>1?'RSI<30+MACD+':null,
        soB>1?'Social':null,
        eB>1?'Événement':null,
        oB>1?'On-chain':null
      ].filter(Boolean).join(', ');

      enriched.push({
        name: sym,
        forecast,
        article: news.articles[0]?.title || 'Aucune info',
        confidence: ((sB+iB+soB+eB+oB)/5*10).toFixed(1),
        extra: hasEvent?`Événement: ${evList[0].title}`:'',
        why
      });
    } catch(e) {
      console.error('Enrich error', t.symbol, e);
    }
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
  const enriched = await Promise.all(portfolio.map(async a => ({
    ...a,
    info: a.type==='crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym)
  })));

  enriched
    .filter(e => e.info)
    .sort((a,b)=>b.info.change - a.info.change)
    .forEach(a => {
      const price  = a.info.price;
      const value  = price * a.qty;
      const gain   = value - a.inv;
      const pct    = a.info.change.toFixed(2);
      inv += a.inv; val += value;
      tA.innerHTML += a.type==='crypto' ? '' :
        `<tr><td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td><td>${price.toFixed(2)}</td><td>${value.toFixed(2)}</td><td class='${gain>=0?'gain':'perte'}'>${gain>=0?'+':''}${pct}%</td><td>${a.info.currency}</td></tr>`;
      tC.innerHTML += a.type==='crypto' ?
        `<tr><td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td><td>${price.toFixed(2)}</td><td>${value.toFixed(2)}</td><td class='${gain>=0?'gain':'perte'}'>${gain>=0?'+':''}${pct}%</td><td>${a.info.currency}</td></tr>` : '';
      adv.innerHTML += `<li><strong>${a.sym}</strong> : ${
        gain>=20?'Vendre': gain<=-15?'À risque':'Garder'
      }</li>`;
    });

  const totalGain = val - inv;
  const totalPct  = inv ? (totalGain/inv*100).toFixed(2) : '0.00';
  gp.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  gp.style.color = totalGain>=0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = () => {
  refreshAll();
  setInterval(refreshAll, 60000);
};
