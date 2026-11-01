# 部署与配置

怎么把这个 Worker 跑起来，以及跑起来之后怎么绑域名、怎么改配置。

如果你只想尽快有个能用的地址，看 [README 的部署](../README.md#部署) 就够了；这份文档讲完整流程和每个配置项的含义。

## 快速开始

三种方式，按你的需要挑一种：

| 方式 | 适合谁 | 要做的事 | 耗时 |
|---|---|---|---|
| [A. 一键部署](#方式-a一键部署推荐) | 只想有个能用的加速地址 | 点一个按钮，授权 GitHub | 约 1 分钟 |
| [B. 粘贴单文件](#方式-b粘贴单文件不克隆仓库) | 想最快、不想让 Cloudflare 碰仓库 | 复制 `_worker.min.js` 全文粘进 Dashboard | 约 2 分钟 |
| [C. 改代码](#方式-c改代码用-wrangler) | 想改功能、跑测试 | `git clone` + `npm run deploy` | 约 5 分钟 |

### 方式 A：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/geekMus/cf-gh-proxy)

点上面的按钮，然后：

1. Cloudflare 会让你登录并授权它读取你的 GitHub 账号
2. 它把本仓库 **clone 一份到你自己的 GitHub 账号**下（不是部署到我的仓库，是你的）
3. 填一个仓库名和 Worker 名（默认 `cf-gh-proxy`，可以改）
4. 点 **Deploy**，等它构建完成（约 30 秒）

部署完你会得到一个 `https://<worker名>.<你的子域>.workers.dev` 地址，直接可用。

**这个按钮背后做了什么**：Cloudflare 用 Workers Builds 从你克隆出来的仓库构建部署 —— 它读 `wrangler.toml` 和 `package.json`，走本仓库自定义的 `deploy` 脚本（先 `node scripts/build.mjs --min` 打包成 `_worker.min.js`，再 `wrangler deploy --main _worker.min.js`）。所以线上跑的和 `_worker.min.js` 是同一份字节。

**注意**：一键部署是「一次性快照」——它给你的是一个独立仓库，之后本仓库更新了不会自动同步过去。想跟上更新，用下面「粘单文件」那条路（永远取最新构建产物），或者在你克隆出来的仓库里手动 `git pull upstream main`。

### 方式 B：粘贴单文件（不克隆仓库）

单文件地址：

```
https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.min.js
```

也可以直接看 GitHub 上的 [`_worker.min.js`](../_worker.min.js)。

步骤：

1. 打开上面的地址，`Ctrl+A` 全选、`Ctrl+C` 复制
2. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**
3. 给个名字（比如 `gh-proxy`），点 **Deploy**
4. 点 **Edit code**，把编辑器里默认的 `Hello World` 内容全删掉，粘贴刚复制的内容
5. 右上角 **Deploy**

配环境变量：Settings → Variables and Secrets，全部可选，见下文 [配置](#配置)。

`_worker.min.js` 是自动构建的产物：每次 `src/` 有变动，GitHub Actions 会重新构建并**自动提交回 `main`**。所以你打开链接看到的永远是最新代码，不用自己构建。

> 如果你的网络访问 `raw.githubusercontent.com` 不稳定，可以用 GitHub 页面下载：仓库主页 → `_worker.min.js` → 右上角 **Raw** 按钮，效果一样。

### 方式 C：改代码（用 wrangler）

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

`npm run deploy` 部署的是 `_worker.min.js`（压缩构建产物），不是 `src/`。这样**线上跑的和别人复制粘贴的是同一份字节**，不会出现「仓库能跑、单文件不能跑」的偏差。

部署完 `wrangler` 会打印一个 `*.workers.dev` 地址，直接可用。想绑自己的域名，在 `wrangler.toml` 里打开 `[[routes]]` 那一段。

## 部署后：拿到地址、绑自己的域名

**拿到默认地址。** 三种方式建的 Worker，地址都是 `https://<worker名>.<你的子域>.workers.dev`。`<你的子域>` 在 Dashboard → Workers & Pages 页面顶部能看到，形如 `xxx.workers.dev`。这个地址不用任何配置就能用，也能直接配到下载工具里。

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
| `JSDELIVR` | `0` | 是否把「按 tag / 按 SHA」的单文件改写走 jsDelivr（见下文说明） |

> 上游的 `LANDING_LINK` 这里**没有**：说明页右上角那个仓库入口写死指向本仓库（`src/pages.js` 的 `REPO_URL`）。页面属于本项目，做成变量只会多一个「指向别处」的口子；fork 的人要改，改源码那一行。

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

返回 [README](../README.md)。
