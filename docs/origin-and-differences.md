# 来源、致谢与和上游的差异

本项目的血统，以及如果你现在用着上游那版、想换过来会有什么变化。

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

这个项目的改动集中在**代理与跳转处理**，以及一批安全与健壮性问题。原始版本的实际表现是：一次 `releases/latest/download/…` 下载要 **90 秒**、Range 请求直接超时；改完之后 **1.2 秒**、Range 正常 206。完整实测对比见 [重定向：这次改造的核心](how-it-works.md#重定向这次改造的核心)。

| 方面 | 原始版本 | 本项目 |
|---|---|---|
| 重定向处理 | `redirect:'manual'`，把 302 **回写**给客户端，客户端再请求一次 Worker | Worker **自己跟完整条链**，只回最终响应 |
| 客户端拿到的响应 | 带 `Set-Cookie: _gh_sess`（走了 github 网页前端） | 只有文件字节，无 cookie |
| 上游超时 | 无 | `UPSTREAM_TIMEOUT`，超时主动放弃 |
| 跳转次数 | 递归跟随，无上限 | `MAX_REDIRECTS`，超限 508 |
| 边缘缓存 | 无（全部回源） | 按资源可变性分级缓存 |
| 域名白名单 | 空数组时全放行（开放代理，实测 `example.com` 返回 200） | 只放行 GitHub 域名 |
| 路径校验 | 只按正则判前缀，**任意输入都能触发代理**（`github.com/随便什么`、`/login`、`/settings` 全放行） | 域名 + 路径双重校验，只代理可下载文件，网页一律 400 |
| 客户端凭据 | 原样转发 `Cookie` / `Authorization` | 默认不转发（`ALLOW_AUTH=0`） |
| 模块级状态 | `屏蔽爬虫UA = 屏蔽爬虫UA.concat(...)`，每次请求追加、同 isolate 无限增长 | 每次请求重新解析，无模块级可变状态 |
| 死代码 | `exp4` 分支永远到不了（前面已被吃掉），分支上的 jsDelivr 重定向失效 | `JSDELIVR` 是真正生效的配置 |
| 响应头 | 原样透传（含 `Set-Cookie`、CSP、Cloudflare/Azure 内部头） | 剥掉不该透传的，保留 `content-type` / `content-range` / `etag`；代理响应一律补 `access-control-allow-origin: *`（说明页与 favicon 是自家页面，不加） 等 |
| 代码组织 | 单个 480 行 `worker.js`，含内嵌 HTML | `src/` 分 6 个模块 + `test/` 96 个测试 |
| 页面 | 单套暗色配色，无主题切换 | 亮色 / 暗色 / 跟随系统三态，零外部资源，一屏之内，首页 gzip 约 7 KB |
| 异常兜底 | 无，抛出异常即 Cloudflare 1101 空白页 | `fetch` 外层 `try/catch` → 500 + 可读原因 |

### 许可证

上游是 **MIT**（`Copyright (c) 2025 CMLiussss`），MIT 要求保留原版权声明，所以本项目的 [LICENSE](../LICENSE) 里同时保留了两行版权：

```
Copyright (c) 2025 CMLiussss (https://github.com/cmliu/CF-Workers-GitHub)
Copyright (c) 2026 cf-gh-proxy contributors
```

本项目同样以 MIT 发布。

## 与上游的差异一览（给想迁移的人）

如果你现在用着 `cmliu/CF-Workers-GitHub`，想换到本项目：

- **环境变量**：`URL` / `URL302` 完全兼容；`PREFIX` / `CACHE_TTL` / `IMMUTABLE_CACHE_TTL` / `UPSTREAM_TIMEOUT` / `MAX_REDIRECTS` / `ALLOW_AUTH` / `BLOCKED_UA`（含兼容别名 `UA`） / `JSDELIVR` 是新增的
- **不需要改调用方**：链接形态、`?q=` 入口、裸 owner/repo 写法都一样
- **会变的行为**：非 GitHub 域名现在返回 400（上游是放行）；客户端 Cookie 不再转发
- **部署方式**：两种都行——粘 [`_worker.min.js`](../_worker.min.js) 到 Dashboard（和上游一样），或 `npm run deploy`（部署的也是构建出来的同一个单文件）

## 许可

MIT，同时保留上游 `CMLiussss` 的版权声明。详见 [LICENSE](../LICENSE)。

---

返回 [README](../README.md)。
