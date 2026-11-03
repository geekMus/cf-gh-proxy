'use strict'

// ============================================================================
// 目标 URL 构建 / 白名单 / 响应头清洗
//
// 路由判定与 URL 形态识别沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 白名单、路径形态校验、响应头清洗、缓存策略、jsDelivr 改写为新增。
// ============================================================================

import { validateTargetPath } from './validate.js'

/** 允许代理的上游主机。收紧到 GitHub 自家域名，避免变成通用开放代理。 */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'codeload.github.com',
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
])

/** 这些主机只接受「已经完整」的 URL，不做补全猜测。 */
const HOSTS_REQUIRING_FULL_URL = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
])

/**
 * 把「前缀后面剩下的东西」还原成真正的上游 URL。
 *
 * 支持两种输入形态：
 *   1. `https://github.com/u/r/releases/download/v1/x.zip`（带协议，最常见）
 *   2. `github.com/u/r/releases/download/v1/x.zip`（不带协议）
 *
 * 省略 github.com 的裸 owner/repo 写法（`u/r/...`）从 v1.2.18 起不再支持：
 * owner 名带点时会和域名混淆（owner.name/repo/... 分不清是域名还是仓库），
 * 文档与错误页也统一只教「写完整链接」。
 *
 * 返回 URL 对象；无法解析时返回 null。
 *
 * @param {string} rest 去掉前缀后的原始路径（可带 query）
 */
export function buildTargetUrl(rest) {
  if (typeof rest !== 'string') return null
  let s = rest.trim().replace(/^\/+/, '')
  if (!s) return null

  // 有的客户端会把 `https://` 压成 `https:/`，先纠正回来
  s = s.replace(/^(https?):\/(?!\/)/i, '$1://')

  // 显式写了别的协议（ftp:// / file:// / javascript: …）一律拒绝，
  // 否则它会被当成「不带协议的 owner 路径」拼成 github.com/ftp://… 这种怪东西。
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i)
  if (scheme && !/^(https?|ftp)$/i.test(scheme[1])) return null
  if (scheme && /^ftp$/i.test(scheme[1])) return null

  let candidate
  if (/^https?:\/\//i.test(s)) {
    candidate = s
  } else {
    // 不带协议时，首段必须是域名（github.com / raw.githubusercontent.com 等，
    // 判据：含点）。裸 owner/repo 路径（首段不含点）直接拒掉——
    // owner 名带点时会和域名混淆，两端都不再猜。
    const first = s.split(/[/?#]/)[0]
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(first)) return null
    candidate = `https://${s}`
  }

  let u
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.protocol === 'http:') u.protocol = 'https:'
  return u
}

/**
 * 目标是否在白名单内**且**路径形态是「可下载资源」。
 *
 * 只查主机是不够的：`https://github.com/随便什么`、`https://github.com/login`
 * 的主机都在白名单里，但它们不是文件。没有形态校验时 Worker 会把 GitHub
 * 网页 HTML 抓回来，这个「加速站」就变成了通用反向代理。
 *
 * @param {URL} u
 * @returns {boolean}
 */
export function isAllowedTarget(u) {
  return checkTarget(u).ok
}

/**
 * 同上，但返回详细判定结果（`{ ok, kind?, reason? }`），供调用方拼错误信息。
 *
 * @param {URL} u
 * @returns {{ ok: boolean, kind?: string, reason?: string }}
 */
export function checkTarget(u) {
  const host = u.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: `不在允许的域名列表里：${host}` }
  }
  // 白名单锁死默认端口：`github.com:8443` 虽然还是 GitHub，但不该借我们的域名
  // 去连非常规端口；带 userinfo（`https://user@github.com/...`）也一并拒绝。
  if (u.port && u.port !== '443') {
    return { ok: false, reason: `不允许的端口：${u.port}` }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 里不允许带用户名或密码' }
  }
  // 那些「只接受完整 URL」的主机，路径不能为空
  if (HOSTS_REQUIRING_FULL_URL.has(host) && !u.pathname.replace(/^\/+/, '')) {
    return { ok: false, reason: '路径为空' }
  }
  return validateTargetPath(u)
}

/**
 * 可选：把「分支上的单文件」请求改写到 jsDelivr。
 *
 * 为什么默认关闭：jsDelivr 对分支的缓存非常激进，分支更新后它会继续吐旧内容
 * （实测过：同一 URL 返回的还是上一版文件）。只适合「按 tag / 按 commit SHA」的引用。
 *
 * @param {URL} target
 * @param {{ jsdelivr: boolean }} cfg
 * @returns {URL|null} 需要改写时返回新 URL，否则 null
 */
export function maybeJsdelivrUrl(target, cfg) {
  if (!cfg.jsdelivr) return null

  const host = target.hostname
  let owner, repo, ref, rest

  if (host === 'github.com') {
    // /owner/repo/(blob|raw)/ref/path...
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/)
    if (!m) return null
    ;[, owner, repo, ref, rest] = m
  } else if (host === 'raw.githubusercontent.com') {
    // /owner/repo/ref/path...
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
    if (!m) return null
    ;[, owner, repo, ref, rest] = m
  } else {
    return null
  }

  // 只有「按 tag 或 commit SHA」才安全；分支名会吃到过期缓存。
  // tag 只认 semver 形态（`v1.2.3` / `1.2.3`，可带预发布后缀）：`1.x`、`2024-fix`
  // 这类数字开头的**分支名**必须排除，否则 JSDELIVR=1 时会被当成不可变版本。
  const isSemverTag = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref)
  if (!isSemverTag && !/^[0-9a-f]{7,40}$/i.test(ref)) return null

  const out = new URL(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`)
  // 保留原始查询串（`?raw`、`?token=` 之类，交给 jsDelivr 判定）
  out.search = target.search
  return out
}

/**
 * `github.com/o/r/blob/<ref>/<path>` 是**网页**（GitHub 会返回渲染好的 HTML，
 * 带导航栏、按钮、语法高亮），拿不到文件字节。要拿到原文必须换成
 * `raw.githubusercontent.com/o/r/<ref>/<path>`。
 *
 * 上游那版是靠 `path.replace('/blob/','/raw/')` 做这件事，我重写时漏掉了，
 * 结果 /blob/ 路径把整页 HTML 当成「文件」回给了客户端——实测 3 次都返回
 * `text/html` 且正文是 `<!DOCTYPE html>`。这里补回来。
 *
 * 注意只改 blob，不动 raw（raw 本来就是对的）。
 */
export function maybeRewriteBlob(target) {
  if (target.hostname !== 'github.com') return null
  const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (!m) return null
  const [, owner, repo, rest] = m
  return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest}`)
}

/** 上游响应里这些头必须删掉：要么由 Worker 重新决定，要么会干扰下游。 */
const DROP_RESPONSE_HEADERS = new Set([
  // 由 Worker 统一设置
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  // 会破坏跨域与缓存语义
  'content-security-policy',
  'content-security-policy-report-only',
  'clear-site-data',
  'x-frame-options',
  // 上游的 cookie 绝不能落到访问者身上
  'set-cookie',
  'set-cookie2',
  // 这些是 Cloudflare / Fastly 内部头，透传出去只会误导
  'cf-cache-status',
  'cf-ray',
  'cf-request-id',
  'x-cache',
  'x-cache-hits',
  'x-served-by',
  'x-timer',
  'x-ms-request-id',
  'x-ms-version',
  'x-ms-lease-status',
  'x-ms-lease-state',
  'x-ms-server-encrypted',
  'x-ms-access-tier',
  'x-ms-access-tier-inferred',
  'x-ms-blob-content-md5',
  'x-ms-blob-type',
  'x-ms-creation-time',
  'report-to',
  'nel',
  'speculation-rules',
  'alt-svc',
  'via',
  'age',
  // 编码相关：Worker 返回的是上游原样字节，不让下游误判
  'content-encoding',
  'transfer-encoding',
  'connection',
])

/**
 * 清洗上游响应头：删掉不该透传的，保留对客户端有用的
 * （`content-type` / `content-length` / `content-range` / `accept-ranges` /
 * `etag` / `last-modified` / `content-disposition` 等一律保留）。
 *
 * @param {Headers} upstream
 * @returns {Headers}
 */
export function sanitizeUpstreamHeaders(upstream) {
  const out = new Headers()
  for (const [k, v] of upstream) {
    const key = k.toLowerCase()
    if (DROP_RESPONSE_HEADERS.has(key)) continue
    out.set(k, v)
  }
  // 删了 `content-encoding` 就不能再留上游的 `content-length`：那是压缩后的长度，
  // 而 Worker 交出去的是运行时解码后的字节。留着它，客户端会按错误长度读（读到一半
  // 卡住，或截断）。交给运行时按实际 body 重算即可。
  if (upstream.has('content-encoding')) out.delete('content-length')
  return out
}

// 缓存头不在这里生成：这个 Worker 是代理下载服务，所有响应一律 `no-store`，
// 由 index.js 的 handleProxy 统一写死——不留任何「按资源可变性分级」的口子。
