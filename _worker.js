/**
 * cf-gh-proxy v1.0.1 —— GitHub 文件加速 Cloudflare Worker
 *
 * 这个文件是自动构建产物，请勿直接编辑。
 * 源码与构建方式：https://github.com/geekMus/cf-gh-proxy
 * 本文件原始地址：https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.js
 *
 * 基于 cmliu/CF-Workers-GitHub 演化而来（MIT, Copyright (c) 2025 CMLiussss）
 * Copyright (c) 2026 cf-gh-proxy contributors
 *
 * 用法一（推荐，不装任何工具）：整段复制本文件内容，粘贴到
 *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。
 * 用法二（用 wrangler）：npm run deploy（构建后以 --main _worker.js 部署）。
 * 配置：在 Dashboard 的 Settings → Variables and Secrets 里加环境变量，见 README。
 */

// src/config.js
var DEFAULT_BLOCKED_UA = ["netcraft"];
var DEFAULT_LANDING_LINK = "https://github.com/";
function normalizePrefix(raw) {
  let p = typeof raw === "string" && raw.trim() ? raw.trim() : "/";
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p = p + "/";
  return p;
}
function parseList(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/[\s,|"'`]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
function num(raw, fallback, { min = 0 } = {}) {
  if (raw === void 0 || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}
function bool(raw, fallback) {
  if (raw === void 0 || raw === null || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
function str(raw) {
  return typeof raw === "string" ? raw.trim() : "";
}
function resolveConfig(env) {
  const e = env || {};
  const url302 = str(e.URL302);
  const urlRaw = str(e.URL);
  const urlIsNginx = urlRaw && /^nginx$/i.test(urlRaw);
  return {
    prefix: normalizePrefix(e.PREFIX),
    jsdelivr: bool(e.JSDELIVR, false),
    // 可变资源（分支上的 raw / blob、codeload 打包）的边缘缓存秒数
    cacheTtl: num(e.CACHE_TTL, 300),
    // 不可变资源（release 资产、按 commit SHA 的 raw）的边缘缓存秒数
    immutableCacheTtl: num(e.IMMUTABLE_CACHE_TTL, 86400),
    // 上游响应头到达前的等待上限（毫秒）；拿到响应头后不再计时，下载不受影响
    upstreamTimeout: num(e.UPSTREAM_TIMEOUT, 3e4, { min: 1e3 }),
    maxRedirects: num(e.MAX_REDIRECTS, 5),
    // 是否把客户端 Cookie / Authorization 转发给上游（默认否，见 README 的安全说明）
    allowAuth: bool(e.ALLOW_AUTH, false),
    blockedUAs: [...DEFAULT_BLOCKED_UA, ...parseList(e.BLOCKED_UA), ...parseList(e.UA)],
    landingLink: str(e.LANDING_LINK) || DEFAULT_LANDING_LINK,
    // 主页伪装（沿用上游语义）
    disguiseNginx: Boolean(urlIsNginx),
    homeRedirect: url302 || (urlRaw && !urlIsNginx ? urlRaw : "")
  };
}

// src/pages.js
function renderLanding(cfg) {
  const prefix = cfg.prefix;
  const exampleBase = `https://your-domain${prefix === "/" ? "" : prefix}`;
  const landing = escapeHtml(cfg.landingLink);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GitHub \u6587\u4EF6\u52A0\u901F</title>
<style>
  :root { --fg:#e6edf3; --dim:#8b949e; --bg:#0d1117; --card:#161b22; --line:#30363d; --accent:#4493f8; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.6;
    padding: 48px 20px; display: flex; justify-content: center;
  }
  .wrap { width: 100%; max-width: 760px; }
  h1 { font-size: 1.9rem; font-weight: 600; margin-bottom: .4rem; }
  .sub { color: var(--dim); margin-bottom: 2rem; font-size: .95rem; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 20px 22px; margin-bottom: 18px;
  }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .9rem; }
  .row { display: flex; gap: 10px; }
  input[type=text] {
    flex: 1; height: 44px; padding: 0 14px; font-size: .95rem;
    color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; outline: none;
  }
  input[type=text]:focus { border-color: var(--accent); }
  button {
    height: 44px; padding: 0 20px; font-size: .95rem; font-weight: 500;
    color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre {
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; font-size: .85rem; color: var(--fg);
    white-space: pre; margin: 8px 0;
  }
  ul { list-style: none; }
  li { padding: 5px 0; color: var(--dim); font-size: .9rem; }
  li code { color: var(--fg); }
  .note { color: var(--dim); font-size: .85rem; margin-top: .8rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <h1>GitHub \u6587\u4EF6\u52A0\u901F</h1>
  <p class="sub">\u628A GitHub \u7684 release / archive / raw \u94FE\u63A5\u6362\u6210\u4E0B\u9762\u7684\u5F62\u5F0F\uFF0C\u8D70 Cloudflare \u8FB9\u7F18\u8282\u70B9\u3002</p>

  <div class="card">
    <h2>\u8F93\u5165 GitHub \u94FE\u63A5</h2>
    <div class="row">
      <input type="text" id="q" placeholder="https://github.com/user/repo/releases/download/v1.0.0/file.zip" autocomplete="off">
      <button id="go">\u52A0\u901F</button>
    </div>
    <p class="note">\u4E5F\u53EF\u4EE5\u76F4\u63A5\u5728\u6D4F\u89C8\u5668\u5730\u5740\u680F\u91CC\u628A\u94FE\u63A5\u63A5\u5728 <code>${escapeHtml(prefix)}</code> \u540E\u9762\u3002</p>
  </div>

  <div class="card">
    <h2>\u7528\u6CD5</h2>
    <pre>${escapeHtml(exampleBase)}https://github.com/owner/repo/releases/download/v1.0.0/app.zip</pre>
    <p class="note">\u7701\u7565 <code>https://github.com/</code> \u4E5F\u80FD\u7528\uFF1A</p>
    <pre>${escapeHtml(exampleBase)}owner/repo/releases/download/v1.0.0/app.zip</pre>
  </div>

  <div class="card">
    <h2>\u652F\u6301\u7684\u8DEF\u5F84</h2>
    <ul>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/download/&lt;tag&gt;/&lt;file&gt;</code> \u2014 release \u8D44\u4EA7</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/archive/&lt;ref&gt;.zip</code> \u2014 \u6E90\u7801\u6253\u5305</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/raw/&lt;ref&gt;/&lt;path&gt;</code> \u2014 \u5206\u652F/\u63D0\u4EA4\u91CC\u7684\u5355\u6587\u4EF6</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/blob/&lt;ref&gt;/&lt;path&gt;</code> \u2014 \u540C\u4E0A\uFF0C\u81EA\u52A8\u8F6C\u6210 raw</li>
      <li><code>raw.githubusercontent.com/&lt;owner&gt;/&lt;repo&gt;/&lt;ref&gt;/&lt;path&gt;</code> \u2014 raw \u76F4\u94FE</li>
      <li><code>gist.githubusercontent.com/\u2026</code> \u2014 Gist</li>
    </ul>
    <p class="note">\u53EA\u4EE3\u7406 GitHub \u81EA\u5BB6\u57DF\u540D\uFF0C\u5176\u5B83\u57DF\u540D\u4E00\u5F8B 403\u3002</p>
  </div>

  <p class="note">\u6CA1\u6709\u63D0\u4F9B\u6709\u6548\u94FE\u63A5\u65F6\uFF0C\u8BF7\u8BBF\u95EE <a href="${landing}">${landing}</a>\u3002</p>
</div>

<script>
  (function () {
    var input = document.getElementById('q');
    var go = document.getElementById('go');
    function run() {
      var v = (input.value || '').trim();
      if (!v) { input.focus(); return; }
      v = v.replace(/^https?:\\/\\//i, 'https://');
      var base = location.origin + ${JSON.stringify(prefix)};
      if (!/^https?:\\/\\//i.test(v)) v = 'https://github.com/' + v;
      location.href = base + v;
    }
    go.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  })();
</script>
</body>
</html>`;
}
function renderDisguise() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// src/proxy.js
var ALLOWED_HOSTS = /* @__PURE__ */ new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "codeload.github.com",
  "api.github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github.githubassets.com",
  "avatars.githubusercontent.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com"
]);
var HOSTS_REQUIRING_FULL_URL = /* @__PURE__ */ new Set([
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github.githubassets.com",
  "avatars.githubusercontent.com",
  "user-images.githubusercontent.com",
  "private-user-images.githubusercontent.com"
]);
function buildTargetUrl(rest) {
  if (typeof rest !== "string") return null;
  let s = rest.trim().replace(/^\/+/, "");
  if (!s) return null;
  s = s.replace(/^(https?):\/(?!\/)/i, "$1://");
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^(https?|ftp)$/i.test(scheme[1])) return null;
  if (scheme && /^ftp$/i.test(scheme[1])) return null;
  let candidate;
  if (/^https?:\/\//i.test(s)) {
    candidate = s;
  } else {
    const first = s.split(/[/?#]/)[0];
    const looksLikeHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(first);
    candidate = looksLikeHost ? `https://${s}` : `https://github.com/${s}`;
  }
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.protocol === "http:") u.protocol = "https:";
  return u;
}
function isAllowedTarget(u) {
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;
  if (HOSTS_REQUIRING_FULL_URL.has(host) && !u.pathname.replace(/^\/+/, "")) return false;
  return true;
}
function maybeJsdelivrUrl(target, cfg) {
  if (!cfg.jsdelivr) return null;
  const host = target.hostname;
  let owner, repo, ref, rest;
  if (host === "github.com") {
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    [, owner, repo, ref, rest] = m;
  } else if (host === "raw.githubusercontent.com") {
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    [, owner, repo, ref, rest] = m;
  } else {
    return null;
  }
  if (!/^v?\d/.test(ref) && !/^[0-9a-f]{7,40}$/i.test(ref)) return null;
  return new URL(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`);
}
var DROP_RESPONSE_HEADERS = /* @__PURE__ */ new Set([
  // 由 Worker 统一设置
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  // 会破坏跨域与缓存语义
  "content-security-policy",
  "content-security-policy-report-only",
  "clear-site-data",
  "x-frame-options",
  // 上游的 cookie 绝不能落到访问者身上
  "set-cookie",
  "set-cookie2",
  // 这些是 Cloudflare / Fastly 内部头，透传出去只会误导
  "cf-cache-status",
  "cf-ray",
  "cf-request-id",
  "x-cache",
  "x-cache-hits",
  "x-served-by",
  "x-timer",
  "x-ms-request-id",
  "x-ms-version",
  "x-ms-lease-status",
  "x-ms-lease-state",
  "x-ms-server-encrypted",
  "x-ms-access-tier",
  "x-ms-access-tier-inferred",
  "x-ms-blob-content-md5",
  "x-ms-blob-type",
  "x-ms-creation-time",
  "report-to",
  "nel",
  "speculation-rules",
  "alt-svc",
  "via",
  "age",
  // 编码相关：Worker 返回的是上游原样字节，不让下游误判
  "content-encoding",
  "transfer-encoding",
  "connection"
]);
function sanitizeUpstreamHeaders(upstream) {
  const out = new Headers();
  for (const [k, v] of upstream) {
    const key = k.toLowerCase();
    if (DROP_RESPONSE_HEADERS.has(key)) continue;
    out.set(k, v);
  }
  return out;
}
function withCacheHeaders(headers, ttl, upstream) {
  const cc = (upstream.get("cache-control") || "").toLowerCase();
  if (cc.includes("no-store") || cc.includes("private")) {
    headers.set("Cache-Control", "no-store");
    return headers;
  }
  headers.set("Cache-Control", `public, max-age=${ttl}`);
  headers.set("CDN-Cache-Control", `public, max-age=${ttl}`);
  return headers;
}

// src/upstream.js
async function fetchFollowingRedirects(href, init, timeoutMs, maxRedirects, fetchImpl = fetch) {
  let current = href;
  let currentInit = { ...init, redirect: "manual" };
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { ...currentInit, signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    const status = res.status;
    const loc = res.headers.get("location");
    if (status >= 300 && status < 400 && loc) {
      try {
        await res.body?.cancel();
      } catch {
      }
      current = new URL(loc, current).href;
      currentInit = {
        method: currentInit.method === "HEAD" ? "HEAD" : "GET",
        headers: currentInit.headers,
        redirect: "manual"
      };
      continue;
    }
    return res;
  }
  return null;
}

// src/index.js
var CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-max-age": "1728000"
};
var PREFLIGHT = {
  status: 204,
  headers: {
    ...CORS_HEADERS,
    "access-control-allow-headers": "Accept,Accept-Language,Authorization,Content-Type,Range,If-None-Match,If-Modified-Since"
  }
};
var index_default = {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
   */
  async fetch(request, env, ctx) {
    const cfg = resolveConfig(env);
    const url = new URL(request.url);
    const ua = (request.headers.get("User-Agent") || "").toLowerCase();
    if (cfg.blockedUAs.length && cfg.blockedUAs.some((k) => ua.includes(k))) {
      return new Response(renderDisguise(), {
        status: 200,
        headers: { "content-type": "text/html; charset=UTF-8" }
      });
    }
    if (request.method === "OPTIONS" && request.headers.has("access-control-request-headers")) {
      return new Response(null, PREFLIGHT);
    }
    const q = url.searchParams.get("q");
    if (q) {
      const target2 = buildTargetUrl(q);
      if (!target2) {
        return textResponse("\u65E0\u6CD5\u89E3\u6790\u8FD9\u4E2A\u94FE\u63A5", 400);
      }
      return Response.redirect(`${url.origin}${cfg.prefix}${target2.href}`, 302);
    }
    if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, "")}/favicon.ico`) {
      const light = "https://github.githubassets.com/favicons/favicon.png";
      const dark = "https://github.githubassets.com/favicons/favicon-dark.png";
      const preferLight = request.headers.get("sec-ch-prefers-color-scheme") === "light";
      return fetch(preferLight ? light : dark, { cf: { cacheTtl: 86400 } });
    }
    const stripped = stripPrefix(url, cfg.prefix);
    if (stripped === null) {
      return renderHome(cfg);
    }
    const target = buildTargetUrl(stripped);
    if (!target) {
      return renderHome(cfg);
    }
    if (!isAllowedTarget(target)) {
      return textResponse(
        "\u53EA\u5141\u8BB8\u4EE3\u7406 GitHub \u7684\u8D44\u6E90\uFF08github.com / raw.githubusercontent.com / gist.githubusercontent.com / codeload.github.com / release-assets.githubusercontent.com / objects.githubusercontent.com\uFF09",
        403
      );
    }
    const viaCdn = maybeJsdelivrUrl(target, cfg);
    return handleProxy(request, viaCdn || target, cfg, ctx);
  }
};
function renderHome(cfg) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302);
  }
  if (cfg.disguiseNginx) {
    return new Response(renderDisguise(), {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" }
    });
  }
  return new Response(renderLanding(cfg), {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
}
function stripPrefix(url, prefix) {
  let rest;
  if (prefix === "/") {
    rest = url.pathname.slice(1) + url.search;
  } else {
    const bare = prefix.replace(/\/$/, "");
    if (!url.pathname.startsWith(bare)) return null;
    rest = url.pathname.slice(bare.length);
    if (!rest || rest === "/") return null;
    rest = rest.replace(/^\//, "") + url.search;
  }
  if (!rest) return null;
  return rest;
}
function textResponse(body, status = 200) {
  return new Response(body + "\n", {
    status,
    headers: { "content-type": "text/plain; charset=UTF-8", ...CORS_HEADERS }
  });
}
async function handleProxy(request, target, cfg, ctx) {
  const method = request.method;
  const isHead = method === "HEAD";
  const upstreamHeaders = new Headers();
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase();
    if ((key === "cookie" || key === "authorization") && !cfg.allowAuth) continue;
    if (SKIP_REQUEST_HEADERS.has(key)) continue;
    upstreamHeaders.set(k, v);
  }
  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);
  const init = { method, headers: upstreamHeaders };
  if (!isHead && method !== "GET" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }
  let res;
  try {
    res = await fetchFollowingRedirects(target.href, init, cfg.upstreamTimeout, cfg.maxRedirects);
  } catch (err) {
    return textResponse(`\u4E0A\u6E38\u8BF7\u6C42\u5931\u8D25\uFF1A${err && err.message ? err.message : err}`, 502);
  }
  if (!res) {
    return textResponse("\u4E0A\u6E38\u91CD\u5B9A\u5411\u6B21\u6570\u8FC7\u591A", 508);
  }
  const outHeaders = sanitizeUpstreamHeaders(res.headers);
  outHeaders.set("access-control-allow-origin", "*");
  outHeaders.set("access-control-expose-headers", "*");
  const cacheable = res.status === 200 || res.status === 206;
  if (cacheable && method === "GET") {
    withCacheHeaders(outHeaders, pickCacheTtl(target, cfg), res.headers);
  }
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
function pickCacheTtl(target, cfg) {
  const path = target.pathname;
  if (target.hostname === "release-assets.githubusercontent.com") return cfg.immutableCacheTtl;
  if (target.hostname === "objects.githubusercontent.com") return cfg.immutableCacheTtl;
  if (target.hostname === "raw.githubusercontent.com") {
    const seg = path.split("/").filter(Boolean);
    const ref = seg[2] || "";
    if (/^[0-9a-f]{40}$/i.test(ref)) return cfg.immutableCacheTtl;
    return cfg.cacheTtl;
  }
  if (target.hostname === "codeload.github.com") {
    if (/\/zip\/[0-9a-f]{40}$/i.test(path) || /\/tar\.gz\/[0-9a-f]{40}$/i.test(path)) {
      return cfg.immutableCacheTtl;
    }
    return cfg.cacheTtl;
  }
  return cfg.cacheTtl;
}
var SKIP_REQUEST_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  // Cloudflare 会自己处理压缩；转发客户端的 accept-encoding 会让上游按
  // 客户端能力压缩，边缘缓存就无法共享了。
  "accept-encoding"
]);
export {
  index_default as default
};
