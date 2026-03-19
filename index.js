// ═══════════════════════════════════════════════════════════════
// Investment Radar — NSE India Data Proxy
// Deploy on Replit (free tier) — Node.js
// Fetches live: FII/DII flows, bulk deals, results calendar,
//               Nifty 500 prices, index data
// ═══════════════════════════════════════════════════════════════

const https = require('https');
const http  = require('http');

const PORT  = process.env.PORT || 3000;

// ── NSE headers (mimics browser, required by NSE) ─────────────
const NSE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://www.nseindia.com/',
  'Origin':          'https://www.nseindia.com',
  'sec-ch-ua':       '"Chromium";v="122", "Not(A:Brand";v="24"',
  'sec-ch-ua-mobile':'?0',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-origin',
  'Connection':      'keep-alive',
};

// ── Cookie cache (NSE requires a session cookie) ──────────────
let NSE_COOKIE = '';
let cookieExpiry = 0;

function getNSECookie() {
  return new Promise((resolve) => {
    if (NSE_COOKIE && Date.now() < cookieExpiry) {
      return resolve(NSE_COOKIE);
    }
    const req = https.get('https://www.nseindia.com/', {
      headers: {
        'User-Agent': NSE_HEADERS['User-Agent'],
        'Accept': 'text/html',
      }
    }, (res) => {
      const cookies = res.headers['set-cookie'] || [];
      NSE_COOKIE = cookies.map(c => c.split(';')[0]).join('; ');
      cookieExpiry = Date.now() + 25 * 60 * 1000; // 25 min
      resolve(NSE_COOKIE);
    });
    req.on('error', () => resolve(''));
    req.setTimeout(8000, () => { req.destroy(); resolve(''); });
  });
}

// ── Generic NSE fetch ─────────────────────────────────────────
function fetchNSE(path) {
  return new Promise(async (resolve) => {
    const cookie = await getNSECookie();
    const headers = { ...NSE_HEADERS, 'Cookie': cookie };
    const url = 'https://www.nseindia.com' + path;
    const req = https.get(url, { headers }, (res) => {
      let data = '';
      // Handle gzip
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        const zlib = require('zlib');
        stream = res.pipe(zlib.createGunzip());
      }
      stream.on('data', chunk => data += chunk);
      stream.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, error: 'JSON parse failed', raw: data.slice(0, 200) }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

// ── BSE bulk deals fetch ──────────────────────────────────────
function fetchBSEBulk() {
  return new Promise((resolve) => {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    const dateStr = `${dd}/${mm}/${yyyy}`;
    const url = `https://api.bseindia.com/BseIndiaAPI/api/BulkDeal/w?strDate=${dateStr}&endDate=${dateStr}`;
    const req = https.get(url, {
      headers: { 'User-Agent': NSE_HEADERS['User-Agent'], 'Referer': 'https://www.bseindia.com/' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, data: JSON.parse(data) }); }
        catch(e) { resolve({ ok: false, error: 'BSE parse failed' }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

// ── Response cache (avoid hammering NSE) ─────────────────────
const CACHE = {};
const CACHE_TTL = {
  fii:     5  * 60 * 1000,  // 5 min
  bulk:    10 * 60 * 1000,  // 10 min
  results: 30 * 60 * 1000,  // 30 min
  indices: 2  * 60 * 1000,  // 2 min
  quote:   2  * 60 * 1000,  // 2 min
  gainers: 5  * 60 * 1000,  // 5 min
};

function cached(key, ttl, fn) {
  const now = Date.now();
  if (CACHE[key] && now - CACHE[key].ts < ttl) {
    return Promise.resolve({ fromCache: true, ...CACHE[key].val });
  }
  return fn().then(result => {
    CACHE[key] = { ts: now, val: result };
    return result;
  });
}

// ── CORS headers ──────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

function send(res, data, status) {
  cors(res);
  res.writeHead(status || 200);
  res.end(JSON.stringify(data));
}

// ── ROUTE HANDLERS ────────────────────────────────────────────

// 1. FII/DII daily flows
async function handleFII(res) {
  const result = await cached('fii', CACHE_TTL.fii, () =>
    fetchNSE('/api/fiidiiTradeReact')
  );
  if (!result.ok) return send(res, { error: result.error, fallback: true });
  // Parse and clean FII data
  try {
    const raw = result.data;
    const fiiData = Array.isArray(raw) ? raw : (raw.data || []);
    // Get most recent day's data
    const latest = fiiData[0] || {};
    const parsed = {
      date:       latest.date || new Date().toLocaleDateString('en-IN'),
      fii_buy:    parseFloat(latest.fiiBuy || latest.fii_buy || 0),
      fii_sell:   parseFloat(latest.fiiSell || latest.fii_sell || 0),
      fii_net:    parseFloat(latest.fiiNet || latest.fii_net || 0),
      dii_buy:    parseFloat(latest.diiBuy || latest.dii_buy || 0),
      dii_sell:   parseFloat(latest.diiSell || latest.dii_sell || 0),
      dii_net:    parseFloat(latest.diiNet || latest.dii_net || 0),
      raw_latest: latest,
      // Last 5 days for trend
      trend: fiiData.slice(0, 5).map(d => ({
        date: d.date,
        fii_net: parseFloat(d.fiiNet || d.fii_net || 0),
        dii_net: parseFloat(d.diiNet || d.dii_net || 0),
      }))
    };
    send(res, { ok: true, fromCache: result.fromCache || false, data: parsed });
  } catch(e) {
    send(res, { ok: false, error: 'Parse error: ' + e.message, raw: result.data });
  }
}

// 2. Bulk deals today
async function handleBulk(res) {
  const [nseBulk, bseBulk] = await Promise.all([
    cached('bulk_nse', CACHE_TTL.bulk, () => fetchNSE('/api/bulk-deals')),
    cached('bulk_bse', CACHE_TTL.bulk, () => fetchBSEBulk()),
  ]);
  const deals = [];
  // NSE bulk deals
  if (nseBulk.ok) {
    const raw = nseBulk.data;
    const arr = Array.isArray(raw) ? raw : (raw.data || []);
    arr.slice(0, 20).forEach(d => deals.push({
      exchange: 'NSE',
      symbol:   d.symbol || d.Symbol,
      name:     d.name || d.Symbol,
      client:   d.clientName || d.Client,
      type:     (d.buySell || d.BS || '').toUpperCase(),
      qty:      parseInt(d.quantityTraded || d.Quantity || 0),
      price:    parseFloat(d.tradePrice || d.Price || 0),
      date:     d.date || d.Date,
    }));
  }
  // BSE bulk deals
  if (bseBulk.ok) {
    const arr = bseBulk.data?.Table || [];
    arr.slice(0, 10).forEach(d => deals.push({
      exchange: 'BSE',
      symbol:   d.scrip_cd || '',
      name:     d.Scrip_Name || '',
      client:   d.Client_Name || '',
      type:     (d.Deal_Type || '').toUpperCase(),
      qty:      parseInt(d.Quantity || 0),
      price:    parseFloat(d.Deal_Price || 0),
      date:     d.Deal_Date || '',
    }));
  }
  // Filter for significant deals (institutional)
  const significant = deals.filter(d => d.qty > 50000 || d.price * d.qty > 5000000);
  send(res, { ok: true, total: deals.length, significant, all: deals.slice(0, 30) });
}

// 3. Results/earnings calendar
async function handleResults(res) {
  const result = await cached('results', CACHE_TTL.results, () =>
    fetchNSE('/api/event-calendar')
  );
  if (!result.ok) return send(res, { error: result.error });
  try {
    const raw = result.data;
    const arr = Array.isArray(raw) ? raw : (raw.data || []);
    // Filter for upcoming results and dividends
    const today = new Date();
    const upcoming = arr.filter(e => {
      const d = new Date(e.date || e.Date || '');
      return d >= today && d <= new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 days
    }).map(e => ({
      symbol:  e.symbol || e.Symbol || '',
      name:    e.companyName || e.Company || e.symbol || '',
      date:    e.date || e.Date || '',
      purpose: e.purpose || e.Purpose || '',
      type:    (e.purpose || '').toLowerCase().includes('result') ? 'RESULT' :
               (e.purpose || '').toLowerCase().includes('dividend') ? 'DIVIDEND' : 'OTHER',
    })).sort((a, b) => new Date(a.date) - new Date(b.date));
    // Separate results from dividends
    const results = upcoming.filter(e => e.type === 'RESULT').slice(0, 30);
    const dividends = upcoming.filter(e => e.type === 'DIVIDEND').slice(0, 20);
    // Check if any of our tracked stocks are in there
    const TRACKED = ['TCS','INFOSYS','HCLTECH','WIPRO','HAL','BEL','ICICIBANK','HDFCBANK','KOTAKBANK','SBI','ONGC','NTPC','DIXON','PERSISTENTSYS','BAJFINANCE','SUNTV','SUNPHARMA','POLYCAB'];
    const ourStocks = results.filter(e => TRACKED.some(t => (e.symbol||'').toUpperCase().includes(t)));
    send(res, { ok: true, fromCache: result.fromCache || false, results, dividends, ourTrackedResults: ourStocks });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// 4. Index quotes (Nifty 50, Nifty 500, Bank Nifty, Nifty IT)
async function handleIndices(res) {
  const result = await cached('indices', CACHE_TTL.indices, () =>
    fetchNSE('/api/allIndices')
  );
  if (!result.ok) return send(res, { error: result.error });
  try {
    const arr = result.data?.data || [];
    const want = ['NIFTY 50','NIFTY 500','NIFTY BANK','NIFTY IT','NIFTY MIDCAP 100','INDIA VIX','NIFTY SMALLCAP 100','NIFTY DEFENCE','NIFTY PHARMA'];
    const indices = arr.filter(i => want.includes(i.index)).map(i => ({
      name:    i.index,
      last:    i.last,
      change:  i.change,
      pChange: i.percentChange,
      high:    i.high,
      low:     i.low,
      open:    i.open,
      pe:      i.pe,
      pb:      i.pb,
      div:     i.divYield,
    }));
    send(res, { ok: true, fromCache: result.fromCache || false, indices });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// 5. Individual stock quote
async function handleQuote(res, symbol) {
  if (!symbol) return send(res, { error: 'symbol required' }, 400);
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9&]/g, '');
  const result = await cached('quote_' + sym, CACHE_TTL.quote, () =>
    fetchNSE('/api/quote-equity?symbol=' + encodeURIComponent(sym))
  );
  if (!result.ok) return send(res, { error: result.error });
  try {
    const d = result.data;
    const info = d.info || {};
    const pd = d.priceInfo || {};
    send(res, {
      ok:           true,
      symbol:       info.symbol,
      name:         info.companyName,
      price:        pd.lastPrice,
      open:         pd.open,
      high:         pd.intraDayHighLow?.max,
      low:          pd.intraDayHighLow?.min,
      close:        pd.previousClose,
      change:       pd.change,
      pChange:      pd.pChange,
      weekHigh52:   pd['52weekHighLow']?.max,
      weekLow52:    pd['52weekHighLow']?.min,
      volume:       d.marketDeptOrderBook?.tradeInfo?.totalTradedVolume,
      marketCap:    d.industryInfo?.basicIndustry,
    });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// 6. Multi-quote (batch up to 20 symbols)
async function handleMultiQuote(res, symbols) {
  if (!symbols) return send(res, { error: 'symbols required' }, 400);
  const syms = symbols.split(',').slice(0, 20).map(s => s.trim().toUpperCase());
  const results = await Promise.all(syms.map(sym =>
    cached('quote_' + sym, CACHE_TTL.quote, () =>
      fetchNSE('/api/quote-equity?symbol=' + encodeURIComponent(sym))
    ).then(r => {
      if (!r.ok) return { symbol: sym, error: r.error };
      const pd = r.data?.priceInfo || {};
      return { symbol: sym, price: pd.lastPrice, change: pd.change, pChange: pd.pChange, close: pd.previousClose };
    })
  ));
  const prices = {};
  results.forEach(r => { if (r.price) prices[r.symbol] = r.price; });
  send(res, { ok: true, prices, details: results });
}

// 7. Top gainers / losers from Nifty 500
async function handleGainers(res) {
  const [gainers, losers] = await Promise.all([
    cached('gainers', CACHE_TTL.gainers, () =>
      fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=gainers')
    ),
    cached('losers', CACHE_TTL.gainers, () =>
      fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=loosers')
    ),
  ]);
  const parseList = (r) => {
    if (!r.ok) return [];
    const arr = r.data?.data || [];
    return arr.slice(0, 10).map(d => ({
      symbol:  d.symbol,
      name:    d.meta?.companyName || d.symbol,
      price:   d.lastPrice,
      pChange: d.pChange,
      change:  d.change,
    }));
  };
  send(res, { ok: true, gainers: parseList(gainers), losers: parseList(losers) });
}

// 8. Health check + data freshness
async function handleHealth(res) {
  const cacheStatus = {};
  Object.keys(CACHE).forEach(k => {
    const age = Math.round((Date.now() - CACHE[k].ts) / 1000);
    cacheStatus[k] = { age_seconds: age, has_data: true };
  });
  send(res, {
    status:    'ok',
    timestamp: new Date().toISOString(),
    uptime:    process.uptime(),
    cache:     cacheStatus,
    endpoints: [
      'GET /fii          — FII/DII daily flows',
      'GET /bulk         — Bulk and block deals today',
      'GET /results      — Upcoming earnings + dividend calendar (60 days)',
      'GET /indices      — Nifty 50, 500, Bank, IT, VIX',
      'GET /quote?s=TCS  — Single stock quote',
      'GET /quotes?s=TCS,INFY,HAL — Batch quotes (max 20)',
      'GET /gainers      — Top gainers/losers Nifty 500 today',
      'GET /health       — This page',
    ]
  });
}

// ── ROUTER ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }

  console.log(`${new Date().toISOString()} ${req.method} ${path}`);

  try {
    if (path === '/'        || path === '/health') return await handleHealth(res);
    if (path === '/fii')                           return await handleFII(res);
    if (path === '/bulk')                          return await handleBulk(res);
    if (path === '/results')                       return await handleResults(res);
    if (path === '/indices')                       return await handleIndices(res);
    if (path === '/gainers')                       return await handleGainers(res);
    if (path === '/quote')   return await handleQuote(res, url.searchParams.get('s') || url.searchParams.get('symbol'));
    if (path === '/quotes')  return await handleMultiQuote(res, url.searchParams.get('s') || url.searchParams.get('symbols'));
    send(res, { error: 'Not found', endpoints: ['/', '/fii', '/bulk', '/results', '/indices', '/quote', '/quotes', '/gainers'] }, 404);
  } catch(e) {
    console.error('Server error:', e);
    send(res, { error: 'Internal error', message: e.message }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║       Investment Radar — NSE Data Proxy                  ║
║       Running on port ${PORT}                              ║
╠══════════════════════════════════════════════════════════╣
║  Endpoints:                                              ║
║  /fii     — FII/DII live flows                          ║
║  /bulk    — Bulk deals today                            ║
║  /results — Earnings calendar (60 days)                 ║
║  /indices — Nifty 50/500/Bank/IT/VIX                    ║
║  /quote   — Single stock: /quote?s=TCS                  ║
║  /quotes  — Batch: /quotes?s=TCS,INFY,HAL               ║
║  /gainers — Top gainers/losers Nifty 500                ║
║  /health  — Status + cache                              ║
╚══════════════════════════════════════════════════════════╝
  `);
});
