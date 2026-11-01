'use strict'

// ============================================================================
// 配置解析：把 Worker 的 env（Dashboard 变量 / wrangler vars / .dev.vars）归一化成 cfg
// 每次请求都重新解析，**不保留任何模块级可变状态**。
//
// 这一点很关键：上游 cmliu/CF-Workers-GitHub（MIT, CMLiussss）把屏蔽 UA 列表
// 放在模块全局数组里，每次请求 `屏蔽爬虫UA = 屏蔽爬虫UA.concat(...)`，
// 同一个 isolate 里会无限增长。这里改成每次请求重新解析。
// ============================================================================

const DEFAULT_BLOCKED_UA = ['netcraft']

/** 把 '/gh' / 'gh' / '/gh/' 都归一成 '/gh/'；'/' 保持 '/' */
function normalizePrefix(raw) {
  let p = typeof raw === 'string' && raw.trim() ? raw.trim() : '/'
  if (!p.startsWith('/')) p = '/' + p
  if (!p.endsWith('/')) p = p + '/'
  return p
}

/** 'a b,c|d' → ['a','b','c','d']，统一小写（UA 比较用） */
function parseList(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[\s,|"'`]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function num(raw, fallback, { min = 0 } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

function bool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/** 取一个去掉首尾空白的字符串；空值统一成 '' */
function str(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

export function resolveConfig(env) {
  const e = env || {}
  // 兼容上游（cmliu/CF-Workers-GitHub）的两个伪装变量：
  //   URL     = 主页伪装地址；设为 nginx 则返回 nginx 默认页
  //   URL302  = 主页 302 跳转地址（优先级高于 URL）
  const url302 = str(e.URL302)
  const urlRaw = str(e.URL)
  const urlIsNginx = urlRaw && /^nginx$/i.test(urlRaw)

  return {
    prefix: normalizePrefix(e.PREFIX),
    jsdelivr: bool(e.JSDELIVR, false),
    // 上游响应头到达前的等待上限（毫秒）；拿到响应头后不再计时，下载不受影响
    upstreamTimeout: num(e.UPSTREAM_TIMEOUT, 30000, { min: 1000 }),
    maxRedirects: num(e.MAX_REDIRECTS, 5),
    // 是否把客户端 Cookie / Authorization 转发给上游（默认否，见 README 的安全说明）
    allowAuth: bool(e.ALLOW_AUTH, false),
    blockedUAs: [...DEFAULT_BLOCKED_UA, ...parseList(e.BLOCKED_UA), ...parseList(e.UA)],
    // 页面上的仓库入口是写死的（见 pages.js 的 REPO_URL），不是配置项：
    // 这个页面属于本项目，别人 fork 了要改，改源码里那一行即可。
    // 主页伪装（沿用上游语义）
    disguiseNginx: Boolean(urlIsNginx),
    homeRedirect: absoluteHttp(url302) || (urlRaw && !urlIsNginx ? absoluteHttp(urlRaw) : ''),
  }
}

/**
 * 伪装变量只接受完整的 http(s) 地址。
 *
 * 少了 scheme（`URL=example.com` 是最常见的误配）时 `Response.redirect` 会抛
 * 「Failed to parse URL」，于是每次访问首页都变成 500。这里提前判掉：非法值
 * 当作没配，回退到说明页——宁可露出自己的页面，也不要一个打不开的首页。
 *
 * @param {string} raw
 * @returns {string}
 */
function absoluteHttp(raw) {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}
