// ============================================
// ULTRAVIOLET-STYLE PROXY - Single File
// Backend: Bare Server + Static File Serving
// Frontend: Service Worker + URL Rewriter
// ============================================

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');
const fs = require('fs');
let HttpProxyAgent, HttpsProxyAgent;
try {
    ({ HttpProxyAgent } = require('http-proxy-agent'));
    ({ HttpsProxyAgent } = require('https-proxy-agent'));
} catch (err) {
    console.warn('[proxy-pool] Install http-proxy-agent and https-proxy-agent to enable upstream rotation');
}

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 8080;
const PREFIX = '/service/';
const BARE_PREFIX = '/bare/';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 50 * 1024 * 1024);
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === 'true';
const PROXY_LIST_FILE = process.env.PROXY_LIST_FILE || './proxies.txt';
const USE_UPSTREAM_PROXIES = process.env.USE_UPSTREAM_PROXIES !== 'false';
const PROXY_ATTEMPT_TIMEOUT_MS = 30000;

function loadProxyPool() {
    if (!USE_UPSTREAM_PROXIES || !fs.existsSync(PROXY_LIST_FILE)) return [];
    const rank = { fast: 0, medium: 1, slow: 2 };
    return fs.readFileSync(PROXY_LIST_FILE, 'utf8').split(/\r?\n/).slice(1).map(line => {
        const c = line.split('\t');
        if (c.length < 12) return null;
        const host = c[0].trim(), port = Number(c[1]), protocol = c[3].trim().toLowerCase();
        const speed = c[6].trim().toLowerCase(), latency = Number.parseFloat(c[10]) || 999999;
        if (!/^https?$/.test(protocol) || !host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
        try { new URL(`${protocol}://${host}:${port}`); } catch { return null; }
        return { host, port, protocol, speed, latency, score: (rank[speed] ?? 9) * 1e6 + latency };
    }).filter(Boolean).sort((a, b) => a.score - b.score);
}
const upstreamProxyPool = loadProxyPool();
let upstreamProxyIndex = 0;
function nextUpstreamProxy() {
    if (!upstreamProxyPool.length) return null;
    const proxy = upstreamProxyPool[upstreamProxyIndex % upstreamProxyPool.length];
    upstreamProxyIndex++;
    return proxy;
}
function applyUpstreamProxy(options, target) {
    const proxy = nextUpstreamProxy();
    if (!proxy || !HttpProxyAgent || !HttpsProxyAgent) return null;
    const proxyUrl = `${proxy.protocol}://${proxy.host}:${proxy.port}`;
    if (target.protocol === 'https:') {
        options.agent = new HttpsProxyAgent(proxyUrl);
    } else {
        options.agent = new HttpProxyAgent(proxyUrl);
    }
    options.headers.host = target.host;
    options.headers.connection = 'close';
    return proxy;
}


function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function isBlockedHostname(hostname) {
    const host = hostname.toLowerCase().replace(/[\[\]]/g, '');
    if (ALLOW_PRIVATE_TARGETS) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
    if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
    const m = host.match(/^172\.(\d{1,3})\./);
    return !!(m && Number(m[1]) >= 16 && Number(m[1]) <= 31);
}

function validateTarget(value) {
    const target = new URL(value);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Only http and https targets are supported');
    if (isBlockedHostname(target.hostname)) throw new Error('Target host is not allowed');
    return target;
}

// XOR encoding for URLs (same as UV)
const XOR_KEY = 'ultraviolet';

function xorEncode(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
        result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return Buffer.from(result, 'binary').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function xorDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const decoded = Buffer.from(str, 'base64').toString('binary');
    let result = '';
    for (let i = 0; i < decoded.length; i++) {
        result += String.fromCharCode(decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    }
    return result;
}

// ============================================
// HEADER CLEANER - Prevents Cloudflare Error 1000
// ============================================
function cleanHeaders(headers) {
    const h = { ...headers };
    
    // Strip ALL Cloudflare and forwarding headers
    const blockedHeaders = [
        'cf-ray', 'cf-visitor', 'cdn-loop', 'cf-connecting-ip',
        'cf-ipcountry', 'cf-worker', 'cf-ew-via', 'cf-request-id',
        'cf-bgj', 'cf-polished', 'cf-cache-status', 'cf-apo-via',
        'cf-edge-cache', 'cf-features', 'cf-verification',
        'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
        'x-real-ip', 'true-client-ip', 'x-request-id',
        'x-forwarded-server', 'x-http-host-override'
    ];
    
    for (const key of blockedHeaders) {
        delete h[key];
    }
    
    // Spoof a real browser user-agent if missing or suspicious
    if (!h['user-agent'] || h['user-agent'].includes('node')) {
        h['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    }
    
    // Do not forward hop-by-hop connection headers from the browser.
    // A fresh, non-persistent upstream connection is more reliable for sites
    // such as DuckDuckGo when this server is deployed behind another proxy.
    delete h['connection'];
    delete h['keep-alive'];
    delete h['proxy-connection'];
    delete h['te'];
    delete h['trailer'];
    delete h['upgrade'];
    delete h['content-length'];

    // Add conservative browser headers if missing. Avoid Brotli here because
    // some upstream/proxy combinations negotiate it but never finish cleanly.
    if (!h['accept']) {
        h['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    }
    if (!h['accept-language']) {
        h['accept-language'] = 'en-US,en;q=0.9';
    }
    h['accept-encoding'] = 'gzip, deflate';
    h['connection'] = 'close';
    
    return h;
}

// ============================================
// URL REWRITER
// ============================================
function rewriteRedirectUrl(value, baseUrl) {
    if (!value || typeof value !== 'string') return value;
    const trimmed = value.trim();
    try {
        const base = new URL(baseUrl);
        const absolute = new URL(trimmed, base);
        return PREFIX + xorEncode(absolute.href);
    } catch {
        return trimmed;
    }
}

function rewriteUrl(url, baseUrl) {
    if (!url || typeof url !== 'string') return url;
    if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:') || url.startsWith('mailto:')) {
        return url;
    }
    if (url.startsWith(PREFIX)) return url;

    try {
        let absoluteUrl;
        if (url.startsWith('//')) {
            absoluteUrl = 'https:' + url;
        } else if (url.startsWith('/')) {
            const base = new URL(baseUrl);
            absoluteUrl = base.protocol + '//' + base.host + url;
        } else if (!url.includes('://')) {
            absoluteUrl = new URL(url, baseUrl).href;
        } else {
            absoluteUrl = url;
        }
        return PREFIX + xorEncode(absoluteUrl);
    } catch (e) {
        return url;
    }
}

function assetKind(contentType, targetUrl) {
    const type = String(contentType || '').toLowerCase().split(';', 1)[0].trim();
    try {
        const path = new URL(targetUrl).pathname.toLowerCase();
        if (type === 'text/css' || type === 'text/stylesheet' || type === 'application/css' || path.endsWith('.css')) return 'css';
        if (type.includes('javascript') || type.includes('ecmascript') || type === 'text/js' || /\.(?:m?js|cjs|json|map)$/.test(path)) return 'js';
        if (type === 'text/html' || type === 'application/xhtml+xml' || path.endsWith('.html') || path.endsWith('.htm')) return 'html';
    } catch {}
    return '';
}

function rewriteHtml(html, baseUrl) {
    // Remove <base> tags to prevent incorrect relative URL resolution
    html = html.replace(/<base\b[^>]*>/gi, '');

    // Remove CSP meta tags
    html = html.replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
    html = html.replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy-Report-Only["'][^>]*>/gi, '');

    // Remove integrity attributes (rewritten scripts won't match the hash)
    html = html.replace(/\s+integrity=["'][^"']*["']/gi, '');
    
    // Remove crossorigin attributes
    html = html.replace(/\s+crossorigin=["'][^"']*["']/gi, '');
    
    // Remove referrerpolicy attributes
    html = html.replace(/\s+referrerpolicy=["'][^"']*["']/gi, '');

    // Rewrite href attributes
    html = html.replace(/href=["']([^"']+)["']/gi, (match, url) => {
        return `href="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite src attributes
    html = html.replace(/src=["']([^"']+)["']/gi, (match, url) => {
        return `src="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite srcset attributes
    html = html.replace(/srcset=["']([^"']+)["']/gi, (match, srcset) => {
        const rewritten = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const spaceIdx = trimmed.search(/\s/);
            if (spaceIdx === -1) {
                return rewriteUrl(trimmed, baseUrl);
            }
            const url = trimmed.slice(0, spaceIdx);
            const descriptor = trimmed.slice(spaceIdx);
            return rewriteUrl(url, baseUrl) + descriptor;
        }).join(', ');
        return `srcset="${rewritten}"`;
    });

    // Rewrite action attributes
    html = html.replace(/action=["']([^"']+)["']/gi, (match, url) => {
        return `action="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite formaction attributes (input/button)
    html = html.replace(/formaction=["']([^"']+)["']/gi, (match, url) => {
        return `formaction="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite background attributes
    html = html.replace(/background=["']([^"']+)["']/gi, (match, url) => {
        return `background="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite poster attributes (video)
    html = html.replace(/poster=["']([^"']+)["']/gi, (match, url) => {
        return `poster="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite data attributes (object, etc.)
    html = html.replace(/\bdata=["']([^"']+)["']/gi, (match, url) => {
        return `data="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite manifest attributes (html)
    html = html.replace(/manifest=["']([^"']+)["']/gi, (match, url) => {
        return `manifest="${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite cite attributes (blockquote, q, del, ins)
    html = html.replace(/cite=["']([^"']+)["']/gi, (match, url) => {
        return `cite="${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite longdesc attributes
    html = html.replace(/longdesc=["']([^"']+)["']/gi, (match, url) => {
        return `longdesc="${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite profile attributes (head)
    html = html.replace(/profile=["']([^"']+)["']/gi, (match, url) => {
        return `profile="${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite dynsrc attributes (deprecated but still used)
    html = html.replace(/dynsrc=["']([^"']+)["']/gi, (match, url) => {
        return `dynsrc="${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite lowsrc attributes (deprecated but still used)
    html = html.replace(/lowsrc=["']([^"']+)["']/gi, (match, url) => {
        return `lowsrc="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite meta refresh
    html = html.replace(/<meta\b[^>]*http-equiv=["']refresh["'][^>]*content=["'](\d+);\s*url=([^"']*)["'][^>]*>/gi, 
        (match, delay, url) => {
            return `<meta http-equiv="refresh" content="${delay}; url=${rewriteUrl(url, baseUrl)}">`;
        }
    );

    // Rewrite CSS in style tags
    html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
        return `<style>${rewriteCss(css, baseUrl)}</style>`;
    });

    // Rewrite CSS in style attributes
    html = html.replace(/style=["']([^"']*)["']/gi, (match, css) => {
        return `style="${rewriteCss(css, baseUrl)}"`;
    });

    // Inject UV client script at the very beginning of <head> or before </head>
    const uvScript = `<script src="/uv/uv.client.js"></script>`;
    if (html.includes('<head>')) {
        html = html.replace('<head>', '<head>' + uvScript);
    } else if (html.includes('</head>')) {
        html = html.replace('</head>', uvScript + '</head>');
    } else if (html.includes('<body')) {
        html = html.replace('<body', uvScript + '<body');
    } else {
        html = uvScript + html;
    }

    return html;
}

function rewriteCss(css, baseUrl) {
    // Rewrite url() references - more robust regex
    css = css.replace(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi, (match, url) => {
        return `url("${rewriteUrl(url.trim(), baseUrl)}")`;
    });

    // Rewrite @import with quotes
    css = css.replace(/@import\s+["']([^"']+)["']/gi, (match, url) => {
        return `@import "${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite @import with url()
    css = css.replace(/@import\s+url\(\s*["']?([^"')\s]+)["']?\s*\)/gi, (match, url) => {
        return `@import url("${rewriteUrl(url.trim(), baseUrl)}")`;
    });

    return css;
}

function rewriteJs(js, baseUrl) {
    // Rewrite fetch calls (string literals)
    js = js.replace(/fetch\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `fetch("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite fetch with template literals
    js = js.replace(/fetch\s*\(\s*`([^`]+)`/g, (match, url) => {
        return `fetch(\`${rewriteUrl(url, baseUrl)}\``;
    });
    
    // Rewrite fetch with variables (basic)
    js = js.replace(/fetch\s*\(\s*([^"',]+)/g, (match, url) => {
        if (url.trim().startsWith('"') || url.trim().startsWith("'") || url.trim().startsWith('`')) return match;
        return `fetch(__uv.rewriteUrl(${url})`;
    });

    // Rewrite XMLHttpRequest.open
    js = js.replace(/\.open\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g, (match, method, url) => {
        return `.open("${method}", "${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite XMLHttpRequest.open with variables
    js = js.replace(/\.open\s*\(\s*["']([^"']+)["']\s*,\s*([^)]+)/g, (match, method, url) => {
        if (url.trim().startsWith('"') || url.trim().startsWith("'") || url.trim().startsWith('`')) return match;
        return `.open("${method}", __uv.rewriteUrl(${url})`;
    });

    // Rewrite WebSocket
    js = js.replace(/new\s+WebSocket\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        const wsUrl = rewriteUrl(url, baseUrl).replace('https://', 'wss://').replace('http://', 'ws://');
        return `new WebSocket("${wsUrl}"`;
    });

    // Rewrite window.location assignments
    js = js.replace(/window\.location\s*=\s*["']([^"']+)["']/g, (match, url) => {
        return `window.location = "${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite document.location / self.location / top.location
    js = js.replace(/(document|self|top)\.location\s*=\s*["']([^"']+)["']/g, (match, obj, url) => {
        return `${obj}.location = "${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite location.assign / location.replace
    js = js.replace(/location\.(assign|replace)\s*\(\s*["']([^"']+)["']/g, (match, method, url) => {
        return `location.${method}("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite window.open
    js = js.replace(/window\.open\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `window.open("${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite window.open with variables
    js = js.replace(/window\.open\s*\(\s*([^)]+)/g, (match, url) => {
        if (url.trim().startsWith('"') || url.trim().startsWith("'") || url.trim().startsWith('`')) return match;
        return `window.open(__uv.rewriteUrl(${url})`;
    });

    // Rewrite navigator.sendBeacon
    js = js.replace(/navigator\.sendBeacon\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `navigator.sendBeacon("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite import statements
    js = js.replace(/(import\s+(?:[^'"]*?)\s+from\s+["'])([^"']+)(["'])/g, (match, prefix, url, suffix) => {
        return prefix + rewriteUrl(url, baseUrl) + suffix;
    });

    // Rewrite dynamic import()
    js = js.replace(/(import\s*\(\s*["'])([^"']+)(["']\s*\))/g, (match, prefix, url, suffix) => {
        return prefix + rewriteUrl(url, baseUrl) + suffix;
    });

    // Rewrite export ... from
    js = js.replace(/(export\s+.*?\s+from\s+["'])([^"']+)(["'])/g, (match, prefix, url, suffix) => {
        return prefix + rewriteUrl(url, baseUrl) + suffix;
    });

    // Rewrite new Worker / SharedWorker
    js = js.replace(/new\s+(Worker|SharedWorker)\s*\(\s*["']([^"']+)["']/g, (match, type, url) => {
        return `new ${type}("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite jQuery ajax calls
    js = js.replace(/\$\.(get|post|ajax)\s*\(\s*["']([^"']+)["']/g, (match, method, url) => {
        return `$.${method}("${rewriteUrl(url, baseUrl)}"`;
    });
    
    // Rewrite jQuery load
    js = js.replace(/\$\(.*\)\.load\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return match.replace(url, rewriteUrl(url, baseUrl));
    });
    
    // Rewrite jQuery getJSON/getScript
    js = js.replace(/\$\.(getJSON|getScript)\s*\(\s*["']([^"']+)["']/g, (match, method, url) => {
        return `$.${method}("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite cache.add / cache.addAll
    js = js.replace(/cache\.add\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `cache.add("${rewriteUrl(url, baseUrl)}"`;
    });
    js = js.replace(/cache\.addAll\s*\(\s*\[([^\]]*)\]/g, (match, urls) => {
        const rewritten = urls.split(',').map(u => {
            const trimmed = u.trim();
            if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
                const quote = trimmed[0];
                const inner = trimmed.slice(1, -1);
                return `${quote}${rewriteUrl(inner, baseUrl)}${quote}`;
            }
            return u;
        }).join(', ');
        return `cache.addAll([${rewritten}]`;
    });

    return js;
}

// ============================================
// BARE SERVER IMPLEMENTATION
// ============================================
async function handleBare(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing URL parameter' }));
        return;
    }

    try {
        const target = validateTarget(targetUrl);
        const options = {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: cleanHeaders(req.headers),
            servername: target.hostname
        };

        delete options.headers.host;
        options.headers.host = target.host;
        const selectedProxy = applyUpstreamProxy(options, target);
        if (selectedProxy) console.log(`[proxy-pool] ${selectedProxy.protocol}://${selectedProxy.host}:${selectedProxy.port} -> ${target.hostname}`);

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.setTimeout(PROXY_ATTEMPT_TIMEOUT_MS, () => proxyReq.destroy(new Error(`Upstream proxy attempt timed out after ${PROXY_ATTEMPT_TIMEOUT_MS}ms`)));

        proxyReq.on('error', (err) => {
            if (res.headersSent) return;
            if (selectedProxy && req.method === 'GET' && (req._proxyAttempts || 0) < 3) {
                req._proxyAttempts = (req._proxyAttempts || 0) + 1;
                return handleBare(req, res);
            }
            res.writeHead(502);
            res.end(JSON.stringify({ error: 'Proxy error', message: err.message }));
        });

        req.pipe(proxyReq);
    } catch (err) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid URL', message: err.message }));
    }
}

// ============================================
// PROXY REQUEST HANDLER (XOR-encoded /service/...)
// ============================================
async function handleProxy(req, res) {
    const encodedUrl = req.url.slice(PREFIX.length).split('?')[0];
    const requestQuery = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    let targetUrl;

    try {
        targetUrl = xorDecode(encodedUrl);
    } catch (e) {
        res.writeHead(400);
        res.end('Invalid URL encoding');
        return;
    }

    // Merge request query string with target URL (fixes form GET submissions)
    if (requestQuery) {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + requestQuery.slice(1);
    }

    try {
        const target = validateTarget(targetUrl);
        const options = {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: cleanHeaders(req.headers),
            servername: target.hostname
        };

        delete options.headers.host;
        options.headers.host = target.host;
        const selectedProxy = applyUpstreamProxy(options, target);
        if (selectedProxy) console.log(`[proxy-pool] ${selectedProxy.protocol}://${selectedProxy.host}:${selectedProxy.port} -> ${target.hostname}`);

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, async (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';
            let body = [];

            proxyRes.on('data', chunk => {
                body.push(chunk);
                if (Buffer.concat(body).length > MAX_RESPONSE_BYTES) proxyRes.destroy(new Error('Response too large'));
            });
            proxyRes.on('end', () => {
                let data = Buffer.concat(body);

                // Decompress if needed
                const encoding = proxyRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try { data = zlib.gunzipSync(data); } catch (e) {}
                } else if (encoding === 'deflate') {
                    try { data = zlib.inflateSync(data); } catch (e) {}
                } else if (encoding === 'br') {
                    try { data = zlib.brotliDecompressSync(data); } catch (e) {}
                }

                delete proxyRes.headers['content-encoding'];

                // Remove security headers that break proxied content
                delete proxyRes.headers['content-security-policy'];
                delete proxyRes.headers['content-security-policy-report-only'];
                delete proxyRes.headers['x-frame-options'];
                delete proxyRes.headers['frame-options'];
                delete proxyRes.headers['x-content-type-options'];
                delete proxyRes.headers['referrer-policy'];
                delete proxyRes.headers['permissions-policy'];
                delete proxyRes.headers['feature-policy'];

                // Fix CORS headers for the proxy origin
                proxyRes.headers['access-control-allow-origin'] = '*';
                delete proxyRes.headers['access-control-allow-credentials'];

                // Redirects and cookies matter for binary responses too.
                if (proxyRes.headers.location) proxyRes.headers.location = rewriteRedirectUrl(proxyRes.headers.location, targetUrl);
                if (proxyRes.headers.refresh) {
                    const refreshMatch = proxyRes.headers.refresh.match(/(\d+);\s*url=(.+)/i);
                    if (refreshMatch) proxyRes.headers.refresh = `${refreshMatch[1]}; url=${rewriteRedirectUrl(refreshMatch[2], targetUrl)}`;
                }
                if (proxyRes.headers['set-cookie']) {
                    proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => cookie
                        .replace(/domain=[^;]+/gi, '')
                        .replace(/path=[^;]+/gi, 'path=/')
                        .replace(/;?\s*secure/gi, '')
                        .replace(/;?\s*samesite=[^;]+/gi, ''));
                }

                // Rewrite HTML, CSS, and JavaScript even when a CDN sends a
                // generic MIME type; the URL extension is a safe fallback.
                const kind = assetKind(contentType, targetUrl);
                if (kind) {
                    let bodyStr = data.toString('utf-8');
                    if (kind === 'html') bodyStr = rewriteHtml(bodyStr, targetUrl);
                    else if (kind === 'css') bodyStr = rewriteCss(bodyStr, targetUrl);
                    else if (kind === 'js') bodyStr = rewriteJs(bodyStr, targetUrl);

                    const finalData = Buffer.from(bodyStr);
                    proxyRes.headers['content-length'] = finalData.length;
                    delete proxyRes.headers['transfer-encoding'];
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(finalData);
                } else {
                    // Binary data - pass through unchanged
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(data);
                }
            });
        });

        proxyReq.setTimeout(PROXY_ATTEMPT_TIMEOUT_MS, () => proxyReq.destroy(new Error(`Upstream proxy attempt timed out after ${PROXY_ATTEMPT_TIMEOUT_MS}ms`)));

        proxyReq.on('error', (err) => {
            if (res.headersSent) return;
            if (selectedProxy && req.method === 'GET' && (req._proxyAttempts || 0) < 3) {
                req._proxyAttempts = (req._proxyAttempts || 0) + 1;
                return handleProxy(req, res);
            }
            res.writeHead(502);
            res.end(`<h1>Proxy Error</h1><p>${escapeHtml(err.message)}</p>`);
        });

        req.pipe(proxyReq);

    } catch (err) {
        res.writeHead(400);
        res.end(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);
    }
}

// ============================================
// SIMPLE QUERY-BASED PROXY (for /proxy?url=...)
// ============================================
async function handleSimpleProxy(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing url parameter. Use /proxy?url=https://example.com' }));
        return;
    }

    // Decode if URL-encoded
    try {
        targetUrl = decodeURIComponent(targetUrl);
    } catch (e) {
        // Already decoded or invalid, use as-is
    }

    try {
        const target = validateTarget(targetUrl);
        const options = {
            hostname: target.hostname,
            port: target.port || (target.protocol === 'https:' ? 443 : 80),
            path: target.pathname + target.search,
            method: req.method,
            headers: cleanHeaders(req.headers),
            servername: target.hostname
        };

        delete options.headers.host;
        options.headers.host = target.host;
        const selectedProxy = applyUpstreamProxy(options, target);
        if (selectedProxy) console.log(`[proxy-pool] ${selectedProxy.protocol}://${selectedProxy.host}:${selectedProxy.port} -> ${target.hostname}`);

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, async (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';
            let body = [];

            proxyRes.on('data', chunk => {
                body.push(chunk);
                if (Buffer.concat(body).length > MAX_RESPONSE_BYTES) proxyRes.destroy(new Error('Response too large'));
            });
            proxyRes.on('end', () => {
                let data = Buffer.concat(body);

                // Decompress if needed
                const encoding = proxyRes.headers['content-encoding'];
                if (encoding === 'gzip') {
                    try { data = zlib.gunzipSync(data); } catch (e) {}
                } else if (encoding === 'deflate') {
                    try { data = zlib.inflateSync(data); } catch (e) {}
                } else if (encoding === 'br') {
                    try { data = zlib.brotliDecompressSync(data); } catch (e) {}
                }

                delete proxyRes.headers['content-encoding'];

                // Remove security headers that break proxied content
                delete proxyRes.headers['content-security-policy'];
                delete proxyRes.headers['content-security-policy-report-only'];
                delete proxyRes.headers['x-frame-options'];
                delete proxyRes.headers['frame-options'];
                delete proxyRes.headers['x-content-type-options'];
                delete proxyRes.headers['referrer-policy'];
                delete proxyRes.headers['permissions-policy'];
                delete proxyRes.headers['feature-policy'];

                // Fix CORS headers for the proxy origin
                proxyRes.headers['access-control-allow-origin'] = '*';
                delete proxyRes.headers['access-control-allow-credentials'];

                // Redirects and cookies matter for binary responses too.
                if (proxyRes.headers.location) proxyRes.headers.location = rewriteRedirectUrl(proxyRes.headers.location, targetUrl);
                if (proxyRes.headers.refresh) {
                    const refreshMatch = proxyRes.headers.refresh.match(/(\d+);\s*url=(.+)/i);
                    if (refreshMatch) proxyRes.headers.refresh = `${refreshMatch[1]}; url=${rewriteRedirectUrl(refreshMatch[2], targetUrl)}`;
                }
                if (proxyRes.headers['set-cookie']) {
                    proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => cookie
                        .replace(/domain=[^;]+/gi, '')
                        .replace(/path=[^;]+/gi, 'path=/')
                        .replace(/;?\s*secure/gi, '')
                        .replace(/;?\s*samesite=[^;]+/gi, ''));
                }

                // Rewrite HTML, CSS, and JavaScript even when a CDN sends a
                // generic MIME type; the URL extension is a safe fallback.
                const kind = assetKind(contentType, targetUrl);
                if (kind) {
                    let bodyStr = data.toString('utf-8');
                    if (kind === 'html') bodyStr = rewriteHtml(bodyStr, targetUrl);
                    else if (kind === 'css') bodyStr = rewriteCss(bodyStr, targetUrl);
                    else if (kind === 'js') bodyStr = rewriteJs(bodyStr, targetUrl);

                    const finalData = Buffer.from(bodyStr);
                    proxyRes.headers['content-length'] = finalData.length;
                    delete proxyRes.headers['transfer-encoding'];
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(finalData);
                } else {
                    // Binary data - pass through unchanged
                    res.writeHead(proxyRes.statusCode, proxyRes.headers);
                    res.end(data);
                }
            });
        });

        proxyReq.setTimeout(PROXY_ATTEMPT_TIMEOUT_MS, () => proxyReq.destroy(new Error(`Upstream proxy attempt timed out after ${PROXY_ATTEMPT_TIMEOUT_MS}ms`)));

        proxyReq.on('error', (err) => {
            if (res.headersSent) return;
            if (selectedProxy && req.method === 'GET' && (req._proxyAttempts || 0) < 3) {
                req._proxyAttempts = (req._proxyAttempts || 0) + 1;
                return handleProxy(req, res);
            }
            res.writeHead(502);
            res.end(`<h1>Proxy Error</h1><p>${escapeHtml(err.message)}</p>`);
        });

        req.pipe(proxyReq);

    } catch (err) {
        res.writeHead(400);
        res.end(`<h1>Error</h1><p>${escapeHtml(err.message)}</p>`);
    }
}

// ============================================
// STATIC FILES
// ============================================
const uvClientJs = `
(function() {
    'use strict';

    const PREFIX = '${PREFIX}';
    const BARE_PREFIX = '${BARE_PREFIX}';
    const XOR_KEY = '${XOR_KEY}';

    function xorEncode(str) {
        let result = '';
        for (let i = 0; i < str.length; i++) {
            result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
        }
        return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    }

    function xorDecode(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        const decoded = atob(str);
        let result = '';
        for (let i = 0; i < decoded.length; i++) {
            result += String.fromCharCode(decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
        }
        return result;
    }

    // Get original URL from current proxy path
    function getOriginalUrl() {
        try {
            const encoded = location.pathname.slice(PREFIX.length).split('?')[0];
            return xorDecode(encoded);
        } catch(e) {
            return location.href;
        }
    }

    let currentUrl = getOriginalUrl();
    let ORIGIN;
    try {
        ORIGIN = new URL(currentUrl).origin;
    } catch(e) {
        ORIGIN = location.origin;
    }

    function rewriteUrl(url) {
        if (!url || typeof url !== 'string') return url;
        if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:') || url.startsWith('mailto:')) return url;
        if (url.startsWith(PREFIX)) return url;
        try {
            let absoluteUrl = url;
            if (url.startsWith('//')) absoluteUrl = 'https:' + url;
            else if (url.startsWith('/')) absoluteUrl = ORIGIN + url;
            else if (!url.includes('://')) absoluteUrl = new URL(url, currentUrl).href;
            else absoluteUrl = url;
            return PREFIX + xorEncode(absoluteUrl);
        } catch (e) { return url; }
    }

    // Expose rewriteUrl globally for inline scripts
    window.__uv = { rewriteUrl: rewriteUrl };

    // Save original location before overriding
    const originalLocation = window.location;
    const originalURL = window.URL;

    // Create proxy location object
    let urlObj;
    try { urlObj = new originalURL(currentUrl); } catch (e) { urlObj = new originalURL(location.href); }
    const proxyLoc = {};
    
    const locProps = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin', 'username', 'password'];
    
    locProps.forEach(key => {
        Object.defineProperty(proxyLoc, key, {
            get: () => urlObj[key],
            set: (val) => {
                urlObj[key] = val;
                currentUrl = urlObj.href;
                ORIGIN = urlObj.origin;
                if (key === 'href') {
                    originalLocation.href = PREFIX + xorEncode(currentUrl);
                }
            }
        });
    });
    
    // Add Location methods
    proxyLoc.assign = function(url) {
        currentUrl = new URL(url, currentUrl).href;
        originalLocation.assign(PREFIX + xorEncode(currentUrl));
    };
    proxyLoc.replace = function(url) {
        currentUrl = new URL(url, currentUrl).href;
        originalLocation.replace(PREFIX + xorEncode(currentUrl));
    };
    proxyLoc.reload = function(...args) {
        originalLocation.reload(...args);
    };
    proxyLoc.toString = function() {
        return currentUrl;
    };

    // Some browsers expose window.location as a non-configurable property.
    // Treat that as a normal limitation instead of aborting the whole client.
    try {
        Object.defineProperty(window, 'location', {
            configurable: true,
            get: () => proxyLoc,
            set: (url) => {
                currentUrl = new URL(url, currentUrl).href;
                originalLocation.href = PREFIX + xorEncode(currentUrl);
            }
        });
    } catch (e) {
        console.debug('[UV] window.location override unavailable');
    }

    // Override document.location
    try {
        Object.defineProperty(document, 'location', {
            get: () => proxyLoc,
            set: (url) => {
                currentUrl = new URL(url, currentUrl).href;
                originalLocation.href = PREFIX + xorEncode(currentUrl);
            }
        });
    } catch(e) {}

    // Override URL constructor so relative URLs resolve against original page
    window.URL = class extends originalURL {
        constructor(url, base) {
            if (base === undefined && typeof url === 'string' && !url.match(/^(data|blob|javascript|mailto):/i)) {
                base = currentUrl;
            }
            super(url, base);
        }
    };
    for (const key of Object.getOwnPropertyNames(originalURL)) {
        if (typeof originalURL[key] === 'function' && key !== 'prototype') {
            window.URL[key] = originalURL[key].bind(originalURL);
        }
    }

    // Override document.domain to match original site (helps with iframe detection)
    try {
        Object.defineProperty(document, 'domain', {
            get: () => new URL(currentUrl).hostname,
            set: () => {}
        });
    } catch(e) {}

    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (typeof url === 'string') url = rewriteUrl(url);
        else if (url instanceof Request) {
            const newRequest = new Request(rewriteUrl(url.url), url);
            return originalFetch(newRequest, options);
        }
        return originalFetch(url, options);
    };

    // Override XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
        return originalOpen.call(this, method, rewriteUrl(url), async, user, password);
    };

    // Override WebSocket
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        const rewritten = rewriteUrl(url).replace('https://', 'wss://').replace('http://', 'ws://');
        return new OriginalWebSocket(rewritten, protocols);
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;

    // Override document.cookie
    const originalCookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || 
                          Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');
    if (originalCookie) {
        Object.defineProperty(document, 'cookie', {
            get: function() {
                return originalCookie.get.call(this);
            },
            set: function(val) {
                return originalCookie.set.call(this, val);
            }
        });
    }

    // Override localStorage/sessionStorage
    ['localStorage', 'sessionStorage'].forEach(name => {
        const storage = window[name];
        if (!storage) return;
        const originalSetItem = storage.setItem;
        const originalGetItem = storage.getItem;
        storage.setItem = function(key, value) {
            return originalSetItem.call(this, key, value);
        };
        storage.getItem = function(key) {
            return originalGetItem.call(this, key);
        };
    });

    // Override history.pushState/replaceState
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function(state, title, url) {
        if (url) {
            currentUrl = new URL(url, currentUrl).href;
            url = PREFIX + xorEncode(currentUrl);
        }
        return originalPushState.call(this, state, title, url);
    };
    history.replaceState = function(state, title, url) {
        if (url) {
            currentUrl = new URL(url, currentUrl).href;
            url = PREFIX + xorEncode(currentUrl);
        }
        return originalReplaceState.call(this, state, title, url);
    };

    // Keep currentUrl in sync when user navigates back/forward
    window.addEventListener('popstate', function() {
        try {
            const encoded = location.pathname.slice(PREFIX.length).split('?')[0];
            currentUrl = xorDecode(encoded);
            ORIGIN = new URL(currentUrl).origin;
            // Update urlObj
            const newUrl = new URL(currentUrl);
            locProps.forEach(key => {
                urlObj[key] = newUrl[key];
            });
        } catch(e) {}
    });

    // Override Worker
    const OriginalWorker = window.Worker;
    window.Worker = function(url, options) {
        return new OriginalWorker(rewriteUrl(url), options);
    };

    // Override SharedWorker
    if (window.SharedWorker) {
        const OriginalSharedWorker = window.SharedWorker;
        window.SharedWorker = function(url, options) {
            return new OriginalSharedWorker(rewriteUrl(url), options);
        };
    }

    // Override importScripts (in workers)
    if (typeof importScripts !== 'undefined') {
        const originalImportScripts = importScripts;
        importScripts = function(...urls) {
            return originalImportScripts(...urls.map(rewriteUrl));
        };
    }

    // Override EventSource
    const OriginalEventSource = window.EventSource;
    window.EventSource = function(url, options) {
        return new OriginalEventSource(rewriteUrl(url), options);
    };

    // Override navigator.sendBeacon
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
        return originalSendBeacon.call(this, rewriteUrl(url), data);
    };

    // Intercept dynamic element creation
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
        const element = originalCreateElement.call(this, tagName, options);
        const tag = tagName.toLowerCase();
        if (tag === 'script' || tag === 'iframe' || tag === 'link' || tag === 'source' || 
            tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'embed' || 
            tag === 'object' || tag === 'track') {
            const originalSetAttribute = element.setAttribute;
            element.setAttribute = function(name, value) {
                if (name === 'src' || name === 'href' || name === 'srcset' || 
                    name === 'data' || name === 'action' || name === 'formaction' ||
                    name === 'poster' || name === 'background' || name === 'cite' ||
                    name === 'longdesc' || name === 'profile' || name === 'dynsrc' ||
                    name === 'lowsrc') {
                    value = rewriteUrl(value);
                }
                return originalSetAttribute.call(this, name, value);
            };
        }
        return element;
    };
    
    // Intercept src property setters on existing elements
    const originalSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (originalSrcSetter && originalSrcSetter.set) {
        Object.defineProperty(HTMLImageElement.prototype, 'src', {
            get: originalSrcSetter.get,
            set: function(val) {
                originalSrcSetter.set.call(this, rewriteUrl(val));
            }
        });
    }
    
    const originalHrefSetter = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
    if (originalHrefSetter && originalHrefSetter.set) {
        Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
            get: originalHrefSetter.get,
            set: function(val) {
                originalHrefSetter.set.call(this, rewriteUrl(val));
            }
        });
    }

    // Override window.open more thoroughly
    const originalOpen = window.open;
    window.open = function(url, target, features) {
        if (url) url = rewriteUrl(url);
        return originalOpen.call(this, url, target, features);
    };

    console.log('[UV] Client initialized');
})();
`;

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #0a0a0a;
            color: #fff;
            font-family: 'Segoe UI', system-ui, sans-serif;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }
        .container {
            width: 90%;
            max-width: 700px;
            text-align: center;
        }
        h1 {
            font-size: 3rem;
            margin-bottom: 10px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }
        .subtitle {
            color: #888;
            margin-bottom: 40px;
            font-size: 1.1rem;
        }
        .search-box {
            display: flex;
            gap: 10px;
            margin-bottom: 30px;
        }
        input[type="text"] {
            flex: 1;
            padding: 15px 20px;
            border: 2px solid #333;
            border-radius: 12px;
            background: #1a1a1a;
            color: #fff;
            font-size: 1rem;
            outline: none;
            transition: border-color 0.3s;
        }
        input[type="text"]:focus {
            border-color: #667eea;
        }
        button {
            padding: 15px 30px;
            border: none;
            border-radius: 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #fff;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
        }
        .search-toggle {
            display: flex;
            justify-content: center;
            gap: 10px;
            margin-bottom: 15px;
        }
        .toggle-btn {
            padding: 8px 20px;
            border: 2px solid #333;
            border-radius: 20px;
            background: #1a1a1a;
            color: #888;
            font-size: 0.85rem;
            cursor: pointer;
            transition: all 0.3s;
        }
        .toggle-btn.active {
            border-color: #667eea;
            color: #fff;
            background: #252540;
        }
        .shortcuts {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
            gap: 15px;
            margin-top: 20px;
        }
        .shortcut {
            padding: 20px;
            background: #1a1a1a;
            border-radius: 12px;
            cursor: pointer;
            transition: transform 0.2s, background 0.2s;
            border: 1px solid #333;
        }
        .shortcut:hover {
            transform: translateY(-3px);
            background: #252525;
            border-color: #667eea;
        }
        .shortcut-icon {
            font-size: 2rem;
            margin-bottom: 8px;
        }
        .shortcut-name {
            font-size: 0.9rem;
            color: #ccc;
        }
        .footer {
            position: fixed;
            bottom: 20px;
            color: #555;
            font-size: 0.85rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Proxy</h1>
        <p class="subtitle">Browse the web freely</p>

        <div class="search-toggle">
            <button class="toggle-btn active" id="webBtn" onclick="setMode('web')">Web</button>
            <button class="toggle-btn" id="youtubeBtn" onclick="setMode('youtube')">YouTube</button>
        </div>

        <div class="search-box">
            <input type="text" id="urlInput" placeholder="Enter URL (e.g., google.com)" 
                   onkeypress="if(event.key==='Enter')go()">
            <button onclick="go()">Go</button>
        </div>

        <div class="shortcuts">
            <div class="shortcut" onclick="goTo('https://google.com')">
                <div class="shortcut-icon">🔍</div>
                <div class="shortcut-name">Google</div>
            </div>
            <div class="shortcut" onclick="goTo('https://youtube.com')">
                <div class="shortcut-icon">📺</div>
                <div class="shortcut-name">YouTube</div>
            </div>
            <div class="shortcut" onclick="goTo('https://discord.com')">
                <div class="shortcut-icon">💬</div>
                <div class="shortcut-name">Discord</div>
            </div>
            <div class="shortcut" onclick="goTo('https://reddit.com')">
                <div class="shortcut-icon">🔴</div>
                <div class="shortcut-name">Reddit</div>
            </div>
            <div class="shortcut" onclick="goTo('https://twitter.com')">
                <div class="shortcut-icon">🐦</div>
                <div class="shortcut-name">Twitter</div>
            </div>
            <div class="shortcut" onclick="goTo('https://github.com')">
                <div class="shortcut-icon">🐙</div>
                <div class="shortcut-name">GitHub</div>
            </div>
        </div>
    </div>

    <div class="footer">Built with Node.js | UV-Style Proxy</div>

    <script>
        const PREFIX = '${PREFIX}';
        const XOR_KEY = '${XOR_KEY}';

        let searchMode = 'web';

        function setMode(mode) {
            searchMode = mode;
            document.getElementById('webBtn').classList.toggle('active', mode === 'web');
            document.getElementById('youtubeBtn').classList.toggle('active', mode === 'youtube');
            const input = document.getElementById('urlInput');
            if (mode === 'youtube') {
                input.placeholder = 'Search YouTube...';
            } else {
                input.placeholder = 'Enter URL (e.g., google.com)';
            }
        }

        function xorEncode(str) {
            let result = '';
            for (let i = 0; i < str.length; i++) {
                result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
            }
            return btoa(result).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        }

        function go() {
            let query = document.getElementById('urlInput').value.trim();
            if (!query) return;

            if (searchMode === 'youtube') {
                // YouTube search via proxy
                const searchUrl = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query) + '&themeRefresh=';
                location.href = PREFIX + xorEncode(searchUrl);
            } else {
                // Normal web mode
                let url = query;
                if (!url.startsWith('http://') && !url.startsWith('https://')) {
                    url = 'https://' + url;
                }
                location.href = PREFIX + xorEncode(url);
            }
        }

        function goTo(url) {
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                url = 'https://' + url;
            }
            location.href = PREFIX + xorEncode(url);
        }
    </script>
</body>
</html>`;

;

// ============================================
// MAIN SERVER
// ============================================
const server = http.createServer((req, res) => {
    const cleanUrl = req.url.split('?')[0];

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', '*');
    // Credentials cannot be combined with a wildcard origin.
    // Keep this endpoint intentionally non-credentialed.

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Serve UV client script BEFORE proxy check
    if (cleanUrl === '/uv/uv.client.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(uvClientJs);
        return;
    }

    // Simple query-based proxy (for /proxy?url=...)
    if (cleanUrl === '/proxy') {
        handleSimpleProxy(req, res);
        return;
    }

    // Bare server endpoint
    if (cleanUrl.startsWith(BARE_PREFIX)) {
        handleBare(req, res);
        return;
    }

    // Proxy service (XOR-encoded /service/...)
    if (cleanUrl.startsWith(PREFIX)) {
        handleProxy(req, res);
        return;
    }

    // Static files
    if (cleanUrl === '/' || cleanUrl === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexHtml);
        return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(
`╔══════════════════════════════════════════╗
║     UV-Style Proxy Server Running        ║
╠══════════════════════════════════════════╣
║  Port:     ${PORT.toString().padEnd(31)} ║
║  Prefix:   ${PREFIX.padEnd(31)} ║
║  Bare:     ${BARE_PREFIX.padEnd(31)} ║
║  Simple:   /proxy?url=...                ║
╚══════════════════════════════════════════╝
Open: http://localhost:${PORT}
`);
});
