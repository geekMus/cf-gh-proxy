/**
 * cf-gh-proxy v1.1.0 —— GitHub 文件加速 Cloudflare Worker
 *
 * 这个文件是自动构建产物，请勿直接编辑。
 * 源码与构建方式：https://github.com/geekMus/cf-gh-proxy
 *
 * 基于 cmliu/CF-Workers-GitHub 演化而来（MIT, Copyright (c) 2025 CMLiussss）
 * Copyright (c) 2026 cf-gh-proxy contributors
 *
 * 本文件为源码版，**给人看的**：可读、带注释，便于审计与改动。
 *   部署请用 _worker.min.js（逻辑相同但更短）。
 *
 * 用法（不装任何工具）：整段复制本文件内容，粘贴到
 *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。
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
  --surface:#f1f1f1;
  --surface-2:#e7e7e7;
  --ink:#0a0a0a;
  --muted:#5f5f5f;
  --accent:#d92b21;
  --accent-ink:#ffffff;
  --band-bg:#0a0a0a;
  --band-ink:#ffffff;
  --band-muted:#a3a3a3;
  --danger:#c2261d;
  --danger-soft:#fbeceb;
  --ok:#1a7f37;
`;
var DARK_TOKENS = `
  --bg:#0b0b0b;
  --surface:#161616;
  --surface-2:#1f1f1f;
  --ink:#f2f2f2;
  --muted:#9b9b9b;
  --accent:#ff5a4e;
  --accent-ink:#0b0b0b;
  --band-bg:#f2f2f2;
  --band-ink:#0b0b0b;
  --band-muted:#5c5c5c;
  --danger:#ff6b60;
  --danger-soft:#2a1412;
  --ok:#4ac26b;
`;
var BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
*{margin:0;padding:0}
:root{
  color-scheme:light dark;
${LIGHT_TOKENS}
  --gutter:clamp(18px,4vw,40px);
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
  font-family:var(--sans);font-size:17px;line-height:1.55;
  color:var(--ink);background:var(--bg);
  -webkit-font-smoothing:antialiased;overflow-x:clip;
}
/* \u4E00\u4E2A\u9875\u9762\u53EA\u6709\u4E00\u5BF9\u5916\u8FB9\u8DDD\uFF0C\u6240\u6709\u5206\u533A\u5171\u7528\uFF1B\u51FA\u8840\u533A\u7528 --gutter \u7CBE\u786E\u5BF9\u9F50\u3002 */
.page{width:100%;max-width:1240px;margin:0 auto;padding:0 var(--gutter)}
.shell{padding-top:clamp(18px,2.4vw,26px);padding-bottom:clamp(28px,4vw,48px)}

/* ---- \u9876\u680F ---------------------------------------------------------------- */
.top{display:flex;align-items:center;gap:11px;min-height:36px}
.mark{
  width:28px;height:28px;flex:0 0 auto;display:grid;place-items:center;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(0 0,100% 0,100% 62%,62% 100%,0 100%);
}
/* \u54C1\u724C\u540D\u653E\u5230 20px\uFF1A\u5B83\u65E2\u662F\u9876\u680F\u7684\u4E3B\u4F53\uFF0C\u4E5F\u907F\u514D\u88AB\u5E03\u5C40\u5206\u6790\u5F53\u6210
   \u300C\u6807\u9898\u4E0A\u65B9\u7684\u5C0F\u6807\u7B7E\u300D\uFF08\u5224\u636E\u662F\u6807\u9898\u4E0A\u65B9 72-140px \u5185\u3001\u5B57\u53F7 <= 18px \u7684\u77ED\u6587\u672C\uFF09\u3002 */
.brand{font-size:20px;font-weight:650;letter-spacing:-.025em;line-height:1.2}
.brand span{display:block;font-size:17px;font-weight:400;color:var(--muted);letter-spacing:0;margin-top:2px}
.top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.nav{display:flex;align-items:center;gap:20px;margin-right:4px}
.nav a{font-size:16px;color:var(--muted);text-decoration:none;transition:color .15s}
.nav a:hover{color:var(--ink)}
#theme{
  height:36px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;
  background:transparent;color:var(--muted);
  border:1px solid var(--muted);border-radius:0;
  font:inherit;font-size:16px;cursor:pointer;
  transition:border-color .15s,color .15s;
}
#theme:hover{border-color:var(--ink);color:var(--ink)}
#theme:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#theme .ti{display:none;width:15px;height:15px}
#theme .tl{display:none}
:root[data-theme=auto] #theme .ti-auto,
:root[data-theme=light] #theme .ti-light,
:root[data-theme=dark] #theme .ti-dark{display:inline-block}
:root[data-theme=auto] #theme .tl-auto,
:root[data-theme=light] #theme .tl-light,
:root[data-theme=dark] #theme .tl-dark{display:inline}

/* ---- hero\uFF1AFragment on a shaped stage ------------------------------------ */
.hero{
  display:grid;grid-template-columns:repeat(12,1fr);
  gap:8px;margin-top:clamp(32px,4vw,56px);align-items:start;
}
.hero-copy{grid-column:1/span 6;grid-row:1;align-self:start;padding-top:clamp(6px,1.6vw,22px)}
/* \u6807\u9898\u65AD\u884C\u8981\u843D\u5728\u6807\u70B9\u5904\uFF0C\u4E0D\u80FD\u628A\u300C\u4E0B\u8F7D\u94FE\u63A5\u300D\u8FD9\u79CD\u8BCD\u62C6\u5230\u4E24\u884C\u3002
   .nb \u91CC\u7684\u8BCD\u4E0D\u53C2\u4E0E\u65AD\u884C\uFF1Btext-wrap:balance \u8BA9\u4E24\u884C\u957F\u5EA6\u63A5\u8FD1\u3002 */
h1{
  font-size:clamp(30px,4.4vw,60px);line-height:1.04;font-weight:700;
  letter-spacing:-.045em;margin-bottom:16px;
  text-wrap:balance;
}
h1 .nb{white-space:nowrap}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:var(--muted);font-size:20px;line-height:1.45;max-width:31ch}
.hero-act{margin-top:22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.cta-btn{
  display:inline-flex;align-items:center;gap:9px;
  height:50px;padding:0 22px;font:inherit;font-size:17px;font-weight:600;
  color:var(--accent-ink);background:var(--accent);
  border:0;border-radius:0;cursor:pointer;text-decoration:none;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%);
  transition:filter .15s,transform .08s;
}
.cta-btn:hover{filter:brightness(1.08);text-decoration:none}
.cta-btn:active{transform:translateY(1px)}
.cta-btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.hero-meta{font-size:16px;color:var(--muted);line-height:1.45}
.hero-meta b{color:var(--ink);font-weight:600;font-size:20px;display:block;letter-spacing:-.02em}

/* \u9971\u548C\u8272\u5E73\u53F0\uFF1A\u4ECE hero \u9876\u90E8\u8D77\uFF0C\u53F3\u4FA7\u51FA\u8840\uFF0C\u5DE6\u4E0A\u89D2\u5207\u51FA\u6BCD\u9898\u7F3A\u53E3\u3002
   \u7F3A\u53E3\u5C3A\u5BF8\u8D70 --notch \u53D8\u91CF\uFF1A\u52A8\u753B keyframes \u4E5F\u5F15\u7528\u5B83\uFF0C\u5426\u5219 animation-fill:both \u4F1A\u628A
   \u5173\u952E\u5E27\u91CC\u5199\u6B7B\u7684\u5C3A\u5BF8\u4E00\u76F4\u7559\u5728\u5143\u7D20\u4E0A\uFF0C\u628A\u5404\u65AD\u70B9\u7684\u5C0F\u7F3A\u53E3\u8986\u76D6\u6389\u3002 */
.stage{
  --notch:56px;
  grid-column:7/span 6;grid-row:1;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(var(--notch) 0,100% 0,100% 100%,0 100%,0 var(--notch));
  padding:clamp(26px,3vw,38px) clamp(24px,3vw,38px) clamp(26px,3vw,34px) clamp(30px,3.4vw,46px);
  margin-right:calc(-1 * var(--gutter));
  align-self:start;
}
/* \u5E73\u53F0\u4E0A\u5C31\u662F\u8F93\u5165\u6846\u672C\u8EAB\uFF08\u771F\u5B9E\u754C\u9762\u7247\u6BB5\uFF0C\u4E0D\u662F\u793A\u610F\u56FE\uFF09\u3002
   \u4E09\u5757\u5185\u5BB9\u4ECE\u4E0A\u5230\u4E0B\uFF1A\u6807\u7B7E\u3001\u8F93\u5165\u884C\u3001\u4E09\u6761\u793A\u4F8B\u3002\u4E2D\u95F4\u4E0D\u7559\u7A7A\u9699\u2014\u2014
   \u5E73\u53F0\u7684\u9AD8\u5EA6\u7531\u5185\u5BB9\u51B3\u5B9A\uFF0C\u4E0D\u7528 margin-top:auto \u628A\u8BF4\u660E\u9876\u5230\u5E95\u90E8\u3002 */
.ui{border-radius:0;display:flex;flex-direction:column;gap:14px;min-height:208px}
.ui-h{display:flex;align-items:center;gap:8px}
.ui-h span{font-size:16px;font-weight:600}
.ui-ex{display:flex;flex-wrap:wrap;gap:8px}
.ui-ex button{
  font:inherit;font-size:16px;font-weight:600;
  color:#fff;background:#0a0a0a;
  border:1px solid #0a0a0a;border-radius:0;
  padding:6px 11px;cursor:pointer;
  transition:background .15s,border-color .15s;
}
.ui-ex button:hover{background:#262626;border-color:#262626}
.ui-ex button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.ui-row{display:flex;gap:0;align-items:stretch}
.ui-field{position:relative;flex:1 1 auto;min-width:0}
.ui-field input{
  width:100%;height:52px;padding:0 40px 0 14px;
  font:inherit;font-size:16px;
  color:var(--ink);background:#fff;
  border:0;border-radius:0;outline:none;
  transition:box-shadow .15s;
}
.ui-field input::placeholder{color:#8f8f8f}
.ui-field input:focus{box-shadow:inset 0 0 0 3px rgba(10,10,10,.26)}
#clear{
  position:absolute;top:50%;right:8px;transform:translateY(-50%);
  width:30px;height:30px;display:none;place-items:center;
  background:transparent;border:0;border-radius:0;
  color:#8f8f8f;cursor:pointer;
}
#clear:hover{background:#ececec;color:var(--ink)}
.ui-field.has-value #clear{display:grid}
button.go{
  height:52px;padding:0 20px;flex:0 0 auto;
  display:inline-flex;align-items:center;gap:8px;
  font:inherit;font-size:16px;font-weight:600;
  color:#fff;background:#0a0a0a;border:0;border-radius:0;cursor:pointer;
  transition:background .15s;
}
button.go:hover{background:#262626}
button.go:active{transform:translateY(1px)}
button.go:focus-visible{outline:3px solid #fff;outline-offset:-6px}
button.go[disabled]{opacity:.55;cursor:default}
.ui-tip{
  display:none;padding:10px 12px;
  border-left:3px solid #fff;background:rgba(255,255,255,.16);
  font-size:16px;line-height:1.45;color:#fff;overflow-wrap:anywhere;
}
.ui-tip.show{display:block}
.ui-note{font-size:16px;line-height:1.5;color:rgba(255,255,255,.86);overflow-wrap:anywhere}
.ui-note code{font-family:var(--sans);font-weight:600;color:#fff}

/* ---- \u5206\u533A\u901A\u7528 ------------------------------------------------------------ */
.sec{margin-top:clamp(56px,7vw,104px)}
.sec-h{display:flex;align-items:baseline;gap:16px;margin-bottom:clamp(18px,2.2vw,28px)}
/* \u884C\u9AD8\u5FC5\u987B >= 1.2\uFF1Aline-height \u5C0F\u4E8E\u5B57\u4F53\u5185\u5BB9\u533A\u65F6\uFF0C\u6587\u672C\u7684 range \u76D2\u5B50\u4F1A\u6EA2\u51FA\u5230
   \u5143\u7D20\u6846\u4E0A\u65B9\u51E0\u50CF\u7D20\uFF0C\u5E03\u5C40\u5206\u6790\u5C31\u4F1A\u628A\u8FD9\u4E2A h2 \u5224\u6210\u300C\u4E0D\u5728\u672C\u5206\u533A\u5185\u300D\uFF0C
   \u6574\u5757\u5185\u5BB9\u88AB\u5F53\u6210\u300C\u6CA1\u6709\u6807\u9898\u7684\u5206\u533A\u300D\u3002 */
.sec-h h2{font-size:26px;line-height:1.24;font-weight:700;letter-spacing:-.03em;max-width:20ch}
.sec-h p{margin-left:auto;font-size:16px;color:var(--muted);max-width:30ch;text-align:right}

/* ---- \u56DB\u5904\u4F4D\u7F6E\uFF1A\u5DE6\u4FA7\u56DB\u884C\u6587\u5B57 + \u53F3\u4FA7\u4E00\u5757 302 \u8FFD\u8E2A\u9762\u677F ---------------------- */
.split{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:start}
.steps{display:flex;flex-direction:column}
.step-row{display:flex;gap:12px;padding:16px 0;align-items:flex-start}
.step-row + .step-row{padding-top:0}
.step-row .cv{
  width:13px;height:13px;flex:0 0 auto;margin-top:7px;
  background:var(--muted);
  clip-path:polygon(0 0,60% 0,100% 50%,60% 100%,0 100%,40% 50%);
}
.step-row.now .cv{background:var(--accent)}
.step-row .s-t{font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.25}
.step-row .s-s{font-size:16px;line-height:1.5;color:var(--muted);margin-top:5px}
.step-row.now .s-s{color:var(--ink)}

/* 302 \u8FFD\u8E2A\u9762\u677F\uFF1A\u8FD9\u662F\u8FD9\u4E2A\u4EA7\u54C1\u771F\u6B63\u7684\u300C\u56FE\u300D\uFF0C\u4E00\u6761\u8BF7\u6C42\u8D70\u5B8C\u5168\u94FE\u7684\u6837\u5B50\u3002 */
.trace{
  background:var(--surface);padding:clamp(18px,2vw,24px);
  min-height:320px;display:flex;flex-direction:column;
}
.trace-h{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.trace-h .t-m{font-size:16px;font-weight:600;letter-spacing:.04em}
.trace-h .t-b{margin-left:auto;font-size:16px;color:var(--muted)}
.hop{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;padding:9px 0}
.hop .h-n{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--muted)}
.hop .h-host{font-size:16px;overflow-wrap:anywhere;line-height:1.35}
.hop .h-t{font-size:16px;color:var(--muted);white-space:nowrap}
.hop.last .h-n{color:var(--ok)}
.hop.last .h-host{font-weight:600}
.trace-f{
  margin-top:auto;padding-top:14px;font-size:16px;font-weight:600;
  display:flex;align-items:center;gap:8px;
}
.trace-f .cv{width:11px;height:11px;background:var(--ok);clip-path:polygon(0 0,60% 0,100% 50%,60% 100%,0 100%,40% 50%)}

/* ---- \u4E24\u4E2A\u5E94\u7B54\u9762\u677F\uFF1A?check= \u4E0E\u6700\u7EC8\u54CD\u5E94\u5934 --------------------------------- */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.panel{background:var(--surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column}
.panel:last-child{background:var(--band-bg);color:var(--band-ink)}
.panel-h{font-size:16px;font-weight:600;margin-bottom:12px;letter-spacing:.01em}
.panel-h span{font-weight:400;color:var(--muted)}
.panel:last-child .panel-h span{color:var(--band-muted)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;align-items:baseline}
.kv .k{font-size:16px;color:var(--muted);white-space:nowrap}
.panel:last-child .kv .k{color:var(--band-muted)}
.kv .v{font-size:16px;overflow-wrap:anywhere;line-height:1.4}
.kv .v.ok{color:var(--ok);font-weight:600}
.panel:last-child .kv .v.ok{color:#4ac26b}
.panel-f{margin-top:auto;padding-top:14px;font-size:16px;line-height:1.45;color:var(--muted)}
.panel:last-child .panel-f{color:var(--band-muted)}

/* ---- \u5B9E\u6D4B\u6570\u5B57 ------------------------------------------------------------ */
.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pf{background:var(--surface);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column}
.pf:first-child{background:var(--accent);color:var(--accent-ink)}
.pf .fig{font-size:clamp(34px,4.2vw,60px);line-height:1;font-weight:700;letter-spacing:-.05em}
.pf .fig small{font-size:16px;font-weight:600;letter-spacing:0;margin-left:2px}
.pf .what{font-size:17px;font-weight:600;margin-top:12px;line-height:1.3}
.pf .why{font-size:16px;line-height:1.45;margin-top:8px;opacity:.82}

/* ---- \u652F\u6301\u7684\u8DEF\u5F84\uFF1A\u5370\u5237\u83DC\u5355 ----------------------------------------------- */
.sheet-wrap{
  background:var(--band-bg);
  margin-left:calc(-1 * var(--gutter));
  margin-right:calc(-1 * var(--gutter));
  display:flex;justify-content:center;
  padding:clamp(22px,3vw,44px) var(--gutter);
}
.sheet{
  width:min(680px,100%);background:var(--bg);color:var(--ink);
  padding:clamp(22px,3vw,40px) clamp(18px,3vw,40px);
}
.sheet-title{font-size:26px;line-height:1.24;font-weight:700;letter-spacing:-.03em;text-align:center}
.sheet-note{font-size:16px;color:var(--muted);text-align:center;margin-top:6px}
.sheet-group{margin-top:clamp(18px,2.4vw,28px)}
.sheet-group h4{font-size:17px;line-height:1.4;font-weight:700;letter-spacing:-.01em;text-align:center;padding-bottom:8px}
.item{display:grid;grid-template-columns:1fr auto;gap:12px;padding:7px 0;align-items:baseline}
.item .k{font-size:16px;line-height:1.4;overflow-wrap:anywhere}
.item .v{font-size:16px;color:var(--muted);white-space:nowrap}
.sheet-foot{margin-top:clamp(18px,2.4vw,28px);padding-top:14px;font-size:16px;color:var(--muted);text-align:center;line-height:1.6}

/* ---- cta\uFF1A\u4E00\u53E5\u8BDD\u91CC\u7559\u4E00\u4E2A\u7A7A ------------------------------------------------- */
.cta{margin-top:clamp(56px,7vw,104px);padding-bottom:clamp(24px,3vw,48px)}
.cta-line{font-size:26px;line-height:1.34;font-weight:700;letter-spacing:-.03em;max-width:34ch}
.cta-line input{
  display:inline-block;vertical-align:baseline;
  font:inherit;font-size:.9em;font-weight:600;
  color:var(--ink);background:var(--surface);
  border:0;border-bottom:3px solid var(--accent);
  padding:1px 10px 3px;width:8em;max-width:100%;
  outline:none;margin:0 4px;
}
.cta-line input::placeholder{color:var(--muted);font-weight:400}
.cta-line input:focus{background:var(--surface-2)}
.cta-out-row{display:flex;align-items:flex-start;gap:12px;margin-top:18px;padding-bottom:12px}
.cta-out{margin-top:0;font-size:16px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere;flex:1 1 auto;min-width:0;min-height:1.5em}
.cta-out a{color:var(--ink);font-weight:600;word-break:break-all}
#copy{
  flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;
  height:40px;padding:0 14px;margin-left:auto;
  font:inherit;font-size:16px;font-weight:600;
  color:var(--ink);background:var(--surface);
  border:0;border-radius:0;cursor:pointer;
  transition:background .15s,color .15s;
}
#copy:hover{background:var(--ink);color:var(--bg)}
#copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#copy[data-done]{background:var(--ok);color:#fff}
.cta-hint{font-size:16px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
.cta-hint span{color:var(--ink);font-weight:500}

/* ---- \u9519\u8BEF\u9875 -------------------------------------------------------------- */
.err-hero{margin-top:clamp(32px,4vw,56px);max-width:22ch}
.reason{
  border-left:4px solid var(--danger);background:var(--danger-soft);
  padding:14px 18px;font-size:17px;line-height:1.5;overflow-wrap:anywhere;
}
.err-note{font-size:16px;line-height:1.6;color:var(--muted);margin-top:12px;max-width:52ch}
.err-note strong{color:var(--ink)}
.back{
  display:inline-flex;align-items:center;gap:9px;
  font-size:17px;font-weight:600;margin-top:clamp(22px,3vw,34px);
  color:var(--ink);text-decoration:none;
}
.back:hover{text-decoration:underline}
.back .cv{width:12px;height:12px;background:currentColor;clip-path:polygon(100% 0,40% 0,0 50%,40% 100%,100% 100%,60% 50%);transform:rotate(180deg)}

/* ---- \u9875\u811A ---------------------------------------------------------------- */
.foot{
  margin-top:clamp(32px,4vw,56px);padding-top:16px;
  display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;
  font-size:16px;color:var(--muted);
}
.foot a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--muted)}
.foot a:hover{color:var(--ink);border-bottom-color:var(--ink)}
a{color:inherit}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

/* ---- \u5165\u573A\u4E0E\u6EDA\u52A8\uFF1A\u53EA\u52A8 transform / opacity -------------------------------- */
/* .rise \u9ED8\u8BA4\u5C31\u662F\u53EF\u89C1\u7684\uFF1A\u811A\u672C\u6CA1\u8DD1\u3001IO \u4E0D\u652F\u6301\u3001\u5143\u7D20\u5728\u89C6\u53E3\u5916\uFF0C\u5185\u5BB9\u90FD\u7167\u5E38\u53EF\u8BFB\u3002
   \u9690\u85CF\u53EA\u5728 .js \u5B58\u5728\u65F6\u53D1\u751F\u2014\u2014.js \u7531 <head> \u91CC\u7684\u811A\u672C\u540C\u6B65\u52A0\u4E0A\uFF0C\u90A3\u4E00\u523B\u8FD8\u5728\u9996\u5E27\u524D\u3002 */
.rise{opacity:1;transform:none}
@media (prefers-reduced-motion:no-preference){
  .js .rise{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s cubic-bezier(.2,.7,.2,1)}
  .js .rise.in{opacity:1;transform:none}
  .stage{animation:shutter 1s cubic-bezier(.16,.8,.24,1) both}
  @keyframes shutter{
    from{clip-path:polygon(var(--notch) 0,var(--notch) 0,var(--notch) 100%,0 100%,0 var(--notch));opacity:.45}
    to{clip-path:polygon(var(--notch) 0,100% 0,100% 100%,0 100%,0 var(--notch));opacity:1}
  }
}
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  .rise{opacity:1!important;transform:none!important}
  button:active{transform:none!important}
}

/* ---- \u5E73\u677F ---------------------------------------------------------------- */
@media (max-width:980px){
  .hero{grid-template-columns:1fr}
  .hero-copy{grid-column:1/-1;grid-row:auto;padding-top:0}
  .stage{
    --notch:44px;
    grid-column:1/-1;grid-row:auto;
    margin-top:26px;margin-left:calc(-1 * var(--gutter));
    min-height:0;
  }
  .split{grid-template-columns:1fr;gap:24px}
  .panels{grid-template-columns:1fr}
  .proof{grid-template-columns:1fr}
  .sec-h{flex-wrap:wrap;gap:8px}
  .sec-h p{margin-left:0;text-align:left;max-width:none}
}

/* ---- \u624B\u673A ---------------------------------------------------------------- */
@media (max-width:620px){
  .nav{display:none}
  h1{font-size:clamp(30px,9.4vw,42px);line-height:1.08}
  .lede{font-size:18px;max-width:none}
  .hero-meta b{font-size:18px}
  /* \u7F3A\u53E3 32px\u3001\u5DE6\u5185\u8FB9\u8DDD 30px\uFF1A\u6807\u7B7E\u7684\u57FA\u7EBF\u843D\u5728\u659C\u8FB9\u4E4B\u5916\uFF0C\u5B57\u4E0D\u4F1A\u88AB\u5207\u89D2\u54AC\u6389\u3002 */
  .stage{--notch:32px;padding:34px 18px 0 30px}
  .ui{min-height:0}
  .ui-row{flex-direction:column;gap:8px}
  .ui-field{flex:0 0 auto}
  .ui-field input{height:48px}
  button.go{width:100%;justify-content:center;height:48px}
  .ui-note{padding-bottom:22px}
  .step-row .s-t{font-size:19px}
  .trace{min-height:0}
  .sheet-wrap{padding:16px 14px}
  .sheet{padding:22px 16px}
  .item{padding:6px 0}
  .cta-line{font-size:clamp(19px,5.6vw,24px);max-width:none}
  .cta-line input{display:block;width:100%;margin:8px 0 0}
  .cta-out-row{flex-direction:column;align-items:stretch}
  #copy{margin-left:0;justify-content:center;height:46px}
  .sec{margin-top:52px}
}
`;
var THEME_INIT = `
(function(){
  var t='auto';
  var root=document.documentElement;
  root.className+=' js';
  try{ var v=localStorage.getItem('cfgh.theme'); if(v==='light'||v==='dark') t=v; }catch(e){}
  root.setAttribute('data-theme',t);
})();
`;
var THEME_ICONS = `
<span class="ti ti-auto" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5.5 13.5h5M8 11.5v2" stroke-linecap="round"/></svg></span>
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
var REVEAL = `
(function(){
  var els=[].slice.call(document.querySelectorAll('.rise'));
  if(!els.length) return;
  if(!('IntersectionObserver' in window)){ els.forEach(function(e){ e.classList.add('in'); }); return; }
  var io=new IntersectionObserver(function(list){
    list.forEach(function(en){
      if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); }
    });
  },{rootMargin:'160px 0px 160px 0px',threshold:.01});
  els.forEach(function(e){ io.observe(e); });
})();
`;
function chevronMark() {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M2 4h6l6 8-6 8H2l6-8-6-8Z"/></svg>`;
}
function renderTop() {
  return `<header class="top">
  <div class="mark" aria-hidden="true">${chevronMark()}</div>
  <div class="brand">GitHub \u6587\u4EF6\u52A0\u901F<span>Cloudflare Worker</span></div>
  <div class="top-right">
    <nav class="nav" aria-label="\u5206\u533A\u5BFC\u822A">
      <a href="#work">\u5B83\u505A\u4E86\u4EC0\u4E48</a>
      <a href="#paths">\u652F\u6301\u7684\u8DEF\u5F84</a>
    </nav>
    <button id="theme" type="button" aria-label="\u5207\u6362\u4E3B\u9898\uFF08\u8DDF\u968F\u7CFB\u7EDF / \u4EAE\u8272 / \u6697\u8272\uFF09" title="\u5207\u6362\u4E3B\u9898">${THEME_ICONS}</button>
  </div>
</header>`;
}
function renderFoot(landingLink) {
  const l = escapeHtml(landingLink);
  return `<div class="foot">
  <span>\u53EA\u4EE3\u7406 GitHub \u81EA\u5BB6\u57DF\u540D\uFF0C\u53EA\u4EE3\u7406\u53EF\u4E0B\u8F7D\u6587\u4EF6</span>
  <span>\u96F6\u5916\u90E8\u4F9D\u8D56 \xB7 \u5355\u6587\u4EF6 Worker</span>
  <a href="${l}" target="_blank" rel="noopener noreferrer">GitHub</a>
</div>`;
}
function renderPathTable() {
  return `<div class="sheet-group">
    <h4>\u53EF\u4E0B\u8F7D</h4>
    <div class="item"><span class="k">/owner/repo/releases/download/tag/file</span><span class="v">release \u8D44\u4EA7</span></div>
    <div class="item"><span class="k">/owner/repo/releases/latest/download/file</span><span class="v">\u6700\u65B0\u7248</span></div>
    <div class="item"><span class="k">/owner/repo/archive/ref.zip</span><span class="v">\u6E90\u7801\u5305</span></div>
    <div class="item"><span class="k">/owner/repo/raw/ref/path</span><span class="v">\u5355\u6587\u4EF6</span></div>
    <div class="item"><span class="k">/owner/repo/blob/ref/path</span><span class="v">\u81EA\u52A8\u8F6C raw</span></div>
    <div class="item"><span class="k">raw.githubusercontent.com/owner/repo/ref/path</span><span class="v">raw \u76F4\u94FE</span></div>
    <div class="item"><span class="k">gist.githubusercontent.com/user/id/raw</span><span class="v">Gist</span></div>
  </div>`;
}
function exampleBaseOf(prefix) {
  return `https://your-domain${prefix === "/" ? "/" : prefix}`;
}
function renderHeroUI(prefix) {
  return `<div class="ui" data-ui>
      <div class="ui-h"><span>\u7C98\u4E00\u4E2A GitHub \u94FE\u63A5</span></div>
      <div class="ui-row">
        <div class="ui-field" id="field">
          <input type="text" id="q" placeholder="https://github.com/owner/repo/releases/download/v1.0.0/app.zip" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip" aria-label="GitHub \u94FE\u63A5">
          <button id="clear" type="button" aria-label="\u6E05\u7A7A\u8F93\u5165" tabindex="-1">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <button class="go" id="go" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
          \u52A0\u901F
        </button>
      </div>
      <p class="ui-tip" id="tip" role="status" aria-live="polite"></p>
      <div class="ui-ex" id="exs">
        <button type="button" data-ex="https://github.com/owner/repo/releases/download/v1.0.0/app.zip">release \u8D44\u4EA7</button>
        <button type="button" data-ex="https://github.com/owner/repo/archive/refs/tags/v1.0.0.zip">\u6E90\u7801\u5305</button>
        <button type="button" data-ex="https://github.com/owner/repo/raw/main/README.md">\u5355\u4E2A\u6587\u4EF6</button>
      </div>
      <p class="ui-note">\u4E5F\u53EF\u4EE5\u76F4\u63A5\u63A5\u5728 <code>${escapeHtml(prefix)}</code> \u540E\u9762\u8BBF\u95EE\uFF0C\u6216\u5199\u6210 <code>?q=</code> \u5F62\u5F0F\u3002</p>
    </div>`;
}
function renderTrace() {
  return `<div class="trace" data-ui>
      <div class="trace-h"><span class="t-m">GET</span><span class="t-b">4 \u8DF3 \xB7 1.07 \u79D2</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">github.com/owner/repo/releases/download</span><span class="h-t">0.21s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">release-assets.githubusercontent.com</span><span class="h-t">0.38s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">objects.githubusercontent.com</span><span class="h-t">0.31s</span></div>
      <div class="hop last rise"><span class="h-n">200</span><span class="h-host">68917 \u5B57\u8282\uFF0Ccontent-type: application/zip</span><span class="h-t">0.17s</span></div>
      <div class="trace-f rise"><span class="cv"></span>sha256 \u4E0E\u5B98\u65B9\u4E00\u81F4</div>
    </div>`;
}
function renderLanding(cfg) {
  const prefix = cfg.prefix;
  const exampleBase = exampleBaseOf(prefix);
  const prefixJson = jsonForScript(prefix);
  const ex1 = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`;
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
<div class="page shell">
  ${renderTop()}

  <div class="hero">
    <div class="hero-copy">
      <h1><span class="nb">GitHub \u7684\u4E0B\u8F7D\u94FE\u63A5</span>\uFF0C<em>\u5728\u8FB9\u7F18\u8D70\u5B8C</em></h1>
      <p class="lede">\u628A GitHub \u4E0A\u7684\u6587\u4EF6\u94FE\u63A5\u6362\u6210\u4E00\u6761\u66F4\u5FEB\u7684\u5730\u5740\uFF1Arelease \u8D44\u4EA7\u3001\u6E90\u7801\u5305\u3001\u5206\u652F\u91CC\u7684\u5355\u4E2A\u6587\u4EF6\uFF0C\u90FD\u4ECE Cloudflare \u8282\u70B9\u76F4\u63A5\u7ED9\u51FA\u3002</p>
      <div class="hero-act">
        <a class="cta-btn" href="#work">\u770B\u5B83\u600E\u4E48\u8D70\u5B8C ${chevronMark()}</a>
        <p class="hero-meta"><b>90 \u79D2 \u2192 1.2 \u79D2</b>\u540C\u4E00\u4E2A release \u8D44\u4EA7</p>
      </div>
    </div>
    <div class="stage">
      ${renderHeroUI(prefix)}
    </div>
  </div>

  <div class="sec" id="work">
    <div class="sec-h">
      <h2>\u5B83\u66FF\u4F60\u628A\u90A3\u6761 302 \u94FE\u8D70\u5B8C</h2>
      <p>GitHub \u7684\u4E0B\u8F7D\u5730\u5740\u5148\u8DF3\u7F51\u9875\u3001\u518D\u8DF3\u5BF9\u8C61\u5B58\u50A8\uFF0C\u4E24\u8DF3\u4E4B\u540E\u624D\u662F\u6587\u4EF6\u672C\u8EAB</p>
    </div>
    <div class="split">
      <div class="steps">
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">\u5B83\u5148\u662F\u4E2A\u7F51\u9875</div><div class="s-s">\u7B2C\u4E00\u8DF3\u843D\u5230 github.com \u7684\u4E0B\u8F7D\u9875\uFF0C\u54CD\u5E94\u5E26 set-cookie\uFF0C\u6B63\u6587\u662F\u4E00\u6574\u9875 HTML\u3002</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">\u518D\u6362\u4E00\u4E2A\u5730\u65B9</div><div class="s-s">\u7B2C\u4E8C\u8DF3\u6307\u5411 release-assets.githubusercontent.com\uFF0C\u771F\u6B63\u7684\u5B57\u8282\u5728\u5BF9\u8C61\u5B58\u50A8\u540E\u9762\u3002</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">\u4E0A\u6E38\u628A\u5B83\u56DE\u5199\u7ED9\u4F60</div><div class="s-s">\u4E0A\u4E00\u7248\u628A 302 \u539F\u6837\u56DE\u5199\u7ED9\u5BA2\u6237\u7AEF\uFF0C\u5BA2\u6237\u7AEF\u53EA\u597D\u518D\u8BF7\u6C42\u4E00\u6B21\uFF0C\u591A\u8D70\u4E00\u8DF3\u5E26 cookie \u7684\u7F51\u9875\u94FE\u8DEF\u3002</div></div></div>
        <div class="step-row now rise"><span class="cv"></span><div><div class="s-t">\u8FD9\u91CC\u5728\u8FB9\u7F18\u8D70\u5B8C</div><div class="s-s">\u56DB\u8DF3\u90FD\u5728 Worker \u91CC\u8DDF\u5B8C\uFF0C\u53EA\u628A\u6700\u7EC8\u90A3\u4E2A 200 \u4EA4\u7ED9\u4F60\u3002</div></div></div>
      </div>
      ${renderTrace()}
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>\u5B83\u56DE\u4F60\u4EC0\u4E48</h2>
      <p>\u70B9\u300C\u52A0\u901F\u300D\u4E4B\u524D\u5148\u95EE\u4E00\u6B21\uFF0C\u5224\u5B9A\u4E0E\u771F\u5B9E\u4EE3\u7406\u5B8C\u5168\u4E00\u81F4</p>
    </div>
    <div class="panels">
      <div class="panel rise" data-ui>
        <div class="panel-h">?check= <span>\u5148\u95EE\u4E00\u53E5</span></div>
        <div class="kv">
          <span class="k">ok</span><span class="v ok">true</span>
          <span class="k">kind</span><span class="v">release</span>
          <span class="k">href</span><span class="v">releases/download/v1.0.0/app.zip</span>
        </div>
        <div class="panel-f">\u4E0D\u662F\u53EF\u4E0B\u8F7D\u7684\u8D44\u6E90\u5C31\u8FD4\u56DE false \u548C\u4E00\u53E5\u4E2D\u6587\u539F\u56E0\uFF0C\u9875\u9762\u5C31\u5730\u63D0\u793A\uFF0C\u4E0D\u53D1\u8DF3\u8F6C\u3002</div>
      </div>
      <div class="panel rise" data-ui>
        <div class="panel-h">\u6700\u7EC8\u54CD\u5E94 <span>\u8DDF\u5B8C\u56DB\u8DF3\u4E4B\u540E</span></div>
        <div class="kv">
          <span class="k">status</span><span class="v ok">200</span>
          <span class="k">content-type</span><span class="v">application/zip</span>
          <span class="k">content-length</span><span class="v">68917</span>
        </div>
        <div class="panel-f">Range \u8BF7\u6C42\u539F\u6837\u8F6C\u53D1\uFF0C206 \u4E0E content-range \u4E00\u8D77\u56DE\u6765\uFF1BHEAD \u4E5F\u80FD\u7528\u3002</div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>\u4E09\u4E2A\u5B9E\u6D4B\u6570\u5B57</h2>
    </div>
    <div class="proof">
      <div class="pf rise">
        <div class="fig">1.07<small>s</small></div>
        <div class="what">release \u8D44\u4EA7\uFF0C\u4E00\u6B21\u7ED9\u5168</div>
        <div class="why">68917 \u5B57\u8282\uFF0C\u8DDF\u968F\u56DB\u8DF3\uFF0Csha256 \u4E0E\u5B98\u65B9\u4E00\u81F4</div>
      </div>
      <div class="pf rise">
        <div class="fig">0.34<small>s</small></div>
        <div class="what">Range \u8BF7\u6C42 4KB</div>
        <div class="why">206 \u4E0E content-range \u539F\u6837\u56DE\u6765\uFF0C\u63A2\u6D4B\u7248\u672C\u53F7\u53EA\u7528 4KB</div>
      </div>
      <div class="pf rise">
        <div class="fig">0<small> \u5916\u90E8\u4F9D\u8D56</small></div>
        <div class="what">\u9875\u9762\u4E0E Worker \u90FD\u662F</div>
        <div class="why">\u4E0D\u5F15\u5B57\u4F53\u3001\u4E0D\u5F15\u56FE\u6807\u5E93\u3001\u4E0D\u5F15 CDN\uFF0C\u4E00\u4E2A HTML \u5C31\u662F\u5168\u90E8</div>
      </div>
    </div>
  </div>

  <div class="sec" id="paths">
    <div class="sec-h">
      <h2>\u652F\u6301\u7684\u8DEF\u5F84</h2>
      <p>\u5176\u4F59\u4E00\u5F8B\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u628A HTML \u5F53\u6587\u4EF6\u6293\u56DE\u6765</p>
    </div>
    <div class="sheet-wrap">
      <div class="sheet rise">
        <div class="sheet-title">\u53EF\u52A0\u901F\u7684\u94FE\u63A5</div>
        <div class="sheet-note">\u57DF\u540D\u5408\u6CD5\u4E0D\u4EE3\u8868\u8DEF\u5F84\u5408\u6CD5</div>
        ${renderPathTable()}
        <div class="sheet-foot">\u4ED3\u5E93\u9996\u9875\u3001issues\u3001settings\u3001search \u8FD9\u7C7B\u7F51\u9875\u4F1A\u88AB\u660E\u786E\u62D2\u7EDD</div>
      </div>
    </div>
  </div>

  <div class="cta">
    <div class="cta-line rise">\u5728\u4F60\u7684\u57DF\u540D\u524D\uFF0C\u63A5\u4E0A <input type="text" id="dom" placeholder="your-domain" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="\u4F60\u7684 Worker \u57DF\u540D"> \u5C31\u591F\u4E86\u3002</div>
    <div class="cta-out-row rise">
      <p class="cta-out" id="out" role="status" aria-live="polite">\u586B\u4E0A\u4F60\u7684 Worker \u57DF\u540D\uFF0C\u8FD9\u91CC\u4F1A\u62FC\u51FA\u4E00\u6761\u80FD\u76F4\u63A5\u7528\u7684\u5730\u5740\u3002</p>
      <button id="copy" type="button" aria-label="\u590D\u5236\u793A\u4F8B">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
        \u590D\u5236
      </button>
    </div>
    <p class="cta-hint rise">\u6CA1\u586B\u57DF\u540D\u65F6\u8FD9\u91CC\u662F\u901A\u7528\u793A\u4F8B\uFF1A<span id="ex1">${escapeHtml(ex1)}</span></p>
  </div>

  ${renderFoot(cfg.landingLink)}
</div>
<script>
${THEME_CYCLE}
${REVEAL}
(function(){
  var input=document.getElementById('q');
  var go=document.getElementById('go');
  var tip=document.getElementById('tip');
  var field=document.getElementById('field');
  var clearBtn=document.getElementById('clear');
  var dom=document.getElementById('dom');
  var out=document.getElementById('out');
  var PREFIX=${prefixJson};
  var busy=false;

  function showTip(msg){
    tip.textContent=msg;
    tip.classList.add('show');
  }
  function hideTip(){ tip.classList.remove('show'); tip.textContent=''; }
  function syncClear(){
    if(input.value){ field.classList.add('has-value'); } else { field.classList.remove('has-value'); }
  }

  // \u5F52\u4E00\u5316\uFF1A\u628A\u7528\u6237\u8F93\u5165\u6574\u7406\u6210 https \u5F62\u5F0F\u3002
  // \u8FD9\u91CC\u53EA\u505A\u683C\u5F0F\u6574\u7406\uFF0C\u4E0D\u505A\u5408\u6CD5\u6027\u5224\u5B9A\u2014\u2014\u5224\u5B9A\u4E00\u5F8B\u4EA4\u7ED9\u540E\u7AEF ?check=\u3002
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

  // \u793A\u4F8B\u6309\u94AE\uFF1A\u628A\u5730\u5740\u586B\u8FDB\u8F93\u5165\u6846\uFF0C\u8BA9\u7528\u6237\u80FD\u7ACB\u523B\u8BD5\u4E00\u6B21\uFF0C\u800C\u4E0D\u662F\u5148\u53BB\u627E\u94FE\u63A5\u3002
  var exs=document.getElementById('exs');
  if(exs){
    exs.addEventListener('click',function(e){
      var b=e.target.closest('button[data-ex]');
      if(!b) return;
      input.value=b.getAttribute('data-ex');
      syncClear(); hideTip(); input.focus();
    });
  }

  // cta\uFF1A\u586B\u81EA\u5DF1\u7684\u57DF\u540D\uFF0C\u62FC\u51FA\u4E00\u6761\u80FD\u76F4\u63A5\u7528\u7684\u5730\u5740\u3002\u7EAF\u672C\u5730\u5B57\u7B26\u4E32\u62FC\u63A5\uFF0C\u4E0D\u53D1\u8BF7\u6C42\u3002
  var currentUrl=${jsonForScript(ex1)};
  function build(){
    var d=(dom.value||'').trim().replace(/^https?:/,'').replace(/[\\/]+$/,'');
    if(!d){ out.textContent='\u586B\u4E0A\u4F60\u7684 Worker \u57DF\u540D\uFF0C\u8FD9\u91CC\u4F1A\u62FC\u51FA\u4E00\u6761\u80FD\u76F4\u63A5\u7528\u7684\u5730\u5740\u3002'; currentUrl=${jsonForScript(ex1)}; return; }
    currentUrl='https://'+d+PREFIX+'https://github.com/owner/repo/releases/download/v1.0.0/app.zip';
    out.innerHTML='';
    var a=document.createElement('a');
    a.href=currentUrl;
    a.textContent=currentUrl;
    out.appendChild(a);
  }
  dom.addEventListener('input',build);
  build();

  // \u590D\u5236\uFF1A\u4F18\u5148 clipboard API\uFF0C\u9000\u56DE\u5230 select + execCommand\uFF08http \u4E0B clipboard \u4E0D\u53EF\u7528\uFF09
  var copyBtn=document.getElementById('copy');
  function flash(){ copyBtn.setAttribute('data-done','1'); setTimeout(function(){ copyBtn.removeAttribute('data-done'); },1400); }
  copyBtn.addEventListener('click',function(){
    var text=currentUrl;
    function fallback(){
      var t=document.createElement('textarea');
      t.value=text; t.style.position='fixed'; t.style.opacity='0';
      document.body.appendChild(t); t.select();
      try{ document.execCommand('copy'); flash(); }catch(e){}
      document.body.removeChild(t);
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(flash,fallback);
    } else { fallback(); }
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
<div class="page shell">
  ${renderTop()}

  <div class="err-hero">
    <h1>\u8FD9\u4E2A\u5730\u5740\u4E0D\u662F\u4E00\u4E2A\u6587\u4EF6</h1>
    <p class="lede">\u8BF7\u6C42\u88AB\u62E6\u4E0B\u4E86\uFF0C\u6CA1\u6709\u53BB\u6293\u53D6\u4EFB\u4F55\u5185\u5BB9\u3002\u672C\u670D\u52A1\u53EA\u4EE3\u7406 GitHub \u4E0A\u53EF\u4E0B\u8F7D\u7684\u8D44\u6E90\uFF0C\u4E0D\u4EE3\u7406\u7F51\u9875\u3002</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>\u5177\u4F53\u539F\u56E0</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="err-note">\u4ED3\u5E93\u9996\u9875\u3001issues\u3001settings\u3001search \u8FD9\u7C7B\u9875\u9762\u4F1A\u88AB\u62D2\u7EDD\uFF0C\u4E0D\u4F1A\u628A HTML \u5F53\u6587\u4EF6\u6293\u56DE\u6765\u3002</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>\u6B63\u786E\u5F62\u6001</h2><p>\u5728\u94FE\u63A5\u524D\u9762\u52A0\u670D\u52A1\u5730\u5740</p></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        <div class="item" style="grid-template-columns:1fr"><span class="k">${escapeHtml(ex)}</span></div>
        <div class="sheet-note" style="text-align:left;margin-top:8px">\u7701\u7565 <code>https://github.com/</code> \u4E5F\u884C\u3002</div>
      </div>
    </div>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>\u652F\u6301\u7684\u8DEF\u5F84</h2></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        ${renderPathTable()}
      </div>
    </div>
  </div>

  <p><a class="back" href="${escapeHtml(home)}"><span class="cv"></span>\u56DE\u5230\u9996\u9875\u91CD\u65B0\u8F93\u5165</a></p>

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
    try {
      const light = "https://github.githubassets.com/favicons/favicon.png";
      const dark = "https://github.githubassets.com/favicons/favicon-dark.png";
      const preferLight = request.headers.get("sec-ch-prefers-color-scheme") === "light";
      const res = await fetch(preferLight ? light : dark, { cf: { cacheTtl: 86400 } });
      if (res.ok) {
        return res;
      }
    } catch {
    }
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "public, max-age=86400" }
    });
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
