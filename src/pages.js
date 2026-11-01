'use strict'

// ============================================================================
// 静态页面：首页说明页 / 错误说明页 / nginx 伪装页
//
// 页面形态与伪装机制沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 视觉与主题系统、错误页、无障碍与性能细节为重写。
//
// 设计约束（都是有原因的，改动前请先看 README 的「页面与性能」一节）：
//   1. 零外部资源：不引字体、不引图标库、不引 CDN。全部内联，一个 HTML 就是全部。
//      这样页面能被边缘缓存、不产生额外请求、也不受第三方可用性影响。
//   2. 主题三态：auto（跟随系统）/ light / dark。auto 由 CSS 媒体查询负责，
//      显式选择由 :root[data-theme] 覆盖，**首帧前**在 <head> 里落定，避免闪白。
//   3. 前端不做业务判定：校验一律问后端 ?check= 接口（见 index.js），
//      保证「页面说什么」和「服务端做什么」永远一致——两边各写一份逻辑必然漂移。
//
// 模板字符串注意：本文件用普通模板字符串拼 HTML，因此正文里
//   - 不能出现反引号
//   - 不能出现 ${（会被当插值）
//   - CSS / JS 里尽量不用反斜杠（正则、转义都改写成字符串操作）
// 改完务必跑 npm test，其中有「抽出内联脚本并用 vm 编译」的守卫。
// ============================================================================

// 亮色是默认值；暗色在下面按「系统偏好 + 显式选择」两处应用同一份 token。
const LIGHT_TOKENS = `
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
`

const DARK_TOKENS = `
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
`

// 共用样式：两页都引用，保证视觉一致。
const BASE_CSS = `
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

/* ---- 顶栏 ---------------------------------------------------------------- */
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

/* 主题切换：当前状态由 :root[data-theme] 驱动，不依赖 JS 才能显示正确图标 */
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

/* ---- 标题 ---------------------------------------------------------------- */
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

/* ---- 卡片 ---------------------------------------------------------------- */
.card{
  background:var(--bg-elev);border:1px solid var(--line);
  border-radius:var(--radius);padding:clamp(16px,3vw,22px);
  margin-bottom:14px;box-shadow:var(--shadow-sm);
}
.card-h{display:flex;align-items:baseline;gap:8px;margin-bottom:12px}
.card-h h2{font-size:.94rem;font-weight:600;letter-spacing:-.01em}
.card-h .hint{margin-left:auto;font-size:.78rem;color:var(--fg-faint)}

/* ---- 输入行 -------------------------------------------------------------- */
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

/* ---- 提示 ---------------------------------------------------------------- */
.tip{
  display:none;margin-top:10px;padding:9px 12px;
  border-left:3px solid var(--danger);background:var(--danger-soft);
  border-radius:var(--radius-sm);font-size:.85rem;line-height:1.55;
  color:var(--fg);overflow-wrap:anywhere;
}
.tip[data-kind=ok]{border-left-color:var(--ok);background:rgba(26,127,55,.08)}
.tip.show{display:block}
.note{color:var(--fg-dim);font-size:.83rem;margin-top:10px}

/* ---- 代码块 -------------------------------------------------------------- */
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

/* ---- 路径表 -------------------------------------------------------------- */
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

/* ---- 错误页专用 ---------------------------------------------------------- */
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

/* ---- 页脚 ---------------------------------------------------------------- */
.foot{
  margin-top:22px;padding-top:16px;border-top:1px solid var(--line);
  display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;
  font-size:.8rem;color:var(--fg-faint);
}
.foot a{color:var(--fg-dim)}

/* 尊重减少动效偏好 */
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  button:active{transform:none!important}
}
/* 窄屏：输入行与按钮各占一行，按钮拉满 */
@media (max-width:520px){
  .row{flex-direction:column}
  /* 关键：改纵向后 flex-basis 会变成「高度」，必须显式收回，
     否则输入框会被拉成一整块（实测手机上输入框占了 200px 高）。 */
  .field{flex:0 0 auto}
  input[type=text]{height:44px}
  button.go{width:100%;justify-content:center}
  .tbl td:last-child{white-space:normal}
  /* 窄屏上示例地址一定超出屏宽。软换行只是显示效果，复制出去的内容一字不变，
     比让用户横向拖拽友好得多。 */
  pre{white-space:pre-wrap;overflow-wrap:anywhere}
}
`

// 首帧前落定主题，避免「先亮后暗」的闪一下。
// 注意这段在 <head> 里同步执行，且必须容忍 localStorage 被禁用。
const THEME_INIT = `
(function(){
  var t='auto';
  try{ var v=localStorage.getItem('cfgh.theme'); if(v==='light'||v==='dark') t=v; }catch(e){}
  document.documentElement.setAttribute('data-theme',t);
})();
`

// 主题按钮的图标与文字：三种状态各一份，由 CSS 按 :root[data-theme] 选择，
// 因此即使 JS 没跑，图标也是对的。
const THEME_ICONS = `
<span class="ti ti-auto" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 13.5h5M8 11.5v2" stroke-linecap="round"/></svg></span>
<span class="ti ti-light" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.9 2.9l1.1 1.1M12 12l1.1 1.1M13.1 2.9L12 4M4 12l-1.1 1.1" stroke-linecap="round"/></svg></span>
<span class="ti ti-dark" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" stroke-linejoin="round"/></svg></span>
<span class="tl tl-auto">跟随系统</span><span class="tl tl-light">亮色</span><span class="tl tl-dark">暗色</span>
`

// 主题按钮的点击逻辑：auto → light → dark → auto。
const THEME_CYCLE = `
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
`

// 顶栏：logo + 名称 + 主题按钮。两页共用。
function renderTop() {
  return `<div class="top">
  <div class="mark" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="21" height="21" fill="currentColor"><path d="M12 2.6 3.4 7.4v9.2L12 21.4l8.6-4.8V7.4L12 2.6Zm0 2.3 6.5 3.6-6.5 3.6-6.5-3.6L12 4.9Zm-7 5.2 6 3.4v5.6l-6-3.4v-5.6Zm8 9V13.5l6-3.4v5.6l-6 3.4Z"/></svg>
  </div>
  <div class="brand">GitHub 文件加速<span>Cloudflare Worker</span></div>
  <div class="top-right">
    <button id="theme" type="button" aria-label="切换主题（跟随系统 / 亮色 / 暗色）" title="切换主题">${THEME_ICONS}</button>
  </div>
</div>`
}

function renderFoot(landingLink) {
  const l = escapeHtml(landingLink)
  return `<div class="foot">
  <span>只代理 GitHub 自家域名，只代理可下载文件</span>
  <a href="${l}" target="_blank" rel="noopener noreferrer">GitHub</a>
</div>`
}

/** 支持的路径表。两页共用，避免「首页说一套、错误页说另一套」。 */
function renderPathTable() {
  return `<table class="tbl">
  <thead><tr><th>路径</th><th>用途</th></tr></thead>
  <tbody>
    <tr><td>/owner/repo/releases/download/tag/file</td><td><span class="badge">release</span></td></tr>
    <tr><td>/owner/repo/releases/latest/download/file</td><td><span class="badge">最新版</span></td></tr>
    <tr><td>/owner/repo/archive/ref.zip</td><td><span class="badge">源码包</span></td></tr>
    <tr><td>/owner/repo/raw/ref/path</td><td><span class="badge">单文件</span></td></tr>
    <tr><td>/owner/repo/blob/ref/path</td><td><span class="badge">自动转 raw</span></td></tr>
    <tr><td>raw.githubusercontent.com/owner/repo/ref/path</td><td><span class="badge">raw 直链</span></td></tr>
    <tr><td>gist.githubusercontent.com/user/id/raw</td><td><span class="badge">Gist</span></td></tr>
  </tbody>
</table>`
}

/**
 * 示例里「服务地址」那一截。
 *
 * 关键细节：prefix 是 `/` 时必须补一个结尾斜杠，否则拼出来是
 * `https://your-domainhttps://github.com/...` —— 两个 URL 连成一片，
 * 用户会以为要这么写（实测第一版就是这样，截图上很难看）。
 */
function exampleBaseOf(prefix) {
  return `https://your-domain${prefix === '/' ? '/' : prefix}`
}

/**
 * 首页。
 *
 * 校验不在这里做：点「加速」后先问后端的 ?check= 接口，拿到和真实代理
 * 完全一致的判定（含同样的中文原因），再决定跳转还是就地报错。
 * 这样前端不需要维护第二份规则——两份规则必然漂移，这是上一版的真实教训。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 */
export function renderLanding(cfg) {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix)
  const prefixJson = jsonForScript(prefix)
  const ex1 = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`
  const ex2 = `${exampleBase}owner/repo/releases/download/v1.0.0/app.zip`

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>GitHub 文件加速</title>
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="wrap">
  ${renderTop()}

  <div class="hero">
    <h1>把 GitHub 下载链接换成一条更快的地址</h1>
    <p class="lede">release 资产、源码包、分支里的单个文件，都能走 Cloudflare 边缘节点。支持 Range 请求与断点续传，也支持 <code>curl</code> / <code>wget</code>。</p>
    <div class="pill"><span class="dot"></span>边缘缓存 · 自动跟随重定向 · 只代理公开文件</div>
  </div>

  <div class="card">
    <div class="card-h">
      <h2>输入 GitHub 链接</h2>
      <span class="hint">回车即可</span>
    </div>
    <div class="row">
      <div class="field" id="field">
        <input type="text" id="q" placeholder="https://github.com/owner/repo/releases/download/v1.0.0/app.zip" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip">
        <button id="clear" type="button" aria-label="清空输入" tabindex="-1">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
        </button>
      </div>
      <button class="go" id="go" type="button">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
        加速
      </button>
    </div>
    <p class="tip" id="tip" role="status" aria-live="polite"></p>
    <p class="note">也可以直接把链接接在 <code>${escapeHtml(prefix)}</code> 后面访问，或写成 <code>?q=</code> 形式。</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>用法</h2><span class="hint">在链接前面加服务地址</span></div>
    <div class="code">
      <pre id="ex1">${escapeHtml(ex1)}</pre>
      <button id="copy" type="button" aria-label="复制示例">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
      </button>
    </div>
    <p class="note">省略 <code>https://github.com/</code> 也能用：</p>
    <div class="code"><pre>${escapeHtml(ex2)}</pre></div>
  </div>

  <div class="card">
    <div class="card-h"><h2>支持的路径</h2><span class="hint">其余一律拒绝</span></div>
    ${renderPathTable()}
    <p class="note">域名合法不代表路径合法：仓库首页、issues、settings、search 这类网页会被明确拒绝，不会把 HTML 当文件抓回来。</p>
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

  // 归一化：把用户输入整理成「https://...」形式。
  // 这里**只做格式整理，不做合法性判定**——判定一律交给后端 ?check=。
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
    if(!raw.trim()){ showTip('请输入一个 GitHub 链接'); input.focus(); return; }
    var href=normalize(raw);
    if(!href){ showTip('只支持 http / https 链接'); input.focus(); return; }

    var checkUrl=location.origin+PREFIX+'?check='+encodeURIComponent(href);
    busy=true;
    go.setAttribute('disabled','disabled');
    hideTip();

    fetch(checkUrl,{headers:{'accept':'application/json'}})
      .then(function(r){ return r.json(); })
      .then(function(v){
        busy=false; go.removeAttribute('disabled');
        if(v&&v.ok===true){ location.href=location.origin+PREFIX+href; return; }
        showTip((v&&v.reason)||'这个链接不是可加速的 GitHub 文件');
        input.focus();
      })
      .catch(function(){
        busy=false; go.removeAttribute('disabled');
        // 校验接口不可用时不要卡住用户：直接跳过去，让后端给出权威判定。
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
        showTip('示例已复制','ok');
        setTimeout(hideTip,1600);
      }).catch(function(){ showTip('复制失败，请手动选中','err'); });
    } else {
      showTip('这个浏览器不支持自动复制，请手动选中','err');
    }
  });
  syncClear();
})();
</script>
</body>
</html>`
}

/**
 * 链接不合法时的说明页。
 *
 * 为什么不直接返回 403 纯文本：首页那个输入框会把任意输入拼成 URL，
 * 用户很容易粘错；给一页说明「错在哪、正确形态是什么」比一句 403 有用得多。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {string} reason 具体原因（由 validate.js 产出）
 */
export function renderErrorPage(cfg, reason) {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix)
  const home = `${prefix}`
  const ex = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>不是可加速的 GitHub 文件</title>
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="wrap">
  ${renderTop()}

  <div class="hero">
    <h1>这个地址不是一个文件</h1>
    <p class="lede">请求被拦下了，没有去抓取任何内容。下面说明具体原因和正确的写法。</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>具体原因</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="note">本服务只代理 GitHub 上<strong>可下载的资源</strong>，不代理网页。仓库首页、issues、settings、search 这类页面会被拒绝。</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>正确形态</h2><span class="hint">在链接前面加服务地址</span></div>
    <div class="code"><pre>${escapeHtml(ex)}</pre></div>
    <p class="note">省略 <code>https://github.com/</code> 也行。</p>
  </div>

  <div class="card">
    <div class="card-h"><h2>支持的路径</h2></div>
    ${renderPathTable()}
  </div>

  <p class="back"><a href="${escapeHtml(home)}">
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8h-11M7 3.5 2.5 8 7 12.5"/></svg>
    回到首页重新输入</a></p>

  ${renderFoot(cfg.landingLink)}
</div>
<script>${THEME_CYCLE}</script>
</body>
</html>`
}

/** 命中屏蔽 UA 时返回的伪装页。刻意保持和真 nginx 默认页一致，不要美化。 */
export function renderDisguise() {
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
</html>`
}

/** 把值安全地放进 HTML 里的内联 JS（防 </script> 提前闭合、防引号）。 */
function jsonForScript(s) {
  return JSON.stringify(String(s))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
