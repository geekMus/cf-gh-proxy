'use strict'

// ============================================================================
// 目标 URL 构建 / 白名单 / 响应头清洗
//
// 路由判定与 URL 形态识别沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 白名单、响应头清洗、缓存策略、jsDelivr 改写为新增。
// ============================================================================

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
 * 支持三种输入形态：
 *   1. `https://github.com/u/r/releases/download/v1/x.zip`（带协议，最常见）
 *   2. `github.com/u/r/releases/download/v1/x.zip`（不带协议）
 *   3. `u/r/releases/download/v1/x.zip`（省略 github.com，即裸 owner/repo/...）
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
    // 首段是不是域名？判据：含点、且不是 `owner.repo` 这种仓库名写法。
    // 例：`github.com/u/r/...` 首段 `github.com` 含点 → 当域名。
    //     `geekMus/container-autoupdate/...` 首段不含点 → 当裸 owner/repo。
    const first = s.split(/[/?#]/)[0]
    const looksLikeHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(first)
    candidate = looksLikeHost ? `https://${s}` : `https://github.com/${s}`
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
 * 目标是否在白名单内。
 * @param {URL} u
 */
export function isAllowedTarget(u) {
  const host = u.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) return false
  // 那些「只接受完整 URL」的主机，路径不能为空
  if (HOSTS_REQUIRING_FULL_URL.has(host) && !u.pathname.replace(/^\/+/, '')) return false
  return true
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

  // 只有「按 tag 或 commit SHA」才安全；分支名会吃到过期缓存
  if (!/^v?\d/.test(ref) && !/^[0-9a-f]{7,40}$/i.test(ref)) return null

  return new URL(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`)
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
  return out
}

/**
 * 给响应头加上 Cache-Control 与 CDN-Cache-Control。
 *
 * Cloudflare 的 `cf.cacheTtl` 只在请求 `cf` 选项时生效，而我们这里用的是
 * 「响应头驱动缓存」，所以两个头都要写：
 *   - `Cache-Control` 给浏览器与中间层；
 *   - `CDN-Cache-Control` 给 Cloudflare 边缘（优先级高于 Cache-Control）。
 *
 * @param {Headers} headers 已清洗的响应头（会被原地修改并返回）
 * @param {number} ttl 秒
 * @param {Headers} upstream 原始上游响应头（用来判断是否可缓存）
 */
export function withCacheHeaders(headers, ttl, upstream) {
  // 上游明确禁止缓存时尊重它
  const cc = (upstream.get('cache-control') || '').toLowerCase()
  if (cc.includes('no-store') || cc.includes('private')) {
    headers.set('Cache-Control', 'no-store')
    return headers
  }
  headers.set('Cache-Control', `public, max-age=${ttl}`)
  headers.set('CDN-Cache-Control', `public, max-age=${ttl}`)
  // 已经是 200/206/301 这类可缓存状态才有意义；其他状态交给调用方判断
  return headers
}
