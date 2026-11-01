# 它解决什么问题、怎么解决的

这份文档讲原理：上游那版为什么慢、重定向到底发生了什么、本项目改在哪里。只看结论的话：一次 `releases/latest/download/…` 下载从 **90 秒**降到 **1.2 秒**。

## 它解决什么问题

直连 `github.com` 在国内经常很慢甚至超时；现成的第三方加速站要么需要排队，要么像上游那版那样把重定向直接丢给客户端，导致一次下载要请求两遍。

这个 Worker 的做法是：**自己把 GitHub 的重定向链跟完，只把最终的文件字节回给客户端。** 一次请求，一跳到底。

同时它**只代理可下载的文件**：`github.com/login`、`github.com/owner/repo`、`github.com/search` 这类网页路径会被拒绝并说明原因，不会变成谁都能用的通用反向代理。

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

## 安全说明

- **不转发 Cookie / Authorization**（`ALLOW_AUTH=0`）。这个 Worker 是公开服务，把访问者凭据送给上游既没必要也不安全。
- **只放行 GitHub 域名**，其它一律 403。
- **上游响应的 `Set-Cookie` 一律剥掉**，不会落到访问者身上。
- 上游响应里的 `Content-Security-Policy`、`X-Frame-Options` 等也剥掉——它们对「直接下文件」没有意义，反而会干扰浏览器处理。

---

返回 [README](../README.md)。
