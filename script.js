// script.js (modifié avec meilleure tolérance pour actions sans pc - previousClose)

const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';

let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

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

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '';

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=3&page=1");
    const tickers = await res.json();

    const enriched = await Promise.all(tickers.map(async t => {
      const id = t.id;
      const sym = t.symbol.toUpperCase();
      let errorMsg = '';

      try {
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
          fetch(`https://api.coingecko.com/api/v3/coins/${id}`),
          fetch(`${PROXY}events?coins=${sym}`),
          fetch(`${PROXY}onchain?symbol=${t.symbol}`)
        ]);

        const news = await newsRes.json();
        const rsiData = await rsiRes.json();
        const macdData = await macdRes.json();
        const community = await communityRes.json();
        const events = await eventRes.json();
        const onchain = await onchainRes.json();

        const rsi = rsiData.value;
        const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
        const socialScore = community.community_score || 30;
        const hasEvent = events?.body?.length > 0;
        const activeAddresses = onchain?.data?.value || 0;

        const sentimentBoost = news.articles.length > 0 ? 1.2 : 1;
        const indicatorBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
        const socialBoost = socialScore > 60 ? 1.2 : 1;
        const eventBoost = hasEvent ? 1.2 : 1;
        const onchainBoost = activeAddresses > 1000 ? 1.2 : 1;

        const forecast = t.price_change_percentage_24h * sentimentBoost * indicatorBoost * socialBoost * eventBoost * onchainBoost;
        const article = news.articles[0]?.title || "Aucune info récente.";
        const eventNote = hasEvent ? `Événement à venir: ${events.body[0].title}` : "";

        return {
          name: sym,
          forecast: `+${forecast.toFixed(1)}%`,
          horizon: "2-4 jours",
          confidence: ((sentimentBoost + indicatorBoost + socialBoost + eventBoost + onchainBoost) / 5 * 5).toFixed(1),
          reason: article,
          extra: eventNote
        };
      } catch (e) {
        errorMsg = e.message || "Erreur inconnue";
        return { name: sym, forecast: "+0.0%", confidence: "0.0", reason: `Erreur: ${errorMsg}`, extra: "Debug info visible" };
      }
    }));

    enriched.forEach(e => {
      ul.innerHTML += `<li><strong>${e.name}</strong> : ${e.forecast} attendu d'ici ${e.horizon || "?"}<br/>Confiance IA: ${e.confidence}/10<br/><em>${e.reason}</em><br/>${e.extra}</li>`;
    });
  } catch {
    ul.innerHTML = '<li>Erreur globale lors de la récupération des opportunités</li>';
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
  setInterval(refreshAll, 60000);
};
