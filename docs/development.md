# 开发

改了代码怎么验证、构建产物怎么来的、页面怎么做的、目录结构怎么组织。只想部署的话不需要看这份。

## 开发

```bash
npm test                # 102 个单元测试，纯桩无网络
npm run check           # 语法检查（六个模块逐个 node --check）
npm run build           # 构建两个产物：_worker.min.js + _worker.js
npm run test:build      # 验证两个产物与源码行为一致（40 项断言）
npm run bench           # 两个产物的性能基准（冷启动 / 吞吐 / 体积）
npm run verify          # 全套：语法 + 单测 + 构建 + 等价性
node scripts/live-check.mjs   # 真机联调（需联网，31 项断言）
node scripts/check-disguise.mjs  # 伪装页三变量组合（12 项断言）
node scripts/check-workflow.cjs  # 校验 CI 配置本身（40 项断言）
npx wrangler tail       # 看线上实时日志
```

单元测试覆盖：配置解析、上游兼容变量、URL 构建（三种输入形态）、白名单、**路径形态校验（只代理文件、不代理网页）**、**`/blob/` 改写成 raw**、响应头清洗、缓存头、**重定向跟随（本次改造的核心）**、jsDelivr 改写、**首页与错误页（内联脚本可编译、零外部资源、主题三态、`?check=` 与真实代理判定一致、异常兜底不产生 1101）**。

`npm run test:build` 做的事：同一组请求分别打到 `src/index.js` 和两个产物，逐项比对状态码、响应头、正文 sha256。构建产物和源码行为不一致时它会失败——这是「单文件分发」的安全网。

## 两个构建产物

| 产物 | 给谁 | 特点 |
|---|---|---|
| `_worker.min.js` | **部署用这个** | esbuild 压缩：去空白换行、缩短标识符、中文不转义。41.7 KB（gzip 14.9 KB） |
| `_worker.js` | 给人看的 | 六个模块按依赖顺序拼接，**注释一行不丢**。81.6 KB（gzip 29.8 KB）。也能直接跑 |

两个都是单文件 ESM：零 import、零 require、保留 `export default { fetch }`。

**两个版本是怎么产出的（不一样，别以为是同一套流程跑两遍）**：

- **压缩版**走 esbuild（`minify: true`、`charset: 'utf8'`）。`charset` 是关键：esbuild 默认 `'ascii'`，会把每个汉字转义成 `\uXXXX`，3 字节变 6 字节。本项目界面文案与错误原因全是中文，实测转义让压缩版白白多出 3.2 KB（41,142 → 37,860 字节，未含版本横幅）。改 `utf8` 只改文件编码，不改行为。
- **源码版不走 esbuild**。esbuild 即使 `minify: false` 也会把 `//` 注释全部剥掉（只有 `legalComments` 管法务注释），那样产出的「源码版」只剩代码骨架——对「方便用户自己看」这个目的等于没有。所以源码版由 `buildSource()` 按拓扑序拼接 `config → validate → proxy → upstream → pages → index`：只删 `import` 行、把 `export function` 还原成 `function`，其余原样保留。六个模块已核查**无同名顶层声明**，拼接安全。
  - 拼接后立刻**逐行**核对注释完整性，判据是精确相等而不是「不少于」：源文件的 243 行 `//` 加上六个模块的 18 行分隔头，产物必须正好 261 行；块注释 57 个（含顶部横幅）。再用行集合比对一遍，确保每条源注释都原样出现。之所以不能写 `产物 >= 源文件`——那 18 行分隔头会把最多 18 行丢失抵消掉，检查看着通过、注释其实少了。任何一处不符脚本直接 `exit 1`。
  - 行为等价由 `npm run test:build` 兜底：同一组 12 个请求分别打 `src/index.js` 和两个产物，逐项比对状态码 / 头 / 正文 sha256。

**为什么不做混淆**：混淆会引入字符串数组查表和控制流间接，那是真正的性能损失。`npm run bench` 用「成对交替 + 中位数」测稳态每请求耗时：`fetch` 先打桩（留作保险——Worker 现在整站零外部请求，桩命中应为 0；早先 `/favicon.ico` 会去 `github.githubassets.com` 取图，不桩的话每请求测到的是 16 ms 网络往返，执行差异整个被淹掉），两个产物背靠背各跑一遍取比值，再对所有比值取中位数（串联测会把机器负载漂移算成两边的差别）。多轮实测中位比值在 0.97–1.09 之间摆动（−0.9%、+0.5%、+6.3% 都出现过，快慢两个方向都有），单组比值的四分位宽度还有 10%–30%，这一点中位差就是噪声。所以判据不是「中位差 <5%」一条，而是**中位差 >5% 且下四分位也 >1** 才算稳定回退——四分位横跨 1 就说明两边都赢过，方向不固定。压缩只用来减小体积——gzip 后 14.9 KB vs 29.8 KB，上传更快、解析更省，执行逻辑不动。

## 本地预览

```bash
node scripts/preview.mjs            # 预览 src/index.js（源码；启动时 import 一次，改完要重启进程）
node scripts/preview.mjs --built    # 预览 _worker.min.js（真正要部署的那份字节）
PORT=8801 node scripts/preview.mjs  # 换端口
```

`scripts/preview.mjs` 把 Node 的 http 请求包成 Workers 的 `Request` 交给真实的 `worker.fetch`，所以浏览器里跑的是**线上会跑的那份代码**，不是静态 HTML。改完 `src/` 不用先 `npm run build`，也不会出现「预览的是旧产物」这种假象。

> 两个踩过的坑：`new URL('D:/...')` 在 Windows 上会把盘符当协议（`ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`），必须用 `pathToFileURL`；`'../src/index.js'` 从仓库根解析会跑到仓库外（`ERR_MODULE_NOT_FOUND`），路径要用 `resolve(ROOT, ...)` 拼。

## 页面

首页和错误页都是**单文件内联**的，不引任何外部字体、图标库或 CDN。首页只占**一屏**，不滚动：标题一句话、下面一条输入栏，仓库入口是右上角一个 GitHub 图标（点进本仓库），页面底部不放任何东西。

| 特性 | 做法 |
|---|---|
| 一屏之内 | `.shell{min-height:100svh}` 的纵向 flex，中间 `.stage` 吃掉剩余高度并居中；1440×900 与 390×844 都是恰好一屏，不出滚动条 |
| 输入栏 | 一条 `.bar`：白底 + 1px inset 描边，`#go` 按钮嵌在右端 6px 处，聚焦时整条换成 2px 强调色。描边用 `box-shadow:inset` 不用 `border`——边框占宽度，换色时整行会跳 |
| 亮色 / 暗色 / 跟随系统 | `data-theme="auto"` 默认；`prefers-color-scheme` 负责跟随系统，`:root[data-theme=dark]` 负责显式选择 |
| 不闪白 | 主题在 `<head>` 里同步落定（读 `localStorage('cfgh.theme')` 后立刻 `setAttribute`），不等 DOM 解析完 |
| 不跑 JS 也不错乱 | 主题按钮的图标与文字由 CSS 按 `:root[data-theme]` 选择，JS 失效时仍显示正确状态 |
| 体积 | 首页 20.8 KB，gzip 后 7.1 KB（`_worker.min.js` 整体 gzip 14.9 KB） |
| 仓库入口 | 右上角一枚 GitHub 图标（桌面端 40×40、640px 以下 36×36，与主题按钮同高、同描边），地址**写死**在 `src/pages.js` 的 `REPO_URL`，不做成环境变量；页面底部不放任何东西，所以全页外链只有这一个 |
| 图标 | 顶栏 logo 与 favicon 由同一段几何生成：页面 favicon 走 `faviconHref()` 的 data URI，`/favicon.ico` 走 `FAVICON_SVG`，都不发外部请求 |
| 背景 | 网格是两层 SVG `data:` 拼的（32px 细线 + 128px 主线），不用 CSS 渐变 |
| 无障碍 | `:focus-visible` 统一轮廓、`#tip` 带 `role="status" aria-live="polite"`、`prefers-reduced-motion` 关动效 |
| 响应式 | `clamp()` 字号与内边距；640px 以下输入栏改成上下两行、按钮通栏 |
| 可被抓取 | `<meta name="robots" content="index,follow">`、`<meta name="description">`、带 origin 时输出 `<link rel="canonical">`；`/robots.txt` 由 Worker 直接回 `Allow: /`（否则它会被当成资源路径走代理校验，抓取方看到的是「拒绝抓取」）。错误页仍是 `noindex`——报错页没有索引价值 |
| 快 | 首页带 `cache-control: public, max-age=300, s-maxage=3600`，并写进 Cache API：第一个访客之后，同一个 PoP 的后续请求直接命中边缘，不用每条 HTML 都跑一遍 Worker |
| 安全头 | 自己的页面带 `nosniff`、`X-Frame-Options: DENY`、`COOP: same-origin`、`Referrer-Policy`、`Permissions-Policy`、HSTS；代理回来的文件**不加**——那是用户要下载的东西，不该被页面语义改写 |

**前端不做业务判定。** 点「加速」时先请求 `?check=<url>`，由后端 `validate.js` 给出判定（含同样的中文原因），前端只负责展示。判定通过后**在新标签页打开**：`window.open` 必须落在用户手势的同一个同步帧里（`fetch` 之后再开会被浏览器当弹窗拦掉），所以点击时先开一个 `about:blank` 占位，校验回来再导航过去；校验没过就把空白页关掉，用户看不到闪烁。弹窗被浏览器拦下时不会死路一条：提示里给出一个真的 `<a target="_blank">` 兜底链接（用户点链接本身就是手势，不会被拦截器挡）。上一版前端自带一份规则，与后端漂移后出现「前端放行、后端 400」的不一致——现在只有一份规则。

**视觉方向**（为什么长这样、哪些地方主动降级了）记在 [`.taste-skill/notes.md`](../.taste-skill/notes.md)。几个硬约束决定了它长不成通用落地页：

1. **零外部资源**——不引字体、不引图床、不引 CDN。`test/pages.test.js` 有断言：首页 `src=`/`href=` 里不许出现外部地址。理由是一个 HTML 就是全部、能被边缘缓存、不产生额外请求、不受第三方可用性影响。代价是**外部字体一律不引**，正文用系统字体栈（`-apple-system` 这一串），不做 webfont 排版。
2. **零外部图片、也不放界面截图**——这一屏只做一件事：给输入框。把 302 追踪图、路径表这类「讲原理」的内容搬上来会把一屏撑成三屏，也不符合「用户只需要知道粘链接就能下」。
3. **正文 ≥13px、字号档位 ≤5 档**——现在只有四档：13 / 15 / 16 / 32（标题用 `clamp()` 在 24–32px 之间缩放，手机 21–26px）。
4. **图标不能借现成的**——GitHub 图标、图标库都不合适（前者是别人的标识，后者要引外部资源）。所以自己画：一枚直角转折箭头，正好是「302 链在边缘拐个弯走完」这个动作，16px 下是一块实心图形，不会糊。
5. **动效只做入场**——`.anim` 让标题、说明、输入栏、示例行按 50ms 递进浮入；`prefers-reduced-motion` 直接关掉。这一屏没有滚动，也就没有滚动触发的动画。

### Range 与压缩：一个差点写坏文件的坑

线上实测发现的真问题（当时那一版是 37913 字节的 raw 文本）：直连 `raw.githubusercontent.com` 回 `Content-Range: bytes 0-99/37913`，经 Worker 却回 `bytes 0-99/13173`——13173 是**压缩后表示**的长度，正文是 br 流的前 100 字节。断点续传会把这些碎片拼进文件，得到一份 sha256 对不上的坏文件。

根因不在我们的代码：Cloudflare 的 subrequest 由平台决定压缩协商，上游于是按压缩表示切字节。Worker 侧既改不了协商（v1.2.3 显式发 `Accept-Encoding: identity`，线上实测仍协商 br），也看不到 `content-encoding`（被边缘抹掉）。

现在的处理（`src/index.js` 的 `handleProxy()`）：

| 信号 | 处理 |
|---|---|
| 带 `Range`，且上游回 `content-encoding`，或 ETag 是弱标记 `W/` | 认定 206 落在压缩表示上：`res.body.cancel()`，删掉 `Range` 重取全量，回 **200 + 整个文件** |
| 带 `Range`，上游是原始字节（zip/exe 这类，强 ETag） | 原样透传 **206**，`Content-Range` / `Content-Length` 都对 |
| 上游没按 `Range` 回 206（忽略 `Range` 直接 200，或 416），或请求本身就带 body | 不做重取——前者重取等于白下一遍整包，后者 body 是流、第二次 fetch 用不了 |

**206 不进公共缓存**：缓存键里没有 `Range`，一副片段不能被当成整个文件的表示。所以 206 一律 `cache-control: no-store` + `vary: Range`，并且不写 `cdn-cache-control`；只有完整的 200 才按 `pickCacheTtl()` 加 TTL（`ALLOW_AUTH=1` 且请求带 `Authorization`/`Cookie` 时也回 `no-store`，共享缓存不能把 A 的授权内容发给 B）。

代价说清楚：**文本文件的断点续传被主动放弃了**——`-r 200-999` 会拿到整个文件（多下几 KB，但字节一定对），二进制资产照旧 206。宁可多传，也不交回一份拼得起来的坏文件。线上验证：raw 文本 `-r 0-99` → 200 + 全文；electron 的 115 MB zip `-r 5000000-` → 206。

### 为什么不会轻易出现 1101

`fetch` 外面套了一层 `try/catch`，任何未预期异常都会变成 **500 + 「内部错误：请求处理失败，详情见 Worker 日志」**，而不是 Cloudflare 的 1101 空白页（1101 只在日志里留线索，用户看到的是白屏）。异常细节只写 `console.error`，不回显给客户端——原样回显 `err.message` 会把内部 URL 和解析细节漏出去，而那些对使用者没有帮助。`test/pages.test.js` 里用 `new Proxy({}, {get(){throw}})` 强制让配置解析抛异常来验证这条兜底，另外还覆盖了 `/%zz`、`/../../etc/passwd`、2000 个字符的路径、`%00` 等畸形输入，以及 HEAD/POST/PUT/DELETE/PATCH/OPTIONS 各方法——都不许抛。

`/favicon.ico` 是零外部请求的最后一块拼图：图标由 `pages.js` 的 `FAVICON_SVG` 内联给出，Worker 直接回 `image/svg+xml`、缓存一天，一个字节都不去外站取。早先这里要去 GitHub 的静态资源取图，天然没有兜底——网络抖动就会抛成 500。图标丢了不算错误，绝不能因此把请求打成 500；现在连失败面都没有了（本地常量，不依赖任何网络），这条原则仍由 `fetch` 外层的 `try/catch` 兜着。

### 构建产物是自动提交的

`.github/workflows/build-worker.yml` 在 `src/`、`scripts/build.mjs`、`package.json`、`package-lock.json` 以及它自己变更时触发：

1. 装依赖 → 语法与行尾检查 → 构建 → 产物形态检查（两个产物各查一遍：无 import、无 sourcemap、有 export、有归属声明）→ 与源码行为比对
2. 额外断言**压缩版必须真的比源码版小**，否则说明 `--min` 没生效
3. 产物若与仓库里的不同，就以 `github-actions[bot]` 身份提交回 `main`，提交信息带 `[skip build]`

所以**改完 `src/` 不用记得手动 `npm run build` 再提交**，CI 会补上。想本地先看效果，跑一下 `npm run build` 就行。

`_worker.js` 与 `_worker.min.js` 都不在 workflow 的 `paths` 里，回填提交不会再次触发构建，不会形成循环。

## 目录结构

```
_worker.min.js          ← 构建产物：压缩版，部署用（CI 自动更新）
_worker.js              ← 构建产物：源码版，给人看（CI 自动更新）
src/
  index.js              # Worker 入口：路由分发
  config.js             # env → cfg 归一化
  proxy.js              # 目标 URL 构建 / 白名单 / 响应头清洗 / 缓存头
  validate.js           # 路径形态校验（只代理文件、不代理网页）
  upstream.js           # 上游请求：自己跟随重定向 + 超时
  pages.js              # 说明页 / 错误页 / nginx 伪装页
test/
  unit.test.js             # 配置、URL、白名单、响应头
  validate.test.js         # 路径形态校验（21 项，锁死「不代理网页」）
  redirect.test.js         # 重定向跟随（核心）
  blob-rewrite.test.js     # /blob/ 改写成 raw
  jsdelivr.test.js         # jsDelivr 改写
  compat-upstream.test.js  # 上游 URL / URL302 兼容
  pages.test.js            # 首页与错误页（内联脚本可编译、零外部资源、异常兜底）
scripts/
  build.mjs               # 打包成两个单文件产物
  check-build.mjs         # 验证两个产物与源码行为一致（40 项）
  check-workflow.cjs      # 校验工作流配置本身（40 项）
  check-disguise.mjs      # 伪装页三变量组合（12 项）
  live-check.mjs          # 真机联调（需联网，31 项）
  bench.mjs               # 两个产物的性能基准
  preview.mjs             # 本地预览（把 Node 请求交给真实 worker.fetch）
.github/workflows/
  build-worker.yml        # src 变更时自动构建并回填两个产物
README.md                 # 项目说明：部署入口、用法、配置表
docs/                     # 详细文档：部署、支持路径、工作原理、开发、血统
LICENSE                   # MIT
package.json              # npm 脚本 + Dashboard 里的变量说明
package-lock.json         # CI 用 npm ci，锁死依赖树
.dev.vars.example         # 本地开发的环境变量样例（复制成 .dev.vars）
.gitignore
.taste-skill/             # 首页视觉方向的记录（git 只跟踪 notes.md 与 direction.json）
wrangler.toml
.gitattributes            # 强制 LF（Windows autocrlf 会污染，CI 有断言）
```

---

返回 [README](../README.md)。
