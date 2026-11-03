# 支持哪些链接

这个 Worker 只代理 GitHub 上**可下载的文件**，不代理网页。这份文档列出全部支持的路径形态、被拒绝的输入，以及为什么。

## 支持的路径

| 形态 | 例子 |
|---|---|
| release 资产 | `github.com/o/r/releases/download/v1.0.0/app.zip` |
| 最新 release | `github.com/o/r/releases/latest/download/app.zip` |
| 源码打包 | `github.com/o/r/archive/refs/heads/main.zip`、`github.com/o/r/archive/v1.0.0.tar.gz` |
| 分支/提交里的文件 | `github.com/o/r/raw/main/x.sh`、`github.com/o/r/blob/main/x.sh` |
| raw 直链 | `raw.githubusercontent.com/o/r/main/x.sh` |
| Gist | `gist.githubusercontent.com/user/id/raw/x.txt`；`gist.github.com/user/id/raw`（**不带 `/raw` 的 gist 网页会被拒**） |
| API | `api.github.com/...` |

其中 `/blob/` 是 GitHub 的**网页**（返回渲染好的 HTML，不是文件字节），Worker 会自动改写成 `raw.githubusercontent.com` 再取，所以 `blob` 链接也能拿到原始文本。

链接要写完整，包含 `https://github.com/`：

```
https://gh.example.com/https://github.com/o/r/releases/download/v1.0.0/app.zip
```

> 裸路径（`https://gh.example.com/o/r/releases/download/v1.0.0/app.zip`）**不再支持**（v1.2.18 起）：
> 首段带点时它有歧义——`owner.name/repo/...` 里的 `owner.name` 会被当成域名而不是仓库，
> 于是同一形态时而能用时而 400。所以两端统一只认完整链接，老调用方请把 `https://github.com/` 补上。

### 只代理文件，不代理网页

这是本项目与「通用反向代理」的关键区别。**域名合法不代表路径合法**——`github.com/login` 的主机在白名单里，但它是一张网页。如果只查域名，Worker 就会把 GitHub 的 HTML 抓回来，这个服务也就退化成了开放代理。

所以路径还要过一层形态校验，下面这些一律返回 **400** 并说明原因：

| 会被拒的输入 | 为什么 |
|---|---|
| `随便什么`、`hello` | 不是 owner/repo 形态 |
| `github.com/owner/repo` | 仓库首页，是网页 |
| `github.com/owner/repo/tree/main` | 文件浏览页，是网页 |
| `github.com/owner/repo/issues`、`/pulls`、`/actions`、`/wiki` | 都是网页 |
| `github.com/login`、`/settings`、`/search`、`/explore`、`/topics` | GitHub 站内页面 |
| `github.com/owner/repo/releases`、`/releases/tag/v1` | releases 的网页，不是资产 |
| `github.com/owner/repo/archive/v1.0.0` | 缺 `.zip` / `.tar.gz` 扩展名 |
| `github.com/owner/repo/raw/main` | 缺文件名 |
| `example.com/...`、`evil.com/https://github.com/...` | 非 GitHub 域名 |

错误响应分两种形态：浏览器（`Accept` 含 `text/html`）给一页可读的说明，含具体原因与正确示例；`curl` / `wget` 给一行纯文本，方便脚本 grep。

只代理 GitHub 自家域名，其它域名一律拒绝（避免变成公开的开放代理）。

---

返回 [README](../README.md)。
