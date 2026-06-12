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
        return btoa(result).replace(/\\\\+/g, '-').replace(/\\\\//g, '_').replace(/=/g, '');
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
    const urlObj = new URL(currentUrl);
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

    // Override window.location with Proxy
    Object.defineProperty(window, 'location', {
        get: () => proxyLoc,
        set: (url) => {
            currentUrl = new URL(url, currentUrl).href;
            originalLocation.href = PREFIX + xorEncode(currentUrl);
        }
    });

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
            return btoa(result).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
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
