const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Your Render domain (needed for URL rewriting)
const PROXY_HOST = process.env.PROXY_HOST || '';

setInterval(() => {
  console.log('Keep-alive:', new Date().toISOString());
}, 5 * 60 * 1000);

function fetchUrl(targetUrl, callback) {
  try {
    const parsed = new URL(targetUrl);
    const protocol = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => callback(null, res, data));
    });

    req.on('error', (err) => callback(err));
    req.on('timeout', () => {
      req.destroy();
      callback(new Error('Timeout'));
    });
    req.end();

  } catch (err) {
    callback(err);
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);

  // Health check
  if (parsed.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'alive', time: new Date().toISOString() }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url=' }));
      return;
    }

    fetchUrl(target, (err, proxyRes, data) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to fetch', message: err.message }));
        return;
      }

      const contentType = proxyRes.headers['content-type'] || '';

      // If it's HTML, rewrite URLs to go through proxy
      if (contentType.includes('text/html')) {
        const proxyBase = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
        
        // Rewrite href/src URLs to route through proxy
        data = data.replace(
          /(href|src|action)=["'](?!https?:\/\/|\/\/|#|javascript:|mailto:|data:)([^"']+)["']/gi,
          (match, attr, path) => {
            try {
              const baseUrl = new URL(target);
              const absolute = new URL(path, baseUrl).href;
              return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(absolute)}"`;
            } catch (e) {
              return match;
            }
          }
        );

        // Rewrite absolute URLs in same domain to also go through proxy
        const targetHost = new URL(target).hostname;
        const sameDomainPattern = new RegExp(`(href|src|action)=["']https?://([^/]*${targetHost.replace(/\./g, '\\.')}[^"']*)["']`, 'gi');
        
        data = data.replace(sameDomainPattern, (match, attr, url) => {
          return `${attr}="${proxyBase}/proxy?url=${encodeURIComponent(url)}"`;
        });
      }

      res.writeHead(proxyRes.statusCode, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Prøxy running on port ${PORT}`);
});
