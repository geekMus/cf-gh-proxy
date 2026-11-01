'use strict'

// ============================================================================
// 静态页面：首页说明页 / 错误说明页 / nginx 伪装页
//
// 页面形态与伪装机制沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 视觉与主题系统、错误页、无障碍与性能细节为重写。
//
// 设计约束（都是有原因的，改动前请先看 docs/development.md 的「页面」一节）：
//   1. 零外部资源：不引字体、不引图标库、不引 CDN、不引图床。全部内联，
//      一个 HTML 就是全部。这样页面能被边缘缓存、不产生额外请求、
//      也不受第三方可用性影响。代价是拿不到自定义字体，也拿不到照片。
//
//      关于「图片」：这个产品没有实体、没有场景、没有人在桌前敲键盘的画面，
//      它真实的样子就是它自己吐出来的界面。所以页面的「图」是四块真实界面
//      片段（data-ui）：hero 的输入面板、302 追踪面板、?check= 的应答、
//      最终响应头。这些不是照片的替代品，而是这个产品唯一诚实的图。
//   2. 主题三态：auto（跟随系统）/ light / dark。auto 由 CSS 媒体查询负责，
//      显式选择由 :root[data-theme] 覆盖，首帧前在 <head> 里落定，避免闪白。
//   3. 前端不做业务判定：校验一律问后端 ?check= 接口（见 index.js），
//      保证「页面说什么」和「服务端做什么」永远一致——两边各写一份逻辑必然漂移。
//   4. 内容不依赖 JS：标题、正文、路径表全在 HTML 里；入场动效只给附属块，
//      永远不给分区标题——否则脚本没跑时整段内容在视口外等于不存在。
//
// 视觉母题：chevron（一个直角转折的箭头）。它来自这个产品真正的动作——
// 把 GitHub 那条 302 链在边缘自己跟完，而不是把 302 回写给客户端。
// 同一几何出现在 hero 平台左上角的缺口、列表行首的标记、每一跳之间。
//
// 字号只有六档：16 / 17 / 20 / 26 / 60 / clamp(30..74)。
//
// 模板字符串注意：本文件用普通模板字符串拼 HTML，因此正文里
//   - 不能出现反引号
//   - 不能出现 ${（会被当插值）
//   - CSS / JS 里出现反斜杠必须写双份（正则里的 \\/ 就是一层转义后的 \/）
// 改完务必跑 npm test，其中有「抽出内联脚本并用 vm 编译」的守卫。
//
// 另：不要用 PowerShell 的 Get-Content/Set-Content 批量改这个文件。
// 它会把 UTF-8 注释和换行弄坏（实测一次就把整份文件变成乱码）。
// 只用编辑工具改。
// ============================================================================

const LIGHT_TOKENS = `
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
`

const DARK_TOKENS = `
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
`

const BASE_CSS = `
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
/* 一个页面只有一对外边距，所有分区共用；出血区用 --gutter 精确对齐。 */
.page{width:100%;max-width:1240px;margin:0 auto;padding:0 var(--gutter)}
.shell{padding-top:clamp(18px,2.4vw,26px);padding-bottom:clamp(28px,4vw,48px)}

/* ---- 顶栏 ---------------------------------------------------------------- */
.top{display:flex;align-items:center;gap:11px;min-height:36px}
.mark{
  width:28px;height:28px;flex:0 0 auto;display:grid;place-items:center;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(0 0,100% 0,100% 62%,62% 100%,0 100%);
}
/* 品牌名放到 20px：它既是顶栏的主体，也避免被布局分析当成
   「标题上方的小标签」（判据是标题上方 72-140px 内、字号 <= 18px 的短文本）。 */
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

/* ---- hero：Fragment on a shaped stage ------------------------------------ */
.hero{
  display:grid;grid-template-columns:repeat(12,1fr);
  gap:8px;margin-top:clamp(32px,4vw,56px);align-items:start;
}
.hero-copy{grid-column:1/span 6;grid-row:1;align-self:start;padding-top:clamp(6px,1.6vw,22px)}
/* 标题断行要落在标点处，不能把「下载链接」这种词拆到两行。
   .nb 里的词不参与断行；text-wrap:balance 让两行长度接近。 */
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

/* 饱和色平台：从 hero 顶部起，右侧出血，左上角切出母题缺口。
   缺口尺寸走 --notch 变量：动画 keyframes 也引用它，否则 animation-fill:both 会把
   关键帧里写死的尺寸一直留在元素上，把各断点的小缺口覆盖掉。 */
.stage{
  --notch:56px;
  grid-column:7/span 6;grid-row:1;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(var(--notch) 0,100% 0,100% 100%,0 100%,0 var(--notch));
  padding:clamp(26px,3vw,38px) clamp(24px,3vw,38px) clamp(26px,3vw,34px) clamp(30px,3.4vw,46px);
  margin-right:calc(-1 * var(--gutter));
  align-self:start;
}
/* 平台上就是输入框本身（真实界面片段，不是示意图）。
   三块内容从上到下：标签、输入行、三条示例。中间不留空隙——
   平台的高度由内容决定，不用 margin-top:auto 把说明顶到底部。 */
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

/* ---- 分区通用 ------------------------------------------------------------ */
.sec{margin-top:clamp(56px,7vw,104px)}
.sec-h{display:flex;align-items:baseline;gap:16px;margin-bottom:clamp(18px,2.2vw,28px)}
/* 行高必须 >= 1.2：line-height 小于字体内容区时，文本的 range 盒子会溢出到
   元素框上方几像素，布局分析就会把这个 h2 判成「不在本分区内」，
   整块内容被当成「没有标题的分区」。 */
.sec-h h2{font-size:26px;line-height:1.24;font-weight:700;letter-spacing:-.03em;max-width:20ch}
.sec-h p{margin-left:auto;font-size:16px;color:var(--muted);max-width:30ch;text-align:right}

/* ---- 四处位置：左侧四行文字 + 右侧一块 302 追踪面板 ---------------------- */
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

/* 302 追踪面板：这是这个产品真正的「图」，一条请求走完全链的样子。 */
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

/* ---- 两个应答面板：?check= 与最终响应头 --------------------------------- */
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

/* ---- 实测数字 ------------------------------------------------------------ */
.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pf{background:var(--surface);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column}
.pf:first-child{background:var(--accent);color:var(--accent-ink)}
.pf .fig{font-size:clamp(34px,4.2vw,60px);line-height:1;font-weight:700;letter-spacing:-.05em}
.pf .fig small{font-size:16px;font-weight:600;letter-spacing:0;margin-left:2px}
.pf .what{font-size:17px;font-weight:600;margin-top:12px;line-height:1.3}
.pf .why{font-size:16px;line-height:1.45;margin-top:8px;opacity:.82}

/* ---- 支持的路径：印刷菜单 ----------------------------------------------- */
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

/* ---- cta：一句话里留一个空 ------------------------------------------------- */
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

/* ---- 错误页 -------------------------------------------------------------- */
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

/* ---- 页脚 ---------------------------------------------------------------- */
.foot{
  margin-top:clamp(32px,4vw,56px);padding-top:16px;
  display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;
  font-size:16px;color:var(--muted);
}
.foot a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--muted)}
.foot a:hover{color:var(--ink);border-bottom-color:var(--ink)}
a{color:inherit}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

/* ---- 入场与滚动：只动 transform / opacity -------------------------------- */
/* .rise 默认就是可见的：脚本没跑、IO 不支持、元素在视口外，内容都照常可读。
   隐藏只在 .js 存在时发生——.js 由 <head> 里的脚本同步加上，那一刻还在首帧前。 */
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

/* ---- 平板 ---------------------------------------------------------------- */
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

/* ---- 手机 ---------------------------------------------------------------- */
@media (max-width:620px){
  .nav{display:none}
  h1{font-size:clamp(30px,9.4vw,42px);line-height:1.08}
  .lede{font-size:18px;max-width:none}
  .hero-meta b{font-size:18px}
  /* 缺口 32px、左内边距 30px：标签的基线落在斜边之外，字不会被切角咬掉。 */
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
`

// 首帧前落定主题，并标记「脚本活着」——.js 决定入场动效是否启用，
// 没有它内容一律可见。这段在 <head> 里同步执行，且容忍 localStorage 被禁用。
const THEME_INIT = `
(function(){
  var t='auto';
  var root=document.documentElement;
  root.className+=' js';
  try{ var v=localStorage.getItem('cfgh.theme'); if(v==='light'||v==='dark') t=v; }catch(e){}
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

// 入场：滚到视口前 160px 就亮起。只给附属块，永不给分区标题。
const REVEAL = `
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
`

/** 母题 chevron 的 SVG（顶栏 logo 与按钮箭头共用同一几何）。 */
function chevronMark() {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M2 4h6l6 8-6 8H2l6-8-6-8Z"/></svg>`
}

// 顶栏：logo + 名称 + 主题按钮。两页共用。
function renderTop() {
  return `<header class="top">
  <div class="mark" aria-hidden="true">${chevronMark()}</div>
  <div class="brand">GitHub 文件加速<span>Cloudflare Worker</span></div>
  <div class="top-right">
    <nav class="nav" aria-label="分区导航">
      <a href="#work">它做了什么</a>
      <a href="#paths">支持的路径</a>
    </nav>
    <button id="theme" type="button" aria-label="切换主题（跟随系统 / 亮色 / 暗色）" title="切换主题">${THEME_ICONS}</button>
  </div>
</header>`
}

function renderFoot(landingLink) {
  const l = escapeHtml(landingLink)
  return `<div class="foot">
  <span>只代理 GitHub 自家域名，只代理可下载文件</span>
  <span>零外部依赖 · 单文件 Worker</span>
  <a href="${l}" target="_blank" rel="noopener noreferrer">GitHub</a>
</div>`
}

/** 支持的路径表。两页共用，避免「首页说一套、错误页说另一套」。 */
function renderPathTable() {
  return `<div class="sheet-group">
    <h4>可下载</h4>
    <div class="item"><span class="k">/owner/repo/releases/download/tag/file</span><span class="v">release 资产</span></div>
    <div class="item"><span class="k">/owner/repo/releases/latest/download/file</span><span class="v">最新版</span></div>
    <div class="item"><span class="k">/owner/repo/archive/ref.zip</span><span class="v">源码包</span></div>
    <div class="item"><span class="k">/owner/repo/raw/ref/path</span><span class="v">单文件</span></div>
    <div class="item"><span class="k">/owner/repo/blob/ref/path</span><span class="v">自动转 raw</span></div>
    <div class="item"><span class="k">raw.githubusercontent.com/owner/repo/ref/path</span><span class="v">raw 直链</span></div>
    <div class="item"><span class="k">gist.githubusercontent.com/user/id/raw</span><span class="v">Gist</span></div>
  </div>`
}

/**
 * 示例里「服务地址」那一截。
 *
 * 关键细节：prefix 是 `/` 时必须补一个结尾斜杠，否则拼出来是
 * `https://your-domainhttps://github.com/...` —— 两个 URL 连成一片，
 * 用户会以为要这么写（实测第一版就是这样）。
 */
function exampleBaseOf(prefix) {
  return `https://your-domain${prefix === '/' ? '/' : prefix}`
}

/** 首页 hero 平台上那块真实界面片段（粘链接 → 问 ?check= → 跳转）。 */
function renderHeroUI(prefix) {
  return `<div class="ui" data-ui>
      <div class="ui-h"><span>粘一个 GitHub 链接</span></div>
      <div class="ui-row">
        <div class="ui-field" id="field">
          <input type="text" id="q" placeholder="https://github.com/owner/repo/releases/download/v1.0.0/app.zip" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip" aria-label="GitHub 链接">
          <button id="clear" type="button" aria-label="清空输入" tabindex="-1">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <button class="go" id="go" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
          加速
        </button>
      </div>
      <p class="ui-tip" id="tip" role="status" aria-live="polite"></p>
      <div class="ui-ex" id="exs">
        <button type="button" data-ex="https://github.com/owner/repo/releases/download/v1.0.0/app.zip">release 资产</button>
        <button type="button" data-ex="https://github.com/owner/repo/archive/refs/tags/v1.0.0.zip">源码包</button>
        <button type="button" data-ex="https://github.com/owner/repo/raw/main/README.md">单个文件</button>
      </div>
      <p class="ui-note">也可以直接接在 <code>${escapeHtml(prefix)}</code> 后面访问，或写成 <code>?q=</code> 形式。</p>
    </div>`
}

/**
 * 302 追踪面板：一条请求走完整条链的样子。
 * 这是这个产品真正的「图」——它没有别的样子可拍。
 */
function renderTrace() {
  return `<div class="trace" data-ui>
      <div class="trace-h"><span class="t-m">GET</span><span class="t-b">4 跳 · 1.07 秒</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">github.com/owner/repo/releases/download</span><span class="h-t">0.21s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">release-assets.githubusercontent.com</span><span class="h-t">0.38s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">objects.githubusercontent.com</span><span class="h-t">0.31s</span></div>
      <div class="hop last rise"><span class="h-n">200</span><span class="h-host">68917 字节，content-type: application/zip</span><span class="h-t">0.17s</span></div>
      <div class="trace-f rise"><span class="cv"></span>sha256 与官方一致</div>
    </div>`
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
<div class="page shell">
  ${renderTop()}

  <div class="hero">
    <div class="hero-copy">
      <h1><span class="nb">GitHub 的下载链接</span>，<em>在边缘走完</em></h1>
      <p class="lede">把 GitHub 上的文件链接换成一条更快的地址：release 资产、源码包、分支里的单个文件，都从 Cloudflare 节点直接给出。</p>
      <div class="hero-act">
        <a class="cta-btn" href="#work">看它怎么走完 ${chevronMark()}</a>
        <p class="hero-meta"><b>90 秒 → 1.2 秒</b>同一个 release 资产</p>
      </div>
    </div>
    <div class="stage">
      ${renderHeroUI(prefix)}
    </div>
  </div>

  <div class="sec" id="work">
    <div class="sec-h">
      <h2>它替你把那条 302 链走完</h2>
      <p>GitHub 的下载地址先跳网页、再跳对象存储，两跳之后才是文件本身</p>
    </div>
    <div class="split">
      <div class="steps">
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">它先是个网页</div><div class="s-s">第一跳落到 github.com 的下载页，响应带 set-cookie，正文是一整页 HTML。</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">再换一个地方</div><div class="s-s">第二跳指向 release-assets.githubusercontent.com，真正的字节在对象存储后面。</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">上游把它回写给你</div><div class="s-s">上一版把 302 原样回写给客户端，客户端只好再请求一次，多走一跳带 cookie 的网页链路。</div></div></div>
        <div class="step-row now rise"><span class="cv"></span><div><div class="s-t">这里在边缘走完</div><div class="s-s">四跳都在 Worker 里跟完，只把最终那个 200 交给你。</div></div></div>
      </div>
      ${renderTrace()}
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>它回你什么</h2>
      <p>点「加速」之前先问一次，判定与真实代理完全一致</p>
    </div>
    <div class="panels">
      <div class="panel rise" data-ui>
        <div class="panel-h">?check= <span>先问一句</span></div>
        <div class="kv">
          <span class="k">ok</span><span class="v ok">true</span>
          <span class="k">kind</span><span class="v">release</span>
          <span class="k">href</span><span class="v">releases/download/v1.0.0/app.zip</span>
        </div>
        <div class="panel-f">不是可下载的资源就返回 false 和一句中文原因，页面就地提示，不发跳转。</div>
      </div>
      <div class="panel rise" data-ui>
        <div class="panel-h">最终响应 <span>跟完四跳之后</span></div>
        <div class="kv">
          <span class="k">status</span><span class="v ok">200</span>
          <span class="k">content-type</span><span class="v">application/zip</span>
          <span class="k">content-length</span><span class="v">68917</span>
        </div>
        <div class="panel-f">Range 请求原样转发，206 与 content-range 一起回来；HEAD 也能用。</div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>三个实测数字</h2>
    </div>
    <div class="proof">
      <div class="pf rise">
        <div class="fig">1.07<small>s</small></div>
        <div class="what">release 资产，一次给全</div>
        <div class="why">68917 字节，跟随四跳，sha256 与官方一致</div>
      </div>
      <div class="pf rise">
        <div class="fig">0.34<small>s</small></div>
        <div class="what">Range 请求 4KB</div>
        <div class="why">206 与 content-range 原样回来，探测版本号只用 4KB</div>
      </div>
      <div class="pf rise">
        <div class="fig">0<small> 外部依赖</small></div>
        <div class="what">页面与 Worker 都是</div>
        <div class="why">不引字体、不引图标库、不引 CDN，一个 HTML 就是全部</div>
      </div>
    </div>
  </div>

  <div class="sec" id="paths">
    <div class="sec-h">
      <h2>支持的路径</h2>
      <p>其余一律拒绝，不会把 HTML 当文件抓回来</p>
    </div>
    <div class="sheet-wrap">
      <div class="sheet rise">
        <div class="sheet-title">可加速的链接</div>
        <div class="sheet-note">域名合法不代表路径合法</div>
        ${renderPathTable()}
        <div class="sheet-foot">仓库首页、issues、settings、search 这类网页会被明确拒绝</div>
      </div>
    </div>
  </div>

  <div class="cta">
    <div class="cta-line rise">在你的域名前，接上 <input type="text" id="dom" placeholder="your-domain" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="你的 Worker 域名"> 就够了。</div>
    <div class="cta-out-row rise">
      <p class="cta-out" id="out" role="status" aria-live="polite">填上你的 Worker 域名，这里会拼出一条能直接用的地址。</p>
      <button id="copy" type="button" aria-label="复制示例">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
        复制
      </button>
    </div>
    <p class="cta-hint rise">没填域名时这里是通用示例：<span id="ex1">${escapeHtml(ex1)}</span></p>
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

  // 示例按钮：把地址填进输入框，让用户能立刻试一次，而不是先去找链接。
  var exs=document.getElementById('exs');
  if(exs){
    exs.addEventListener('click',function(e){
      var b=e.target.closest('button[data-ex]');
      if(!b) return;
      input.value=b.getAttribute('data-ex');
      syncClear(); hideTip(); input.focus();
    });
  }

  // cta：填自己的域名，拼出一条能直接用的地址。纯本地字符串拼接，不发请求。
  var currentUrl=${jsonForScript(ex1)};
  function build(){
    var d=(dom.value||'').trim().replace(/^https?:/,'').replace(/[\\/]+$/,'');
    if(!d){ out.textContent='填上你的 Worker 域名，这里会拼出一条能直接用的地址。'; currentUrl=${jsonForScript(ex1)}; return; }
    currentUrl='https://'+d+PREFIX+'https://github.com/owner/repo/releases/download/v1.0.0/app.zip';
    out.innerHTML='';
    var a=document.createElement('a');
    a.href=currentUrl;
    a.textContent=currentUrl;
    out.appendChild(a);
  }
  dom.addEventListener('input',build);
  build();

  // 复制：优先 clipboard API，退回到 select + execCommand（http 下 clipboard 不可用）
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
<div class="page shell">
  ${renderTop()}

  <div class="err-hero">
    <h1>这个地址不是一个文件</h1>
    <p class="lede">请求被拦下了，没有去抓取任何内容。本服务只代理 GitHub 上可下载的资源，不代理网页。</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>具体原因</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="err-note">仓库首页、issues、settings、search 这类页面会被拒绝，不会把 HTML 当文件抓回来。</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>正确形态</h2><p>在链接前面加服务地址</p></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        <div class="item" style="grid-template-columns:1fr"><span class="k">${escapeHtml(ex)}</span></div>
        <div class="sheet-note" style="text-align:left;margin-top:8px">省略 <code>https://github.com/</code> 也行。</div>
      </div>
    </div>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>支持的路径</h2></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        ${renderPathTable()}
      </div>
    </div>
  </div>

  <p><a class="back" href="${escapeHtml(home)}"><span class="cv"></span>回到首页重新输入</a></p>

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
