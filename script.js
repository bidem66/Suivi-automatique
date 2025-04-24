// script.js

// === 1. CONST & VARIABLES GLOBALES ===
const PROXY = 'https://proxi-api-crypto.onrender.com/proxy/';
let portfolio = JSON.parse(localStorage.getItem('portfolio') || '[]');
const BUTTON_COOLDOWN = 60 * 60 * 1000;
const SLEEP_SHORT = 300;
const SLEEP_LONG  = 500;

// === 2. OUTILS DE FETCH SÉCURISÉ ===
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
function debug(msg) {
  const el = document.getElementById('debugConsole');
  if (el) el.innerHTML += `${new Date().toLocaleTimeString()} – ${msg}<br>`;
}
async function safeFetch(url, label) {
  try {
    const res = await fetch(url);
    debug(`${label} HTTP ${res.status}`);
    return res;
  } catch (err) {
    debug(`${label} fetch error: ${err.message}`);
    return null;
  }
}
async function safeJson(res, label) {
  if (!res) return null;
  if (!res.ok) {
    debug(`${label} non-OK status: ${res.status}`);
    return null;
  }
  try {
    return await res.json();
  } catch (err) {
    debug(`${label} JSON parse error: ${err.message}`);
    return null;
  }
}

// === 3. FETCH ACTIONS & CRYPTOS ===
async function fetchExchangeRate() {
  const res = await safeFetch(
    "https://api.exchangerate.host/latest?base=USD&symbols=CAD",
    'ExchangeRate'
  );
  const j = await safeJson(res, 'ExchangeRate');
  return j?.rates?.CAD || 1.35;
}
async function fetchAction(sym) {
  const res = await safeFetch(`${PROXY}finnhub?symbol=${sym}`, 'Finnhub');
  const d   = await safeJson(res, 'Finnhub');
  if (!d) return null;
  const change = d.pc ? ((d.c - d.pc) / d.pc) * 100 : 0;
  return { price: d.c, change, currency: 'USD' };
}
async function fetchCrypto(sym, curr) {
  const res = await safeFetch(`${PROXY}binance?symbol=${sym}USDT`, 'Binance');
  const d   = await safeJson(res, 'Binance');
  if (!d) return null;
  const price  = parseFloat(d.lastPrice);
  const change = parseFloat(d.priceChangePercent);
  if (curr === 'CAD') {
    const rate = await fetchExchangeRate();
    return { price: price * rate, change, currency: 'CAD' };
  }
  return { price, change, currency: 'USD' };
}

// === 4. PRÉ-SÉLECTION (1000 tickers) ===
async function fetchGeckoTickers(perPage = 100, pages = 5) {
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const res = await safeFetch(
      `${PROXY}coingecko?endpoint=coins/markets` +
      `&vs_currency=usd&order=market_cap_desc` +
      `&per_page=${perPage}&page=${p}` +
      `&sparkline=false&price_change_percentage=24h`,
      `Gecko page ${p}`
    );
    const arr = await safeJson(res, `Gecko page ${p}`);
    if (!Array.isArray(arr)) break;
    all.push(...arr);
    await sleep(SLEEP_SHORT);
  }
  return all;
}
async function getTickerList() {
  const results = [];
  // 4.1 – CoinPaprika (top 1000)
  {
    const res = await safeFetch(`${PROXY}coinpaprika`, 'CoinPaprika');
    const d1  = await safeJson(res, 'CoinPaprika');
    if (Array.isArray(d1)) {
      results.push(...d1.slice(0, 1000));
      debug(`✅ CoinPaprika: ${results.length} tickers`);
    } else {
      debug('⚠️ CoinPaprika returned non-array');
    }
  }
  // 4.2 – Compléter jusqu’à 1000 avec Gecko
  const need = 1000 - results.length;
  if (need > 0) {
    const pages = Math.ceil(need / 100);
    const geo   = await fetchGeckoTickers(100, pages);
    const slice = geo.slice(0, need);
    const fmt   = slice.map(d => ({
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
    debug(`✅ CoinGecko: ${fmt.length} tickers`);
  }
  debug(`🔄 Total combiné pour préfiltrage: ${results.length}`);
  return results;
}
// === 5. ENRICHISSEMENT IA & AFFICHAGE (100 candidats → afficher 50) ===
async function fetchOpportunities() {
  const ul = document.getElementById('opportunities');
  ul.innerHTML = '<li>Analyse IA des cryptos...</li>';
  debug('--- Début fetchOpportunities ---');

  // 5.1 – récupérer et filtrer
  const all      = await getTickerList();
  debug(`🔄 Total brut pour préfiltrage : ${all.length}`);
  const filtered = all.filter(t => {
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
  debug(`🔍 Après filtres : ${filtered.length}`);

  // 5.1.1 – scorer et garder les 100 meilleures
  const maxMC  = Math.max(...filtered.map(t => t.quotes.USD.market_cap));
  const maxVol = Math.max(...filtered.map(t => t.quotes.USD.volume_24h));
  const scored = filtered
    .map(t => ({
      ...t,
      preScore: (t.quotes.USD.market_cap/maxMC)*0.7 + (t.quotes.USD.volume_24h/maxVol)*0.3
    }))
    .sort((a,b) => b.preScore - a.preScore);
  const candidates = scored.slice(0, 100);
  debug(`🎯 100 meilleurs pré-sélectionnés`);

  // 5.2 – enrichir 100 candidats
  const enriched = [];
  for (let i = 0; i < candidates.length; i++) {
    const t   = candidates[i];
    const sym = t.symbol;
    debug(`▶️ Enrichissement ${i+1}/100 : ${sym}`);

    let news, rsi, macdData, evt, onch;
    try {
      // 5.2.1 – fenêtre 7 jours
      const fromDate = new Date(Date.now() - 7*24*60*60*1000).toISOString();

      // 5.2.2 – News ciblée
      const domains = [
        'news.coinmarketcap.com',
        'www.cointelegraph.com',
        'www.coindesk.com'
      ].join(',');
      let res = await safeFetch(
        `${PROXY}news?` +
        `q=${encodeURIComponent(t.name)}` +
        `&domains=${domains}` +
        `&pageSize=1&sortBy=publishedAt&from=${fromDate}`,
        `News ${sym}`
      );
      news = await safeJson(res, `News ${sym}`);
      await sleep(200);

      // fallback sans from si vide
      if (!news?.articles?.length) {
        const res2  = await safeFetch(
          `${PROXY}news?` +
          `q=${encodeURIComponent(t.name)}` +
          `&domains=${domains}` +
          `&pageSize=1&sortBy=publishedAt`,
          `News ${sym} fallback`
        );
        const news2 = await safeJson(res2, `News ${sym} fallback`);
        if (news2?.articles?.length) news = news2;
        await sleep(200);
      }

      // RSI, MACD, Events, On-chain
      res      = await safeFetch(`${PROXY}rsi?symbol=${sym}`, 'RSI');
      rsi      = (await safeJson(res, 'RSI'))?.value;     await sleep(200);
      res       = await safeFetch(`${PROXY}macd?symbol=${sym}`, 'MACD');
      macdData  = await safeJson(res, 'MACD');            await sleep(200);
      res  = await safeFetch(`${PROXY}events?coins=${sym}`, 'Events');
      evt  = await safeJson(res, 'Events');               await sleep(200);
      res   = await safeFetch(`${PROXY}onchain?symbol=${sym}`, 'Onchain');
      onch  = await safeJson(res, 'Onchain');             await sleep(200);
    } catch (err) {
      debug(`❌ Erreur IA fetch pour ${sym}: ${err.message}`);
      continue;
    }

    // boosts & forecast
    const sig     = macdData?.valueMACDSignal || 0;
    const valM    = macdData?.valueMACD       || 0;
    const boosts  = [
      news?.articles?.length ? 1.2 : 1,
      (rsi < 30 && valM > sig) ? 1.2 : 1,
      evt?.body?.length > 0    ? 1.2 : 1,
      (onch?.data?.value||0) > 500 ? 1.2 : 1
    ];
    const rawPct    = t.quotes.USD.percent_change_24h || 0;
    const forecast  = rawPct * boosts.reduce((a,b)=>a*b,1) * 7;

    // **Confiance IA** = (nombre de boosts>1)/4*10
    const countBoosts = boosts.filter(b => b > 1).length;
    const confidence  = ((countBoosts / boosts.length) * 10).toFixed(1);

    if (forecast >= 20) {
      const article = news?.articles?.[0];
      let dateStr = '';
      if (article?.publishedAt) {
        dateStr = new Date(article.publishedAt).toLocaleDateString('fr-FR', {
          year:'numeric', month:'2-digit', day:'2-digit',
          hour:'2-digit', minute:'2-digit'
        });
      }
      enriched.push({
        name: sym,
        forecast: forecast.toFixed(1),
        confidence,
        reason: article?.title || 'Pas d’actualité',
        newsDate: dateStr,
        newsUrl: article?.url
      });
    }
    await sleep(SLEEP_LONG);
  }
  debug(`✅ Enrichies : ${enriched.length} (ciblé 100)`);

  // 5.3 – trier et afficher top 50
  ul.innerHTML = '';
  enriched
    .sort((a,b) => parseFloat(b.forecast) - parseFloat(a.forecast))
    .slice(0,50)
    .forEach(e => {
      ul.innerHTML += `
        <li>
          <strong>${e.name}</strong>: +${e.forecast}% (7j)<br/>
          Confiance IA: ${e.confidence}/10<br/>
          ${e.newsUrl
            ? `<a href="${e.newsUrl}" target="_blank">📰 ${e.reason} (${e.newsDate})</a>`
            : '<em>Aucune actualité disponible</em>'}
        </li>`;
    });
}

// === 6. RAFRAÎCHISSEMENT & ÉVÉNEMENTS ===
async function refreshAll() {
  const tA   = document.getElementById("tableAction"),
        tC   = document.getElementById("tableCrypto"),
        advice= document.getElementById("adviceList"),
        perf = document.getElementById("globalPerf");
  tA.innerHTML = tC.innerHTML = advice.innerHTML = '';
  let inv = 0, val = 0;

  for (const a of portfolio) {
    const info = a.type==='crypto'
      ? await fetchCrypto(a.sym, a.curr)
      : await fetchAction(a.sym);
    if (!info) continue;
    const v      = info.price * a.qty;
    const gain   = v - a.inv;
    const change = info.change?.toFixed(2) || '0.00';
    const cls    = gain>=0?'gain':'perte';
    const sign   = gain>=0?'+':'-';
    inv+=a.inv; val+=v;

    tA.innerHTML += `
      <tr>
        <td>${a.sym}</td><td>${a.qty}</td><td>${a.inv.toFixed(2)}</td>
        <td>${info.price.toFixed(2)}</td><td>${v.toFixed(2)}</td>
        <td class="${cls}">${sign}${change}%</td><td>${info.currency}</td>
      </tr>`;
    advice.innerHTML += `<li><strong>${a.sym}</strong>: ${
      gain>=20?'Vendre':gain<=-15?'À risque':'Garder'
    }</li>`;
  }

  const totalGain = val-inv;
  const totalPct  = inv?((totalGain/inv)*100).toFixed(2):0;
  perf.textContent = `Performance globale : ${totalGain.toFixed(2)} CAD (${totalPct}%)`;
  perf.style.color   = totalGain>=0?'green':'red';

  await fetchOpportunities();
}

window.onload = refreshAll;
document.getElementById('refreshBtn')?.addEventListener('click', async ()=>{
  document.getElementById('refreshBtn').disabled = true;
  debug('🔄 Rafraîchissement IA lancé');
  await fetchOpportunities();
  setTimeout(()=>{
    document.getElementById('refreshBtn').disabled = false;
    debug('✅ Bouton réactivé');
  }, BUTTON_COOLDOWN);
});
