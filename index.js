// ═══════════════════════════════════════════════════════════════
// Investment Radar — NSE India Data Proxy v2
// Fixed: better cookie handling, gzip, fallback data
// ═══════════════════════════════════════════════════════════════

const https  = require('https');
const http   = require('http');
const zlib   = require('zlib');
const PORT   = process.env.PORT || 3000;

// ── NSE session cookie cache ───────────────────────────────────
let NSE_COOKIE   = '';
let COOKIE_TIME  = 0;
const COOKIE_TTL = 20 * 60 * 1000; // 20 min

function refreshCookie() {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'www.nseindia.com',
      path: '/',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      timeout: 10000,
    };
    const req = https.request(opts, (res) => {
      // drain body
      res.on('data', () => {});
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        if (cookies.length > 0) {
          NSE_COOKIE  = cookies.map(c => c.split(';')[0]).join('; ');
          COOKIE_TIME = Date.now();
          console.log('Cookie refreshed OK, cookies:', cookies.length);
        }
        resolve(NSE_COOKIE);
      });
    });
    req.on('error', (e) => { console.log('Cookie error:', e.message); resolve(''); });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

async function getCookie() {
  if (!NSE_COOKIE || Date.now() - COOKIE_TIME > COOKIE_TTL) {
    await refreshCookie();
  }
  return NSE_COOKIE;
}

// ── Generic NSE API fetch ──────────────────────────────────────
async function fetchNSE(apiPath) {
  const cookie = await getCookie();
  return new Promise((resolve) => {
    const opts = {
      hostname: 'www.nseindia.com',
      path: apiPath,
      method: 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept':          'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer':         'https://www.nseindia.com/',
        'Origin':          'https://www.nseindia.com',
        'Connection':      'keep-alive',
        'Cookie':          cookie,
        'sec-fetch-dest':  'empty',
        'sec-fetch-mode':  'cors',
        'sec-fetch-site':  'same-origin',
      },
      timeout: 12000,
    };

    const req = https.request(opts, (res) => {
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());

      let raw = '';
      stream.on('data', c => raw += c.toString());
      stream.on('end', () => {
        if (!raw || raw.trim() === '') {
          return resolve({ ok: false, error: 'empty response', status: res.statusCode });
        }
        try {
          resolve({ ok: true, data: JSON.parse(raw), status: res.statusCode });
        } catch(e) {
          // Sometimes NSE returns HTML when cookie expired
          if (raw.includes('<html') || raw.includes('<!DOCTYPE')) {
            NSE_COOKIE = ''; // force cookie refresh next time
            resolve({ ok: false, error: 'got HTML — cookie expired', status: res.statusCode });
          } else {
            resolve({ ok: false, error: 'JSON parse failed: ' + e.message, raw: raw.slice(0, 300), status: res.statusCode });
          }
        }
      });
      stream.on('error', e => resolve({ ok: false, error: 'stream: ' + e.message }));
    });

    req.on('error',   e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end();
  });
}

// ── Cache ──────────────────────────────────────────────────────
const CACHE = {};
function cached(key, ttlMs, fn) {
  const now = Date.now();
  if (CACHE[key] && now - CACHE[key].ts < ttlMs) {
    return Promise.resolve({ ...CACHE[key].val, fromCache: true });
  }
  return fn().then(r => { CACHE[key] = { ts: now, val: r }; return r; });
}

// ── CORS + JSON response ───────────────────────────────────────
function send(res, data, status) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(status || 200);
  res.end(JSON.stringify(data));
}

// ── Fallback FII data (hardcoded recent values) ────────────────
const FALLBACK_FII = {
  fallback: true,
  note: 'NSE API unavailable — using recent approximate values',
  date: new Date().toLocaleDateString('en-IN'),
  fii_net: -8000,
  dii_net: 5200,
  fii_buy: 12000,
  fii_sell: 20000,
  dii_buy: 18000,
  dii_sell: 12800,
  trend: [
    { date: 'Mar 19', fii_net: -8000,  dii_net: 5200  },
    { date: 'Mar 18', fii_net: -6500,  dii_net: 4800  },
    { date: 'Mar 17', fii_net: -9200,  dii_net: 6100  },
    { date: 'Mar 14', fii_net: -11000, dii_net: 7200  },
    { date: 'Mar 13', fii_net: -7800,  dii_net: 5500  },
  ]
};

// ── HANDLERS ──────────────────────────────────────────────────

// /health
async function handleHealth(res) {
  const cacheInfo = {};
  Object.keys(CACHE).forEach(k => {
    cacheInfo[k] = { age_sec: Math.round((Date.now() - CACHE[k].ts) / 1000) };
  });
  send(res, {
    status:      'ok',
    version:     'v2',
    timestamp:   new Date().toISOString(),
    uptime_sec:  Math.round(process.uptime()),
    cookie_age:  NSE_COOKIE ? Math.round((Date.now() - COOKIE_TIME) / 1000) + 's' : 'not fetched',
    cache:       cacheInfo,
    endpoints:   ['/health', '/fii', '/bulk', '/results', '/indices', '/quote?s=TCS', '/quotes?s=TCS,INFY', '/gainers'],
  });
}

// /fii — with retry logic
async function handleFII(res) {
  // Try up to 2 times (second time forces cookie refresh)
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) {
      console.log('FII attempt 2 — refreshing cookie');
      NSE_COOKIE = '';
      await refreshCookie();
    }

    const r = await cached('fii_' + attempt, attempt === 1 ? 5 * 60 * 1000 : 1000, () =>
      fetchNSE('/api/fiidiiTradeReact')
    );

    if (r.ok && r.data) {
      try {
        const raw  = r.data;
        const arr  = Array.isArray(raw) ? raw : (raw.data || raw.table || []);
        if (arr.length === 0) {
          console.log('FII: empty array, attempt', attempt);
          continue;
        }
        // NSE returns rows with a "category" field — one row per category per date
        // Categories: "FII", "DII", "MF" etc.
        // Fields: buyValue, sellValue, netValue (as of Mar 2026)
        // Group by date first, then extract FII and DII rows
        const byDate = {};
        arr.forEach(row => {
          const d = row.date || row.Date || row.tradingDate || '';
          if (!byDate[d]) byDate[d] = {};
          const cat = (row.category || row.Category || '').toUpperCase();
          byDate[d][cat] = row;
        });

        const dates    = Object.keys(byDate).sort().reverse(); // most recent first
        const latest   = byDate[dates[0]] || {};
        const fiiRow   = latest['FII'] || latest['FII/FPI'] || {};
        const diiRow   = latest['DII'] || {};

        // Universal field getter — tries multiple naming conventions
        const getVal = (row, ...keys) => {
          for (const k of keys) {
            const v = parseFloat(row[k] || row[k.toLowerCase()] || row[k.toUpperCase()] || 0);
            if (v !== 0) return v;
          }
          return 0;
        };

        const fiiBuy  = getVal(fiiRow, 'buyValue',  'Buy Value',  'fiiBuy',  'BUY');
        const fiiSell = getVal(fiiRow, 'sellValue', 'Sell Value', 'fiiSell', 'SELL');
        const fiiNet  = getVal(fiiRow, 'netValue',  'Net Value',  'fiiNet',  'NET');
        const diiBuy  = getVal(diiRow, 'buyValue',  'Buy Value',  'diiBuy',  'BUY');
        const diiSell = getVal(diiRow, 'sellValue', 'Sell Value', 'diiSell', 'SELL');
        const diiNet  = getVal(diiRow, 'netValue',  'Net Value',  'diiNet',  'NET');

        // Build 5-day trend
        const trend = dates.slice(0, 5).map(d => {
          const fR = byDate[d]['FII'] || byDate[d]['FII/FPI'] || {};
          const dR = byDate[d]['DII'] || {};
          return {
            date:    d,
            fii_net: getVal(fR, 'netValue', 'Net Value', 'fiiNet', 'NET'),
            dii_net: getVal(dR, 'netValue', 'Net Value', 'diiNet', 'NET'),
          };
        });

        return send(res, {
          ok:        true,
          source:    'NSE live',
          fromCache: r.fromCache || false,
          attempt,
          data: {
            date:     dates[0] || new Date().toLocaleDateString('en-IN'),
            fii_net:  fiiNet,
            fii_buy:  fiiBuy,
            fii_sell: fiiSell,
            dii_net:  diiNet,
            dii_buy:  diiBuy,
            dii_sell: diiSell,
            trend,
            categories_found: Object.keys(latest),
            raw_sample: fiiRow, // for future debugging
          }
        });
      } catch(e) {
        console.log('FII parse error:', e.message);
      }
    } else {
      console.log('FII attempt', attempt, 'failed:', r.error);
    }
  }

  // Both attempts failed — return fallback
  return send(res, { ok: false, ...FALLBACK_FII });
}

// /indices
async function handleIndices(res) {
  const r = await cached('indices', 2 * 60 * 1000, () =>
    fetchNSE('/api/allIndices')
  );
  if (!r.ok) {
    // Fallback indices
    return send(res, { ok: false, fallback: true, indices: [
      { name: 'NIFTY 50',   last: 23778, change: -120, pChange: -0.50 },
      { name: 'INDIA VIX',  last: 17.8,  change: -0.5, pChange: -2.73 },
      { name: 'NIFTY BANK', last: 51200, change: -280, pChange: -0.54 },
    ]});
  }
  try {
    const want = ['NIFTY 50','NIFTY 500','NIFTY BANK','NIFTY IT','NIFTY MIDCAP 100','INDIA VIX','NIFTY SMALLCAP 100','NIFTY DEFENCE','NIFTY PHARMA','NIFTY AUTO'];
    const all  = r.data?.data || [];
    const indices = all
      .filter(i => want.includes(i.index))
      .map(i => ({
        name:    i.index,
        last:    i.last,
        change:  i.change,
        pChange: i.percentChange,
        high:    i.high,
        low:     i.low,
        open:    i.open,
        pe:      i.pe,
        pb:      i.pb,
      }));
    send(res, { ok: true, fromCache: r.fromCache, indices });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// /results — earnings + dividends calendar
async function handleResults(res) {
  const r = await cached('results', 30 * 60 * 1000, () =>
    fetchNSE('/api/event-calendar')
  );
  if (!r.ok) return send(res, { ok: false, error: r.error, fallback: true, results: [], dividends: [] });
  try {
    const arr    = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    const today  = new Date();
    const cutoff = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000);

    const upcoming = arr
      .filter(e => {
        const d = new Date(e.date || e.Date || '');
        return d >= today && d <= cutoff;
      })
      .map(e => ({
        symbol:  e.symbol  || e.Symbol  || '',
        name:    e.companyName || e.Company || e.symbol || '',
        date:    e.date    || e.Date    || '',
        purpose: e.purpose || e.Purpose || '',
        type:    (e.purpose||'').toLowerCase().includes('result')   ? 'RESULT' :
                 (e.purpose||'').toLowerCase().includes('dividend') ? 'DIVIDEND' : 'OTHER',
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    const TRACKED = ['TCS','INFY','HCLTECH','WIPRO','HAL','BEL','ICICIBANK','HDFCBANK','SBIN','ONGC','NTPC','DIXON','PERSISTENT','BAJFINANCE','SUNPHARMA','POLYCAB','MARUTI','RELIANCE','TITAN','ITC'];
    send(res, {
      ok:               true,
      fromCache:        r.fromCache,
      results:          upcoming.filter(e => e.type === 'RESULT').slice(0, 40),
      dividends:        upcoming.filter(e => e.type === 'DIVIDEND').slice(0, 30),
      ourTrackedResults:upcoming.filter(e => e.type === 'RESULT' && TRACKED.some(t => e.symbol.toUpperCase().includes(t))),
    });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// /bulk deals
async function handleBulk(res) {
  const r = await cached('bulk', 10 * 60 * 1000, () =>
    fetchNSE('/api/bulk-deals')
  );
  if (!r.ok) return send(res, { ok: false, error: r.error, deals: [] });
  try {
    const arr  = Array.isArray(r.data) ? r.data : (r.data?.data || []);
    const deals = arr.slice(0, 30).map(d => ({
      symbol: d.symbol || d.Symbol || '',
      client: d.clientName || d.Client || '',
      type:   (d.buySell || d.BS || '').toUpperCase(),
      qty:    parseInt(d.quantityTraded || d.Quantity || 0),
      price:  parseFloat(d.tradePrice || d.Price || 0),
      value:  Math.round(parseInt(d.quantityTraded||0) * parseFloat(d.tradePrice||0)),
    }));
    const significant = deals.filter(d => d.value > 5000000); // > 50L
    send(res, { ok: true, fromCache: r.fromCache, significant, all: deals });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// /quote?s=TCS
async function handleQuote(res, sym) {
  if (!sym) return send(res, { error: 'Pass ?s=SYMBOL' }, 400);
  const s = sym.toUpperCase().replace(/[^A-Z0-9&-]/g, '');
  const r = await cached('q_' + s, 2 * 60 * 1000, () =>
    fetchNSE('/api/quote-equity?symbol=' + encodeURIComponent(s))
  );
  if (!r.ok) return send(res, { ok: false, error: r.error, symbol: s });
  try {
    const pd = r.data?.priceInfo || {};
    send(res, {
      ok:      true,
      symbol:  s,
      price:   pd.lastPrice,
      open:    pd.open,
      high:    pd.intraDayHighLow?.max,
      low:     pd.intraDayHighLow?.min,
      prev:    pd.previousClose,
      change:  pd.change,
      pChange: pd.pChange,
      w52h:    pd['52weekHighLow']?.max,
      w52l:    pd['52weekHighLow']?.min,
    });
  } catch(e) {
    send(res, { ok: false, error: e.message });
  }
}

// /quotes?s=TCS,INFY,HAL (batch, sequential to avoid rate limits)
async function handleMultiQuote(res, syms) {
  if (!syms) return send(res, { error: 'Pass ?s=SYM1,SYM2' }, 400);
  const list   = syms.split(',').slice(0, 15).map(s => s.trim().toUpperCase().replace(/[^A-Z0-9&-]/g,''));
  const prices = {};
  for (const sym of list) {
    const r = await cached('q_' + sym, 2 * 60 * 1000, () =>
      fetchNSE('/api/quote-equity?symbol=' + encodeURIComponent(sym))
    );
    if (r.ok && r.data?.priceInfo?.lastPrice) {
      prices[sym] = r.data.priceInfo.lastPrice;
    }
    // Small delay between requests to avoid NSE rate limit
    await new Promise(r2 => setTimeout(r2, 300));
  }
  send(res, { ok: true, prices, count: Object.keys(prices).length });
}

// /gainers
async function handleGainers(res) {
  const [gR, lR] = await Promise.all([
    cached('gainers', 5*60*1000, () => fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=gainers')),
    cached('losers',  5*60*1000, () => fetchNSE('/api/live-analysis-variations?index=nifty500&dataType=loosers')),
  ]);
  const parse = r => {
    if (!r.ok) return [];
    return (r.data?.data || []).slice(0, 10).map(d => ({
      symbol:  d.symbol,
      price:   d.lastPrice,
      pChange: d.pChange,
    }));
  };
  send(res, { ok: true, gainers: parse(gR), losers: parse(lR) });
}

// ── Google News RSS ───────────────────────────────────────────
function fetchGoogleNews(query) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query + ' NSE India stock');
    const path = '/rss/search?q=' + encoded + '&hl=en-IN&gl=IN&ceid=IN:en';
    const opts = {
      hostname: 'news.google.com', path, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)', 'Accept': 'application/rss+xml,text/xml,*/*' },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', c => data += c.toString());
      stream.on('end', () => {
        const items = [];
        const itemRx = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRx.exec(data)) !== null && items.length < 8) {
          const it = m[1];
          const title   = (/<title>([\s\S]*?)<\/title>/.exec(it)   || [])[1] || '';
          const pubDate = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(it)|| [])[1] || '';
          const clean   = title.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
          if (clean && !clean.startsWith('Google News')) items.push({ title: clean, date: pubDate.trim() });
        }
        resolve({ ok: true, items });
      });
      stream.on('error', e => resolve({ ok: false, error: e.message, items: [] }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message, items: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', items: [] }); });
    req.end();
  });
}

// /news?s=TCS,HAL,DDOG
async function handleNews(res, symbols) {
  if (!symbols) return send(res, { error: 'Pass ?s=SYM1,SYM2' }, 400);
  const syms = symbols.split(',').slice(0, 12).map(s => s.trim());
  const results = {};
  const nameMap = {
    'GOLD ETF':'gold ETF India', 'SILVER ETF':'silver ETF India',
    'HAL':'Hindustan Aeronautics HAL', 'BEL':'Bharat Electronics BEL',
    'DDOG':'Datadog stock', 'NET':'Cloudflare stock',
    'NBIS':'Nebius Group stock', 'CEG':'Constellation Energy stock',
    'BHARTI ARTL':'Bharti Airtel', 'COCHIN SHIP':'Cochin Shipyard',
    'INDUSIND BK':'IndusInd Bank', 'BANK OF BARO':'Bank of Baroda',
    'SHRIRAM FIN':'Shriram Finance', 'BHARAT FORGE':'Bharat Forge',
    'MTAR TECH':'MTAR Technologies', 'DATA PATTERNS':'Data Patterns India',
    'GARDEN REACH':'Garden Reach Shipbuilders', 'PARAS DEFENCE':'Paras Defence',
    'EICHER MOTOR':'Eicher Motors', 'HERO MOTOCO':'Hero MotoCorp',
    'BAJAJ AUTO':'Bajaj Auto', 'TVS MOTOR':'TVS Motor Company',
    'VARUN BEV':'Varun Beverages', 'NAVIN FLUOR':'Navin Fluorine',
    'AARTI INDS':'Aarti Industries', 'CLEAN SCIENCE':'Clean Science Technology',
    'GODREJ PROP':'Godrej Properties', 'OBEROI REAL':'Oberoi Realty',
    'ADANI PORTS':'Adani Ports', 'COAL INDIA':'Coal India',
    'INDUS TOWERS':'Indus Towers', 'VODAFONE ID':'Vodafone Idea',
    'CONTAINER COR':'Container Corporation CONCOR', 'BLUE DART':'Blue Dart Express',
    'TATA STEEL':'Tata Steel', 'JSW STEEL':'JSW Steel',
    'INTERGLOBE':'IndiGo airline', 'INDIAN HOTELS':'Indian Hotels Taj',
    'HDFC LIFE':'HDFC Life Insurance', 'SBI LIFE':'SBI Life Insurance',
    'BAJAJ FINSERV':'Bajaj Finserv', 'L AND T':'Larsen Toubro LT',
    'LTIMINDTREE':'LTIMindtree', 'M&M FIN':'M&M Financial Services',
    'KPIT TECH':'KPIT Technologies', 'RBI G-SEC':'India government bond',
    'ARB FUND':'arbitrage mutual fund India', 'CORP BOND MF':'corporate bond fund India',
    'HDFC LIQ':'HDFC liquid fund', 'EMBASSY REIT':'Embassy Office REIT',
    'FEDERAL BK':'Federal Bank India', 'APTUS VALUE':'Aptus Value Housing',
  };
  for (const sym of syms) {
    const query = nameMap[sym] || sym;
    const r = await cached('news_' + sym, 15 * 60 * 1000, () => fetchGoogleNews(query));
    results[sym] = r.items || [];
    await new Promise(r2 => setTimeout(r2, 250));
  }
  send(res, { ok: true, timestamp: new Date().toISOString(), news: results });
}

// /marketnews
async function handleMarketNews(res) {
  const queries = ['NSE Nifty market today', 'India stocks FII DII today', 'BSE NSE market news'];
  const allItems = [];
  for (const q of queries) {
    const r = await cached('mnews_' + q.slice(0,10), 10 * 60 * 1000, () => fetchGoogleNews(q));
    (r.items || []).forEach(item => allItems.push(item));
    await new Promise(r2 => setTimeout(r2, 200));
  }
  const seen = new Set();
  const unique = allItems.filter(item => {
    const key = item.title.slice(0, 35);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  send(res, { ok: true, timestamp: new Date().toISOString(), items: unique.slice(0, 15) });
}

// ── WARM UP on start ───────────────────────────────────────────
async function warmUp() {
  console.log('Warming up — fetching NSE cookie...');
  await refreshCookie();
  console.log('Cookie ready:', NSE_COOKIE ? 'YES (' + NSE_COOKIE.length + ' chars)' : 'FAILED');
  // Pre-fetch indices on startup
  setTimeout(async () => {
    console.log('Pre-fetching indices...');
    const r = await fetchNSE('/api/allIndices');
    console.log('Indices warm-up:', r.ok ? 'OK' : r.error);
  }, 2000);
}

// ── SERVER ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.writeHead(204); return res.end();
  }

  const url  = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const s    = url.searchParams.get('s') || url.searchParams.get('symbol') || url.searchParams.get('symbols');
  console.log(new Date().toISOString().slice(11,19), req.method, path, s||'');

  try {
    if (path==='/'||path==='/health') return await handleHealth(res);
    if (path==='/fii')                return await handleFII(res);
    if (path==='/indices')            return await handleIndices(res);
    if (path==='/results')            return await handleResults(res);
    if (path==='/bulk')               return await handleBulk(res);
    if (path==='/quote')              return await handleQuote(res, s);
    if (path==='/quotes')             return await handleMultiQuote(res, s);
    if (path==='/gainers')            return await handleGainers(res);
    if (path==='/news')               return await handleNews(res, s);
    if (path==='/marketnews')         return await handleMarketNews(res);
    send(res, { error: 'Not found' }, 404);
  } catch(e) {
    console.error('Unhandled:', e);
    send(res, { error: 'Internal error', message: e.message }, 500);
  }
});

server.listen(PORT, async () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║   Investment Radar — NSE Data Proxy  v2                  ║
║   Port: ${PORT}                                            ║
╠══════════════════════════════════════════════════════════╣
║   /health  /fii  /indices  /results                      ║
║   /bulk    /quote?s=TCS    /quotes?s=TCS,INFY            ║
║   /gainers                                               ║
╚══════════════════════════════════════════════════════════╝`);
  await warmUp();
});
