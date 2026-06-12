// ============================================
// ULTRAVIOLET-STYLE PROXY - Single File
// Backend: Bare Server + Static File Serving
// Frontend: Service Worker + URL Rewriter
// ============================================

const http = require('http');
const https = require('https');
const { URL } = require('url');
const zlib = require('zlib');

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 8080;
const PREFIX = '/service/';
const BARE_PREFIX = '/bare/';

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
        'x-real-ip', 'true-client-ip', 'x-request-id'
    ];
    
    for (const key of blockedHeaders) {
        delete h[key];
    }
    
    return h;
}

// ============================================
// URL REWRITER
// ============================================
function rewriteUrl(url, baseUrl) {
    if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:')) {
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

function rewriteHtml(html, baseUrl) {
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
            const [url, descriptor] = part.trim().split(/\s+/);
            return rewriteUrl(url, baseUrl) + (descriptor ? ' ' + descriptor : '');
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
    html = html.replace(/data=["']([^"']+)["']/gi, (match, url) => {
        return `data="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite manifest attributes (html)
    html = html.replace(/manifest=["']([^"']+)["']/gi, (match, url) => {
        return `manifest="${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite meta refresh
    html = html.replace(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["'](\d+);\s*url=([^"']*)["'][^>]*>/gi, 
        (match, delay, url) => {
            return `<meta http-equiv="refresh" content="${delay}; url=${rewriteUrl(url, baseUrl)}">`;
        }
    );

    // Rewrite CSS in style tags
    html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => {
        return `<style>${rewriteCss(css, baseUrl)}</style>`;
    });

    // Rewrite CSS in style attributes
    html = html.replace(/style=["']([^"']*)["']/gi, (match, css) => {
        return `style="${rewriteCss(css, baseUrl)}"`;
    });

    // Inject UV client script
    const uvScript = `<script src="/uv/uv.client.js"></script>`;
    if (html.includes('</head>')) {
        html = html.replace('</head>', uvScript + '</head>');
    } else if (html.includes('<body')) {
        html = html.replace('<body', uvScript + '<body');
    } else {
        html = uvScript + html;
    }

    return html;
}

function rewriteCss(css, baseUrl) {
    // Rewrite url() references
    css = css.replace(/url\(\s*["']?([^"')]+?)["']?\s*\)/gi, (match, url) => {
        return `url("${rewriteUrl(url.trim(), baseUrl)}")`;
    });

    // Rewrite @import with quotes
    css = css.replace(/@import\s+["']([^"']+)["']/gi, (match, url) => {
        return `@import "${rewriteUrl(url, baseUrl)}"`;
    });

    return css;
}

function rewriteJs(js, baseUrl) {
    // Rewrite fetch calls (string literals)
    js = js.replace(/fetch\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `fetch("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite fetch with template literals (basic)
    js = js.replace(/fetch\s*\(\s*`([^`]+)`/g, (match, url) => {
        return `fetch(\`${rewriteUrl(url, baseUrl)}\``;
    });

    // Rewrite XMLHttpRequest.open
    js = js.replace(/\.open\s*\(\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g, (match, method, url) => {
        return `.open("${method}", "${rewriteUrl(url, baseUrl)}"`;
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

    // Rewrite navigator.sendBeacon
    js = js.replace(/navigator\.sendBeacon\s*\(\s*["']([^"']+)["']/g, (match, url) => {
        return `navigator.sendBeacon("${rewriteUrl(url, baseUrl)}"`;
    });

    // Rewrite import statements
    js = js.replace(/(import\s+(?:[^'"]*?|.*?)\s+from\s+["'])([^"']+)(["'])/g, (match, prefix, url, suffix) => {
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
        const target = new URL(targetUrl);
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

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
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
    let targetUrl;

    try {
        targetUrl = xorDecode(encodedUrl);
    } catch (e) {
        res.writeHead(400);
        res.end('Invalid URL encoding');
        return;
    }

    try {
        const target = new URL(targetUrl);
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

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, async (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';
            let body = [];

            proxyRes.on('data', chunk => body.push(chunk));
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

                // Only rewrite text content
                const isText = contentType.includes('text/html') || 
                              contentType.includes('text/css') || 
                              contentType.includes('javascript') ||
                              contentType.includes('ecmascript') ||
                              contentType.includes('/js');

                if (isText) {
                    let bodyStr = data.toString('utf-8');

                    if (contentType.includes('text/html')) {
                        bodyStr = rewriteHtml(bodyStr, targetUrl);
                    } else if (contentType.includes('text/css')) {
                        bodyStr = rewriteCss(bodyStr, targetUrl);
                    } else if (contentType.includes('javascript') || contentType.includes('ecmascript') || contentType.includes('/js')) {
                        bodyStr = rewriteJs(bodyStr, targetUrl);
                    }

                    // Rewrite Location headers
                    if (proxyRes.headers.location) {
                        proxyRes.headers.location = rewriteUrl(proxyRes.headers.location, targetUrl);
                    }

                    // Rewrite Set-Cookie domain/path
                    if (proxyRes.headers['set-cookie']) {
                        proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => {
                            return cookie.replace(/domain=[^;]+/, '').replace(/path=[^;]+/, 'path=/');
                        });
                    }

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

        proxyReq.on('error', (err) => {
            res.writeHead(502);
            res.end(`<h1>Proxy Error</h1><p>${err.message}</p>`);
        });

        req.pipe(proxyReq);

    } catch (err) {
        res.writeHead(400);
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
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
        const target = new URL(targetUrl);
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

        const proxyReq = (target.protocol === 'https:' ? https : http).request(options, async (proxyRes) => {
            const contentType = proxyRes.headers['content-type'] || '';
            let body = [];

            proxyRes.on('data', chunk => body.push(chunk));
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

                // Only rewrite text content
                const isText = contentType.includes('text/html') || 
                              contentType.includes('text/css') || 
                              contentType.includes('javascript') ||
                              contentType.includes('ecmascript') ||
                              contentType.includes('/js');

                if (isText) {
                    let bodyStr = data.toString('utf-8');

                    if (contentType.includes('text/html')) {
                        bodyStr = rewriteHtml(bodyStr, targetUrl);
                    } else if (contentType.includes('text/css')) {
                        bodyStr = rewriteCss(bodyStr, targetUrl);
                    } else if (contentType.includes('javascript') || contentType.includes('ecmascript') || contentType.includes('/js')) {
                        bodyStr = rewriteJs(bodyStr, targetUrl);
                    }

                    // Rewrite Location headers
                    if (proxyRes.headers.location) {
                        proxyRes.headers.location = rewriteUrl(proxyRes.headers.location, targetUrl);
                    }

                    // Rewrite Set-Cookie domain/path
                    if (proxyRes.headers['set-cookie']) {
                        proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(cookie => {
                            return cookie.replace(/domain=[^;]+/, '').replace(/path=[^;]+/, 'path=/');
                        });
                    }

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

        proxyReq.on('error', (err) => {
            res.writeHead(502);
            res.end(`<h1>Proxy Error</h1><p>${err.message}</p>`);
        });

        req.pipe(proxyReq);

    } catch (err) {
        res.writeHead(400);
        res.end(`<h1>Error</h1><p>${err.message}</p>`);
    }
}

// ============================================
// STATIC FILES
// ============================================
const uvClientJs = `
// UV Client - Intercepts browser APIs
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
        return btoa(result).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
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

    function rewriteUrl(url) {
        if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('blob:')) return url;
        if (url.startsWith(PREFIX)) return url;
        try {
            let absoluteUrl = url;
            if (url.startsWith('//')) absoluteUrl = 'https:' + url;
            else if (url.startsWith('/')) absoluteUrl = location.origin + url;
            else if (!url.includes('://')) absoluteUrl = new URL(url, location.href).href;
            return PREFIX + xorEncode(absoluteUrl);
        } catch (e) { return url; }
    }

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

    // Override window.location
    let currentUrl = location.href;
    Object.defineProperty(window, 'location', {
        get: function() {
            const loc = new URL(currentUrl);
            const proxyLoc = {};
            for (let key in loc) {
                if (typeof loc[key] === 'function') {
                    proxyLoc[key] = loc[key].bind(loc);
                } else {
                    Object.defineProperty(proxyLoc, key, {
                        get: () => loc[key],
                        set: (val) => {
                            if (key === 'href') {
                                currentUrl = rewriteUrl(val);
                                location.href = currentUrl;
                            }
                        }
                    });
                }
            }
            return proxyLoc;
        },
        set: function(url) {
            location.href = rewriteUrl(url);
        }
    });

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
        if (url) url = rewriteUrl(url);
        return originalPushState.call(this, state, title, url);
    };
    history.replaceState = function(state, title, url) {
        if (url) url = rewriteUrl(url);
        return originalReplaceState.call(this, state, title, url);
    };

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

    // Intercept dynamic script injection
    const originalCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function(tagName, options) {
        const element = originalCreateElement.call(this, tagName, options);
        if (tagName.toLowerCase() === 'script' || tagName.toLowerCase() === 'iframe' || tagName.toLowerCase() === 'link') {
            const originalSetAttribute = element.setAttribute;
            element.setAttribute = function(name, value) {
                if (name === 'src' || name === 'href') value = rewriteUrl(value);
                return originalSetAttribute.call(this, name, value);
            };
        }
        return element;
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

        function xorEncode(str) {
            let result = '';
            for (let i = 0; i < str.length; i++) {
                result += String.fromCharCode(str.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
            }
            return btoa(result).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
        }

        function go() {
            let url = document.getElementById('urlInput').value.trim();
            if (!url) return;
            goTo(url);
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

// ============================================
// MAIN SERVER
// ============================================
const server = http.createServer((req, res) => {
    const cleanUrl = req.url.split('?')[0];

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

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
