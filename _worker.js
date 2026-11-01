/**
 * cf-gh-proxy v1.0.2 —— GitHub 文件加速 Cloudflare Worker
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
  .tip {
    display: none; margin-top: 10px; padding: 8px 12px;
    border-left: 3px solid var(--warn); background: rgba(248,81,73,.08);
    border-radius: 6px; font-size: .88rem; color: var(--fg); word-break: break-all;
  }
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
    <p class="tip" id="tip"></p>
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
    var tip = document.getElementById('tip');

    // \u4E0E\u540E\u7AEF validate.js \u7684\u89C4\u5219\u4FDD\u6301\u4E00\u81F4\u3002\u524D\u7AEF\u6821\u9A8C\u53EA\u662F\u300C\u5C11\u8DD1\u4E00\u8D9F\u300D\uFF0C
    // \u771F\u6B63\u7684\u5224\u5B9A\u5728\u540E\u7AEF\u2014\u2014\u8FD9\u91CC\u653E\u8FC7\u7684\u4EFB\u4F55\u4E1C\u897F\u540E\u7AEF\u90FD\u4F1A\u518D\u9A8C\u4E00\u904D\u3002
    var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
    var REF = /^[A-Za-z0-9._-][A-Za-z0-9._\\/-]{0,199}$/;

    function fail(msg) {
      tip.textContent = msg;
      tip.style.display = 'block';
      input.focus();
      return null;
    }

    function ok() {
      tip.style.display = 'none';
      return true;
    }

    // \u628A\u7528\u6237\u8F93\u5165\u5F52\u4E00\u6210\u300Chttps://...\u300D\u5F62\u5F0F\uFF0C\u518D\u62C6\u51FA host \u4E0E path \u505A\u5F62\u6001\u5224\u5B9A
    function normalize(v) {
      v = v.replace(/^(https?):\\/(?!\\/)/i, '$1://');
      var scheme = v.match(/^([a-z][a-z0-9+.-]*):/i);
      if (scheme) {
        if (!/^https?$/i.test(scheme[1])) return fail('\u53EA\u652F\u6301 http / https \u94FE\u63A5\uFF0C\u6536\u5230\uFF1A' + scheme[1]);
      }
      if (!/^https?:\\/\\//i.test(v)) {
        var first = v.split(/[/?#]/)[0];
        // \u9996\u6BB5\u542B\u70B9\u5F53\u57DF\u540D\uFF0C\u5426\u5219\u5F53\u88F8 owner/repo
        v = /^[a-z0-9-]+(?:\\.[a-z0-9-]+)+$/i.test(first)
          ? 'https://' + v
          : 'https://github.com/' + v;
      }
      return v;
    }

    function checkPath(u) {
      var segs = u.pathname.split('/').filter(Boolean);

      if (u.hostname === 'github.com') {
        if (segs.length < 2) return fail('\u8DEF\u5F84\u592A\u77ED\uFF0C\u81F3\u5C11\u8981 owner/repo');
        if (!NAME.test(segs[0]) || !NAME.test(segs[1])) return fail('owner \u6216 repo \u540D\u5B57\u4E0D\u5408\u6CD5');
        if (segs.length === 2) return fail('\u8FD9\u662F\u4ED3\u5E93\u9996\u9875\uFF0C\u4E0D\u662F\u6587\u4EF6\u3002\u8BF7\u7ED9 releases/download\u3001archive\u3001raw \u6216 blob \u8DEF\u5F84');
        var t = segs[2];
        if (t === 'releases') {
          if (segs.length >= 5 && segs[3] === 'download') {
            if (!REF.test(segs[4])) return fail('tag \u4E0D\u5408\u6CD5');
            if (segs.length < 6) return fail('releases/download \u540E\u9762\u7F3A\u6587\u4EF6\u540D');
            return ok();
          }
          if (segs.length >= 6 && segs[3] === 'latest' && segs[4] === 'download') return ok();
          return fail('\u8FD9\u662F releases \u7684\u7F51\u9875\u9875\u9762\uFF0C\u8D44\u4EA7\u8DEF\u5F84\u8981\u542B /download/');
        }
        if (t === 'archive') {
          if (segs.length < 4) return fail('archive \u8DEF\u5F84\u4E0D\u5B8C\u6574');
          var rest = segs[3] === 'refs' ? segs.slice(5).join('/') : segs.slice(3).join('/');
          if (segs[3] === 'refs' && (segs[4] !== 'heads' && segs[4] !== 'tags')) {
            return fail('archive/refs \u53EA\u652F\u6301 heads \u6216 tags');
          }
          if (!/\\.(zip|tar\\.gz|tgz)$/i.test(rest)) return fail('archive \u53EA\u652F\u6301 .zip / .tar.gz / .tgz');
          return ok();
        }
        if (t === 'raw' || t === 'blob') {
          if (segs.length < 5) return fail(t + ' \u8DEF\u5F84\u4E0D\u5B8C\u6574\uFF0C\u9700\u8981 ref \u548C\u6587\u4EF6\u8DEF\u5F84');
          if (!REF.test(segs[3])) return fail('ref \u4E0D\u5408\u6CD5');
          return ok();
        }
        return fail('\u4E0D\u652F\u6301\u7684\u8DEF\u5F84\u7C7B\u578B\uFF1A/' + t + '\uFF08\u53EA\u652F\u6301 releases/download\u3001archive\u3001raw\u3001blob\uFF09');
      }

      if (u.hostname === 'raw.githubusercontent.com') {
        if (segs.length < 4) return fail('raw \u8DEF\u5F84\u4E0D\u5B8C\u6574\uFF0C\u9700\u8981 owner/repo/ref/file');
        if (!NAME.test(segs[0]) || !NAME.test(segs[1])) return fail('owner \u6216 repo \u540D\u5B57\u4E0D\u5408\u6CD5');
        if (!REF.test(segs[2])) return fail('ref \u4E0D\u5408\u6CD5');
        return ok();
      }

      if (u.hostname === 'gist.githubusercontent.com' || u.hostname === 'gist.github.com') {
        if (segs.length < 2) return fail('gist \u8DEF\u5F84\u4E0D\u5B8C\u6574');
        return ok();
      }

      if (u.hostname === 'codeload.github.com') {
        if (segs.length < 4) return fail('codeload \u8DEF\u5F84\u4E0D\u5B8C\u6574\uFF0C\u9700\u8981 owner/repo/zip/ref');
        if (!/^(zip|tar\\.gz|tgz|legacy\\.zip|legacy\\.tar\\.gz)$/i.test(segs[2])) return fail('codeload \u53EA\u652F\u6301 zip / tar.gz');
        return ok();
      }

      return fail('\u53EA\u652F\u6301 GitHub \u7684\u57DF\u540D\uFF1Agithub.com / raw.githubusercontent.com / gist.githubusercontent.com / codeload.github.com');
    }

    function run() {
      var v = (input.value || '').trim();
      if (!v) { fail('\u8BF7\u8F93\u5165\u4E00\u4E2A GitHub \u94FE\u63A5'); return; }

      var href = normalize(v);
      if (!href) return;

      var u;
      try { u = new URL(href); } catch (e) { fail('\u8FD9\u4E2A\u94FE\u63A5\u89E3\u6790\u4E0D\u51FA\u6765\uFF0C\u68C0\u67E5\u4E00\u4E0B\u683C\u5F0F'); return; }

      if (!checkPath(u)) return;

      location.href = location.origin + ${JSON.stringify(prefix)} + u.href;
    }

    go.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  })();
</script>
</body>
</html>`;
}
function renderErrorPage(cfg, reason) {
  const prefix = cfg.prefix;
  const exampleBase = `https://your-domain${prefix === "/" ? "" : prefix}`;
  const home = `${escapeHtml(prefix)}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6</title>
<style>
  :root { --fg:#e6edf3; --dim:#8b949e; --bg:#0d1117; --card:#161b22; --line:#30363d; --accent:#4493f8; --warn:#f85149; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.6;
    padding: 48px 20px; display: flex; justify-content: center;
  }
  .wrap { width: 100%; max-width: 760px; }
  h1 { font-size: 1.6rem; font-weight: 600; margin-bottom: .4rem; }
  .sub { color: var(--dim); margin-bottom: 2rem; font-size: .95rem; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 20px 22px; margin-bottom: 18px;
  }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .9rem; }
  .reason {
    border-left: 3px solid var(--warn); background: rgba(248,81,73,.08);
    padding: 10px 14px; border-radius: 6px; font-size: .92rem;
    color: var(--fg); word-break: break-all;
  }
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
  <h1>\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6</h1>
  <p class="sub">\u8FD9\u4E2A\u5730\u5740\u4E0D\u662F\u4E00\u4E2A\u53EF\u4EE5\u4E0B\u8F7D\u7684\u6587\u4EF6\u8DEF\u5F84\uFF0C\u6240\u4EE5\u6CA1\u6709\u53BB\u6293\u53D6\u3002</p>

  <div class="card">
    <h2>\u5177\u4F53\u539F\u56E0</h2>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="note">\u672C\u670D\u52A1\u53EA\u4EE3\u7406 GitHub \u4E0A<strong>\u53EF\u4E0B\u8F7D\u7684\u8D44\u6E90</strong>\uFF0C\u4E0D\u4EE3\u7406\u7F51\u9875\u3002\u4ED3\u5E93\u9996\u9875\u3001issues\u3001settings\u3001search \u8FD9\u7C7B\u9875\u9762\u4F1A\u88AB\u62D2\u7EDD\u3002</p>
  </div>

  <div class="card">
    <h2>\u6B63\u786E\u5F62\u6001</h2>
    <pre>${escapeHtml(exampleBase)}https://github.com/owner/repo/releases/download/v1.0.0/app.zip</pre>
    <p class="note">\u7701\u7565 <code>https://github.com/</code> \u4E5F\u884C\uFF1A</p>
    <pre>${escapeHtml(exampleBase)}owner/repo/releases/download/v1.0.0/app.zip</pre>
  </div>

  <div class="card">
    <h2>\u652F\u6301\u7684\u8DEF\u5F84</h2>
    <ul>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/download/&lt;tag&gt;/&lt;file&gt;</code> \u2014 release \u8D44\u4EA7</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/latest/download/&lt;file&gt;</code> \u2014 \u6700\u65B0 release</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/archive/&lt;ref&gt;.zip</code> \u2014 \u6E90\u7801\u6253\u5305</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/raw/&lt;ref&gt;/&lt;path&gt;</code> \u2014 \u5206\u652F/\u63D0\u4EA4\u91CC\u7684\u5355\u6587\u4EF6</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/blob/&lt;ref&gt;/&lt;path&gt;</code> \u2014 \u540C\u4E0A\uFF0C\u81EA\u52A8\u8F6C\u6210 raw</li>
      <li><code>raw.githubusercontent.com/&lt;owner&gt;/&lt;repo&gt;/&lt;ref&gt;/&lt;path&gt;</code> \u2014 raw \u76F4\u94FE</li>
      <li><code>gist.githubusercontent.com/\u2026</code> \u2014 Gist</li>
    </ul>
  </div>

  <p class="note"><a href="${home}">\u2190 \u56DE\u5230\u9996\u9875\u91CD\u65B0\u8F93\u5165</a></p>
</div>
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

// src/validate.js
var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
var REF_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,199}$/;
var FILE_RE = /^[^\s]+$/;
function validateGithubPath(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) {
    const single = segs[0] || "";
    if (/^(login|logout|join|signup|settings|search|explore|topics|notifications|marketplace|sponsors|about|pricing|features|enterprise|team|collections|trending|new|organizations|apps|codespaces|dashboard)$/i.test(single)) {
      return { ok: false, reason: `/${single} \u662F GitHub \u7684\u7F51\u9875\uFF0C\u4E0D\u662F\u6587\u4EF6` };
    }
    return { ok: false, reason: "\u8DEF\u5F84\u91CC\u7F3A\u5C11 owner/repo\uFF0C\u770B\u8D77\u6765\u4E0D\u662F\u4E00\u4E2A GitHub \u6587\u4EF6\u94FE\u63A5" };
  }
  const [owner, repo] = segs;
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner \u4E0D\u5408\u6CD5\uFF1A${owner}` };
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo \u4E0D\u5408\u6CD5\uFF1A${repo}` };
  if (segs.length === 2) {
    if (/^(settings|search|explore|topics|notifications|marketplace|sponsors|organizations|apps|codespaces|dashboard|pulls|issues)$/i.test(owner)) {
      return { ok: false, reason: `/${owner} \u662F GitHub \u7684\u7F51\u9875\uFF0C\u4E0D\u662F\u6587\u4EF6` };
    }
    return { ok: false, reason: "\u8FD9\u662F\u4ED3\u5E93\u9996\u9875\uFF08\u7F51\u9875\uFF09\uFF0C\u4E0D\u662F\u6587\u4EF6\uFF1B\u8BF7\u7ED9 releases/download\u3001archive\u3001raw \u6216 blob \u8DEF\u5F84" };
  }
  const third = segs[2];
  if (third === "releases") {
    if (segs.length >= 5 && segs[3] === "download") {
      const tag = segs[4];
      if (!REF_RE.test(tag)) return { ok: false, reason: `tag \u4E0D\u5408\u6CD5\uFF1A${tag}` };
      if (segs.length < 6) return { ok: false, reason: "\u7F3A\u5C11\u6587\u4EF6\u540D" };
      const file = segs.slice(5).join("/");
      if (!FILE_RE.test(file)) return { ok: false, reason: "\u6587\u4EF6\u540D\u4E0D\u5408\u6CD5" };
      return { ok: true, kind: "release" };
    }
    if (segs.length >= 6 && segs[3] === "latest" && segs[4] === "download") {
      const file = segs.slice(5).join("/");
      if (!FILE_RE.test(file)) return { ok: false, reason: "\u6587\u4EF6\u540D\u4E0D\u5408\u6CD5" };
      return { ok: true, kind: "release" };
    }
    return { ok: false, reason: "\u8FD9\u662F releases \u7684\u7F51\u9875\u9875\u9762\uFF0C\u4E0D\u662F\u8D44\u4EA7\uFF1B\u8D44\u4EA7\u8DEF\u5F84\u8981\u542B /download/" };
  }
  if (third === "archive") {
    if (segs.length < 4) return { ok: false, reason: "archive \u8DEF\u5F84\u4E0D\u5B8C\u6574" };
    let refPart;
    if (segs[3] === "refs") {
      if (segs.length < 6) return { ok: false, reason: "archive/refs \u8DEF\u5F84\u4E0D\u5B8C\u6574" };
      const sub = segs[4];
      if (sub !== "heads" && sub !== "tags") {
        return { ok: false, reason: `archive/refs \u53EA\u652F\u6301 heads \u6216 tags\uFF0C\u6536\u5230\uFF1A${sub}` };
      }
      refPart = segs.slice(5).join("/");
    } else {
      refPart = segs.slice(3).join("/");
    }
    if (!/\.(zip|tar\.gz|tgz)$/i.test(refPart)) {
      return { ok: false, reason: "archive \u53EA\u652F\u6301 .zip / .tar.gz / .tgz" };
    }
    const ref = refPart.replace(/\.(zip|tar\.gz|tgz)$/i, "");
    if (!ref || !REF_RE.test(ref)) return { ok: false, reason: `ref \u4E0D\u5408\u6CD5\uFF1A${ref}` };
    return { ok: true, kind: "archive" };
  }
  if (third === "raw" || third === "blob") {
    if (segs.length < 5) return { ok: false, reason: `${third} \u8DEF\u5F84\u4E0D\u5B8C\u6574` };
    const ref = segs[3];
    if (!REF_RE.test(ref)) return { ok: false, reason: `ref \u4E0D\u5408\u6CD5\uFF1A${ref}` };
    const file = segs.slice(4).join("/");
    if (!FILE_RE.test(file)) return { ok: false, reason: "\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5408\u6CD5" };
    return { ok: true, kind: third };
  }
  return {
    ok: false,
    reason: `\u4E0D\u652F\u6301\u7684\u8DEF\u5F84\u7C7B\u578B\uFF1A/${third}\uFF08\u53EA\u652F\u6301 releases/download\u3001archive\u3001raw\u3001blob\uFF09`
  };
}
function validateRawPath(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 4) {
    return { ok: false, reason: "raw \u8DEF\u5F84\u4E0D\u5B8C\u6574\uFF0C\u9700\u8981 /owner/repo/ref/file" };
  }
  const [owner, repo, ref] = segs;
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner \u4E0D\u5408\u6CD5\uFF1A${owner}` };
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo \u4E0D\u5408\u6CD5\uFF1A${repo}` };
  if (!REF_RE.test(ref)) return { ok: false, reason: `ref \u4E0D\u5408\u6CD5\uFF1A${ref}` };
  const file = segs.slice(3).join("/");
  if (!FILE_RE.test(file)) return { ok: false, reason: "\u6587\u4EF6\u8DEF\u5F84\u4E0D\u5408\u6CD5" };
  return { ok: true, kind: "raw" };
}
function validateCodeloadPath(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 4) {
    return { ok: false, reason: "codeload \u8DEF\u5F84\u4E0D\u5B8C\u6574\uFF0C\u9700\u8981 /owner/repo/zip/ref" };
  }
  const [owner, repo, fmt] = segs;
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner \u4E0D\u5408\u6CD5\uFF1A${owner}` };
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo \u4E0D\u5408\u6CD5\uFF1A${repo}` };
  if (!/^(zip|tar\.gz|tgz|legacy\.zip|legacy\.tar\.gz)$/i.test(fmt)) {
    return { ok: false, reason: `codeload \u53EA\u652F\u6301 zip / tar.gz / legacy.zip / legacy.tar.gz\uFF0C\u6536\u5230\uFF1A${fmt}` };
  }
  const ref = segs.slice(3).join("/");
  if (!ref || !REF_RE.test(ref)) return { ok: false, reason: `ref \u4E0D\u5408\u6CD5\uFF1A${ref}` };
  return { ok: true, kind: "codeload" };
}
function validateGistPath(u) {
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs.length < 2) return { ok: false, reason: "gist \u8DEF\u5F84\u4E0D\u5B8C\u6574" };
  const [user, id] = segs;
  if (!NAME_RE.test(user)) return { ok: false, reason: `gist \u7528\u6237\u540D\u4E0D\u5408\u6CD5\uFF1A${user}` };
  if (!/^[0-9a-f]{20,}$/i.test(id) && !NAME_RE.test(id)) {
    return { ok: false, reason: `gist id \u4E0D\u5408\u6CD5\uFF1A${id}` };
  }
  if (segs[2] && segs[2] !== "raw") {
    return { ok: false, reason: `gist \u53EA\u652F\u6301 /raw/ \u8DEF\u5F84\uFF0C\u6536\u5230\uFF1A${segs[2]}` };
  }
  return { ok: true, kind: "gist" };
}
function validateSignedAssetPath(u) {
  const p = u.pathname.replace(/^\/+/, "");
  if (!p) return { ok: false, reason: "\u8DEF\u5F84\u4E3A\u7A7A" };
  if (/https?:\/\//i.test(p)) return { ok: false, reason: "\u8DEF\u5F84\u91CC\u5D4C\u5957\u4E86\u53E6\u4E00\u4E2A URL" };
  return { ok: true, kind: "signed" };
}
function validateTargetPath(u) {
  const host = u.hostname.toLowerCase();
  switch (host) {
    case "github.com":
      return validateGithubPath(u);
    case "raw.githubusercontent.com":
      return validateRawPath(u);
    case "codeload.github.com":
      return validateCodeloadPath(u);
    case "gist.githubusercontent.com":
      return validateGistPath(u);
    case "gist.github.com":
      return validateGistPath(u);
    case "api.github.com":
      return u.pathname.replace(/^\/+/, "") ? { ok: true, kind: "api" } : { ok: false, reason: "api \u8DEF\u5F84\u4E3A\u7A7A" };
    case "release-assets.githubusercontent.com":
    case "objects.githubusercontent.com":
    case "github.githubassets.com":
    case "avatars.githubusercontent.com":
    case "user-images.githubusercontent.com":
    case "private-user-images.githubusercontent.com":
      return validateSignedAssetPath(u);
    default:
      return { ok: false, reason: `\u4E0D\u652F\u6301\u7684\u4E3B\u673A\uFF1A${host}` };
  }
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
function checkTarget(u) {
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: `\u4E0D\u5728\u5141\u8BB8\u7684\u57DF\u540D\u5217\u8868\u91CC\uFF1A${host}` };
  }
  if (HOSTS_REQUIRING_FULL_URL.has(host) && !u.pathname.replace(/^\/+/, "")) {
    return { ok: false, reason: "\u8DEF\u5F84\u4E3A\u7A7A" };
  }
  return validateTargetPath(u);
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
        return badRequest(request, cfg, "\u65E0\u6CD5\u89E3\u6790\u8FD9\u4E2A\u94FE\u63A5");
      }
      const verdict2 = checkTarget(target2);
      if (!verdict2.ok) {
        return badRequest(request, cfg, verdict2.reason || "\u8FD9\u4E2A\u94FE\u63A5\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6");
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
      return badRequest(request, cfg, "\u65E0\u6CD5\u89E3\u6790\u8FD9\u4E2A\u94FE\u63A5");
    }
    const verdict = checkTarget(target);
    if (!verdict.ok) {
      return badRequest(request, cfg, verdict.reason || "\u8FD9\u4E2A\u94FE\u63A5\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6");
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
function badRequest(request, cfg, reason) {
  const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
  if (!wantsHtml) {
    return textResponse(`\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6\uFF1A${reason}`, 400);
  }
  return new Response(renderErrorPage(cfg, reason), {
    status: 400,
    headers: { "content-type": "text/html; charset=UTF-8", ...CORS_HEADERS }
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
