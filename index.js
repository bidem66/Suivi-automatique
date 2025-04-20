const PROXY = 'https://proxi-api-crypto.onrender.com/proxy?url=';
const FINNHUB_KEY = 'd012dp1r01qv3oh29bi0d012dp1r01qv3oh29big';
const NEWS_API_KEY = 'fe5128f148bd4e8ab813af15d9e809f4';
const TAAPI_KEY = '6mqwrl63sn24ipwa9h2xddah0em9oi4qq0wazbkwp';
const LUNAR_API_KEY = 'uqhsjk51pbpv43ta3b2fk2twm9om7gdni3l1han';
const COINMARKETCAL_KEY = '6803e03a806ff1651ee9dcde';
const TOKEN_TERMINAL_KEY = 'eyJhbGciOiJIUzI1NiIsInR5...';

let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

async function fetchAction(sym) {
  try {
    const res = await fetch(`${PROXY}https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`);
    const data = await res.json();
    if (!data.c || data.c === 0) return null;
    const change = ((data.c - data.pc) / data.pc) * 100;
    return { price: data.c, change, currency: 'USD' };
  } catch {
    return null;
  }
}

async function fetchExchangeRate() {
  try {
    const res = await fetch(`${PROXY}https://api.exchangerate.host/latest?base=USD&symbols=CAD`);
    const data = await res.json();
    return data.rates?.CAD || 1.35;
  } catch {
    return 1.35;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const symbolPair = sym.toUpperCase() + 'USDT';
    const res = await fetch(`${PROXY}https://api.binance.com/api/v3/ticker/24hr?symbol=${symbolPair}`);
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
  const curr = document.getElementById('devise').value;
  if (!symInput || !qty || !inv) return alert('Tous les champs sont requis.');
  const sym = symInput.toLowerCase();
  portfolio.push({ type, sym, qty, inv, curr });
  localStorage.setItem('portfolio', JSON.stringify(portfolio));
  await refreshAll();
}

async function fetchOpportunities() {
  const ul = document.getElementById("opportunities");
  ul.innerHTML = '';
  try {
    const res = await fetch(`${PROXY}https://api.binance.com/api/v3/ticker/24hr`);
    const tickers = await res.json();
    const top = tickers
      .filter(t => t.symbol.endsWith("USDT"))
      .map(t => ({
        symbol: t.symbol.replace("USDT", ""),
        change: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.quoteVolume)
      }))
      .sort((a, b) => b.change - a.change)
      .slice(0, 10);

    const enriched = await Promise.all(top.map(async t => {
      try {
        const [newsRes, rsiRes, macdRes, socialRes, eventRes, onchainRes] = await Promise.all([
          fetch(`${PROXY}https://newsapi.org/v2/everything?q=${t.symbol}&language=en&apiKey=${NEWS_API_KEY}`),
          fetch(`${PROXY}https://api.taapi.io/rsi?secret=${TAAPI_KEY}&exchange=binance&symbol=${t.symbol}/USDT&interval=1h`),
          fetch(`${PROXY}https://api.taapi.io/macd?secret=${TAAPI_KEY}&exchange=binance&symbol=${t.symbol}/USDT&interval=1h`),
          fetch(`${PROXY}https://lunarcrush.com/api3/coins?symbol=${t.symbol}&key=${LUNAR_API_KEY}`),
          fetch(`${PROXY}https://developers.coinmarketcal.com/v1/events?coins=${t.symbol}&access_token=${COINMARKETCAL_KEY}`),
          fetch(`${PROXY}https://api.tokenterminal.com/v2/projects/${t.symbol}/metrics/active_addresses_24h`, {
            headers: { Authorization: `Bearer ${TOKEN_TERMINAL_KEY}` }
          })
        ]);

        const news = await newsRes.json();
        const rsiData = await rsiRes.json();
        const macdData = await macdRes.json();
        const social = await socialRes.json();
        const events = await eventRes.json();
        const onchain = await onchainRes.json();

        const rsi = rsiData.value;
        const macdSignal = macdData.valueMACD - macdData.valueMACDSignal;
        const socialScore = social?.data?.[0]?.galaxy_score || 30;
        const hasEvent = events?.body?.length > 0;
        const activeAddresses = onchain?.data?.value || 0;

        const sentimentBoost = news.articles.length > 0 ? 1.2 : 1;
        const indicatorBoost = (rsi < 30 && macdSignal > 0) ? 1.2 : 1;
        const socialBoost = socialScore > 60 ? 1.2 : 1;
        const eventBoost = hasEvent ? 1.2 : 1;
        const onchainBoost = activeAddresses > 1000 ? 1.2 : 1;

        const forecast = t.change * sentimentBoost * indicatorBoost * socialBoost * eventBoost * onchainBoost;
        const article = news.articles[0]?.title || "Aucune info récente.";
        const eventNote = hasEvent ? `Événement à venir: ${events.body[0].title}` : "";

        return {
          name: t.symbol,
          forecast: `+${forecast.toFixed(1)}%`,
          horizon: "2-4 jours",
          confidence: ((sentimentBoost + indicatorBoost + socialBoost + eventBoost + onchainBoost) / 5 * 5).toFixed(1),
          reason: article,
          extra: eventNote
        };
      } catch {
        return { name: t.symbol, forecast: "+0.0%", confidence: "0.0", reason: "Erreur d’analyse IA", extra: "" };
      }
    }));

    enriched
      .sort((a, b) => parseFloat(b.forecast) - parseFloat(a.forecast))
      .slice(0, 3)
      .forEach(e => {
        ul.innerHTML += `<li><strong>${e.name}</strong> : ${e.forecast} attendu d'ici ${e.horizon}<br/>
        Confiance IA: ${e.confidence}/10<br/>
        <em>${e.reason}</em><br/>${e.extra}</li>`;
      });
  } catch {
    ul.innerHTML = '<li>Erreur de récupération des opportunités</li>';
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
    const info = a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr || a.devise)
      : await fetchAction(a.sym);
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
