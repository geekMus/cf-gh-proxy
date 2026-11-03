# cf-gh-proxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/geekMus/cf-gh-proxy)

把 GitHub 的 release / archive / raw 链接套一层 Cloudflare Worker，走 Cloudflare 边缘节点。
部署在你自己的域名上，不依赖任何第三方加速站。

```
https://gh.example.com/https://github.com/owner/repo/releases/download/v1.0.0/app.zip
```

> **这个项目是基于 [cmliu/CF-Workers-GitHub](https://github.com/cmliu/CF-Workers-GitHub) 演化而来的。**
> 血统、沿袭了什么、改了什么，都在 [docs/origin-and-differences.md](docs/origin-and-differences.md)。

---

## 部署

点上面的按钮，然后：

1. Cloudflare 会让你登录并授权它读取你的 GitHub 账号
2. 它把本仓库 **clone 一份到你自己的 GitHub 账号**下（不是部署到我的仓库，是你的）
3. 填一个仓库名和 Worker 名（默认 `cf-gh-proxy`，可以改）
4. 点 **Deploy**，等它构建完成（约 30 秒）

部署完你会得到一个 `https://<worker名>.<你的子域>.workers.dev` 地址，直接可用。

### 不想点按钮？粘单文件

打开 [`_worker.min.js`](_worker.min.js)（或 raw 地址 `https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.min.js`），
全选复制 → [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Worker**
→ 命名 → **Deploy** → **Edit code** → 删掉默认内容、粘贴 → 右上角 **Deploy**。

两个产物都是 CI 自动构建的，每次 `src/` 变动重新构建并提交回 `main`：

| 文件 | 用途 |
|---|---|
| `_worker.min.js` | **部署用这个**。压缩过（去空白换行、缩短标识符、中文不转义），执行逻辑与源码版完全一致 |
| `_worker.js` | 给人看的：六个模块原样拼接，**注释一行不丢**，想审计或改一行就看它 |

> 实测两个产物性能无可测差异：`npm run bench` 成对交替测量，每请求耗时中位比值在 0.97–1.09 之间摆动
> （−0.9%、+0.5%、+6.3% 都跑出来过，快慢两个方向都出现；本机单组采样抖动就有 10%–30%，这点差别是噪声）。
> 压缩只减小体积、不改执行逻辑。本项目**不做混淆**——混淆会引入字符串数组查表与控制流间接，那是真的变慢。

---

## 用法

在 GitHub 链接前面加上你的服务地址（链接要写完整）：

```
https://gh.example.com/https://github.com/owner/repo/releases/download/v1.0.0/app.zip
```

支持的链接：release 资产、`latest/download`、`archive` 源码包、`raw` / `blob` 单文件、`raw.githubusercontent.com` 直链、Gist、`api.github.com`。
完整的支持列表和被拒绝的输入，见 [docs/paths.md](docs/paths.md)。

---

## 验证部署

拿一个真实存在的文件试（这里用本仓库自己的 `_worker.min.js`）：

```bash
curl -sI "https://gh.example.com/https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.min.js"
```

三个关键点：状态码 **200**（不是 302）、`content-type: text/plain` 或 `application/octet-stream`（不是 text/html）、**没有 set-cookie**。

---

## 配置

所有配置都是环境变量，在 Dashboard → Settings → Variables and Secrets 里加，或写进 `wrangler.toml` 的 `[vars]`。全部可选，不改也能用。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PREFIX` | `/` | 路由前缀。填 `/gh` 就是 `https://域名/gh/https://github.com/...` |
| `UPSTREAM_TIMEOUT` | `30000` | 等上游响应头的上限（毫秒），不影响大文件下载 |
| `MAX_REDIRECTS` | `5` | 最多跟几跳重定向 |
| `ALLOW_AUTH` | `0` | 是否转发访问者的 Cookie / Authorization。公开服务保持 `0` |
| `BLOCKED_UA` | `netcraft` | 命中这些 UA 子串时返回 nginx 伪装页；上游兼容变量 `UA` 同义（两个都生效，内置 `netcraft` 始终在列表里） |
| `JSDELIVR` | `0` | 是否把按 tag / SHA 的单文件改写走 jsDelivr |

完整的配置说明（含 `URL` / `URL302` 两个兼容上游的伪装变量、每个变量的取值理由）见 [docs/deploy.md](docs/deploy.md#配置)。

---

## 更多文档

| 文档 | 讲什么 |
|---|---|
| [docs/deploy.md](docs/deploy.md) | 部署的完整流程、绑自己的域名、每个配置项的含义 |
| [docs/paths.md](docs/paths.md) | 支持哪些链接、哪些会被拒绝、为什么 |
| [docs/how-it-works.md](docs/how-it-works.md) | 为什么上游那版慢、重定向到底发生了什么、安全设计 |
| [docs/development.md](docs/development.md) | 跑测试、构建单文件、页面实现、目录结构 |
| [docs/origin-and-differences.md](docs/origin-and-differences.md) | 来源与致谢、和上游的差异一览 |

---

## 许可

MIT，同时保留上游 `CMLiussss` 的版权声明。详见 [LICENSE](LICENSE)。
