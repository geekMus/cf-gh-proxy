/**
 * cf-gh-proxy v1.0.5 —— GitHub 文件加速 Cloudflare Worker
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
var LIGHT_TOKENS = `
  --bg:#ffffff;
  --bg-soft:#f6f8fa;
  --bg-elev:#ffffff;
  --fg:#1f2328;
  --fg-dim:#59636e;
  --fg-faint:#818b98;
  --line:#d1d9e0;
  --line-soft:#e8ecf1;
  --accent:#0969da;
  --accent-fg:#ffffff;
  --accent-soft:rgba(9,105,218,.08);
  --accent-line:rgba(9,105,218,.35);
  --danger:#cf222e;
  --danger-soft:rgba(207,34,46,.07);
  --ok:#1a7f37;
  --shadow:0 1px 2px rgba(31,35,40,.05),0 8px 24px rgba(31,35,40,.07);
  --shadow-sm:0 1px 2px rgba(31,35,40,.06);
  --hero:radial-gradient(1000px 380px at 50% -8%,rgba(9,105,218,.16),rgba(9,105,218,.05) 45%,transparent 72%);
`;
var DARK_TOKENS = `
  --bg:#0d1117;
  --bg-soft:#010409;
  --bg-elev:#161b22;
  --fg:#e6edf3;
  --fg-dim:#9198a1;
  --fg-faint:#6e7681;
  --line:#30363d;
  --line-soft:#21262d;
  --accent:#4493f8;
  --accent-fg:#ffffff;
  --accent-soft:rgba(68,147,248,.12);
  --accent-line:rgba(68,147,248,.4);
  --danger:#f85149;
  --danger-soft:rgba(248,81,73,.12);
  --ok:#3fb950;
  --shadow:0 1px 2px rgba(1,4,9,.5),0 8px 24px rgba(1,4,9,.6);
  --shadow-sm:0 1px 2px rgba(1,4,9,.4);
  --hero:radial-gradient(1000px 420px at 50% -8%,rgba(68,147,248,.22),rgba(68,147,248,.07) 45%,transparent 72%);
`;
var BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
*{margin:0;padding:0}
:root{
  color-scheme:light dark;
${LIGHT_TOKENS}
  --radius:12px;
  --radius-sm:8px;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
${DARK_TOKENS}
  }
}
:root[data-theme=dark]{
${DARK_TOKENS}
}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{
  font-family:var(--sans);font-size:16px;line-height:1.65;
  color:var(--fg);background:var(--bg);
  background-image:var(--hero);
  padding:clamp(28px,6vw,64px) clamp(16px,4vw,24px);
  display:flex;justify-content:center;
  min-height:100vh;
}
.wrap{width:100%;max-width:820px}

/* ---- \u9876\u680F ---------------------------------------------------------------- */
.top{display:flex;align-items:center;gap:12px;margin-bottom:clamp(18px,4vw,30px)}
.mark{
  width:40px;height:40px;flex:0 0 auto;border-radius:11px;
  display:grid;place-items:center;
  background:var(--accent);color:var(--accent-fg);
  box-shadow:var(--shadow-sm);
}
.brand{font-size:1.02rem;font-weight:600;letter-spacing:-.01em}
.brand span{display:block;font-size:.8rem;font-weight:400;color:var(--fg-dim);letter-spacing:0}
.top-right{margin-left:auto;display:flex;align-items:center;gap:8px}

/* \u4E3B\u9898\u5207\u6362\uFF1A\u5F53\u524D\u72B6\u6001\u7531 :root[data-theme] \u9A71\u52A8\uFF0C\u4E0D\u4F9D\u8D56 JS \u624D\u80FD\u663E\u793A\u6B63\u786E\u56FE\u6807 */
#theme{
  height:36px;padding:0 11px;display:inline-flex;align-items:center;gap:7px;
  background:var(--bg-elev);color:var(--fg-dim);
  border:1px solid var(--line);border-radius:999px;
  font:inherit;font-size:.82rem;cursor:pointer;
  transition:border-color .15s,color .15s,background .15s;
}
#theme:hover{border-color:var(--accent-line);color:var(--fg)}
#theme:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#theme .ti{display:none;width:15px;height:15px}
#theme .tl{display:none}
:root[data-theme=auto] #theme .ti-auto,
:root[data-theme=light] #theme .ti-light,
:root[data-theme=dark] #theme .ti-dark{display:inline-block}
:root[data-theme=auto] #theme .tl-auto,
:root[data-theme=light] #theme .tl-light,
:root[data-theme=dark] #theme .tl-dark{display:inline}

/* ---- \u6807\u9898 ---------------------------------------------------------------- */
.hero{margin-bottom:clamp(20px,4vw,32px)}
h1{
  font-size:clamp(1.5rem,4.2vw,2.05rem);line-height:1.25;
  font-weight:650;letter-spacing:-.022em;margin-bottom:.5rem;
}
.lede{color:var(--fg-dim);font-size:.95rem;max-width:60ch}
.pill{
  display:inline-flex;align-items:center;gap:6px;
  margin-top:.85rem;padding:3px 10px;border-radius:999px;
  background:var(--accent-soft);color:var(--accent);
  font-size:.78rem;font-weight:500;
}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}

/* ---- \u5361\u7247 ---------------------------------------------------------------- */
.card{
  background:var(--bg-elev);border:1px solid var(--line);
  border-radius:var(--radius);padding:clamp(16px,3vw,22px);
  margin-bottom:14px;box-shadow:var(--shadow-sm);
}
.card-h{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.card-h h2{font-size:.94rem;font-weight:600;letter-spacing:-.01em}
.card-h .hint{margin-left:auto;font-size:.78rem;color:var(--fg-faint)}

/* ---- \u8F93\u5165\u884C -------------------------------------------------------------- */
.row{display:flex;gap:8px;flex-wrap:wrap}
.field{position:relative;flex:1 1 260px;min-width:0}
input[type=text]{
  width:100%;height:44px;padding:0 40px 0 13px;
  font:inherit;font-size:.9rem;font-family:var(--mono);
  color:var(--fg);background:var(--bg-soft);
  border:1px solid var(--line);border-radius:var(--radius-sm);
  outline:none;transition:border-color .15s,background .15s,box-shadow .15s;
}
input[type=text]::placeholder{color:var(--fg-faint);font-family:var(--sans)}
input[type=text]:hover{border-color:var(--fg-faint)}
input[type=text]:focus{
  border-color:var(--accent);background:var(--bg);
  box-shadow:0 0 0 3px var(--accent-soft);
}
#clear{
  position:absolute;top:50%;right:6px;transform:translateY(-50%);
  width:28px;height:28px;display:none;place-items:center;
  background:transparent;border:0;border-radius:6px;
  color:var(--fg-faint);cursor:pointer;
}
#clear:hover{background:var(--line-soft);color:var(--fg)}
.field.has-value #clear{display:grid}
button.go{
  height:44px;padding:0 20px;flex:0 0 auto;
  display:inline-flex;align-items:center;gap:7px;
  font:inherit;font-size:.9rem;font-weight:550;
  color:var(--accent-fg);background:var(--accent);
  border:0;border-radius:var(--radius-sm);cursor:pointer;
  transition:filter .15s,transform .08s;
}
button.go:hover{filter:brightness(1.08)}
button.go:active{transform:translateY(1px)}
button.go:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.go[disabled]{opacity:.6;cursor:default;filter:none;transform:none}

/* ---- \u63D0\u793A ---------------------------------------------------------------- */
.tip{
  display:none;margin-top:10px;padding:9px 12px;
  border-left:3px solid var(--danger);background:var(--danger-soft);
  border-radius:var(--radius-sm);font-size:.85rem;line-height:1.55;
  color:var(--fg);overflow-wrap:anywhere;
}
.tip[data-kind=ok]{border-left-color:var(--ok);background:rgba(26,127,55,.08)}
.tip.show{display:block}
.note{color:var(--fg-dim);font-size:.83rem;margin-top:10px}

/* ---- \u4EE3\u7801\u5757 -------------------------------------------------------------- */
.code{position:relative;margin:8px 0}
pre{
  font-family:var(--mono);font-size:.83rem;line-height:1.6;
  background:var(--bg-soft);border:1px solid var(--line);
  border-radius:var(--radius-sm);padding:11px 40px 11px 13px;
  overflow-x:auto;color:var(--fg);white-space:pre;
  -webkit-overflow-scrolling:touch;
}
pre::-webkit-scrollbar{height:8px}
pre::-webkit-scrollbar-thumb{background:var(--line);border-radius:4px}
#copy{
  position:absolute;top:7px;right:7px;width:28px;height:28px;
  display:grid;place-items:center;
  background:var(--bg-elev);border:1px solid var(--line);border-radius:6px;
  color:var(--fg-faint);cursor:pointer;transition:color .15s,border-color .15s;
}
#copy:hover{color:var(--fg);border-color:var(--accent-line)}
#copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

/* ---- \u8DEF\u5F84\u8868 -------------------------------------------------------------- */
.tbl{width:100%;border-collapse:collapse;font-size:.84rem}
.tbl th{
  text-align:left;font-weight:600;font-size:.78rem;letter-spacing:.02em;
  color:var(--fg-faint);text-transform:uppercase;
  padding:0 10px 8px;border-bottom:1px solid var(--line);
}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line-soft);vertical-align:top}
.tbl tr:last-child td{border-bottom:0}
.tbl td:first-child{font-family:var(--mono);font-size:.8rem;overflow-wrap:anywhere}
.tbl td:last-child{color:var(--fg-dim);white-space:nowrap}
.badge{
  display:inline-block;padding:1px 7px;border-radius:5px;
  background:var(--accent-soft);color:var(--accent);
  font-family:var(--sans);font-size:.72rem;font-weight:500;
}

/* ---- \u9519\u8BEF\u9875\u4E13\u7528 ---------------------------------------------------------- */
.reason{
  border-left:3px solid var(--danger);background:var(--danger-soft);
  padding:11px 14px;border-radius:var(--radius-sm);
  font-size:.9rem;overflow-wrap:anywhere;
}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.back{
  display:inline-flex;align-items:center;gap:6px;
  font-size:.88rem;font-weight:500;
}

/* ---- \u9875\u811A ---------------------------------------------------------------- */
.foot{
  margin-top:22px;padding-top:16px;border-top:1px solid var(--line);
  display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;
  font-size:.8rem;color:var(--fg-faint);
}
.foot a{color:var(--fg-dim)}

/* \u5C0A\u91CD\u51CF\u5C11\u52A8\u6548\u504F\u597D */
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  button:active{transform:none!important}
}
/* \u7A84\u5C4F\uFF1A\u8F93\u5165\u884C\u4E0E\u6309\u94AE\u5404\u5360\u4E00\u884C\uFF0C\u6309\u94AE\u62C9\u6EE1 */
@media (max-width:520px){
  .row{flex-direction:column}
  /* \u5173\u952E\uFF1A\u6539\u7EB5\u5411\u540E flex-basis \u4F1A\u53D8\u6210\u300C\u9AD8\u5EA6\u300D\uFF0C\u5FC5\u987B\u663E\u5F0F\u6536\u56DE\uFF0C
     \u5426\u5219\u8F93\u5165\u6846\u4F1A\u88AB\u62C9\u6210\u4E00\u6574\u5757\uFF08\u5B9E\u6D4B\u624B\u673A\u4E0A\u8F93\u5165\u6846\u5360\u4E86 200px \u9AD8\uFF09\u3002 */
  .field{flex:0 0 auto}
  input[type=text]{height:44px}
  button.go{width:100%;justify-content:center}
  .tbl td:last-child{white-space:normal}
  /* \u7A84\u5C4F\u4E0A\u793A\u4F8B\u5730\u5740\u4E00\u5B9A\u8D85\u51FA\u5C4F\u5BBD\u3002\u8F6F\u6362\u884C\u53EA\u662F\u663E\u793A\u6548\u679C\uFF0C\u590D\u5236\u51FA\u53BB\u7684\u5185\u5BB9\u4E00\u5B57\u4E0D\u53D8\uFF0C
     \u6BD4\u8BA9\u7528\u6237\u6A2A\u5411\u62D6\u62FD\u53CB\u597D\u5F97\u591A\u3002 */
  pre{white-space:pre-wrap;overflow-wrap:anywhere}
}
`;
var THEME_INIT = `
(function(){
  var t='auto';
  try{ var v=localStorage.getItem('cfgh.theme'); if(v==='light'||v==='dark') t=v; }catch(e){}
  document.documentElement.setAttribute('data-theme',t);
})();
`;
var THEME_ICONS = `
<span class="ti ti-auto" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 13.5h5M8 11.5v2" stroke-linecap="round"/></svg></span>
<span class="ti ti-light" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.9 2.9l1.1 1.1M12 12l1.1 1.1M13.1 2.9L12 4M4 12l-1.1 1.1" stroke-linecap="round"/></svg></span>
<span class="ti ti-dark" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" stroke-linejoin="round"/></svg></span>
<span class="tl tl-auto">\u8DDF\u968F\u7CFB\u7EDF</span><span class="tl tl-light">\u4EAE\u8272</span><span class="tl tl-dark">\u6697\u8272</span>
`;
var THEME_CYCLE = `
(function(){
  var K='cfgh.theme';
  var root=document.documentElement;
  var btn=document.getElementById('theme');
  if(!btn) return;
  function cur(){
    var t=root.getAttribute('data-theme');
    return (t==='light'||t==='dark')?t:'auto';
  }
  btn.addEventListener('click',function(){
    var next={auto:'light',light:'dark',dark:'auto'}[cur()];
    root.setAttribute('data-theme',next);
    try{ localStorage.setItem(K,next); }catch(e){}
  });
})();
`;
function renderTop() {
  return `<div class="top">
  <div class="mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M12 2.6 3.4 7.4v9.2L12 21.4l8.6-4.8V7.4L12 2.6Zm0 2.3 6.5 3.6-6.5 3.6-6.5-3.6L12 4.9Zm-7 5.2 6 3.4v5.6l-6-3.4v-5.6Zm8 9V13.5l6-3.4v5.6l-6 3.4Z"/></svg>
  </div>
  <div class="brand">GitHub \u6587\u4EF6\u52A0\u901F<span>Cloudflare Worker</span></div>
  <div class="top-right">
    <button id="theme" type="button" aria-label="\u5207\u6362\u4E3B\u9898\uFF08\u8DDF\u968F\u7CFB\u7EDF / \u4EAE\u8272 / \u6697\u8272\uFF09" title="\u5207\u6362\u4E3B\u9898">${THEME_ICONS}</button>
  </div>
</div>`;
}
function renderFoot(landingLink) {
  const l = escapeHtml(landingLink);
  return `<div class="foot">
  <span>\u53EA\u4EE3\u7406 GitHub \u81EA\u5BB6\u57DF\u540D\uFF0C\u53EA\u4EE3\u7406\u53EF\u4E0B\u8F7D\u6587\u4EF6</span>
  <a href="${l}" target="_blank" rel="noopener noreferrer">GitHub</a>
</div>`;
}
function renderPathTable() {
  return `<table class="tbl">
  <thead><tr><th>\u8DEF\u5F84</th><th>\u7528\u9014</th></tr></thead>
  <tbody>
    <tr><td>/owner/repo/releases/download/tag/file</td><td><span class="badge">release</span></td></tr>
    <tr><td>/owner/repo/releases/latest/download/file</td><td><span class="badge">\u6700\u65B0\u7248</span></td></tr>
    <tr><td>/owner/repo/archive/ref.zip</td><td><span class="badge">\u6E90\u7801\u5305</span></td></tr>
    <tr><td>/owner/repo/raw/ref/path</td><td><span class="badge">\u5355\u6587\u4EF6</span></td></tr>
    <tr><td>/owner/repo/blob/ref/path</td><td><span class="badge">\u81EA\u52A8\u8F6C raw</span></td></tr>
    <tr><td>raw.githubusercontent.com/owner/repo/ref/path</td><td><span class="badge">raw \u76F4\u94FE</span></td></tr>
    <tr><td>gist.githubusercontent.com/user/id/raw</td><td><span class="badge">Gist</span></td></tr>
  </tbody>
</table>`;
}
function exampleBaseOf(prefix) {
  return `https://your-domain${prefix === "/" ? "/" : prefix}`;
}
function renderLanding(cfg) {
  const prefix = cfg.prefix;
  const exampleBase = exampleBaseOf(prefix);
  const prefixJson = jsonForScript(prefix);
  const ex1 = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`;
  const ex2 = `${exampleBase}owner/repo/releases/download/v1.0.0/app.zip`;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>GitHub \u6587\u4EF6\u52A0\u901F</title>
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="wrap">
  ${renderTop()}

  <div class="hero">
    <h1>\u628A GitHub \u4E0B\u8F7D\u94FE\u63A5\u6362\u6210\u4E00\u6761\u66F4\u5FEB\u7684\u5730\u5740</h1>
    <p class="lede">release \u8D44\u4EA7\u3001\u6E90\u7801\u5305\u3001\u5206\u652F\u91CC\u7684\u5355\u4E2A\u6587\u4EF6\uFF0C\u90FD\u80FD\u8D70 Cloudflare \u8FB9\u7F18\u8282\u70B9\u3002\u652F\u6301 Range \u8BF7\u6C42\u4E0E\u65AD\u70B9\u7EED\u4F20\uFF0C\u4E5F\u652F\u6301 <code>curl</code> / <code>wget</code>\u3002</p>
    <div class="pill"><span class="dot"></span>\u8FB9\u7F18\u7F13\u5B58 \xB7 \u81EA\u52A8\u8DDF\u968F\u91CD\u5B9A\u5411 \xB7 \u53EA\u4EE3\u7406\u516C\u5F00\u6587\u4EF6</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>\u8F93\u5165 GitHub \u94FE\u63A5</h2>
      <span class="hint">\u56DE\u8F66\u5373\u53EF</span>
    </div>
    <div class="row">
      <div class="field" id="field">
        <input type="text" id="q" placeholder="https://github.com/owner/repo/releases/download/v1.0.0/app.zip" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip">
        <button id="clear" type="button" aria-label="\u6E05\u7A7A\u8F93\u5165" tabindex="-1">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <button class="go" id="go" type="button">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
        \u52A0\u901F
      </button>
    </div>
    <p class="tip" id="tip" role="status" aria-live="polite"></p>
    <p class="note">\u4E5F\u53EF\u4EE5\u76F4\u63A5\u628A\u94FE\u63A5\u63A5\u5728 <code>${escapeHtml(prefix)}</code> \u540E\u9762\u8BBF\u95EE\uFF0C\u6216\u5199\u6210 <code>?q=</code> \u5F62\u5F0F\u3002</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>\u7528\u6CD5</h2><span class="hint">\u5728\u94FE\u63A5\u524D\u9762\u52A0\u670D\u52A1\u5730\u5740</span></div>
    <div class="code">
      <pre id="ex1">${escapeHtml(ex1)}</pre>
      <button id="copy" type="button" aria-label="\u590D\u5236\u793A\u4F8B">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
      </button>
    </div>
    <p class="note">\u7701\u7565 <code>https://github.com/</code> \u4E5F\u80FD\u7528\uFF1A</p>
    <div class="code"><pre>${escapeHtml(ex2)}</pre></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>\u652F\u6301\u7684\u8DEF\u5F84</h2><span class="hint">\u5176\u4F59\u4E00\u5F8B\u62D2\u7EDD</span></div>
    ${renderPathTable()}
    <p class="note">\u57DF\u540D\u5408\u6CD5\u4E0D\u4EE3\u8868\u8DEF\u5F84\u5408\u6CD5\uFF1A\u4ED3\u5E93\u9996\u9875\u3001issues\u3001settings\u3001search \u8FD9\u7C7B\u7F51\u9875\u4F1A\u88AB\u660E\u786E\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u628A HTML \u5F53\u6587\u4EF6\u6293\u56DE\u6765\u3002</p>
  </div>

  ${renderFoot(cfg.landingLink)}
</div>
<script>
${THEME_CYCLE}
(function(){
  var input=document.getElementById('q');
  var go=document.getElementById('go');
  var tip=document.getElementById('tip');
  var field=document.getElementById('field');
  var clearBtn=document.getElementById('clear');
  var copyBtn=document.getElementById('copy');
  var ex1=document.getElementById('ex1');
  var PREFIX=${prefixJson};
  var busy=false;

  function showTip(msg,kind){
    tip.textContent=msg;
    tip.setAttribute('data-kind',kind||'err');
    tip.classList.add('show');
  }
  function hideTip(){ tip.classList.remove('show'); tip.textContent=''; }

  function syncClear(){
    if(input.value){ field.classList.add('has-value'); } else { field.classList.remove('has-value'); }
  }

  // \u5F52\u4E00\u5316\uFF1A\u628A\u7528\u6237\u8F93\u5165\u6574\u7406\u6210\u300Chttps://...\u300D\u5F62\u5F0F\u3002
  // \u8FD9\u91CC**\u53EA\u505A\u683C\u5F0F\u6574\u7406\uFF0C\u4E0D\u505A\u5408\u6CD5\u6027\u5224\u5B9A**\u2014\u2014\u5224\u5B9A\u4E00\u5F8B\u4EA4\u7ED9\u540E\u7AEF ?check=\u3002
  function normalize(v){
    v=v.trim();
    if(!v) return '';
    var i=v.indexOf('://');
    if(i>0){
      var s=v.slice(0,i).toLowerCase();
      if(s!=='http'&&s!=='https') return '';
      return v;
    }
    var first=v.split('/')[0].split('?')[0].split('#')[0];
    if(first.indexOf('.')>0) return 'https://'+v;
    return 'https://github.com/'+v;
  }

  function submit(){
    if(busy) return;
    var raw=input.value||'';
    if(!raw.trim()){ showTip('\u8BF7\u8F93\u5165\u4E00\u4E2A GitHub \u94FE\u63A5'); input.focus(); return; }
    var href=normalize(raw);
    if(!href){ showTip('\u53EA\u652F\u6301 http / https \u94FE\u63A5'); input.focus(); return; }

    var checkUrl=location.origin+PREFIX+'?check='+encodeURIComponent(href);
    busy=true;
    go.setAttribute('disabled','disabled');
    hideTip();

    fetch(checkUrl,{headers:{'accept':'application/json'}})
      .then(function(r){ return r.json(); })
      .then(function(v){
        busy=false; go.removeAttribute('disabled');
        if(v&&v.ok===true){ location.href=location.origin+PREFIX+href; return; }
        showTip((v&&v.reason)||'\u8FD9\u4E2A\u94FE\u63A5\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6');
        input.focus();
      })
      .catch(function(){
        busy=false; go.removeAttribute('disabled');
        // \u6821\u9A8C\u63A5\u53E3\u4E0D\u53EF\u7528\u65F6\u4E0D\u8981\u5361\u4F4F\u7528\u6237\uFF1A\u76F4\u63A5\u8DF3\u8FC7\u53BB\uFF0C\u8BA9\u540E\u7AEF\u7ED9\u51FA\u6743\u5A01\u5224\u5B9A\u3002
        location.href=location.origin+PREFIX+href;
      });
  }

  go.addEventListener('click',submit);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  input.addEventListener('input',function(){ syncClear(); hideTip(); });
  clearBtn.addEventListener('click',function(){ input.value=''; syncClear(); hideTip(); input.focus(); });
  copyBtn.addEventListener('click',function(){
    var text=ex1.textContent;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){
        showTip('\u793A\u4F8B\u5DF2\u590D\u5236','ok');
        setTimeout(hideTip,1600);
      }).catch(function(){ showTip('\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D','err'); });
    } else {
      showTip('\u8FD9\u4E2A\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u81EA\u52A8\u590D\u5236\uFF0C\u8BF7\u624B\u52A8\u9009\u4E2D','err');
    }
  });
  syncClear();
})();
</script>
</body>
</html>`;
}
function renderErrorPage(cfg, reason) {
  const prefix = cfg.prefix;
  const exampleBase = exampleBaseOf(prefix);
  const home = `${prefix}`;
  const ex = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`;
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6</title>
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="wrap">
  ${renderTop()}

  <div class="hero">
    <h1>\u8FD9\u4E2A\u5730\u5740\u4E0D\u662F\u4E00\u4E2A\u6587\u4EF6</h1>
    <p class="lede">\u8BF7\u6C42\u88AB\u62E6\u4E0B\u4E86\uFF0C\u6CA1\u6709\u53BB\u6293\u53D6\u4EFB\u4F55\u5185\u5BB9\u3002\u4E0B\u9762\u8BF4\u660E\u5177\u4F53\u539F\u56E0\u548C\u6B63\u786E\u7684\u5199\u6CD5\u3002</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>\u5177\u4F53\u539F\u56E0</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="note">\u672C\u670D\u52A1\u53EA\u4EE3\u7406 GitHub \u4E0A<strong>\u53EF\u4E0B\u8F7D\u7684\u8D44\u6E90</strong>\uFF0C\u4E0D\u4EE3\u7406\u7F51\u9875\u3002\u4ED3\u5E93\u9996\u9875\u3001issues\u3001settings\u3001search \u8FD9\u7C7B\u9875\u9762\u4F1A\u88AB\u62D2\u7EDD\u3002</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>\u6B63\u786E\u5F62\u6001</h2><span class="hint">\u5728\u94FE\u63A5\u524D\u9762\u52A0\u670D\u52A1\u5730\u5740</span></div>
    <div class="code"><pre>${escapeHtml(ex)}</pre></div>
    <p class="note">\u7701\u7565 <code>https://github.com/</code> \u4E5F\u884C\u3002</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>\u652F\u6301\u7684\u8DEF\u5F84</h2></div>
    ${renderPathTable()}
  </div>

  <p class="back"><a href="${escapeHtml(home)}">
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8h-11M7 3.5 2.5 8 7 12.5"/></svg>
    \u56DE\u5230\u9996\u9875\u91CD\u65B0\u8F93\u5165</a></p>

  ${renderFoot(cfg.landingLink)}
</div>
<script>${THEME_CYCLE}</script>
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
function jsonForScript(s) {
  return JSON.stringify(String(s)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
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
function maybeRewriteBlob(target) {
  if (target.hostname !== "github.com") return null;
  const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  if (!m) return null;
  const [, owner, repo, rest] = m;
  return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest}`);
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
    try {
      return await route(request, env, ctx);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      try {
        return textResponse(`\u5185\u90E8\u9519\u8BEF\uFF1A${msg}`, 500);
      } catch {
        return new Response("Internal Error", { status: 500 });
      }
    }
  }
};
async function route(request, env, ctx) {
  const cfg = resolveConfig(env);
  const url = new URL(request.url);
  const ua = (request.headers.get("User-Agent") || "").toLowerCase();
  if (cfg.blockedUAs.length && cfg.blockedUAs.some((k) => ua.includes(k))) {
    return htmlResponse(renderDisguise());
  }
  if (request.method === "OPTIONS" && request.headers.has("access-control-request-headers")) {
    return new Response(null, PREFLIGHT);
  }
  const checkRaw = url.searchParams.get("check");
  if (checkRaw) {
    return handleCheck(checkRaw);
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
  const rawTarget = maybeRewriteBlob(target) || target;
  const viaCdn = maybeJsdelivrUrl(rawTarget, cfg);
  return handleProxy(request, viaCdn || rawTarget, cfg, ctx);
}
function handleCheck(raw) {
  const target = buildTargetUrl(raw);
  if (!target) {
    return jsonResponse({ ok: false, reason: "\u65E0\u6CD5\u89E3\u6790\u8FD9\u4E2A\u94FE\u63A5" });
  }
  const verdict = checkTarget(target);
  if (!verdict.ok) {
    return jsonResponse({ ok: false, reason: verdict.reason || "\u8FD9\u4E2A\u94FE\u63A5\u4E0D\u662F\u53EF\u52A0\u901F\u7684 GitHub \u6587\u4EF6" });
  }
  return jsonResponse({ ok: true, href: target.href, kind: verdict.kind || "" });
}
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "cache-control": "no-store",
      ...CORS_HEADERS
    }
  });
}
function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" }
  });
}
function renderHome(cfg) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302);
  }
  if (cfg.disguiseNginx) {
    return htmlResponse(renderDisguise());
  }
  return htmlResponse(renderLanding(cfg));
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
