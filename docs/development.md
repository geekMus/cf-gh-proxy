# 开发

改了代码怎么验证、构建产物怎么来的、目录结构怎么组织。只想部署的话不需要看这份。

## 开发

```bash
npm test                # 93 个单元测试，纯桩无网络
npm run check           # 语法检查
npm run build           # 构建单文件 _worker.js
npm run test:build      # 验证单文件与源码行为一致（16 项断言）
npm run verify          # 全套：语法 + 单测 + 构建 + 等价性
node scripts/live-check.mjs   # 真机联调（需联网，31 项断言）
npx wrangler tail       # 看线上实时日志
```

单元测试覆盖：配置解析、上游兼容变量、URL 构建（三种输入形态）、白名单、**路径形态校验（只代理文件、不代理网页）**、**`/blob/` 改写成 raw**、响应头清洗、缓存头、**重定向跟随（本次改造的核心）**、jsDelivr 改写、**首页与错误页（内联脚本可编译、零外部资源、主题三态、`?check=` 与真实代理判定一致、异常兜底不产生 1101）**。

`npm run test:build` 做的事：同一组请求分别打到 `src/index.js` 和 `_worker.js`，逐项比对状态码、响应头、正文 sha256。构建产物和源码行为不一致时它会失败——这是「单文件分发」的安全网。

## 页面

首页和错误页都是**单文件内联**的，不引任何外部字体、图标库或 CDN：

| 特性 | 做法 |
|---|---|
| 亮色 / 暗色 / 跟随系统 | `data-theme="auto"` 默认；`prefers-color-scheme` 负责跟随系统，`:root[data-theme=dark]` 负责显式选择 |
| 不闪白 | 主题在 `<head>` 里同步落定（读 `localStorage('cfgh.theme')` 后立刻 `setAttribute`），不等 DOM 解析完 |
| 不跑 JS 也不错乱 | 主题按钮的图标与文字由 CSS 按 `:root[data-theme]` 选择，JS 失效时仍显示正确状态 |
| 体积 | 首页约 19.8 KB，gzip 后约 6.9 KB（`_worker.js` 整体 gzip 约 14.5 KB） |
| 无障碍 | `:focus-visible` 统一轮廓、`#tip` 带 `role="status" aria-live="polite"`、`prefers-reduced-motion` 关动效 |
| 响应式 | `clamp()` 字号与内边距；窄屏输入行纵向排列、示例地址软换行 |

**前端不做业务判定。** 点「加速」时先请求 `?check=<url>`，由后端 `validate.js` 给出判定（含同样的中文原因），前端只负责展示和跳转。上一版前端自带一份规则，与后端漂移后出现「前端放行、后端 400」的不一致——现在只有一份规则。

### 为什么不会轻易出现 1101

`fetch` 外面套了一层 `try/catch`，任何未预期异常都会变成 **500 + 「内部错误：…」**，而不是 Cloudflare 的 1101 空白页（1101 只在日志里留线索，用户看到的是白屏）。`test/pages.test.js` 里用 `new Proxy({}, {get(){throw}})` 强制让配置解析抛异常来验证这条兜底，另外还覆盖了 `/%zz`、`/../../etc/passwd`、2000 个字符的路径、`%00` 等畸形输入，以及 HEAD/POST/PUT/DELETE/PATCH/OPTIONS 各方法——都不许抛。

### 构建产物是自动提交的

`.github/workflows/build-worker.yml` 在 `src/`、`scripts/build.mjs`、`package.json`、`package-lock.json` 变更时触发：

1. 装依赖 → 语法与行尾检查 → 构建 → 产物形态检查 → 与源码行为比对
2. 产物若与仓库里的不同，就以 `github-actions[bot]` 身份提交回 `main`，提交信息带 `[skip build]`

所以**改完 `src/` 不用记得手动 `npm run build` 再提交**，CI 会补上。想本地先看效果，跑一下 `npm run build` 就行。

`_worker.js` 不在 workflow 的 `paths` 里，回填提交不会再次触发构建，不会形成循环。

### 构建产物是自动提交的

`.github/workflows/build-worker.yml` 在 `src/`、`scripts/build.mjs`、`package.json`、`package-lock.json` 变更时触发：

1. 装依赖 → 语法与行尾检查 → 构建 → 产物形态检查 → 与源码行为比对
2. 产物若与仓库里的不同，就以 `github-actions[bot]` 身份提交回 `main`，提交信息带 `[skip build]`

所以**改完 `src/` 不用记得手动 `npm run build` 再提交**，CI 会补上。想本地先看效果，跑一下 `npm run build` 就行。

`_worker.js` 不在 workflow 的 `paths` 里，回填提交不会再次触发构建，不会形成循环。

## 目录结构

```
_worker.js              ← 构建产物（单文件，可直接粘贴；CI 自动更新）
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
  jsdelivr.test.js         # jsDelivr 改写
  compat-upstream.test.js  # 上游 URL / URL302 兼容
scripts/
  build.mjs               # 打包成单文件 _worker.js
  check-build.mjs         # 验证单文件与源码行为一致
  check-workflow.cjs      # 校验工作流配置（26 项断言）
  live-check.mjs          # 真机联调（需联网）
.github/workflows/
  build-worker.yml        # src 变更时自动构建并回填 _worker.js
wrangler.toml
.gitattributes            # 强制 LF（Windows autocrlf 会污染，CI 有断言）
```

---

返回 [README](../README.md)。
