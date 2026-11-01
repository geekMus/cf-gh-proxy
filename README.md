# cf-gh-proxy

把 GitHub 的 release / archive / raw 链接套一层 Cloudflare Worker，走 Cloudflare 边缘节点。
部署在你自己的域名上，不依赖任何第三方加速站。

```
https://gh.example.com/https://github.com/owner/repo/releases/download/v1.0.0/app.zip
```

> **这个项目是基于 [cmliu/CF-Workers-GitHub](https://github.com/cmliu/CF-Workers-GitHub) 演化而来的。**
> 详见下方 [来源与致谢](#来源与致谢)。

---

## 来源与致谢

### 本项目从哪来

本项目**不是从零写的**。它的起点是 [cmliu/CF-Workers-GitHub](https://github.com/cmliu/CF-Workers-GitHub) —— 一个基于 Cloudflare Workers 的 GitHub 镜像代理工具，作者是 [CMLiussss](https://github.com/cmliu)。

那个项目本身又是站在 [hunshcn/gh-proxy](https://github.com/hunshcn/gh-proxy) 和 [jsproxy](https://github.com/EtherDream/jsproxy/) 的肩膀上。完整的谱系是：

```
hunshcn/gh-proxy  ──┐
                    ├──→  cmliu/CF-Workers-GitHub  ──→  cf-gh-proxy（本项目）
jsproxy         ────┘         (MIT, CMLiussss)
```

### 沿袭了什么

从 `cmliu/CF-Workers-GitHub` 沿袭下来的部分：

- **整体思路**：一个 Worker 把 GitHub 的各种链接（release 资产 / 源码打包 / 分支文件 / gist / api）转发出去
- **路由判定**：用几条正则识别 URL 形态，分流到不同处理分支（`releases|archive`、`blob|raw`、`gist`、`tags`、`raw.githubusercontent` 等）
- **伪装机制**：命中爬虫 UA 时返回 nginx 默认页；`URL` / `URL302` 两个环境变量控制主页伪装
- **首页形态**：一个可粘贴 GitHub 链接的输入框页面
- **`?q=` 便捷入口**：把裸链接转成前缀形式

### 改了什么

这个项目的改动集中在**代理与跳转处理**，以及一批安全与健壮性问题。原始版本的实际表现是：一次 `releases/latest/download/…` 下载要 **90 秒**、Range 请求直接超时；改完之后 **1.2 秒**、Range 正常 206。完整实测对比见下方 [重定向：这次改造的核心](#重定向这次改造的核心)。

| 方面 | 原始版本 | 本项目 |
|---|---|---|
| 重定向处理 | `redirect:'manual'`，把 302 **回写**给客户端，客户端再请求一次 Worker | Worker **自己跟完整条链**，只回最终响应 |
| 客户端拿到的响应 | 带 `Set-Cookie: _gh_sess`（走了 github 网页前端） | 只有文件字节，无 cookie |
| 上游超时 | 无 | `UPSTREAM_TIMEOUT`，超时主动放弃 |
| 跳转次数 | 递归跟随，无上限 | `MAX_REDIRECTS`，超限 508 |
| 边缘缓存 | 无（全部回源） | 按资源可变性分级缓存 |
| 域名白名单 | 空数组时全放行（开放代理，实测 `example.com` 返回 200） | 只放行 GitHub 域名，其它 403 |
| 客户端凭据 | 原样转发 `Cookie` / `Authorization` | 默认不转发（`ALLOW_AUTH=0`） |
| 模块级状态 | `屏蔽爬虫UA = 屏蔽爬虫UA.concat(...)`，每次请求追加、同 isolate 无限增长 | 每次请求重新解析，无模块级可变状态 |
| 死代码 | `exp4` 分支永远到不了（前面已被吃掉），分支上的 jsDelivr 重定向失效 | `JSDELIVR` 是真正生效的配置 |
| 响应头 | 原样透传（含 `Set-Cookie`、CSP、Cloudflare/Azure 内部头） | 剥掉不该透传的，保留 `content-type` / `content-range` / `etag` 等 |
| 代码组织 | 单个 480 行 `worker.js`，含内嵌 HTML | `src/` 分 5 个模块 + `test/` 41 个测试 |

### 许可证

上游是 **MIT**（`Copyright (c) 2025 CMLiussss`），MIT 要求保留原版权声明，所以本项目的 [LICENSE](LICENSE) 里同时保留了两行版权：

```
Copyright (c) 2025 CMLiussss (https://github.com/cmliu/CF-Workers-GitHub)
Copyright (c) 2026 cf-gh-proxy contributors
```

本项目同样以 MIT 发布。

---

## 它解决什么问题

直连 `github.com` 在国内经常很慢甚至超时；现成的第三方加速站要么需要排队，要么像本文重写前那样把重定向直接丢给客户端，导致一次下载要请求两遍。

这个 Worker 的做法是：**自己把 GitHub 的重定向链跟完，只把最终的文件字节回给客户端。** 一次请求，一跳到底。

---

## 重定向：这次改造的核心

GitHub 的 release 资产不是直接返回文件，而是一串 302：

```
github.com/o/r/releases/latest/download/x.zip
   │  302（带 Set-Cookie，落到 github.com 网页前端）
   ▼
github.com/o/r/releases/download/v0.3.2/x.zip
   │  302
   ▼
release-assets.githubusercontent.com/github-production-release-asset/…
   │
   ▼
  200  文件字节
```

原始版本在第二跳上把 `Location` 改写后**回写给客户端**（`location: /https://github.com/...`），让客户端再请求一次 Worker。于是：

- 每次下载都要走**两遍** Worker
- 第二遍落在 `github.com` 的**网页前端**（带 `_gh_sess` cookie），不是直连资产
- 结果：完整下载 90 秒断在 20798/68917 字节，Range 请求直接超时

本项目改为由 Worker 内部把整条链跟完。实测对比：

| 探测项 | 原始版本 | 本项目 |
|---|---|---|
| `latest/download/…` 完整下载 | **90.0 秒**（只收到 20798/68917 字节就断） | **1.2 秒**，68917 字节，sha256 一致 |
| Range 取前 4KB | **90 秒超时，code=000** | **0.34 秒**，206，4001 字节 |
| HEAD | 超时无输出 | **0.34 秒**，200 |
| 响应头 | 带 `Set-Cookie: _gh_sess` | 无 cookie |

（实测脚本：`node scripts/live-check.mjs`，41 项断言，三轮连跑全过。）

---

## 快速开始

### 方式 A：只想跑起来（不克隆仓库）

单文件地址：

```
https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.js
```

也可以直接看 GitHub 上的 [`_worker.js`](_worker.js)。

步骤：

1. 打开上面的地址，`Ctrl+A` 全选、`Ctrl+C` 复制
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**
3. 给个名字（比如 `gh-proxy`），点 **Deploy**
4. 点 **Edit code**，把编辑器里默认的 `Hello World` 内容全删掉，粘贴刚复制的内容
5. 右上角 **Deploy**

配环境变量：Settings → Variables and Secrets，全部可选，见下方 [配置](#配置)。

`_worker.js` 是自动构建的产物：每次 `src/` 有变动，GitHub Actions 会重新构建并**自动提交回 `main`**。所以你打开链接看到的永远是最新代码，不用自己构建。

> 如果你的网络访问 `raw.githubusercontent.com` 不稳定，可以用 GitHub 页面下载：仓库主页 → `_worker.js` → 右上角 **Raw** 按钮，效果一样。

### 方式 B：改代码

#### 1. 装依赖

```bash
npm install
```

### 2. 本地跑起来看效果

```bash
npm run dev
```

打开 <http://localhost:8787>，会看到说明页；把 GitHub 链接粘进去试试。

### 3. 部署

```bash
npx wrangler login          # 首次需要
npm run deploy              # 先构建单文件，再部署它
```

`npm run deploy` 部署的是 `_worker.js`（构建产物），不是 `src/`。这样**线上跑的和别人复制粘贴的是同一份字节**，不会出现「仓库能跑、单文件不能跑」的偏差。

部署完 `wrangler` 会打印一个 `*.workers.dev` 地址，直接可用。想绑自己的域名，在 `wrangler.toml` 里打开 `[[routes]]` 那一段。

---

## 部署后：拿到地址、绑自己的域名

**拿到默认地址。** 用方式 A 在 Dashboard 建的 Worker，地址是 `https://<worker名>.<你的子域>.workers.dev`。`<你的子域>` 在 Dashboard → Workers & Pages 页面顶部能看到，形如 `xxx.workers.dev`。这个地址不用任何配置就能用，也能直接配到下载工具里。

**绑自己的域名（可选，但强烈建议）。** `workers.dev` 在国内经常被墙，绑自己的域名才稳定：

1. 先把域名接入 Cloudflare（DNS 托管在 CF）
2. Dashboard → Workers & Pages → 选中你的 Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain**
3. 填你的域名，比如 `gh.mus.pp.ua`，点 **Add domain**
4. Cloudflare 会自动给你建一条 CNAME 记录，等 1～2 分钟生效

绑好后就能用：

```
https://gh.mus.pp.ua/https://github.com/geekMus/container-autoupdate/releases/download/v0.3.2/container-autoupdate.sh
```

**用 wrangler 部署的话**，在 `wrangler.toml` 里取消注释这一段，再 `npm run deploy`：

```toml
[[routes]]
pattern = "gh.example.com"
custom_domain = true
```

**验证部署成功。** 浏览器打开 `https://你的域名/`，应该看到说明页（一个输入框 + 用法示例）。然后试一条真实链接：

```bash
curl -sI "https://gh.mus.pp.ua/https://github.com/geekMus/container-autoupdate/releases/latest/download/container-autoupdate.sh"
# 期望：HTTP/2 200、content-type: application/octet-stream、没有 location、没有 set-cookie
```

三个关键点都对上就说明部署正确：**200**（不是 302）、**octet-stream**（不是 text/html）、**没有 set-cookie**。这三条正是本项目相对上游改造的地方——上游会把 302 回写给客户端，多走一跳 GitHub 网页前端。

---

## 配置

所有配置都在 `wrangler.toml` 的 `[vars]` 里，改完重新 `deploy` 即可；线上也可以直接在 Dashboard → Settings → Variables 里改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PREFIX` | `/` | 路由前缀。`/` 表示直接挂在根上；填 `/gh` 就是 `https://域名/gh/https://github.com/...` |
| `CACHE_TTL` | `300` | 可变资源（分支上的 raw、按分支名的打包）的边缘缓存秒数 |
| `IMMUTABLE_CACHE_TTL` | `86400` | 不可变资源（release 资产、按 commit SHA 的 raw）的缓存秒数 |
| `UPSTREAM_TIMEOUT` | `30000` | 等上游响应头的上限（毫秒）。**只管到拿到响应头为止**，下载大文件不受这个限制 |
| `MAX_REDIRECTS` | `5` | 最多跟几跳重定向 |
| `ALLOW_AUTH` | `0` | 是否把访问者的 `Cookie` / `Authorization` 转发给上游。公开服务请保持 `0` |
| `BLOCKED_UA` | `netcraft` | 命中这些 UA 子串时返回 nginx 伪装页 |
| `JSDELIVR` | `0` | 是否把「按 tag / 按 SHA」的单文件改写走 jsDelivr（见下方说明） |
| `LANDING_LINK` | `https://github.com/` | 说明页底部展示的链接 |

### 兼容上游的两个伪装变量

为了和 `cmliu/CF-Workers-GitHub` 保持兼容，这两个变量语义完全沿用：

| 变量 | 效果 |
|---|---|
| `URL302` | 主页 **302 跳转**到这个地址（优先级最高） |
| `URL` | 主页伪装成这个地址；设为 `nginx` 则返回 nginx 默认页 |

都不设时，主页返回本项目的说明页。

### 关于 `JSDELIVR`

默认**关闭**。开启后，`github.com/o/r/blob/<tag>/x.js` 与 `raw.githubusercontent.com/o/r/<tag>/x.js` 这类请求会被改写到 `cdn.jsdelivr.net/gh/...`，省一点 Cloudflare 的出口流量。

只对 **tag 或 commit SHA** 生效，**分支名一律不改写**——jsDelivr 对分支的缓存很激进，分支更新后它还会继续吐旧内容（实测踩过：同一个 URL 返回的是上一版文件）。release 资产和源码打包也不改写，jsDelivr 不支持。

---

## 支持的路径

| 形态 | 例子 |
|---|---|
| release 资产 | `github.com/o/r/releases/download/v1.0.0/app.zip` |
| 源码打包 | `github.com/o/r/archive/refs/heads/main.zip` |
| 分支/提交里的文件 | `github.com/o/r/raw/main/x.sh`、`github.com/o/r/blob/main/x.sh` |
| raw 直链 | `raw.githubusercontent.com/o/r/main/x.sh` |
| Gist | `gist.githubusercontent.com/...` |
| API | `api.github.com/...` |

省略 `https://github.com/` 也能用：

```
https://gh.example.com/o/r/releases/download/v1.0.0/app.zip
```

只代理 GitHub 自家域名，其它域名一律 403（避免变成公开的开放代理）。

---

## 开发

```bash
npm test                # 41 个单元测试，纯桩无网络
npm run check           # 语法检查
npm run build           # 构建单文件 _worker.js
npm run test:build      # 验证单文件与源码行为一致（16 项断言）
npm run verify          # 全套：语法 + 单测 + 构建 + 等价性
node scripts/live-check.mjs   # 真机联调（需联网，31 项断言）
npx wrangler tail       # 看线上实时日志
```

单元测试覆盖：配置解析、上游兼容变量、URL 构建（三种输入形态）、白名单、响应头清洗、缓存头、**重定向跟随（本次改造的核心）**、jsDelivr 改写。

`npm run test:build` 做的事：同一组请求分别打到 `src/index.js` 和 `_worker.js`，逐项比对状态码、响应头、正文 sha256。构建产物和源码行为不一致时它会失败——这是「单文件分发」的安全网。

### 构建产物是自动提交的

`.github/workflows/build-worker.yml` 在 `src/`、`scripts/build.mjs`、`package.json`、`package-lock.json` 变更时触发：

1. 装依赖 → 语法与行尾检查 → 构建 → 产物形态检查 → 与源码行为比对
2. 产物若与仓库里的不同，就以 `github-actions[bot]` 身份提交回 `main`，提交信息带 `[skip build]`

所以**改完 `src/` 不用记得手动 `npm run build` 再提交**，CI 会补上。想本地先看效果，跑一下 `npm run build` 就行。

`_worker.js` 不在 workflow 的 `paths` 里，回填提交不会再次触发构建，不会形成循环。

---

## 目录结构

```
_worker.js              ← 构建产物（单文件，可直接粘贴；CI 自动更新）
src/
  index.js              # Worker 入口：路由分发
  config.js             # env → cfg 归一化
  proxy.js              # 目标 URL 构建 / 白名单 / 响应头清洗 / 缓存头
  upstream.js           # 上游请求：自己跟随重定向 + 超时
  pages.js              # 说明页 / nginx 伪装页
test/
  unit.test.js             # 配置、URL、白名单、响应头
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

## 安全说明

- **不转发 Cookie / Authorization**（`ALLOW_AUTH=0`）。这个 Worker 是公开服务，把访问者凭据送给上游既没必要也不安全。
- **只放行 GitHub 域名**，其它一律 403。
- **上游响应的 `Set-Cookie` 一律剥掉**，不会落到访问者身上。
- 上游响应里的 `Content-Security-Policy`、`X-Frame-Options` 等也剥掉——它们对「直接下文件」没有意义，反而会干扰浏览器处理。

---

## 与上游的差异一览（给想迁移的人）

如果你现在用着 `cmliu/CF-Workers-GitHub`，想换到本项目：

- **环境变量**：`URL` / `URL302` 完全兼容；`PREFIX` / `CACHE_TTL` / `UPSTREAM_TIMEOUT` / `ALLOW_AUTH` / `JSDELIVR` 是新增的
- **不需要改调用方**：链接形态、`?q=` 入口、裸 owner/repo 写法都一样
- **会变的行为**：非 GitHub 域名现在返回 403（上游是放行）；客户端 Cookie 不再转发
- **部署方式**：两种都行——粘 [`_worker.js`](_worker.js) 到 Dashboard（和上游一样），或 `npm run deploy`（部署的也是构建出来的同一个单文件）

---

## 许可

MIT，同时保留上游 `CMLiussss` 的版权声明。详见 [LICENSE](LICENSE)。
