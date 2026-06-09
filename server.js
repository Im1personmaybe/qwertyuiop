const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', credentials: true }));
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

const BLOCKED_HEADERS = new Set([
  'content-encoding', 'transfer-encoding', 'content-length',
  'connection', 'keep-alive', 'proxy-connection',
  'strict-transport-security',
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'permissions-policy',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel'
]);

function getProxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function proxyUrl(target, req) {
  const base = getProxyBase(req);
  if (!target || target.startsWith('data:') || target.startsWith('blob:') || target.startsWith('javascript:') || target.startsWith('mailto:')) {
    return target;
  }
  try {
    const u = new URL(target, req._targetOrigin || 'https://example.com');
    if (/youtube\.com|googlevideo\.com|ytimg\.com/.test(u.hostname)) {
      return `${base}/youtube/${u.href.replace(/^https?:\/\//, '')}`;
    }
    return `${base}/proxy?url=${encodeURIComponent(u.href)}`;
  } catch {
    return target;
  }
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

// ==================== CONTENT REWRITERS ====================

function rewriteHTML(body, targetUrl, req) {
  const base = getProxyBase(req);
  const origin = new URL(targetUrl).origin + '/';

  // Helper to proxy any URL
  const p = (url) => {
    if (!url || url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:') || url.startsWith('#')) return url;
    try {
      const u = new URL(url, targetUrl);
      if (/youtube\.com|googlevideo\.com|ytimg\.com/.test(u.hostname)) {
        return `${base}/youtube/${u.href.replace(/^https?:\/\//, '')}`;
      }
      return `${base}/proxy?url=${encodeURIComponent(u.href)}`;
    } catch { return url; }
  };

  // 1. Inject <base> and patch script right after <head>
  const patchScript = `<script>
(function(){
  const PROXY_BASE = '${base}';
  const TARGET_ORIGIN = '${origin}';
  
  function pu(url) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('javascript:') || url.startsWith('mailto:')) return url;
    if (url.startsWith('//')) return PROXY_BASE + '/proxy?url=https:' + url;
    if (url.startsWith('/')) return PROXY_BASE + '/proxy?url=' + encodeURIComponent(TARGET_ORIGIN + url.replace(/^\\//, ''));
    if (!url.match(/^https?:\\/\\//)) return PROXY_BASE + '/proxy?url=' + encodeURIComponent(TARGET_ORIGIN + url);
    if (url.includes('youtube.com') || url.includes('googlevideo.com') || url.includes('ytimg.com')) {
      return PROXY_BASE + '/youtube/' + url.replace(/^https?:\\/\\//, '');
    }
    return PROXY_BASE + '/proxy?url=' + encodeURIComponent(url);
  }

  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = function(url, opts) {
    if (typeof url === 'string') url = pu(url);
    else if (url && url.url) url.url = pu(url.url);
    return _fetch.call(this, url, opts);
  };

  // Patch XHR
  const _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, async, user, pass) {
    return _xhrOpen.call(this, method, pu(url), async, user, pass);
  };

  // Patch WebSocket
  const _ws = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    if (typeof url === 'string') {
      if (url.startsWith('wss://')) url = url.replace('wss://', 'https://');
      else if (url.startsWith('ws://')) url = url.replace('ws://', 'http://');
      url = pu(url);
    }
    return new _ws(url, protocols);
  };

  // Patch history
  const _push = history.pushState;
  const _replace = history.replaceState;
  history.pushState = function(s, t, u) { return _push.call(this, s, t, u ? pu(u) : u); };
  history.replaceState = function(s, t, u) { return _replace.call(this, s, t, u ? pu(u) : u); };

  // Patch window.open
  const _open = window.open;
  window.open = function(url, name, features) {
    return _open.call(this, url ? pu(url) : url, name, features);
  };

  // Patch location assignments (best effort)
  let _loc = window.location;
  Object.defineProperty(window, 'location', {
    get: () => _loc,
    set: (v) => { _loc.href = pu(v); }
  });

  // Intercept all clicks on <a> tags
  document.addEventListener('click', function(e) {
    const a = e.composedPath ? e.composedPath().find(el => el.tagName === 'A') : (e.target.closest ? e.target.closest('a') : null);
    if (a && a.href && !a.href.startsWith('javascript:') && !a.href.startsWith('#')) {
      const phref = pu(a.href);
      if (phref !== a.href) {
        a.href = phref;
      }
    }
  }, true);

  // Patch dynamic imports
  const _import = __import__ || null;
  if (_import) {
    window.__import__ = function(specifier) {
      return _import(pu(specifier));
    };
  }
  // Patch import() if supported
  try {
    const _dynImport = eval('import');
    const newImport = function(specifier) {
      return _dynImport(pu(specifier));
    };
    // Can't override import() directly, but we can patch module scripts
  } catch(e) {}

  // Patch createElement for scripts/styles/iframes
  const _createEl = document.createElement;
  document.createElement = function(tag) {
    const el = _createEl.call(document, tag);
    if (tag.toLowerCase() === 'script' || tag.toLowerCase() === 'link' || tag.toLowerCase() === 'iframe' || tag.toLowerCase() === 'img' || tag.toLowerCase() === 'video' || tag.toLowerCase() === 'audio' || tag.toLowerCase() === 'source') {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'src') || Object.getOwnPropertyDescriptor(el, 'src');
      if (desc && desc.set) {
        const orig = desc.set;
        Object.defineProperty(el, 'src', {
          set: function(v) { return orig.call(this, pu(v)); },
          get: desc.get
        });
      }
      const hrefDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'href') || Object.getOwnPropertyDescriptor(el, 'href');
      if (hrefDesc && hrefDesc.set) {
        const orig = hrefDesc.set;
        Object.defineProperty(el, 'href', {
          set: function(v) { return orig.call(this, pu(v)); },
          get: hrefDesc.get
        });
      }
    }
    return el;
  };

  // Patch srcset
  const _srcsetDesc = Object.getOwnPropertyDescriptor(Image.prototype, 'srcset') || Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'srcset');
  if (_srcsetDesc && _srcsetDesc.set) {
    const orig = _srcsetDesc.set;
    Object.defineProperty(Image.prototype, 'srcset', {
      set: function(v) {
        if (typeof v === 'string') {
          v = v.split(',').map(s => {
            const parts = s.trim().split(/\\s+/);
            parts[0] = pu(parts[0]);
            return parts.join(' ');
          }).join(', ');
        }
        return orig.call(this, v);
      },
      get: _srcsetDesc.get
    });
  }
})();
</script>`;

  body = body.replace(/<<head([^>]*)>/i, `<head$1><base href="${origin}">${patchScript}`);

  // 2. Rewrite all URL attributes in HTML
  const attrRe = /(href|src|action|data-src|poster|data-url|data-href|srcset|formaction|background|manifest|modulepreload|preload|cite|longdesc|profile|codebase|data)="([^"]*)"/gi;
  body = body.replace(attrRe, (match, attr, url) => {
    return `${attr}="${p(url)}"`;
  });

  // 3. Rewrite meta refresh
  body = body.replace(/<<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, (match) => {
    return match.replace(/content=["'](\d+);\s*url=([^"']+)["']/i, (m, delay, url) => {
      return `content="${delay};url=${p(url)}"`;
    });
  });

  // 4. Rewrite inline styles
  body = body.replace(/style=["']([^"']*)["']/gi, (match, style) => {
    return `style="${rewriteCSS(style, targetUrl, req)}"`;
  });

  // 5. Rewrite <style> tags
  body = body.replace(/<<style[^>]*>([\s\S]*?)<<\/style>/gi, (match, css) => {
    return `<style>${rewriteCSS(css, targetUrl, req)}</style>`;
  });

  // 6. Rewrite URLs inside inline scripts (basic string replacement)
  body = body.replace(/<<script([^>]*)>([\s\S]*?)<<\/script>/gi, (match, attrs, js) => {
    if (attrs.includes('src=')) return match; // external script, already handled
    return `<script${attrs}>${rewriteJS(js, targetUrl, req)}</script>`;
  });

  // 7. Rewrite protocol-relative URLs in text
  body = body.replace(/url\(["']?\/\/([^"')]+)["']?\)/g, (m, u) => `url("${p('https://' + u)}")`);

  return body;
}

function rewriteCSS(css, targetUrl, req) {
  const base = getProxyBase(req);
  const origin = new URL(targetUrl).origin;

  // url(...)
  css = css.replace(/url\(["']?([^"')]+)["']?\)/g, (match, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('#')) return match;
    try {
      const u = new URL(url, targetUrl);
      if (/youtube\.com|googlevideo\.com|ytimg\.com/.test(u.hostname)) {
        return `url("${base}/youtube/${u.href.replace(/^https?:\/\//, '')}")`;
      }
      return `url("${base}/proxy?url=${encodeURIComponent(u.href)}")`;
    } catch { return match; }
  });

  // @import
  css = css.replace(/@import\s+(?:url\()?["']([^"']+)["']\)?/g, (match, url) => {
    try {
      const u = new URL(url, targetUrl);
      return `@import url("${base}/proxy?url=${encodeURIComponent(u.href)}")`;
    } catch { return match; }
  });

  return css;
}

function rewriteJS(js, targetUrl, req) {
  const base = getProxyBase(req);
  const origin = new URL(targetUrl).origin;

  // These are best-effort regex replacements for common patterns
  // fetch("url"), fetch('url')
  js = js.replace(/fetch\s*\(\s*["']([^"']+)["']\s*[,)]/g, (match, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return match;
    try {
      const u = new URL(url, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(u.href)}`);
    } catch { return match; }
  });

  // XMLHttpRequest.open("GET", "url")
  js = js.replace(/\.open\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g, (match, method, url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return match;
    try {
      const u = new URL(url, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(u.href)}`);
    } catch { return match; }
  });

  // new WebSocket("url")
  js = js.replace(/new\s+WebSocket\s*\(\s*["']([^"']+)["']\s*\)/g, (match, url) => {
    let u = url;
    if (u.startsWith('wss://')) u = u.replace('wss://', 'https://');
    else if (u.startsWith('ws://')) u = u.replace('ws://', 'http://');
    try {
      const parsed = new URL(u, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(parsed.href)}`);
    } catch { return match; }
  });

  // axios.get("url"), axios.post("url", ...)
  js = js.replace(/axios\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/g, (match, method, url) => {
    try {
      const u = new URL(url, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(u.href)}`);
    } catch { return match; }
  });

  // importScripts("url") for Web Workers
  js = js.replace(/importScripts\s*\(\s*["']([^"']+)["']\s*\)/g, (match, url) => {
    try {
      const u = new URL(url, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(u.href)}`);
    } catch { return match; }
  });

  // Worker("url")
  js = js.replace(/new\s+Worker\s*\(\s*["']([^"']+)["']\s*\)/g, (match, url) => {
    try {
      const u = new URL(url, targetUrl);
      return match.replace(url, `${base}/proxy?url=${encodeURIComponent(u.href)}`);
    } catch { return match; }
  });

  // history.pushState/replaceState
  js = js.replace(/(history\.(?:pushState|replaceState)\s*\([^,]+,[^,]+,\s*["'])([^"']+)(["']\s*\))/g, (match, prefix, url, suffix) => {
    try {
      const u = new URL(url, targetUrl);
      return prefix + `${base}/proxy?url=${encodeURIComponent(u.href)}` + suffix;
    } catch { return match; }
  });

  return js;
}

// ==================== PROXY ENGINE ====================

async function proxyPass(targetUrl, req, res, opts = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(targetUrl); } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: 'Invalid URL' });
      return resolve();
    }

    req._targetOrigin = url.origin;

    const client = url.protocol === 'https:' ? https : http;
    const headers = { ...BROWSER_HEADERS };

    ['range', 'referer', 'origin', 'content-type', 'if-modified-since', 'if-none-match', 'authorization'].forEach(h => {
      if (req.headers[h]) headers[h] = req.headers[h];
    });

    if (req.headers.cookie) headers['Cookie'] = req.headers.cookie;
    headers['Host'] = url.hostname;

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

      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        const k = key.toLowerCase();
        if (BLOCKED_HEADERS.has(k)) return;
        if (k === 'location') {
          res.setHeader(key, rewriteLocation(value, targetUrl, req));
          return;
        }
        try { res.setHeader(key, value); } catch {}
      });
      res.setHeader('Access-Control-Expose-Headers', '*');

      const enc = proxyRes.headers['content-encoding'];
      let stream = proxyRes;
      if (enc === 'gzip') stream = proxyRes.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = proxyRes.pipe(zlib.createInflate());
      else if (enc === 'br') stream = proxyRes.pipe(zlib.createBrotliDecompress());

      const ct = (proxyRes.headers['content-type'] || '').toLowerCase();

      if (ct.includes('text/html')) {
        let body = '';
        stream.on('data', c => body += c);
        stream.on('end', () => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(rewriteHTML(body, targetUrl, req));
          resolve();
        });
        stream.on('error', reject);
      } else if (ct.includes('text/css')) {
        let body = '';
        stream.on('data', c => body += c);
        stream.on('end', () => {
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          res.send(rewriteCSS(body, targetUrl, req));
          resolve();
        });
        stream.on('error', reject);
      } else if (ct.includes('javascript') || ct.includes('/ecmascript') || targetUrl.endsWith('.js')) {
        let body = '';
        stream.on('data', c => body += c);
        stream.on('end', () => {
          res.setHeader('Content-Type', ct.includes('javascript') ? proxyRes.headers['content-type'] : 'application/javascript; charset=utf-8');
          res.send(rewriteJS(body, targetUrl, req));
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
      ddg: '/ddg?q=QUERY',
      search: '/search?q=QUERY',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.all('/proxy', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: 'Missing ?url=' });
  try { await proxyPass(target, req, res); } catch (e) { console.error(e); }
});

app.all('/youtube/*', async (req, res) => {
  const raw = req.originalUrl.replace(/^\/youtube\//, '');
  const target = raw.startsWith('http') ? raw : `https://www.youtube.com/${raw}`;
  try { await proxyPass(target, req, res); } catch (e) { console.error(e); }
});

app.get('/ddg', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  try { await proxyPass(target, req, res); } catch (e) { console.error(e); }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Missing ?q=' });
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  const headers = { ...BROWSER_HEADERS, 'Accept': 'text/html,*/*;q=0.8', 'Referer': 'https://html.duckduckgo.com/' };

  try {
    const html = await new Promise((resolve, reject) => {
      const u = new URL(searchUrl);
      const client = u.protocol === 'https:' ? https : http;
      const r = client.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 15_000 }, (resp) => {
        let data = ''; let s = resp;
        const enc = resp.headers['content-encoding'];
        if (enc === 'gzip') s = resp.pipe(zlib.createGunzip());
        else if (enc === 'deflate') s = resp.pipe(zlib.createInflate());
        s.on('data', c => data += c); s.on('end', () => resolve(data)); s.on('error', reject);
      });
      r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); }); r.end();
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
      const title = m[2].replace(/<<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      items.push({ title, href, snippet: '' });
    }

    let i = 0;
    while ((m = snipRe.exec(html)) !== null && i < items.length) {
      items[i].snippet = m[1].replace(/<<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
      i++;
    }

    res.json({ query: q, count: items.length, results: items });
  } catch (err) {
    console.error('[Search Error]', err);
    res.status(500).json({ error: 'Search failed', message: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  if (!res.headersSent) res.status(500).json({ error: 'Internal error', message: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
