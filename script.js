// script.js

// === 1. CONST & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
const SLEEP_SHORT = 300;
const SLEEP_LONG  = 500;

// === 2. OUTILS ===
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}

// === 3. FETCH ACTIONS & CRYPTOS ===
async function fetchExchangeRate() {
  try {
    const r = await fetch("https://api.exchangerate.host/latest?base=USD&symbols=CAD");
    const j = await r.json();
    return j.rates?.CAD || 1.35;
  } catch {
    debug('fetchExchangeRate failed, default to 1.35');
    return 1.35;
  }
}

async function fetchAction(sym) {
  try {
    const r = await fetch(`${PROXY}finnhub?symbol=${sym.toUpperCase()}`);
    const d = await r.json();
    const change = d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0;
    return { price: d.c, change, currency: 'USD' };
  } catch {
    debug(`fetchAction error for ${sym}`);
    return null;
  }
}

async function fetchCrypto(sym, curr) {
  try {
    const r = await fetch(`${PROXY}binance?symbol=${sym.toUpperCase()}USDT`);
    const d = await r.json();
    const price  = parseFloat(d.lastPrice);
    const change = parseFloat(d.priceChangePercent);
    if (curr === 'CAD') {
      const rate = await fetchExchangeRate();
      return { price: price * rate, change, currency: 'CAD' };
    }
    return { price, change, currency: 'USD' };
  } catch {
    debug(`fetchCrypto error for ${sym}`);
    return null;
  }
}

// === 4. PRÉ-SÉLECTION (1000 tickers) ===
async function fetchGeckoTickers(perPage = 100, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    try {
      const r = await fetch(
        `${PROXY}coingecko?endpoint=coins/markets` +
        `&vs_currency=usd&order=market_cap_desc` +
        `&per_page=${perPage}&page=${p}` +
        `&sparkline=false&price_change_percentage=24h`
      );
      const arr = await r.json();
      if (!Array.isArray(arr)) break;
      all.push(...arr);
    } catch (err) {
      debug(`❌ Gecko page ${p} error: ${err.message}`);
      break;
    }
    await sleep(SLEEP_SHORT);
  }
  return all;
}

async function getTickerList() {
  const results = [];

  // 4.1 – CoinPaprika (top 1000)
  try {
    const r1 = await fetch(`${PROXY}coinpaprika`);
    const d1 = await r1.json();
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 1000));
      debug(`✅ CoinPaprika: ${results.length} tickers`);
    } else {
      debug('⚠️ CoinPaprika returned non-array');
    }
  } catch (err) {
    debug('⚠️ CoinPaprika failed: ' + err.message);
  }

  // 4.2 – Compléter jusqu’à 1000 avec Gecko
  const need = 1000 - results.length;
  if (need > 0) {
    const pages = Math.ceil(need / 100);
    try {
      const geo = await fetchGeckoTickers(100, pages);
      const slice = geo.slice(0, need);
      const fmt = slice.map(d => ({
        id: d.id,
        symbol: d.symbol.toUpperCase(),
        name: d.name,
        quotes: { USD: {
          market_cap: d.market_cap,
          volume_24h: d.total_volume,
          percent_change_24h: d.price_change_percentage_24h
        }},
        started_at: d.genesis_date,
        rank: d.market_cap_rank
      }));
      results.push(...fmt);
      debug(`✅ CoinGecko: ${fmt.length} tickers (pages 1–${pages})`);
    } catch (err) {
      debug('⚠️ CoinGecko failed: ' + err.message);
    }
  }

  debug(`🔄 Total combiné pour préfiltrage: ${results.length}`);
  return results;
}

// === 5. ENRICHISSEMENT IA (50 tickers max) ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  try {
    // 5.1 – appliquer les filtres
    const all     = await getTickerList();
    const tickers = all.filter(t => {
      const u    = t.quotes.USD;
      const born = t.started_at ? new Date(t.started_at).getTime() : 0;
      const oneY = Date.now() - 365*24*60*60*1000;
      const ban  = ['elon','cum','baby','moon','trump'];
      return u.market_cap   >= 5e6 &&
             u.volume_24h   >= 1e6 &&
             born           < oneY &&
             t.rank          < 500 &&
             !t.id.includes('testnet') &&
             !ban.some(w => t.name.toLowerCase().includes(w));
    });

    // 5.2 – enrichir SEULEMENT les 50 premiers
    const enriched = [];
    for (let i = 0; i < tickers.length && enriched.length < 50; i++) {
      const t   = tickers[i];
      const sym = t.symbol;

      // fetch séquentiel au lieu de Promise.all
      let news, rsi, macdData, evt, onch;
      try {
        const newsR = await fetch(`${PROXY}news?q=${encodeURIComponent(t.name)}`);
        news = await newsR.json();
        await sleep(200);

        const rsiR = await fetch(`${PROXY}rsi?symbol=${sym}`);
        rsi = (await rsiR.json()).value;
        await sleep(200);

        const macdR = await fetch(`${PROXY}macd?symbol=${sym}`);
        macdData = await macdR.json();
        await sleep(200);

        const evtR = await fetch(`${PROXY}events?coins=${sym}`);
        evt = await evtR.json();
        await sleep(200);

        const onchR = await fetch(`${PROXY}onchain?symbol=${sym}`);
        onch = await onchR.json();
      } catch (err) {
        debug(`❌ fetch IA data for ${sym}: ${err.message}`);
        continue;
      }

      // calcul des boosts
      const sig   = macdData.valueMACDSignal;
      const val   = macdData.valueMACD;
      const boosts = [
        news.articles?.length            ? 1.2 : 1,
        (rsi < 30 && val > sig)          ? 1.2 : 1,
        (evt.body?.length > 0)           ? 1.2 : 1,
        ((onch.data?.value||0) > 500)    ? 1.2 : 1
      ];
      const raw      = t.quotes.USD.percent_change_24h || 0;
      const forecast = raw * boosts.reduce((a,b)=>a*b,1);
      const confidence = ((boosts.reduce((a,b)=>a+b,0)/4)*10).toFixed(1);

      if (forecast >= 20) {
        enriched.push({
          name: sym,
          forecast: forecast.toFixed(1),
          confidence,
          reason: news.articles?.[0]?.title || 'Pas d’actualité'
        });
      }

      await sleep(SLEEP_LONG);
    }

    // 5.3 – affichage du top 5
    ul.innerHTML = '';
    debug(`✅ Total enrichies: ${enriched.length}`);
    enriched
      .sort((a,b)=>parseFloat(b.forecast)-parseFloat(a.forecast))
      .slice(0,5)
      .forEach(e => {
        ul.innerHTML += `
          <li>
            <strong>${e.name}</strong>: ${e.forecast}%<br/>
            Confiance IA: ${e.confidence}/10<br/>
            <em>${e.reason}</em>
          </li>`;
      });

  } catch (err) {
    debug('❌ fetchOpportunities error: ' + err.message);
    ul.innerHTML = '<li>Erreur IA</li>';
  }
}

// === 6. AFFICHAGE & ÉVÉNEMENTS ===
async function refreshAll() {
  const tA   = document.getElementById("tableAction"),
        tC   = document.getElementById("tableCrypto"),
        adv  = document.getElementById("adviceList"),
        perf = document.getElementById("globalPerf");
  tA.innerHTML = tC.innerHTML = adv.innerHTML = '';
  let inv = 0, val = 0;

  for (const a of portfolio) {
    const info = a.type === 'crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym);
    if (!info) continue;
    const value = info.price * a.qty;
    const gain  = value - a.inv;
    const change= info.change?.toFixed(2) || '0.00';
    const cls   = gain >= 0 ? 'gain' : 'perte';
    const sign  = gain >= 0 ? '+' : '';
    inv += a.inv; val += value;

    tA.innerHTML += `
      <tr>
        <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td><td>${value.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td><td>${info.currency}</td>
      </tr>`;
    adv.innerHTML += `<li><strong>${a.sym}</strong>: ${
      gain >= 20 ? 'Vendre' : gain <= -15 ? 'À risque' : 'Garder'
    }</li>`;
  }

  const totalGain = val - inv;
  const totalPct  = inv ? ((totalGain / inv)*100).toFixed(2) : 0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color   = totalGain >= 0 ? 'green' : 'red';

  await fetchOpportunities();
}

window.onload = refreshAll;
document.getElementById('refreshBtn')?.addEventListener('click', async () => {
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(() => {
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
