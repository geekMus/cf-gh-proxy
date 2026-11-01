// ============================================================================
// 页面：首页（单屏）与两种错误页。
//
// 首页的设计约束，按优先级：
//
//   1. **一屏放得下，不许往下拉**。用户来这儿只干一件事：把链接变成一条能下的
//      链接。所有文案都为这一个动作让路，讲原理、讲部署一律不出现在页面上。
//   2. **零外部资源**。不引字体、不引图标库、不引 CDN、不引图床；logo、favicon、
//      网格背景全是内联 SVG / data URI。一个 HTML 就是全部。
//   3. **内容不依赖 JS**。标题、说明、示例在禁用 JS 时仍然可读；主题在 <head>
//      里同步落定，不闪白。
//   4. **前端不做业务判定**。点「加速」先问后端 ?check=，拿到的判定与真实代理
//      完全一致；前端只负责展示与跳转，不维护第二份规则（两份必然漂移）。
//
// 说明文字尽量少：怎么用、支持哪些形态，仓库里的 docs 写得更全，页面上只留
// 一句 + 三个示例按钮。用户不需要在这里读说明书。
// ============================================================================

// 两套配色。亮色是偏冷的纸白 + 青蓝；暗色压暗但不用纯黑，避免刺眼。
// 所有正文/次要文字对底色的对比度都在 4.5:1 以上（亮色 muted 5.1，暗色 7.0）。
const LIGHT_TOKENS = `
  --bg:#f6f8fb;
  --surface:#eef1f6;
  --surface-2:#e2e7ee;
  --field:#ffffff;
  --ink:#1b2634;
  --muted:#5b6b7c;
  --accent:#2f6f9f;
  --accent-ink:#ffffff;
  --danger:#a8453c;
  --ok:#2c7a5a;
  --grid-minor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%231b2634' stroke-opacity='.052' stroke-width='1'/%3E%3C/svg%3E");
  --grid-major:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cpath d='M128 0H0V128' fill='none' stroke='%231b2634' stroke-opacity='.075' stroke-width='1'/%3E%3C/svg%3E");
`

const DARK_TOKENS = `
  --bg:#101519;
  --surface:#171d24;
  --surface-2:#1f2730;
  --field:#0b1014;
  --ink:#e2e9f0;
  --muted:#93a2b3;
  --accent:#7fb4d4;
  --accent-ink:#0b1014;
  --danger:#d08a80;
  --ok:#7fbd9c;
  --grid-minor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%23e2e9f0' stroke-opacity='.045' stroke-width='1'/%3E%3C/svg%3E");
  --grid-major:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cpath d='M128 0H0V128' fill='none' stroke='%23e2e9f0' stroke-opacity='.065' stroke-width='1'/%3E%3C/svg%3E");
`

// 网格背景是两层 SVG 平铺：32px 细线 + 128px 主线。
// 不用 CSS 渐变——渐变会带上一圈假的「光」，而且平铺时接缝更明显。
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{${LIGHT_TOKENS}}
@media (prefers-color-scheme:dark){
  :root{${DARK_TOKENS}}
}
:root[data-theme=light]{${LIGHT_TOKENS}}
:root[data-theme=dark]{${DARK_TOKENS}}

html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{
  margin:0;
  min-height:100svh;
  background:var(--bg);
  color:var(--ink);
  font:400 16px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:var(--grid-minor),var(--grid-major);
  background-size:32px 32px,128px 128px;
  background-position:0 0,0 0;
}

.shell{
  position:relative;z-index:1;
  min-height:100svh;
  max-width:1120px;margin:0 auto;
  padding:clamp(16px,3vw,28px) clamp(18px,4vw,44px) clamp(14px,2.4vw,22px);
  display:flex;flex-direction:column;
}

/* ---- 顶栏：只有标记、名字、主题按钮 ------------------------------------- */
.top{display:flex;align-items:center;gap:10px;flex:0 0 auto}
/* 顶栏左侧「标记 + 名字」是一整块，点它回首页（错误页上尤其需要）。 */
.home{display:inline-flex;align-items:center;gap:10px;flex:0 0 auto;color:inherit;text-decoration:none;padding:2px 6px;margin:-2px -6px}
.home:hover .brand{color:var(--accent)}
.mark{width:26px;height:26px;flex:0 0 auto;color:var(--accent)}
.mark svg{width:100%;height:100%;display:block}
.brand{font-size:15px;font-weight:680;letter-spacing:-.012em;color:var(--ink)}
.top-sp{flex:1 1 auto}
#theme{
  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:40px;min-width:40px;padding:0 10px;
  color:var(--muted);background:transparent;border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:13px;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:color .18s ease,box-shadow .18s ease;
}
#theme:hover{color:var(--ink);box-shadow:inset 0 0 0 1px var(--muted)}
/* 仓库入口：右上角一个 GitHub 图标，点进本仓库；页面底部不再放任何东西 */
.gh{
  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:40px;height:40px;
  color:var(--muted);text-decoration:none;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:color .18s ease,box-shadow .18s ease;
}
.gh svg{width:17px;height:17px;display:block;fill:currentColor}
.gh:hover{color:var(--ink);box-shadow:inset 0 0 0 1px var(--muted)}
.ti{display:none;line-height:0}
.tl{display:none}
:root[data-theme=auto] .ti-auto,:root[data-theme=auto] .tl-auto{display:inline-flex}
:root[data-theme=light] .ti-light,:root[data-theme=light] .tl-light{display:inline-flex}
:root[data-theme=dark] .ti-dark,:root[data-theme=dark] .tl-dark{display:inline-flex}

/* ---- 中间：一屏之内把「粘链接」这件事摆正 ------------------------------- */
.stage{
  flex:1 1 auto;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:clamp(20px,5vh,56px) 0 clamp(20px,5vh,56px);
  text-align:center;
}
.core{width:100%;max-width:660px}

/* 右下角的版本号：一行小字，右边缘与顶栏图标对齐，不占中间的操作区。 */
.ver{margin-top:10px;align-self:flex-end;font-size:13px;line-height:1;color:var(--muted);letter-spacing:.01em}
h1{
  margin:0 0 12px;
  font-size:clamp(24px,2.8vw,32px);
  line-height:1.22;
  letter-spacing:-.022em;
  font-weight:660;
}
.lede{
  margin:0 auto 28px;
  max-width:32em;
  color:var(--muted);
  font-size:16px;
  line-height:1.62;
  text-wrap:pretty;
}

/* 输入栏：整页的主角。整条是**一个**对象——白底、1px 内描边、按钮嵌在右端，
   聚焦时整条换成 2px 强调色描边。描边一律用 inset 阴影而不是 border：
   边框会占宽度，换色时整行会跳一下。 */
.bar{
  display:flex;align-items:center;gap:6px;
  width:100%;padding:6px;
  background:var(--field);
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:box-shadow .2s ease;
}
.bar:hover{box-shadow:inset 0 0 0 1px var(--muted)}
.bar:focus-within{box-shadow:inset 0 0 0 2px var(--accent)}
.ui-field{position:relative;flex:1 1 auto;min-width:0;display:flex}
#q{
  width:100%;height:46px;
  padding:0 40px 0 12px;
  color:var(--ink);background:transparent;
  border:0;border-radius:0;
  font:inherit;font-size:15px;
}
#q::placeholder{color:var(--muted);opacity:.7}
#q:focus{outline:none}
#clear{
  position:absolute;top:50%;right:4px;transform:translateY(-50%);
  width:30px;height:30px;padding:0;
  display:none;place-items:center;
  color:var(--muted);background:transparent;border:0;cursor:pointer;
  font:inherit;
}
.ui-field.has-value #clear{display:grid}
#clear:hover{color:var(--ink)}
#go{
  flex:0 0 auto;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:46px;padding:0 22px;
  color:var(--accent-ink);background:var(--accent);
  border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:15px;font-weight:620;letter-spacing:.004em;
  transition:filter .18s ease,transform .18s ease;
}
#go:hover{filter:brightness(1.06)}
#go:active{transform:translateY(1px)}
#go[disabled]{opacity:.62;cursor:progress}
.ui-tip{
  min-height:20px;margin:10px 2px 0;
  font-size:13px;line-height:1.45;color:var(--danger);
  opacity:0;transition:opacity .2s ease;
}
.ui-tip.show{opacity:1}
.ui-tip a{color:inherit;text-decoration:underline;text-underline-offset:3px}
.ui-tip a:hover{color:var(--ink)}

/* 三个示例：做成安静的文字按钮而不是一排方框——这一屏的主角只有一个（输入栏），
   示例再用边框框起来就会和它抢视线。保留 32px 的可点高度，比纯文字链接好按。 */
.ex{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
  gap:4px 14px;margin-top:14px;
}
.ex .lbl{color:var(--muted);font-size:13px}
.ex button{
  height:32px;padding:0;margin:0;
  color:var(--ink);background:transparent;
  border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:13px;
  text-decoration:underline;text-decoration-color:var(--surface-2);
  text-underline-offset:4px;
  transition:color .18s ease,text-decoration-color .18s ease;
}
.ex button:hover{color:var(--accent);text-decoration-color:var(--accent)}
#copy{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--muted)}
#copy svg{flex:0 0 auto}
#copy:hover{color:var(--accent)}
#copy[data-done]{color:var(--ok)}

/* ---- 页脚：已移除。仓库入口挪到右上角，页面底部只留空白 ---------------- */

/* ---- 焦点可见与动效兜底 ------------------------------------------------ */
a:focus-visible,button:focus-visible,input:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px;
}
:root[data-theme=dark] a:focus-visible,
:root[data-theme=dark] button:focus-visible,
:root[data-theme=dark] input:focus-visible{outline-color:var(--accent)}

@media (prefers-reduced-motion:no-preference){
  .anim{animation:rise .52s cubic-bezier(.2,.7,.2,1) both}
  .anim.d1{animation-delay:.05s}
  .anim.d2{animation-delay:.11s}
  .anim.d3{animation-delay:.17s}
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}

@media (max-width:640px){
  body{font-size:16px}
  h1{font-size:clamp(21px,6vw,26px);margin-bottom:10px}
  .lede{font-size:15px;margin-bottom:22px}
  .bar{flex-wrap:wrap}
  .ui-field{flex:1 1 100%}
  #q{height:48px;font-size:16px}   /* 16px 起 iOS 不会自动放大 */
  #go{flex:1 1 100%;height:48px;margin-top:6px}
  #theme{padding:0 8px}
  .gh{width:36px;height:36px}
  .ex{gap:6px}
  .ex button{height:30px;font-size:13px;padding:0 10px}
}

/* ---- 错误页复用的小零件（首页不用） ------------------------------------ */
.err-hero{margin:clamp(18px,4vh,40px) 0 0}
.err-hero .lede{margin-bottom:0;max-width:38em;text-align:left}
.err-hero h1{text-align:left}
.reason{
  color:var(--ink);background:var(--surface);
  padding:14px 16px;font-size:15px;line-height:1.55;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  word-break:break-word;
}
.err-note{color:var(--muted);font-size:14px;margin:10px 0 0}
.paths{color:var(--muted);font-size:14px}
.paths-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.paths-h h3{margin:0;font-size:15px;font-weight:650;color:var(--ink)}
.paths-h span{font-size:13px}
.path-grid{display:grid;grid-template-columns:1fr;gap:1px;background:var(--surface-2)}
.path-grid .item{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline;
  padding:9px 12px;background:var(--bg);
}
.path-grid .k{color:var(--ink);font-size:13.5px;overflow-wrap:anywhere}
.path-grid .v{color:var(--muted);font-size:13px;text-align:right}
.paths-foot{color:var(--muted);font-size:13px;margin:10px 0 0}
.back{
  display:inline-flex;align-items:center;gap:8px;
  color:var(--ink);text-decoration:none;font-size:15px;
  min-height:44px;
}
.back svg{width:16px;height:16px;flex:0 0 auto}
.back:hover{color:var(--accent)}
.sec{margin-top:clamp(22px,3.2vw,34px)}
.sec-h{margin-bottom:10px}
.sec-h h2{margin:0;font-size:20px;letter-spacing:-.02em}
.sec-h p{margin:6px 0 0;color:var(--muted);font-size:14.5px}
`

// 页面输出用的 CSS：去掉注释与行首缩进。注释是写给读源码的人看的（源码版里有），
// 浏览器不需要；删掉是白拿的：体积与解析都省一点。
const CSS_MIN = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n')

// <head> 里的同步脚本：读本地存的主题，在首帧之前把 data-theme 落定，避免闪白。
// 同时给 <html> 挂上 js 类，供需要脚本的样式使用。
const THEME_INIT = `
(function(){
  var root=document.documentElement;
  root.className+=' js';
  var t='auto';
  try{ var s=localStorage.getItem('cfgh.theme'); if(s==='light'||s==='dark') t=s; }catch(e){}
  root.setAttribute('data-theme',t);
})();
`

// 主题按钮的图标与文字：三种状态各一份，由 CSS 按 :root[data-theme] 选择，
// 因此即使 JS 没跑，图标也是对的。
const THEME_ICONS = `
<span class="ti ti-auto" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5.5 13.5h5M8 11.5v2" stroke-linecap="round"/></svg></span>
<span class="ti ti-light" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.9 2.9l1.1 1.1M12 12l1.1 1.1M13.1 2.9L12 4M4 12l-1.1 1.1" stroke-linecap="round"/></svg></span>
<span class="ti ti-dark" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" stroke-linejoin="round"/></svg></span>
<span class="tl tl-auto">跟随系统</span><span class="tl tl-light">亮色</span><span class="tl tl-dark">暗色</span>
`

// 主题按钮的点击逻辑：auto 到 light 到 dark 再到 auto。
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

// 品牌标记：一个直角转折的箭头——302 链在边缘拐个弯走完。
// 同一份几何用在顶栏和 favicon（favicon 多一块底色）。
const LOGO_PATH = `<path d="M5 8.5h10v9h3" fill="none" stroke="currentColor" stroke-width="4"/><path d="M18 11.6 27.6 17.5 18 23.4Z" fill="currentColor"/>`

function logoMark() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${LOGO_PATH}</svg>`
}

/** favicon 内联到页面里的 data URI（零外部请求，见文件头说明）。 */
function faviconHref() {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#2f6f9f'/><g fill='none' stroke='#fff'><path d='M5 8.5h10v9h3' stroke-width='4'/></g><path d='M18 11.6 27.6 17.5 18 23.4Z' fill='#fff'/></svg>`
  return (
    'data:image/svg+xml,' +
    svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22').replace(/ /g, '%20')
  )
}

/** Worker 直接返回的 favicon（/favicon.ico 分支用，和页面里那份是同一张图）。 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2f6f9f"/><path d="M5 8.5h10v9h3" fill="none" stroke="#fff" stroke-width="4"/><path d="M18 11.6 27.6 17.5 18 23.4Z" fill="#fff"/></svg>`

// 顶栏：标记 + 名字 + 仓库图标 + 主题按钮。两页共用。
// 仓库地址写死在这里，不做成环境变量：这个页面属于本项目，别人的 fork 要改，
// 改这一行就行；留一个 LANDING_LINK 只会让线上多一个「指向别处」的入口。
export const REPO_URL = 'https://github.com/geekMus/cf-gh-proxy'

// 版本号只在「页面右下角」露一次：它是元信息，不是身份，和顶栏的品牌不是一回事；
// 放顶栏会在 390px 上跟主题按钮抢位置。改版本时这里和 package.json 要一起改，
// 测试会核对两者一致（见 test/pages.test.js）。
export const VERSION = '1.2.12'

// 右下角那行小字。放在 .stage 之后：.stage 有 flex:1，于是它自然贴在视口底部，
// 右边缘与顶栏图标对齐，不占中间的操作区。
function renderVer() {
  return `<div class="ver" title="当前版本">v${VERSION}</div>`
}

const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'

function renderTop(home = '/') {
  return `<header class="top">
  <a class="home" href="${escapeHtml(home)}" title="回到首页"><span class="mark" aria-hidden="true">${logoMark()}</span><span class="brand">GitHub 文件加速</span></a>
  <span class="top-sp"></span>
  <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="打开项目仓库" title="项目仓库">${GITHUB_MARK}</a>
  <button id="theme" type="button" aria-label="切换主题（跟随系统 / 亮色 / 暗色）" title="切换主题">${THEME_ICONS}</button>
</header>`
}

/** 支持的路径表。错误页与首页共用，避免「首页说一套、错误页说另一套」。 */
function renderPathTable() {
  return `<div class="paths-h">
      <h3>可下载</h3>
    </div>
    <div class="path-grid">
      <div class="item"><span class="k">/owner/repo/releases/download/tag/file</span><span class="v">release 资产</span></div>
      <div class="item"><span class="k">/owner/repo/releases/latest/download/file</span><span class="v">最新版</span></div>
      <div class="item"><span class="k">/owner/repo/archive/refs/tags/tag.zip</span><span class="v">源码包</span></div>
      <div class="item"><span class="k">/owner/repo/raw/ref/path</span><span class="v">单文件</span></div>
      <div class="item"><span class="k">/owner/repo/blob/ref/path</span><span class="v">自动转 raw</span></div>
      <div class="item"><span class="k">raw.githubusercontent.com/owner/repo/ref/path</span><span class="v">raw 直链</span></div>
      <div class="item"><span class="k">gist.githubusercontent.com/user/id/raw</span><span class="v">Gist</span></div>
      <div class="item"><span class="k">api.github.com/repos/owner/repo/...</span><span class="v">GitHub API</span></div>
    </div>
    <p class="paths-foot">仓库首页、issues、settings、search 这类网页会被明确拒绝，不会把 HTML 当文件抓回来。</p>`
}

/**
 * 示例里「服务地址」那一截。
 *
 * 用调用方传进来的 origin——也就是这个 Worker 真实被访问的域名，
 * 而不是 `https://your-domain` 这种占位符：用户照抄示例时不用替换任何东西。
 * 只有拿不到 origin 时才退回占位（测试里直接调用 `renderErrorPage(cfg, reason)`）。
 *
 * 另一个关键细节：prefix 是 `/` 时必须补一个结尾斜杠，否则拼出来是
 * `https://gh.example.comhttps://github.com/...` —— 两个 URL 连成一片，
 * 用户会以为要这么写（实测第一版就是这样）。
 */
function exampleBaseOf(prefix, origin = '') {
  const base = origin || 'https://your-domain'
  return `${base}${prefix === '/' ? '/' : prefix}`
}

/** 首页那块真实界面：粘链接 → 问 ?check= → 跳转。整页只有这一件事。 */
function renderCore(prefix) {
  return `<div class="core">
      <h1 class="anim">GitHub 文件，一条更快的链接</h1>
      <p class="lede anim d1">把 release 资产、源码包或单个文件的地址丢进来，走这条链接直接下。</p>
      <div class="bar anim d2" data-ui>
        <div class="ui-field" id="field">
          <input type="text" id="q" placeholder="https://github.com/geekMus/cf-gh-proxy/blob/main/_worker.min.js" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip" aria-label="GitHub 链接">
          <button id="clear" type="button" aria-label="清空输入" tabindex="-1">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <button id="go" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
          加速
        </button>
      </div>
      <p class="ui-tip" id="tip" role="status" aria-live="polite"></p>
      <div class="ex anim d3" id="exs">
        <span class="lbl">试试</span>
        <button type="button" data-ex="https://github.com/geekMus/cf-gh-proxy/blob/main/_worker.min.js">本项目脚本</button>
        <button type="button" data-ex="https://github.com/geekMus/cf-gh-proxy/archive/refs/heads/main.zip">源码包</button>
        <button type="button" data-ex="https://github.com/geekMus/cf-gh-proxy/raw/main/_worker.min.js">raw 直链</button>
        <button id="copy" type="button" aria-label="复制示例">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
          复制示例
        </button>
      </div>
    </div>`
}

/**
 * 首页。
 *
 * 校验不在这里做：点「加速」后先问后端的 ?check= 接口，拿到和真实代理
 * 完全一致的判定（含同样的中文原因），再决定跳转还是就地报错。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 */
export function renderLanding(cfg, origin = '') {
  const prefix = cfg.prefix
  const prefixJson = jsonForScript(prefix)
  const canonical = origin ? `${origin}${prefix}` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="index,follow">
<meta name="description" content="把 GitHub 的 release 资产、源码包、raw 单文件链接换成自己的域名：字节从 Cloudflare 边缘直接给出，跟随 302、支持 Range 续传，单文件 Worker，零外部依赖。">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<title>GitHub 文件加速</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref()}">
<style>${CSS_MIN}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="shell">
  ${renderTop(prefix)}
  <main class="stage">
    ${renderCore(prefix)}
  </main>
  ${renderVer()}
</div>
<script>
${THEME_CYCLE}
(function(){
  var input=document.getElementById('q');
  var go=document.getElementById('go');
  var tip=document.getElementById('tip');
  var field=document.getElementById('field');
  var clearBtn=document.getElementById('clear');
  var exs=document.getElementById('exs');
  var copyBtn=document.getElementById('copy');
  var PREFIX=${prefixJson};

  function showTip(msg,openUrl){
    tip.textContent=msg;
    if(openUrl){
      // 兜底入口：用 <a target="_blank"> 而不是再 window.open——
      // 用户点链接本身就是手势，不会被弹窗拦截器拦掉。
      var a=document.createElement('a');
      a.href=openUrl; a.target='_blank'; a.rel='noopener noreferrer';
      a.textContent='点这里打开';
      tip.appendChild(document.createTextNode(' '));
      tip.appendChild(a);
    }
    tip.classList.add('show');
  }
  function hideTip(){ tip.classList.remove('show'); tip.textContent=''; }
  function syncClear(){
    if(input.value){ field.classList.add('has-value'); } else { field.classList.remove('has-value'); }
  }

  // 归一化：把用户输入整理成 https 形式。
  // 这里只做格式整理，不做合法性判定——判定一律交给后端 ?check=。
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

  // 点「加速」直接在**新标签页**里打开代理地址：一个标签页、一次导航，不再先
  // fetch 一次 ?check= 再去导航。那条路要多一个完整往返（实测 0.6 s）加一个空白页
  // 的等待，而校验要判断的东西后端在渲染这份响应时同样有——地址不是文件时，
  // 错误页会直接出现在这个标签页里，比先问一句再跳更省一次 RTT。
  function submit(){
    var raw=input.value||'';
    if(!raw.trim()){ showTip('先粘一个 GitHub 链接进来'); input.focus(); return; }
    var href=normalize(raw);
    if(!href){ showTip('只支持 http / https 链接'); input.focus(); return; }
    var target=location.origin+PREFIX+href;
    hideTip();

    var tab=null;
    try{ tab=window.open(target,'_blank'); }catch(e){ tab=null; }
    if(!tab){
      showTip('浏览器拦下了新标签页：允许本站弹窗后再点一次，或者', target);
      input.focus();
      return;
    }
    try{ tab.opener=null; }catch(e){}
  }

  go.addEventListener('click',submit);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  input.addEventListener('input',function(){ syncClear(); hideTip(); });
  clearBtn.addEventListener('click',function(){ input.value=''; syncClear(); hideTip(); input.focus(); });

  // 示例按钮：把地址填进输入框，让用户能立刻试一次，而不是先去找链接。
  exs.addEventListener('click',function(e){
    var b=e.target.closest('button[data-ex]');
    if(!b) return;
    input.value=b.getAttribute('data-ex');
    syncClear(); hideTip(); input.focus();
  });

  // 复制：有输入就复制输入，没有就复制第一个示例。
  // 优先 clipboard API，退回到 select + execCommand（http 下 clipboard 不可用）
  function copyText(text){
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(flash,fallback);
    } else { fallback(); }
    function fallback(){
      var t=document.createElement('textarea');
      t.value=text; t.style.position='fixed'; t.style.opacity='0';
      document.body.appendChild(t); t.select();
      try{ document.execCommand('copy'); flash(); }catch(e){}
      document.body.removeChild(t);
    }
    function flash(){
      copyBtn.setAttribute('data-done','1');
      setTimeout(function(){ copyBtn.removeAttribute('data-done'); },1400);
    }
  }
  copyBtn.addEventListener('click',function(){
    var v=(input.value||'').trim();
    copyText(v||'https://github.com/geekMus/cf-gh-proxy/blob/main/_worker.min.js');
    if(!v){ input.focus(); }
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
 * 为什么不直接返回一行纯文本：首页那个输入框会把任意输入拼成 URL，
 * 用户很容易粘错；给一页说明「错在哪、正确形态是什么」比一句 400 有用得多。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {string} reason 具体原因（由 validate.js 产出）
 * @param {string} [origin] 这个 Worker 真实被访问的地址（如 `https://gh.example.com`）。
 *   传了就把它拼进「正确形态」示例里，用户照抄即可；不传（测试）退回占位符。
 */
export function renderErrorPage(cfg, reason, origin = '') {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix, origin)
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
<link rel="icon" type="image/svg+xml" href="${faviconHref()}">
<style>${CSS_MIN}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="shell">
  ${renderTop(prefix)}

  <div class="err-hero">
    <h1>这个地址不是一个文件</h1>
    <p class="lede">请求被拦下了，没有去抓取任何内容。本服务只代理 GitHub 上可下载的资源，不代理网页。</p>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>具体原因</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="err-note">仓库首页、issues、settings、search 这类页面会被拒绝，不会把 HTML 当文件抓回来。</p>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>正确形态</h2><p>在链接前面加服务地址</p></div>
    <div class="paths">
      <div class="path-grid"><div class="item"><span class="k">${escapeHtml(ex)}</span></div></div>
      <p class="paths-foot">省略 <code>https://github.com/</code> 也行。</p>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>支持的路径</h2></div>
    <div class="paths">
      ${renderPathTable()}
    </div>
  </div>

  <p><a class="back" href="${escapeHtml(home)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8h-11M6.5 3.5 2 8l4.5 4.5"/></svg>回到首页重新输入</a></p>

  ${renderVer()}
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

/** 把值安全地放进 HTML 里的内联 JS（防 script 提前闭合、防引号）。 */
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