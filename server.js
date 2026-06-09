/**
 * ===================================================================
 *  ULTIMATE PROXY BACKEND — server.js
 * ===================================================================
 *  Features:
 *  • General pass-through proxy with CORS
 *  • YouTube-optimized routing (range requests, streaming, cookies)
 *  • DuckDuckGo search → clean JSON API
 *  • Cookie jar sessions, rate limiting, compression handling
 *  • Location-header rewriting so redirects stay inside the proxy
 *
 *  Install:  npm install express cors
 *  Run:      node server.js
 * ===================================================================
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------
   MIDDLEWARE
   ------------------------------------------------------------------ */
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range', 'X-Session-Id']
}));

// Body parsers (only for non-proxy routes; proxy routes handle streams manually)
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

/* ------------------------------------------------------------------
   CONFIG
   ------------------------------------------------------------------ */
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'DNT': '1',
  'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

/* ------------------------------------------------------------------
   RATE LIMITER (in-memory)
   ------------------------------------------------------------------ */
const requestCounts = new Map();
const RL_WINDOW = 60_000; // 1 minute
const RL_MAX = 120;

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RL_WINDOW;
  const stamps = (requestCounts.get(ip) || []).filter(t => t > windowStart);
  stamps.push(now);
  requestCounts.set(ip, stamps);
  return stamps.length > RL_MAX;
}

setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW;
  for (const [ip, stamps] of requestCounts) {
    const filtered = stamps.filter(t => t > cutoff);
    if (filtered.length === 0) requestCounts.delete(ip);
    else requestCounts.set(ip, filtered);
  }
}, 300_000);

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded (120 req/min)' });
  }
  next();
});

/* ------------------------------------------------------------------
   COOKIE JAR (per-session)
   ------------------------------------------------------------------ */
const cookieJars = new Map();

function getJar(sessionId) {
  if (!sessionId) return null;
  if (!cookieJars.has(sessionId)) cookieJars.set(sessionId, new Map());
  return cookieJars.get(sessionId);
}

function cookieHeaderFor(jar, hostname) {
  if (!jar) return null;
  const out = [];
  for (const [name, meta] of jar.entries()) {
    if (!meta.domain || hostname.includes(meta.domain)) {
      out.push(`${name}=${meta.value}`);
    }
  }
  return out.length ? out.join('; ') : null;
}

function storeCookies(jar, setCookieHeader) {
  if (!jar || !setCookieHeader) return;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of arr) {
    const [main] = c.split(';');
    const [name, ...valParts] = main.trim().split('=');
    if (!name || valParts.length === 0) continue;
    const value = valParts.join('=');
    const dm = c.match(/Domain=([^;]+)/i);
    jar.set(name.trim(), { value: value.trim(), domain: dm ? dm[1].trim() : null });
  }
}

/* ------------------------------------------------------------------
   HELPERS
   ------------------------------------------------------------------ */
function getProxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function rewriteLocation(location, targetUrl, req) {
  try {
    const loc = new URL(location, targetUrl);
    const base = getProxyBase(req);
    // Keep YouTube/googlevideo traffic on /youtube/ route
    if (/youtube\.com|googlevideo\.com|ytimg\.com/.test(loc.hostname)) {
      return `${base}/youtube/${loc.href.replace(/^https?:\/\//, '')}`;
    }
    return `${base}/proxy?url=${encodeURIComponent(loc.href)}`;
  } catch {
    return location;
  }
}

/* ------------------------------------------------------------------
   CORE PROXY ENGINE
   ------------------------------------------------------------------ */
async function proxyPass(targetUrl, req, res, opts = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(targetUrl);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid URL', details: e.message });
      return resolve();
    }

    const client = url.protocol === 'https:' ? https : http;
    const headers = { ...BROWSER_HEADERS };

    // Forward selective client headers
    const fwd = ['range', 'referer', 'origin', 'content-type', 'if-modified-since', 'if-none-match', 'etag'];
    for (const h of fwd) if (req.headers[h]) headers[h] = req.headers[h];

    // Cookies
    const jar = getJar(req.headers['x-session-id'] || req.query.session);
    const cHeader = cookieHeaderFor(jar, url.hostname);
    if (cHeader) headers['Cookie'] = cHeader;
    else if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;

    headers['Host'] = url.hostname;

    // Remove hop-by-hop headers
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['proxy-connection'];
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];
    delete headers['te'];
    delete headers['trailers'];
    delete headers['upgrade'];

    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers,
      timeout: 30_000,
      rejectUnauthorized: false
    };

    const proxyReq = client.request(requestOptions, (proxyRes) => {
      // Store cookies
      if (jar && proxyRes.headers['set-cookie']) {
        storeCookies(jar, proxyRes.headers['set-cookie']);
      }

      // Status
      res.status(proxyRes.statusCode);

      // Forward headers
      const skip = new Set([
        'content-encoding', 'transfer-encoding', 'content-length',
        'connection', 'keep-alive', 'proxy-connection', 'strict-transport-security'
      ]);

      for (const [key, value] of Object.entries(proxyRes.headers)) {
        const k = key.toLowerCase();
        if (skip.has(k)) continue;

        if (k === 'location') {
          res.setHeader(key, rewriteLocation(value, targetUrl, req));
          continue;
        }
        try {
          res.setHeader(key, value);
        } catch { /* ignore invalid header */ }
      }

      res.setHeader('Access-Control-Expose-Headers', '*');

      // Decompress if needed
      const enc = proxyRes.headers['content-encoding'];
      let stream = proxyRes;
      if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
      else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

      // Basic HTML URL rewriting for YouTube (best-effort)
      if (opts.rewriteUrls && (proxyRes.headers['content-type'] || '').includes('text/html')) {
        let body = '';
        stream.on('data', c => body += c);
        stream.on('end', () => {
          const base = getProxyBase(req);
          const ytProxy = `${base}/youtube/`;
          const gvProxy = `${base}/proxy?url=https://`;

          let mod = body
            .replace(/(href|src|action)="https?:\/\/(www\.)?youtube\.com/g, `$1="${ytProxy}https://youtube.com`)
            .replace(/(href|src|action)="https?:\/\/(www\.)?googlevideo\.com/g, `$1="${gvProxy}googlevideo.com`)
            .replace(/(href|src|action)="\/\//g, `$1="${base}/proxy?url=https://`)
            .replace(/"\/(watch\?|results\?|embed\/|channel\/|c\/|user\/|playlist\?)/g, `"${ytProxy}https://youtube.com/$1`);

          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(mod);
          resolve();
        });
        stream.on('error', reject);
      } else {
        stream.pipe(res);
        stream.on('end', resolve);
        stream.on('error', reject);
      }
    });

    proxyReq.on('error', (err) => {
      console.error('[Proxy Error]', err.message, '| Target:', targetUrl);
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error', message: err.message });
      reject(err);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Gateway timeout' });
      reject(new Error('Timeout'));
    });

    // Body forwarding
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (Buffer.isBuffer(req.body)) {
        proxyReq.end(req.body);
      } else if (typeof req.body === 'string') {
        proxyReq.end(req.body);
      } else if (req.body && Object.keys(req.body).length) {
        proxyReq.end(JSON.stringify(req.body));
        if (!headers['content-type']) proxyReq.setHeader('Content-Type', 'application/json');
      } else {
        req.pipe(proxyReq);
      }
    } else {
      proxyReq.end();
    }
  });
}

/* ------------------------------------------------------------------
   ROUTES
   ------------------------------------------------------------------ */

// Health / Info
app.get('/', (req, res) => {
  res.json({
    name: 'Ultimate Proxy',
    status: 'running',
    endpoints: {
      proxy: '/proxy?url=ENCODED_URL',
      youtube: '/youtube/PATH',
      search: '/search?q=QUERY',
      health: '/health'
    },
    tips: [
      'Use ?session=xyz to persist cookies across requests',
      'YouTube video streams need Range header support — handled automatically',
      'Add ?rewrite=true to proxy endpoint for basic HTML URL rewriting'
    ]
  });
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// General proxy
app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });
  try { await proxyPass(target, req, res, { rewriteUrls: req.query.rewrite === 'true' }); }
  catch (e) { console.error(e); }
});

// YouTube-optimized proxy
app.all('/youtube/*', async (req, res) => {
  const raw = req.originalUrl.replace(/^\/youtube\//, '');
  const target = raw.startsWith('http') ? raw : `https://www.youtube.com/${raw}`;
  try { await proxyPass(target, req, res, { rewriteUrls: true }); }
  catch (e) { console.error(e); }
});

// DuckDuckGo Search → JSON
app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const headers = {
    ...BROWSER_HEADERS,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': 'https://html.duckduckgo.com/'
  };

  try {
    const html = await new Promise((resolve, reject) => {
      const u = new URL(searchUrl);
      const client = u.protocol === 'https:' ? https : http;
      const r = client.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
        timeout: 15_000
      }, (resp) => {
        let data = '';
        let s = resp;
        const enc = resp.headers['content-encoding'];
        if (enc === 'gzip') s = resp.pipe(zlib.createGunzip());
        else if (enc === 'deflate') s = resp.pipe(zlib.createInflate());
        s.on('data', c => data += c);
        s.on('end', () => resolve(data));
        s.on('error', reject);
      });
      r.on('error', reject);
      r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      r.end();
    });

    const results = [];
    // DuckDuckGo lite HTML structure
    const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

    let m;
    const items = [];

    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      // Unwrap DDG redirect URLs
      if (href.includes('duckduckgo.com/l/')) {
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]);
      }
      if (href.startsWith('//')) href = 'https:' + href;

      const title = m[2].replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .trim();

      items.push({ title, href, snippet: '' });
    }

    let i = 0;
    while ((m = snipRe.exec(html)) !== null && i < items.length) {
      items[i].snippet = m[1].replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .trim();
      i++;
    }

    res.json({ query: q, count: items.length, results: items });

  } catch (err) {
    console.error('[Search Error]', err);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Raw DDG HTML proxy (if you want the page instead of JSON)
app.get('/ddg', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try { await proxyPass(target, req, res); } catch (e) { console.error(e); }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error', message: err.message });
});

/* ------------------------------------------------------------------
   START
   ------------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on http://localhost:${PORT}`);
  console.log(`📺 YouTube:  http://localhost:${PORT}/youtube/https://youtube.com/watch?v=...`);
  console.log(`🔍 Search:   http://localhost:${PORT}/search?q=node.js+tutorial`);
  console.log(`🌐 Proxy:    http://localhost:${PORT}/proxy?url=https://example.com`);
});
