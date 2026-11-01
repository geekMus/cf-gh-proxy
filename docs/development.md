# 开发

改了代码怎么验证、构建产物怎么来的、页面怎么做的、目录结构怎么组织。只想部署的话不需要看这份。

## 开发

```bash
npm test                # 93 个单元测试，纯桩无网络
npm run check           # 语法检查（六个模块逐个 node --check）
npm run build           # 构建两个产物：_worker.min.js + _worker.js
npm run test:build      # 验证两个产物与源码行为一致（40 项断言）
npm run bench           # 两个产物的性能基准（冷启动 / 吞吐 / 体积）
npm run verify          # 全套：语法 + 单测 + 构建 + 等价性
node scripts/live-check.mjs   # 真机联调（需联网，32 项断言）
node scripts/check-disguise.mjs  # 伪装页三变量组合（12 项断言）
node scripts/check-workflow.cjs  # 校验 CI 配置本身（40 项断言）
npx wrangler tail       # 看线上实时日志
```

单元测试覆盖：配置解析、上游兼容变量、URL 构建（三种输入形态）、白名单、**路径形态校验（只代理文件、不代理网页）**、**`/blob/` 改写成 raw**、响应头清洗、缓存头、**重定向跟随（本次改造的核心）**、jsDelivr 改写、**首页与错误页（内联脚本可编译、零外部资源、主题三态、`?check=` 与真实代理判定一致、异常兜底不产生 1101）**。

`npm run test:build` 做的事：同一组请求分别打到 `src/index.js` 和两个产物，逐项比对状态码、响应头、正文 sha256。构建产物和源码行为不一致时它会失败——这是「单文件分发」的安全网。

## 两个构建产物

| 产物 | 给谁 | 特点 |
|---|---|---|
| `_worker.min.js` | **部署用这个** | esbuild 压缩：去空白换行、缩短标识符、中文不转义。51 KB（gzip 17 KB） |
| `_worker.js` | 给人看的 | 六个模块按依赖顺序拼接，**注释一行不丢**。84 KB（gzip 28 KB）。也能直接跑 |

两个都是单文件 ESM：零 import、零 require、保留 `export default { fetch }`。

**两个版本是怎么产出的（不一样，别以为是同一套流程跑两遍）**：

- **压缩版**走 esbuild（`minify: true`、`charset: 'utf8'`）。`charset` 是关键：esbuild 默认 `'ascii'`，会把每个汉字转义成 `\uXXXX`，3 字节变 6 字节。本项目界面文案与错误原因全是中文，实测转义让压缩版白白多出 5.6 KB（57,351 → 51,734 字节，未含版本横幅）。改 `utf8` 只改文件编码，不改行为。
- **源码版不走 esbuild**。esbuild 即使 `minify: false` 也会把 `//` 注释全部剥掉（只有 `legalComments` 管法务注释），那样产出的「源码版」只剩代码骨架——对「方便用户自己看」这个目的等于没有。所以源码版由 `buildSource()` 按拓扑序拼接 `config → validate → proxy → upstream → pages → index`：只删 `import` 行、把 `export function` 还原成 `function`，其余原样保留。六个模块已核查**无同名顶层声明**，拼接安全。
  - 拼接后立刻核对注释完整性：源文件共 194 行 `//`，产物必须不少于这个数（少了就说明注释被吞，脚本直接 `exit 1`）。
  - 行为等价由 `npm run test:build` 兜底：同一组 12 个请求分别打 `src/index.js` 和两个产物，逐项比对状态码 / 头 / 正文 sha256。

**为什么不做混淆**：混淆会引入字符串数组查表和控制流间接，那是真正的性能损失。`npm run bench` 用「成对交替 + 中位数」测稳态每请求耗时：`fetch` 先打桩（`/favicon.ico` 分支会真的去 `github.githubassets.com` 取图，不桩的话每请求测到的是 16 ms 网络往返，执行差异整个被淹掉），两个产物背靠背各跑一遍取比值，再对所有比值取中位数（串联测会把机器负载漂移算成两边的差别）。多轮实测中位比值在 0.94–1.01 之间，两个方向都跑出来过，差别比单组 ±10%–20% 的采样抖动还小，属于噪声（所以脚本把 ±5% 以内判为「无可测差异」，超出才告警）。所以压缩只用来减小体积——gzip 后 17 KB vs 28 KB，上传更快、解析更省，执行逻辑不动。

## 本地预览

```bash
node scripts/preview.mjs            # 预览 src/index.js（源码，改完刷新即见）
node scripts/preview.mjs --built    # 预览 _worker.min.js（真正要部署的那份字节）
PORT=8801 node scripts/preview.mjs  # 换端口
```

`scripts/preview.mjs` 把 Node 的 http 请求包成 Workers 的 `Request` 交给真实的 `worker.fetch`，所以浏览器里跑的是**线上会跑的那份代码**，不是静态 HTML。改完 `src/` 不用先 `npm run build`，也不会出现「预览的是旧产物」这种假象。

> 两个踩过的坑：`new URL('D:/...')` 在 Windows 上会把盘符当协议（`ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`），必须用 `pathToFileURL`；`'../src/index.js'` 从仓库根解析会跑到仓库外（`ERR_MODULE_NOT_FOUND`），路径要用 `resolve(ROOT, ...)` 拼。

## 页面

首页和错误页都是**单文件内联**的，不引任何外部字体、图标库或 CDN：

| 特性 | 做法 |
|---|---|
| 亮色 / 暗色 / 跟随系统 | `data-theme="auto"` 默认；`prefers-color-scheme` 负责跟随系统，`:root[data-theme=dark]` 负责显式选择 |
| 不闪白 | 主题在 `<head>` 里同步落定（读 `localStorage('cfgh.theme')` 后立刻 `setAttribute`），不等 DOM 解析完 |
| 不跑 JS 也不错乱 | 主题按钮的图标与文字由 CSS 按 `:root[data-theme]` 选择，JS 失效时仍显示正确状态 |
| 体积 | 首页 35.5 KB，gzip 后 11.2 KB（`_worker.min.js` 整体 gzip 17 KB） |
| 无障碍 | `:focus-visible` 统一轮廓、`#tip` 带 `role="status" aria-live="polite"`、`prefers-reduced-motion` 关动效 |
| 响应式 | `clamp()` 字号与内边距；980px / 620px 两个断点，窄屏输入行纵向排列 |

**前端不做业务判定。** 点「加速」时先请求 `?check=<url>`，由后端 `validate.js` 给出判定（含同样的中文原因），前端只负责展示和跳转。上一版前端自带一份规则，与后端漂移后出现「前端放行、后端 400」的不一致——现在只有一份规则。

**视觉方向**（为什么长这样、哪些地方主动降级了）记在 [`.taste-skill/notes.md`](../.taste-skill/notes.md)。三个硬约束决定了它不能长成通用落地页：

1. **零外部资源**——不引字体、不引图床、不引 CDN。`test/pages.test.js` 有断言：首页 `src=`/`href=` 里不许出现外部地址。理由是一个 HTML 就是全部、能被边缘缓存、不产生额外请求、不受第三方可用性影响。
2. **零外部图片**——这个产品没有实体、没有场景、没有人坐在屏幕前的画面，它真实的样子就是它自己吐出来的界面。所以页面的「图」是四块真实界面片段（根节点标 `data-ui`），不是假仪表盘灰条。
3. **正文 ≥15px、字号 ≤9 档**——所以字号只有六档：16 / 17 / 20 / 26 / 60 / `clamp(30..74)`。

### 为什么不会轻易出现 1101

`fetch` 外面套了一层 `try/catch`，任何未预期异常都会变成 **500 + 「内部错误：…」**，而不是 Cloudflare 的 1101 空白页（1101 只在日志里留线索，用户看到的是白屏）。`test/pages.test.js` 里用 `new Proxy({}, {get(){throw}})` 强制让配置解析抛异常来验证这条兜底，另外还覆盖了 `/%zz`、`/../../etc/passwd`、2000 个字符的路径、`%00` 等畸形输入，以及 HEAD/POST/PUT/DELETE/PATCH/OPTIONS 各方法——都不许抛。

同一条原则也修掉了一个真实缺陷：`/favicon.ico` 分支要去外站取图标，原来没有任何兜底，网络抖动就会抛成 500。现在失败一律落 `204`——图标丢了不算错误，绝不能因此把请求打成 500。

### 构建产物是自动提交的

`.github/workflows/build-worker.yml` 在 `src/`、`scripts/build.mjs`、`package.json`、`package-lock.json` 变更时触发：

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
  live-check.mjs          # 真机联调（需联网，32 项）
  bench.mjs               # 两个产物的性能基准
  preview.mjs             # 本地预览（把 Node 请求交给真实 worker.fetch）
.github/workflows/
  build-worker.yml        # src 变更时自动构建并回填两个产物
wrangler.toml
.gitattributes            # 强制 LF（Windows autocrlf 会污染，CI 有断言）
```

---

返回 [README](../README.md)。
