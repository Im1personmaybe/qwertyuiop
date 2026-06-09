const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS for all origins
app.use(cors({ origin: '*', credentials: true }));

// Body parsers (skip for raw proxy streaming)
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: 'text/*', limit: '50mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '50mb' }));

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

function getProxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function rewriteLocation(location, targetUrl, req) {
  try {
    const loc = new URL(location, targetUrl);
    const base = getProxyBase(req);
    if (/youtube\.com|googlevideo\.com|ytimg\.com/.test(loc.hostname)) {
      return `${base}/youtube/${loc.href.replace(/^https?:\/\//, '')}`;
    }
    return `${base}/proxy?url=${encodeURIComponent(loc.href)}`;
  } catch { return location; }
}

async function proxyPass(targetUrl, req, res, opts = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(targetUrl); } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid URL' });
      return resolve();
    }

    const client = url.protocol === 'https:' ? https : http;
    const headers = { ...BROWSER_HEADERS };

    ['range', 'referer', 'origin', 'content-type', 'if-modified-since', 'if-none-match'].forEach(h => {
      if (req.headers[h]) headers[h] = req.headers[h];
    });

    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    headers['Host'] = url.hostname;

    // Strip hop-by-hop headers
    ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailers', 'upgrade'].forEach(h => delete headers[h]);

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: req.method,
      headers,
      timeout: 30_000,
      rejectUnauthorized: false
    };

    const proxyReq = client.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode);

      const skip = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive', 'proxy-connection', 'strict-transport-security']);
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        const k = key.toLowerCase();
        if (skip.has(k)) return;
        if (k === 'location') {
          res.setHeader(key, rewriteLocation(value, targetUrl, req));
          return;
        }
        try { res.setHeader(key, value); } catch {}
      });
      res.setHeader('Access-Control-Expose-Headers', '*');

      // Handle compression
      const enc = proxyRes.headers['content-encoding'];
      let stream = proxyRes;
      if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
      else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

      // HTML rewriting for YouTube
      if (opts.rewriteUrls && (proxyRes.headers['content-type'] || '').includes('text/html')) {
        let body = '';
        stream.on('data', c => body += c);
        stream.on('end', () => {
          const base = getProxyBase(req);
          const mod = body
            .replace(/(href|src|action)="https?:\/\/(www\.)?youtube\.com/g, `$1="${base}/youtube/https://youtube.com`)
            .replace(/(href|src|action)="https?:\/\/(www\.)?googlevideo\.com/g, `$1="${base}/proxy?url=https://googlevideo.com`)
            .replace(/(href|src|action)="\/\//g, `$1="${base}/proxy?url=https://`)
            .replace(/"\/(watch\?|results\?|embed\/|channel\/|c\/|user\/|playlist\?)/g, `"${base}/youtube/https://youtube.com/$1`);
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
      console.error('[Proxy Error]', err.message, targetUrl);
      if (!res.headersSent) res.status(502).json({ error: 'Proxy error', message: err.message });
      reject(err);
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Gateway timeout' });
      reject(new Error('Timeout'));
    });

    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (Buffer.isBuffer(req.body)) proxyReq.end(req.body);
      else if (typeof req.body === 'string') proxyReq.end(req.body);
      else if (req.body && Object.keys(req.body).length) {
        proxyReq.setHeader('Content-Type', 'application/json');
        proxyReq.end(JSON.stringify(req.body));
      } else {
        req.pipe(proxyReq);
      }
    } else {
      proxyReq.end();
    }
  });
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
  res.json({
    status: 'running',
    endpoints: {
      proxy: '/proxy?url=ENCODED_URL',
      youtube: '/youtube/PATH',
      search: '/search?q=QUERY',
      health: '/health'
    }
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
  const headers = { ...BROWSER_HEADERS, 'Accept': 'text/html,*/*;q=0.8', 'Referer': 'https://html.duckduckgo.com/' };

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

    const items = [];
    const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<<\/a>/g;
    const snipRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<<\/a>/g;

    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      if (href.includes('duckduckgo.com/l/')) {
        const uddg = href.match(/[?&]uddg=([^&]+)/);
        if (uddg) href = decodeURIComponent(uddg[1]);
      }
      if (href.startsWith('//')) href = 'https:' + href;
      const title = m[2].replace(/<<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      items.push({ title, href, snippet: '' });
    }

    let i = 0;
    while ((m = snipRe.exec(html)) !== null && i < items.length) {
      items[i].snippet = m[1].replace(/<<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      i++;
    }

    res.json({ query: q, count: items.length, results: items });
  } catch (err) {
    console.error('[Search Error]', err);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

// Raw DDG HTML proxy
app.get('/ddg', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try { await proxyPass(target, req, res); } catch (e) { console.error(e); }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error', message: err.message });
});

// Bind to 0.0.0.0 so Render can reach it
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
