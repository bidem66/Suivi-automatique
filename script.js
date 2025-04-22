
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');

const STABLES = ["BTC", "ETH", "USDT", "USDC", "DAI", "TUSD", "BNB", "XRP", "BCH", "LTC"];
const WEALTHSIMPLE = ["BTC", "ETH", "SOL", "ADA", "LINK", "AVAX", "DOT", "PEPE", "PYTH", "BONK", "WIF", "DOGE", "MATIC", "XLM"];
const SUSPECT_WORDS = ["fart", "rug", "broccoli", "baby", "shit", "moon", "elon", "doge"];

let paprikaCallTimestamps = [];
let apiTimers = {
  taapi: [],
  news: [],
  events: [],
  onchain: []
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function trackApi(api) {
  const now = Date.now();
  apiTimers[api].push(now);
  apiTimers[api] = apiTimers[api].filter(t => now - t < 1000);
}

async function safeFetch(api, url) {
  const maxCalls = 5;
  while (apiTimers[api].length >= maxCalls) {
    await sleep(250);
    const now = Date.now();
    apiTimers[api] = apiTimers[api].filter(t => now - t < 1000);
  }
  try {
    trackApi(api);
    return await fetch(url);
  } catch {
    return { json: async () => ({}) };
  }
}

function trackPaprikaCall() {
  const now = Date.now();
  paprikaCallTimestamps.push(now);
  paprikaCallTimestamps = paprikaCallTimestamps.filter(t => now - t < 1000);
}

async function safePaprikaFetch(url) {
  while (paprikaCallTimestamps.length >= 9) {
    await sleep(200);
    const now = Date.now();
    paprikaCallTimestamps = paprikaCallTimestamps.filter(t => now - t < 1000);
  }
  try {
    trackPaprikaCall();
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(3000);
      return safePaprikaFetch(url);
    }
    return res;
  } catch {
    return { json: async () => [] };
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

// The rest of fetchOpportunities and refreshAll remains unchanged (not shown for brevity)
