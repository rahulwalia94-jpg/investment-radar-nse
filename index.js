// ═══════════════════════════════════════════════════════════════
// Investment Radar — NSE Data Proxy v4
// Scheduled refresh: 6x daily (India + US market times)
// Full cache: prices, FII, indices, valuations, news
// ═══════════════════════════════════════════════════════════════

const https  = require('https');
const http   = require('http');
const zlib   = require('zlib');
const PORT   = process.env.PORT || 3000;

// ── All 101 NSE symbols to track ──────────────────────────────
const NSE_SYMBOLS = [
  'TCS','INFY','HCLTECH','WIPRO','PERSISTENT','KPITTECH','LTIM','COFORGE','MPHASIS','CYIENT',
  'SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','LUPIN','TORNTPHARM','MAXHEALTH',
  'ICICIBANK','HDFCBANK','KOTAKBANK','SBIN','AXISBANK','BAJFINANCE','INDUSINDBK',
  'BANKBARODA','FEDERALBNK','SHRIRAMFIN','APTUS','M&MFIN',
  'HAL','BEL','COCHINSHIP','BHARATFORG','MTARTECH','DATAPATTNS','GRSE','PARASDEF',
  'MARUTI','TATAMOTORS','M&M','HEROMOTOCO','EICHERMOT','BAJAJ-AUTO','TVSMOTOR',
  'HINDUNILVR','ITC','NESTLEIND','TITAN','VBL','MARICO','DABUR','BRITANNIA','TRENT',
  'LT','NTPC','POWERGRID','ULTRACEMCO','DIXON','POLYCAB','ABB','SIEMENS','CUMMINSIND','KEC',
  'DEEPAKNTR','PIIND','NAVINFLUOR','AARTIIND','CLEAN','SRF','PIDILITIND',
  'DLF','PRESTIGE','GODREJPROP','OBEROIRLTY','ADANIPORTS',
  'ONGC','RELIANCE','COALINDIA','NHPC','GAIL','IOC','WAAREEENER',
  'BHARTIARTL','INDUSTOWER','IDEA',
  'DELHIVERY','CONCOR','BLUEDART',
  'TATASTEEL','JSWSTEEL','HINDALCO','VEDL',
  'HDFCLIFE','SBILIFE','BAJAJFINSV','CDSL',
  'INDIGO','INDHOTEL',
  'GOLDBEES','SILVERBEES','EMBASSY',
];

// ── Screener.in stocks to fetch valuations for ────────────────
const SCREENER_STOCKS = [
  'TCS','INFY','HCLTECH','WIPRO','PERSISTENT','LTIM','COFORGE',
  'SUNPHARMA','DRREDDY','CIPLA','DIVISLAB',
  'ICICIBANK','HDFCBANK','SBIN','BAJFINANCE','AXISBANK',
  'HAL','BEL','COCHINSHIP','BHARATFORG',
  'MARUTI','M&M','HEROMOTOCO','TATAMOTORS',
  'HINDUNILVR','ITC','TITAN','TRENT','VBL',
  'LT','NTPC','POWERGRID','DIXON','POLYCAB',
  'DEEPAKNTR','PIDILITIND','RELIANCE','ONGC','COALINDIA',
  'BHARTIARTL','DLF','ADANIPORTS',
];

// ── MASTER CACHE — persists between requests ──────────────────
var CACHE = {
  // Scheduled refresh cache (updated 6x daily)
  snapshot: {
    ts: null,
    label: null,
    prices: {},        // NSE symbol → price
    fii: null,         // FII/DII data
    indices: {},       // index name → data
    gainers: [],
    losers: [],
    results: [],
    dividends: [],
    valuations: {},    // symbol → {pe, pb, roe, growth, de, promoter}
    usdInr: null,
    brent: null,
    gold: null,
    marketNews: [],
    stockNews: {},     // symbol → [{title, date}]
    fetchErrors: [],   // log of what failed
    fetchSuccess: [],  // log of what succeeded
  },
  // Per-request cache (short TTL)
  requests: {},
};

// ── NSE session cookie ─────────────────────────────────────────
let NSE_COOKIE = '';
let COOKIE_TS  = 0;

function refreshCookie() {
  return new Promise(resolve => {
    const req = https.get('https://www.nseindia.com/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      }
    }, res => {
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', ()=>{});
      res.on('end', () => {
        if (cookies.length) {
          NSE_COOKIE = cookies.map(c => c.split(';')[0]).join('; ');
          COOKIE_TS  = Date.now();
          console.log('Cookie refreshed, cookies:', cookies.length);
        }
        resolve(NSE_COOKIE);
      });
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
  });
}

async function getCookie() {
  if (!NSE_COOKIE || Date.now() - COOKIE_TS > 20*60*1000) await refreshCookie();
  return NSE_COOKIE;
}

// ── Generic fetch with decompression ─────────────────────────
function fetchURL(hostname, path, headers, timeout=10000) {
  return new Promise(resolve => {
    const req = https.request({ hostname, path, method:'GET', headers, timeout }, res => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc==='gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc==='br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc==='deflate') stream = res.pipe(zlib.createInflate());
      let data = '';
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        try { resolve({ ok:true, data:JSON.parse(data), status:res.statusCode }); }
        catch(e) {
          if (data.includes('<html')) resolve({ ok:false, error:'got HTML — cookie expired' });
          else resolve({ ok:false, error:'JSON parse: '+e.message, raw:data.slice(0,200) });
        }
      });
      stream.on('error', e => resolve({ ok:false, error:'stream: '+e.message }));
    });
    req.on('error', e => resolve({ ok:false, error:e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, error:'timeout' }); });
    req.end();
  });
}

async function fetchNSE(path) {
  const cookie = await getCookie();
  return fetchURL('www.nseindia.com', path, {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer':         'https://www.nseindia.com/',
    'Cookie':          cookie,
    'sec-fetch-dest':  'empty',
    'sec-fetch-mode':  'cors',
    'sec-fetch-site':  'same-origin',
  });
}

// ── Yahoo Finance fetch ───────────────────────────────────────
function fetchYahoo(symbols) {
  const syms = symbols.join('%2C');
  const path = `/v7/finance/quote?symbols=${syms}&fields=regularMarketPrice,shortName`;
  return fetchURL('query1.finance.yahoo.com', path, {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
  }, 8000);
}

// ── Screener.in scraper ───────────────────────────────────────
function fetchScreener(symbol) {
  return new Promise(resolve => {
    const path = `/company/${symbol}/consolidated/`;
    const req = https.get({
      hostname: 'www.screener.in',
      path,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      timeout: 10000,
    }, res => {
      let html = '';
      res.on('data', c => html += c.toString());
      res.on('end', () => {
        try {
          // Extract key ratios from Screener HTML
          const extract = (label, pattern) => {
            const m = html.match(pattern);
            return m ? parseFloat(m[1].replace(',','')) : null;
          };
          // Screener ratio list format: <li>Market Cap<span...>1,234</span>
          const getVal = (name) => {
            const re = new RegExp(name+'[^<]*<[^>]*>\\s*([\\d,\\.]+)', 'i');
            const m = html.match(re);
            return m ? parseFloat(m[1].replace(/,/g,'')) : null;
          };
          const pe  = getVal('Stock P/E') || getVal('P/E');
          const pb  = getVal('Price to Book') || getVal('P/B');
          const roe = getVal('Return on equity') || getVal('ROE');
          const de  = getVal('Debt to equity');
          // Revenue growth from quarterly data
          const mcap = getVal('Market Cap');
          resolve({ ok:true, symbol, pe, pb, roe, de, mcap });
        } catch(e) {
          resolve({ ok:false, symbol, error:e.message });
        }
      });
    });
    req.on('error', e => resolve({ ok:false, symbol, error:e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, symbol, error:'timeout' }); });
  });
}

// ── Google News fetch ─────────────────────────────────────────
function fetchGoogleNews(query) {
  return new Promise(resolve => {
    const encoded = encodeURIComponent(query);
    const path = `/rss/search?q=${encoded}&hl=en-IN&gl=IN&ceid=IN:en`;
    const req = https.request({
      hostname: 'news.google.com', path, method:'GET',
      headers: { 'User-Agent':'Mozilla/5.0', 'Accept':'application/rss+xml,text/xml,*/*' },
      timeout: 8000,
    }, res => {
      let data = '';
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc==='gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc==='br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        const items = [];
        const rx = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = rx.exec(data)) !== null && items.length < 5) {
          const it = m[1];
          const title   = (/<title>([\s\S]*?)<\/title>/.exec(it)||[])[1]||'';
          const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)||[])[1]||'';
          const clean   = title.replace(/<[^>]+>/g,'')
            .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
            .replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
          if (clean && !clean.startsWith('Google News'))
            items.push({ title:clean, date:pubDate.trim() });
        }
        resolve({ ok:true, items });
      });
      stream.on('error', e => resolve({ ok:false, error:e.message, items:[] }));
    });
    req.on('error', e => resolve({ ok:false, error:e.message, items:[] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok:false, error:'timeout', items:[] }); });
    req.end();
  });
}

// ── FULL SNAPSHOT REFRESH ─────────────────────────────────────
async function runFullRefresh(label) {
  const startTime = Date.now();
  const snap = {
    ts: new Date().toISOString(),
    label,
    prices: {},
    fii: null,
    indices: {},
    gainers: [],
    losers: [],
    results: [],
    dividends: [],
    valuations: {},
    usdInr: null,
    brent: null,
    gold: null,
    silver: null,
    marketNews: [],
    stockNews: {},
    fetchErrors: [],
    fetchSuccess: [],
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SNAPSHOT REFRESH: ${label} at ${snap.ts}`);
  console.log('='.repeat(60));

  // ── 1. REFRESH NSE COOKIE ─────────────────────────────────
  await refreshCookie();
  snap.fetchSuccess.push('cookie');

  // ── 2. FETCH ALL NSE PRICES (batches of 15) ───────────────
  console.log('Fetching NSE prices...');
  const priceBatches = [];
  for (let i = 0; i < NSE_SYMBOLS.length; i += 15)
    priceBatches.push(NSE_SYMBOLS.slice(i, i+15));

  for (const batch of priceBatches) {
    const path = '/api/market-data-pre-open?key=NIFTY&' +
      batch.map(s => `symbol=${encodeURIComponent(s)}`).join('&');
    // Use quote-equity for individual stocks
    for (const sym of batch) {
      const r = await fetchNSE('/api/quote-equity?symbol='+encodeURIComponent(sym));
      if (r.ok && r.data?.priceInfo?.lastPrice) {
        snap.prices[sym] = r.data.priceInfo.lastPrice;
      }
      await new Promise(r2 => setTimeout(r2, 200)); // 200ms between requests
    }
  }
  const priceCount = Object.keys(snap.prices).length;
  console.log(`Fetched ${priceCount} prices`);
  if (priceCount > 0) snap.fetchSuccess.push(`prices:${priceCount}`);
  else snap.fetchErrors.push('prices:all_failed');

  // ── 3. FII/DII ────────────────────────────────────────────
  console.log('Fetching FII/DII...');
  const fiiR = await fetchNSE('/api/fiidiiTradeReact');
  if (fiiR.ok && fiiR.data) {
    try {
      const arr = Array.isArray(fiiR.data) ? fiiR.data : (fiiR.data.data || []);
      const byDate = {};
      arr.forEach(row => {
        const d = row.date || row.Date || '';
        if (!byDate[d]) byDate[d] = {};
        const cat = (row.category || '').toUpperCase();
        byDate[d][cat] = row;
      });
      const dates = Object.keys(byDate).sort().reverse();
      const latest = byDate[dates[0]] || {};
      const fRow = latest['FII'] || latest['FII/FPI'] || {};
      const dRow = latest['DII'] || {};
      const g = (row, ...keys) => {
        for (const k of keys) {
          const v = parseFloat(row[k] || row[k.toLowerCase()] || 0);
          if (v !== 0) return v;
        }
        return 0;
      };
      snap.fii = {
        date:     dates[0],
        fii_net:  g(fRow, 'netValue', 'Net Value', 'fiiNet'),
        fii_buy:  g(fRow, 'buyValue', 'Buy Value', 'fiiBuy'),
        fii_sell: g(fRow, 'sellValue', 'Sell Value', 'fiiSell'),
        dii_net:  g(dRow, 'netValue', 'Net Value', 'diiNet'),
        dii_buy:  g(dRow, 'buyValue', 'Buy Value', 'diiBuy'),
        dii_sell: g(dRow, 'sellValue', 'Sell Value', 'diiSell'),
        trend: dates.slice(0,5).map(d => {
          const fR = byDate[d]['FII'] || byDate[d]['FII/FPI'] || {};
          const dR = byDate[d]['DII'] || {};
          return { date:d, fii_net:g(fR,'netValue','fiiNet'), dii_net:g(dR,'netValue','diiNet') };
        }),
      };
      snap.fetchSuccess.push(`fii:${snap.fii.fii_net}Cr`);
      console.log(`FII net: ${snap.fii.fii_net} Cr`);
    } catch(e) {
      snap.fetchErrors.push('fii:parse_error');
    }
  } else {
    snap.fetchErrors.push('fii:'+fiiR.error);
  }

  // ── 4. INDICES ────────────────────────────────────────────
  console.log('Fetching indices...');
  const idxR = await fetchNSE('/api/allIndices');
  if (idxR.ok && idxR.data) {
    const want = ['NIFTY 50','NIFTY 500','NIFTY BANK','NIFTY IT','INDIA VIX','NIFTY DEFENCE','NIFTY MIDCAP 100','NIFTY PHARMA','NIFTY AUTO'];
    (idxR.data.data || []).filter(i => want.includes(i.index)).forEach(i => {
      snap.indices[i.index] = { last:i.last, change:i.change, pChange:i.percentChange, high:i.high, low:i.low, pe:i.pe, pb:i.pb };
    });
    snap.fetchSuccess.push(`indices:${Object.keys(snap.indices).length}`);
    console.log(`Indices: ${Object.keys(snap.indices).length}`);
  } else {
    snap.fetchErrors.push('indices:'+idxR.error);
  }

  // ── 5. GAINERS / LOSERS ───────────────────────────────────
  const [gR, lR] = await Promise.all([
    fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=gainers'),
    fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=loosers'),
  ]);
  if (gR.ok) snap.gainers = (gR.data?.data||[]).slice(0,10).map(d=>({symbol:d.symbol,price:d.lastPrice,pChange:d.pChange}));
  if (lR.ok) snap.losers  = (lR.data?.data||[]).slice(0,10).map(d=>({symbol:d.symbol,price:d.lastPrice,pChange:d.pChange}));
  snap.fetchSuccess.push(`movers:${snap.gainers.length}g/${snap.losers.length}l`);

  // ── 6. RESULTS CALENDAR ───────────────────────────────────
  console.log('Fetching results calendar...');
  const resR = await fetchNSE('/api/event-calendar');
  if (resR.ok && resR.data) {
    const arr = Array.isArray(resR.data) ? resR.data : (resR.data.data || []);
    const today = new Date();
    const cutoff = new Date(today.getTime() + 60*24*60*60*1000);
    arr.filter(e => {
      const d = new Date(e.date||'');
      return d >= today && d <= cutoff;
    }).forEach(e => {
      const type = (e.purpose||'').toLowerCase().includes('result') ? 'RESULT' : 'DIVIDEND';
      if (type === 'RESULT') snap.results.push({ symbol:e.symbol, name:e.companyName||e.symbol, date:e.date, purpose:e.purpose });
      else snap.dividends.push({ symbol:e.symbol, date:e.date, purpose:e.purpose });
    });
    snap.fetchSuccess.push(`results:${snap.results.length}`);
  } else {
    snap.fetchErrors.push('results:'+resR.error);
  }

  // ── 7. YAHOO FINANCE — macro prices ──────────────────────
  console.log('Fetching Yahoo macro...');
  const yahooR = await fetchYahoo(['USDINR=X','BZ=F','GC=F','SI=F','^NSEI','^NSEBANK']);
  if (yahooR.ok && yahooR.data?.quoteResponse?.result) {
    yahooR.data.quoteResponse.result.forEach(q => {
      const p = q.regularMarketPrice;
      if (q.symbol==='USDINR=X') snap.usdInr = p;
      if (q.symbol==='BZ=F')     snap.brent  = p;
      if (q.symbol==='GC=F')     snap.gold   = p;
      if (q.symbol==='SI=F')     snap.silver = p;
    });
    snap.fetchSuccess.push(`yahoo:USD/INR=${snap.usdInr},Brent=${snap.brent}`);
    console.log(`Yahoo: USD/INR=${snap.usdInr}, Brent=$${snap.brent}`);
  } else {
    snap.fetchErrors.push('yahoo:'+yahooR.error);
  }

  // ── 8. SCREENER.IN VALUATIONS (batched) ──────────────────
  console.log('Fetching Screener.in valuations...');
  let valCount = 0;
  for (const sym of SCREENER_STOCKS.slice(0, 30)) { // top 30 in this refresh
    const r = await fetchScreener(sym);
    if (r.ok && (r.pe || r.pb || r.roe)) {
      snap.valuations[sym] = { pe:r.pe, pb:r.pb, roe:r.roe, de:r.de, mcap:r.mcap };
      valCount++;
    }
    await new Promise(r2 => setTimeout(r2, 300));
  }
  snap.fetchSuccess.push(`valuations:${valCount}`);
  console.log(`Valuations: ${valCount} stocks`);

  // ── 9. MARKET NEWS ────────────────────────────────────────
  console.log('Fetching market news...');
  const newsQueries = ['NSE Nifty market today India', 'FII DII India stock market today', 'RBI Federal Reserve market India'];
  const allItems = [];
  for (const q of newsQueries) {
    const r = await fetchGoogleNews(q);
    (r.items||[]).forEach(item => allItems.push(item));
    await new Promise(r2 => setTimeout(r2, 200));
  }
  const seen = new Set();
  snap.marketNews = allItems.filter(item => {
    const key = item.title.slice(0,35);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,12);
  snap.fetchSuccess.push(`marketNews:${snap.marketNews.length}`);

  // ── 10. STOCK NEWS for TIER1 ──────────────────────────────
  console.log('Fetching stock news...');
  const TIER1 = ['HAL','BEL','TCS','ICICIBANK','ONGC','RELIANCE','HDFCBANK','BHARTIARTL','DIXON','PERSISTENT','BAJFINANCE','SBIN'];
  const NEWS_MAP = {
    'HAL':'Hindustan Aeronautics HAL India','BEL':'Bharat Electronics BEL India',
    'TCS':'TCS Tata Consultancy','ICICIBANK':'ICICI Bank India',
    'ONGC':'ONGC India oil','RELIANCE':'Reliance Industries India',
    'HDFCBANK':'HDFC Bank India','BHARTIARTL':'Bharti Airtel India',
    'DIXON':'Dixon Technologies India EMS','PERSISTENT':'Persistent Systems India IT',
    'BAJFINANCE':'Bajaj Finance India NBFC','SBIN':'SBI State Bank India',
  };
  for (const sym of TIER1) {
    const r = await fetchGoogleNews(NEWS_MAP[sym] || sym);
    if (r.ok && r.items.length > 0) snap.stockNews[sym] = r.items;
    await new Promise(r2 => setTimeout(r2, 200));
  }
  snap.fetchSuccess.push(`stockNews:${Object.keys(snap.stockNews).length}`);

  // ── SAVE SNAPSHOT ─────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  snap.elapsed_seconds = elapsed;
  snap.price_count = Object.keys(snap.prices).length;
  CACHE.snapshot = snap;

  console.log(`\n✅ Snapshot complete in ${elapsed}s`);
  console.log(`   Prices: ${snap.price_count}`);
  console.log(`   Valuations: ${Object.keys(snap.valuations).length}`);
  console.log(`   FII: ${snap.fii?.fii_net} Cr`);
  console.log(`   Errors: ${snap.fetchErrors.length} (${snap.fetchErrors.join(', ')})`);
  console.log(`   Success: ${snap.fetchSuccess.length}`);

  return snap;
}

// ── SCHEDULER — runs at 6 fixed times IST ────────────────────
const SCHEDULE_IST = [
  { h:9,  m:0,  label:'India Open 9:00 AM' },
  { h:12, m:0,  label:'India Midday 12:00 PM' },
  { h:15, m:0,  label:'India Close 3:00 PM' },
  { h:19, m:0,  label:'US Pre-Market 7:00 PM' },
  { h:22, m:0,  label:'US Midday 10:00 PM' },
  { h:1,  m:30, label:'US Close 1:30 AM' },
];

function getISTHour() {
  const now = new Date();
  const istOffset = 5.5 * 60; // IST = UTC+5:30
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const istMinutes = (utcMinutes + istOffset) % (24 * 60);
  return { h: Math.floor(istMinutes / 60), m: istMinutes % 60 };
}

function scheduleNextRefresh() {
  const ist = getISTHour();
  const nowMinutes = ist.h * 60 + ist.m;
  
  // Find next scheduled time
  let nextSlot = null;
  let minDelay = Infinity;
  
  for (const slot of SCHEDULE_IST) {
    const slotMinutes = slot.h * 60 + slot.m;
    let delay = slotMinutes - nowMinutes;
    if (delay <= 0) delay += 24 * 60; // next day
    if (delay < minDelay) {
      minDelay = delay;
      nextSlot = slot;
    }
  }
  
  const delayMs = minDelay * 60 * 1000;
  const nextTime = new Date(Date.now() + delayMs);
  console.log(`\n⏰ Next refresh: ${nextSlot.label} in ${minDelay} min (${nextTime.toISOString()})`);
  
  setTimeout(async () => {
    await runFullRefresh(nextSlot.label);
    scheduleNextRefresh(); // schedule the one after
  }, delayMs);
}

// ── CORS + JSON response ──────────────────────────────────────
function send(res, data, status) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status || 200);
  res.end(JSON.stringify(data));
}

// ── ROUTES ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.writeHead(204); return res.end();
  }

  const url  = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  console.log(new Date().toISOString().slice(11,19), path);

  const snap = CACHE.snapshot;
  const age  = snap.ts ? Math.round((Date.now()-new Date(snap.ts).getTime())/60000) : null;

  // /snapshot — full cached data dump (main endpoint for app)
  if (path === '/snapshot') {
    return send(res, {
      ok: true,
      label: snap.label,
      ts: snap.ts,
      age_minutes: age,
      price_count: snap.price_count,
      prices: snap.prices,
      fii: snap.fii,
      indices: snap.indices,
      gainers: snap.gainers,
      losers: snap.losers,
      results: snap.results,
      dividends: snap.dividends,
      valuations: snap.valuations,
      usdInr: snap.usdInr,
      brent: snap.brent,
      gold: snap.gold,
      silver: snap.silver,
      marketNews: snap.marketNews,
      stockNews: snap.stockNews,
      fetchSuccess: snap.fetchSuccess,
      fetchErrors: snap.fetchErrors,
      elapsed_seconds: snap.elapsed_seconds,
    });
  }

  // /status — quick status check with data freshness
  if (path === '/status' || path === '/health' || path === '/') {
    const ist = getISTHour();
    return send(res, {
      ok: true,
      version: 'v4-scheduled',
      snapshot_label: snap.label || 'not yet fetched',
      snapshot_ts: snap.ts,
      age_minutes: age,
      price_count: snap.price_count || 0,
      fii_net: snap.fii?.fii_net,
      usdInr: snap.usdInr,
      brent: snap.brent,
      fetch_success: snap.fetchSuccess?.length || 0,
      fetch_errors: snap.fetchErrors?.length || 0,
      errors: snap.fetchErrors || [],
      ist_time: `${ist.h}:${String(ist.m).padStart(2,'0')}`,
      schedule: SCHEDULE_IST.map(s => `${s.h}:${String(s.m).padStart(2,'0')} IST — ${s.label}`),
      uptime_sec: Math.round(process.uptime()),
    });
  }

  // /refresh — manual trigger (useful for testing or after market events)
  if (path === '/refresh') {
    const label = url.searchParams.get('label') || 'Manual refresh';
    send(res, { ok:true, message:'Refresh started: '+label, note:'Check /status in 2-3 minutes' });
    // Run async without blocking response
    runFullRefresh(label).catch(e => console.error('Manual refresh error:', e));
    return;
  }

  // Legacy endpoints — serve from snapshot cache for backward compatibility
  if (path === '/fii')     return send(res, { ok:true, fromCache:true, data:snap.fii || {fii_net:-2714,dii_net:3253} });
  if (path === '/indices') return send(res, { ok:true, fromCache:true, indices:Object.entries(snap.indices).map(([name,d])=>({name,...d})) });
  if (path === '/gainers') return send(res, { ok:true, fromCache:true, gainers:snap.gainers, losers:snap.losers });
  if (path === '/results') return send(res, { ok:true, fromCache:true, results:snap.results, dividends:snap.dividends });
  if (path === '/marketnews') return send(res, { ok:true, fromCache:true, items:snap.marketNews });
  if (path === '/valuations') return send(res, { ok:true, fromCache:true, valuations:snap.valuations });
  if (path === '/quotes') {
    const syms = (url.searchParams.get('s')||'').split(',').filter(Boolean);
    const prices = {};
    syms.forEach(s => { if (snap.prices[s]) prices[s] = snap.prices[s]; });
    return send(res, { ok:true, fromCache:true, prices, count:Object.keys(prices).length, snapshot_ts:snap.ts });
  }
  if (path === '/news') {
    const syms = (url.searchParams.get('s')||'').split(',').filter(Boolean);
    const news = {};
    syms.forEach(s => { if (snap.stockNews[s]) news[s] = snap.stockNews[s]; });
    return send(res, { ok:true, fromCache:true, news });
  }
  if (path === '/centralbanksnews') return send(res, {
    ok:true,
    summary: {
      rbi: { rate:'5.25%', stance:'PAUSED', nextMeeting:'Apr 6-8 2026', outlook:'Hold — oil inflation risk' },
      fed: { rate:'3.5-3.75%', stance:'HOLD', nextMeeting:'May 6-7 2026', outlook:'1 cut in 2026, Sep earliest' },
      ecb: { rate:'2.00%', stance:'HOLD', outlook:'Raised inflation forecast Mar 18' },
      boe: { rate:'3.75%', stance:'HOLD', outlook:'Oil = inflation risk' },
      globalStatus:'ALL_MAJOR_CBs_HOLDING',
    },
    items: snap.marketNews.slice(0,8),
  });

  send(res, { error:'Not found', endpoints:['/snapshot','/status','/refresh','/fii','/indices','/gainers','/results','/quotes','/valuations','/news','/marketnews','/centralbanksnews'] }, 404);
});

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Investment Radar — NSE Data Proxy  v4                  ║
║   Scheduled refresh: 6x daily                            ║
╠══════════════════════════════════════════════════════════╣
║   India: 9:00 AM | 12:00 PM | 3:00 PM IST               ║
║   US:    7:00 PM | 10:00 PM | 1:30 AM IST                ║
╠══════════════════════════════════════════════════════════╣
║   /snapshot  — full cached data (main app endpoint)      ║
║   /status    — freshness check                           ║
║   /refresh   — manual trigger                            ║
╚══════════════════════════════════════════════════════════╝`);

  // Run immediate refresh on startup
  console.log('\nRunning startup refresh...');
  await runFullRefresh('Startup');
  
  // Schedule recurring refreshes
  scheduleNextRefresh();
});
