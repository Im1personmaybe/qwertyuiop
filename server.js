const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Sites that block proxies (optional safety check)
const BLOCKED_HOSTS = [];

const server = http.createServer((req, res) => {
  // CORS
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
    res.end(JSON.stringify({ status: 'Proxy is live', timestamp: new Date().toISOString() }));
    return;
  }

  // Proxy endpoint
  if (parsed.pathname === '/proxy') {
    const target = parsed.query.url;
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ?url= parameter' }));
      return;
    }

    // Check for blocked hosts
    try {
      const targetHost = new URL(target).hostname.toLowerCase();
      if (BLOCKED_HOSTS.some(h => targetHost.includes(h))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'This site is blocked by proxy policy' }));
        return;
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL format' }));
      return;
    }

    try {
      const targetUrl = new URL(target);
      const protocol = targetUrl.protocol === 'https:' ? https : http;

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        timeout: 25000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'identity', // Don't ask for gzip, we can't decompress easily
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          'DNT': '1'
        }
      };

      // Forward cookies if present
      if (req.headers['cookie']) {
        options.headers['Cookie'] = req.headers['cookie'];
      }

      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const proxyReq = protocol.request(options, (proxyRes) => {
          // Set response headers
          const headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS'
          };

          // Forward important headers
          const forwardList = [
            'content-type', 'content-length', 'cache-control',
            'etag', 'last-modified', 'content-language',
            'x-frame-options', 'x-content-type-options'
          ];

          forwardList.forEach(h => {
            if (proxyRes.headers[h]) headers[h] = proxyRes.headers[h];
          });

          // Handle cookies
          if (proxyRes.headers['set-cookie']) {
            headers['set-cookie'] = proxyRes.headers['set-cookie'];
          }

          // Handle redirects
          if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            try {
              const redirectUrl = new URL(proxyRes.headers.location, target).href;
              headers['x-proxy-redirect'] = redirectUrl;
            } catch (e) {}
          }

          // Write status and headers
          res.writeHead(proxyRes.statusCode, headers);

          // Pipe the response body
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
          console.error('Proxy request error:', err.message);
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              error: 'Failed to reach target website',
              details: err.message,
              url: target
            }));
          }
        });

        proxyReq.on('timeout', () => {
          proxyReq.destroy();
          if (!res.headersSent) {
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Request timed out (25s)' }));
          }
        });

        if (body) proxyReq.write(body);
        proxyReq.end();
      });

    } catch (err) {
      console.error('URL parse error:', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid URL', details: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: parsed.pathname }));
});

server.listen(PORT, () => {
  console.log(`Prøxy running on port ${PORT}`);
});
