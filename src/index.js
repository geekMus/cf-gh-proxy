'use strict'

// ============================================================================
// cf-gh-proxy —— GitHub 文件加速（Cloudflare Worker）
//
// 本项目基于 cmliu/CF-Workers-GitHub 演化而来：
//   https://github.com/cmliu/CF-Workers-GitHub  （MIT, Copyright (c) 2025 CMLiussss）
// 上游又源自 hunshcn/gh-proxy 与 EtherDream/jsproxy。
// 沿袭：路由判定、伪装机制（URL / URL302）、?q= 入口、首页形态。
// 重写：代理与重定向处理、超时、缓存、白名单、响应头清洗、模块化拆分。
// 详见 README 的「来源与致谢」。
//
// 请求形态：https://<你的域名><PREFIX><GitHub 原始 URL>
//   例：PREFIX=/ 时
//     https://gh.example.com/https://github.com/u/r/releases/download/v1/x.zip
//     https://gh.example.com/u/r/releases/download/v1/x.zip
// ============================================================================

import { resolveConfig } from './config.js'
import { FAVICON_SVG, renderDisguise, renderErrorPage, renderLanding } from './pages.js'
import { buildTargetUrl, checkTarget, maybeJsdelivrUrl, maybeRewriteBlob, sanitizeUpstreamHeaders, withCacheHeaders } from './proxy.js'
import { fetchFollowingRedirects } from './upstream.js'

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '1728000',
}

// 页面类响应的安全头。都是零成本的静态头，能过 Lighthouse 的 Best Practices
// 里那几条「有没有声明」的检查（HSTS / XFO / COOP / nosniff / Referrer-Policy）。
// 只加在**我们自己的页面**上：代理回来的文件是用户要下载的东西，不该被
// X-Frame-Options 之类的东西改变语义。
const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

// 首页是可缓存的静态页：内容只随部署变化，没必要每个访客都回源一次。
// s-maxage 给边缘，max-age 给浏览器；`?check=` 那类请求另有 no-store。
const LANDING_CACHE = 'public, max-age=300, s-maxage=3600'

const PREFLIGHT = {
  status: 204,
  headers: {
    ...CORS_HEADERS,
    'access-control-allow-headers':
      'Accept,Accept-Language,Authorization,Content-Type,Range,If-None-Match,If-Modified-Since',
  },
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
   */
  async fetch(request, env, ctx) {
    // 最外层兜底：任何没预料到的异常都在这里收住。
    //
    // 为什么必须有这一层：Worker 里抛出的异常在 Cloudflare 上表现为 1101
    // （「Worker threw exception」），客户端只拿到一个空白错误页，日志之外
    // 没有任何线索。把异常转成一个可读的 500，既能让用户知道发生了什么，
    // 也能避免「页面全白」这种最难排查的形态。
    try {
      return await route(request, env, ctx)
    } catch (err) {
      // 对外只说「内部错误」，具体异常只写日志。
      // 原样回显 err.message 会把内部 URL、上游地址、解析细节漏给客户端，
      // 而这些信息对使用者没有帮助（他要的是一个可读的 500，不是堆栈）。
      console.error('cf-gh-proxy 未捕获异常：', err && err.stack ? err.stack : err)
      try {
        return textResponse('内部错误：请求处理失败，详情见 Worker 日志', 500)
      } catch {
        // 连 textResponse 都失败（极罕见）时，给一个绝对最小化的响应
        return new Response('Internal Error', { status: 500 })
      }
    }
  },
}

/**
 * 真正的路由。所有分支都在 `fetch` 的 try 里被保护。
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 */
async function route(request, env, ctx) {
  const cfg = resolveConfig(env)
  const url = new URL(request.url)

  // ---- 1. 伪装：命中屏蔽 UA 时返回 nginx 页 ------------------------------
  const ua = (request.headers.get('User-Agent') || '').toLowerCase()
  if (cfg.blockedUAs.length && cfg.blockedUAs.some((k) => ua.includes(k))) {
    return htmlResponse(renderDisguise())
  }

  // ---- 2. CORS 预检 ------------------------------------------------------
  // 任何 OPTIONS 都当预检处理：浏览器对 PUT/PATCH/DELETE 发预检时，
  // 只有带自定义头才会带 `access-control-request-headers`；没有这个头时
  // 若把请求当普通 OPTIONS 转给上游，返回里就缺 allow-methods，预检会失败。
  if (request.method === 'OPTIONS') {
    return new Response(null, PREFLIGHT)
  }

  // ---- 3. ?check= 校验接口 -----------------------------------------------
  // 首页那个输入框用它做「先问再跳」。这样前端不需要维护第二份校验规则：
  // 页面说什么、服务端就做什么，永远不会漂移（上一版就是两份规则各自演化）。
  const checkRaw = url.searchParams.get('check')
  if (checkRaw) {
    return handleCheck(checkRaw)
  }

  // ---- 4. ?q= 便捷入口：把裸链接转成前缀形式 -----------------------------
  const q = url.searchParams.get('q')
  if (q) {
    const target = buildTargetUrl(q)
    if (!target) {
      return badRequest(request, cfg, '无法解析这个链接')
    }
    const verdict = checkTarget(target)
    if (!verdict.ok) {
      return badRequest(request, cfg, verdict.reason || '这个链接不是可加速的 GitHub 文件')
    }
    // 用 302 而不是 301：301 会被浏览器永久缓存，之后换域名/换前缀就再也回不来。
    return Response.redirect(`${url.origin}${cfg.prefix}${target.href}`, 302)
  }

  // ---- 5. favicon -------------------------------------------------------
  // 图标是页面自己的一部分：内联 SVG，和 <head> 里那个 data URI 是同一张图。
  // 这里不再对外部站点发 fetch——没有网络抖动、上游 5xx、被墙这些失败面，
  // 也不违反「零外部资源」这条硬约束。
  if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/favicon.ico`) {
    return new Response(FAVICON_SVG, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=86400',
        ...PAGE_HEADERS,
      },
    })
  }

  // ---- 5b. robots.txt ----------------------------------------------------
  // 说明页是可以被索引的（它就是这个服务本身），给抓取方一份明确的允许规则；
  // 不加的话 `/robots.txt` 会被当成「资源路径」走代理校验，回一个 400，
  // 抓取工具看到的是「站点拒绝抓取」。
  if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/robots.txt`) {
    return new Response('User-agent: *\nAllow: /\n', {
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'cache-control': 'public, max-age=86400',
        ...PAGE_HEADERS,
      },
    })
  }

  // ---- 6. 首页 -----------------------------------------------------------
  const stripped = stripPrefix(url, cfg.prefix)
  if (stripped === null) {
    return renderHome(cfg, url, ctx)
  }

  // ---- 7. 代理 -----------------------------------------------------------
  const target = buildTargetUrl(stripped)
  if (!target) {
    return badRequest(request, cfg, '无法解析这个链接')
  }
  const verdict = checkTarget(target)
  if (!verdict.ok) {
    return badRequest(request, cfg, verdict.reason || '这个链接不是可加速的 GitHub 文件')
  }

  // /blob/ 是网页，换成 raw 才能拿到文件字节（见 maybeRewriteBlob 注释）
  const rawTarget = maybeRewriteBlob(target) || target

  // 可选：分支单文件改写走 jsDelivr（默认关闭，见 maybeJsdelivrUrl 注释）
  const viaCdn = maybeJsdelivrUrl(rawTarget, cfg)

  return handleProxy(request, viaCdn || rawTarget, cfg, ctx)
}

/**
 * `?check=<链接>` 的应答。永远返回 200 + JSON（它是一个「询问」，
 * 不是一个失败），让前端只写一条 happy path。
 *
 * 响应带 no-store：校验结果不能进 CDN 缓存，否则换了目标却拿到旧结论。
 *
 * @param {string} raw 用户给的原始链接
 */
function handleCheck(raw) {
  const target = buildTargetUrl(raw)
  if (!target) {
    return jsonResponse({ ok: false, reason: '无法解析这个链接' })
  }
  const verdict = checkTarget(target)
  if (!verdict.ok) {
    return jsonResponse({ ok: false, reason: verdict.reason || '这个链接不是可加速的 GitHub 文件' })
  }
  return jsonResponse({ ok: true, href: target.href, kind: verdict.kind || '' })
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  })
}

function htmlResponse(html, extra = {}) {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...PAGE_HEADERS, ...extra },
  })
}

// ---------------------------------------------------------------------------
// 路由辅助
// ---------------------------------------------------------------------------

/**
 * 首页。沿用上游 cmliu/CF-Workers-GitHub 的两个伪装变量：
 *   URL302 → 主页 302 跳走（优先级最高）
 *   URL    → 主页伪装成该地址；设为 `nginx` 则返回 nginx 默认页
 * 都没设时返回本项目的说明页。
 */
function renderHome(cfg, url, ctx) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302)
  }
  if (cfg.disguiseNginx) {
    return htmlResponse(renderDisguise())
  }
  const html = renderLanding(cfg, url ? url.origin : '')
  return cachedHtml(cfg, url, ctx, html)
}

/**
 * 说明页是纯静态的（只依赖 prefix），但默认不会被 CF 的边缘缓存接住——
 * 每条 HTML 请求都要真的跑到 Worker。这里显式写进 Cache API：第一个访客
 * 之后，同一个 PoP 上的后续请求直接命中边缘，TTFB 从「绕一圈」变成几毫秒。
 *
 * 只在 GET 且带 ctx 时读写；Node 预览里没有 `caches`，`typeof` 兜住。
 */
async function cachedHtml(cfg, url, ctx, html) {
  const headers = {
    'content-type': 'text/html; charset=UTF-8',
    ...PAGE_HEADERS,
    'cache-control': LANDING_CACHE,
  }
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null
  if (!cache || !url || !ctx || typeof ctx.waitUntil !== 'function') {
    return new Response(html, { status: 200, headers })
  }

  const key = new Request(`${url.origin}${cfg.prefix}`, { method: 'GET' })
  const hit = await cache.match(key)
  if (hit) return hit

  const res = new Response(html, { status: 200, headers })
  ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}))
  return res
}

/**
 * 去掉前缀，得到 GitHub 侧的原始路径（可能形如 `https://github.com/...` 或 `u/r/...`）。
 * 返回 null 表示「这不是一个资源请求」（应该给首页）。
 */
function stripPrefix(url, prefix) {
  let rest
  if (prefix === '/') {
    rest = url.pathname.slice(1) + url.search
  } else {
    const bare = prefix.replace(/\/$/, '')
    if (url.pathname !== bare && !url.pathname.startsWith(bare + '/')) return null
    rest = url.pathname.slice(bare.length)
    // `/gh` 本身（后面没东西）也当首页
    if (!rest || rest === '/') return null
    rest = rest.replace(/^\//, '') + url.search
  }
  // 只有查询串（`/?cb=123`）：这是访问首页时带的缓存参数，不是资源路径
  if (!rest || rest.startsWith('?')) return null
  return rest
}

function textResponse(body, status = 200) {
  return new Response(body + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=UTF-8', ...CORS_HEADERS },
  })
}

/**
 * 链接不合法时的响应。
 *
 * 浏览器（Accept 含 text/html）给一页可读的说明，含返回首页的链接；
 * 命令行（curl / wget）给纯文本，方便脚本 grep。
 *
 * @param {Request} request
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {string} reason
 */
function badRequest(request, cfg, reason) {
  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html')
  if (!wantsHtml) {
    return textResponse(`不是可加速的 GitHub 文件：${reason}`, 400)
  }
  return new Response(renderErrorPage(cfg, reason, new URL(request.url).origin), {
    status: 400,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...PAGE_HEADERS, ...CORS_HEADERS },
  })
}

// ---------------------------------------------------------------------------
// 代理主流程
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {URL} target
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 */
async function handleProxy(request, target, cfg, ctx) {
  const method = request.method
  const isHead = method === 'HEAD'

  // 只透传必要请求头。**默认不转发 Cookie / Authorization**：
  // 这个 Worker 是公开服务，把访问者凭据送给上游既无必要也不安全。
  const upstreamHeaders = new Headers()
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase()
    if ((key === 'cookie' || key === 'authorization') && !cfg.allowAuth) continue
    if (SKIP_REQUEST_HEADERS.has(key)) continue
    upstreamHeaders.set(k, v)
  }

  // Range 必须原样带上，否则「只取前 4KB 探测版本」的请求会退化成全量下载。
  const range = request.headers.get('Range')
  if (range) {
    upstreamHeaders.set('Range', range)
    // Range + 压缩不能同时要：上游会按「压缩后的表示」切字节，回来的是压缩流碎片。
    // 这里显式要 identity（Cloudflare 的边缘 fetch 未必听，所以下面还有兜底）。
    upstreamHeaders.set('Accept-Encoding', 'identity')
  }

  const init = { method, headers: upstreamHeaders }
  if (!isHead && method !== 'GET' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }

  let res
  try {
    // 关键：由 Worker 自己把整条重定向链跟完，只回最终响应。
    res = await fetchFollowingRedirects(target.href, init, cfg.upstreamTimeout, cfg.maxRedirects)
  } catch (err) {
    console.error('上游请求失败：', err)
    return textResponse('上游请求失败', 502)
  }

  if (!res) {
    return textResponse('上游重定向次数过多', 508)
  }

  // Range 落在「压缩后的表示」上时，206 是不可用的：上游按 br/gzip 的字节切，
  // 回来的 content-range 总数是压缩长度，正文是压缩流碎片——客户端续传拼出来
  // 的文件是坏的（实测 37913 字节的文本报成 13173 字节的「总数」）。
  //
  // 怎么判断「这是压缩表示」：Cloudflare 会把 subrequest 的 `content-encoding`
  // 头抹掉（v1.2.3/v1.2.4 实测都拿不到），但它会保留弱 ETag —— `W/` 前缀正是
  // RFC 7232 里「语义相同、字节不同」的标记，压缩就是这种情况。所以两路信号
  // 任一命中就认压缩。二进制资产不会被压缩，走不到这里。
  //
  // 判成压缩表示后别给 206：丢掉 Range 重取全量回 200，让客户端从头下——
  // 慢一点，但拿到的一定是原始字节，不会写坏文件。
  const compressedEtag = /^W\//i.test(res.headers.get('etag') || '')
  // 只在「上游确实按 Range 返回了 206」且请求体没被消费过时才重取：
  //   - 上游忽略 Range、直接回 200/416 时，重取等于白下一遍整包（大文件尤其致命）；
  //   - POST/PUT 带 Range 时 `init.body` 已经被这次 fetch 消费掉，第二次 fetch
  //     会抛「body object should not be disturbed or locked」，只能放弃重取。
  const canRetry = res.status === 206 && !init.body
  if (range && canRetry && (res.headers.has('content-encoding') || compressedEtag)) {
    try {
      await res.body?.cancel()
    } catch {
      /* 取消失败不影响后续重取 */
    }
    const fullHeaders = new Headers(upstreamHeaders)
    fullHeaders.delete('Range')
    const retry = { ...init, headers: fullHeaders }
    try {
      res = await fetchFollowingRedirects(target.href, retry, cfg.upstreamTimeout, cfg.maxRedirects)
    } catch (err) {
      console.error('range 重取失败：', err)
      return textResponse('上游请求失败', 502)
    }
    if (!res) {
      return textResponse('上游重定向次数过多', 508)
    }
  }

  // ---- 响应头清洗 ---------------------------------------------------------
  const outHeaders = sanitizeUpstreamHeaders(res.headers)
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('access-control-expose-headers', '*')

  // ---- 边缘缓存 -----------------------------------------------------------
  // 200 才加公共缓存头：完整资源按 URL 缓存是安全的。
  //
  // 206 不加：它是「某个 Range 的片段」，而缓存键里没有 Range。一旦边缘把片段
  // 当成这个 URL 的表示，后续整文件请求可能拿到半个文件。给 no-store 是明确的
  // 「别缓存」。断点续传因此少一层边缘命中，换的是不会拿错字节。
  //
  // ALLOW_AUTH=1 时响应可能因人而异，同样一律私有：共享缓存不能把 A 的授权
  // 内容发给 B。
  if (res.status === 200 && method === 'GET') {
    const personalized = cfg.allowAuth && (request.headers.has('authorization') || request.headers.has('cookie'))
    const ttl = pickCacheTtl(target, cfg, res.url)
    withCacheHeaders(outHeaders, ttl, res.headers, { noStore: personalized })
  } else if (res.status === 206) {
    outHeaders.set('cache-control', 'no-store')
    outHeaders.set('vary', 'Range')
    outHeaders.delete('cdn-cache-control')
  }

  return new Response(res.body, { status: res.status, headers: outHeaders })
}

/**
 * 可变资源用短缓存，不可变资源用长缓存。
 *
 * 判据看**最终响应**的地址：`github.com/.../releases/download/v1/x.zip` 会 302 到
 * `release-assets.githubusercontent.com`，只看请求地址会把它当可变资源、白拿 300 秒。
 * 唯一的例外是 `releases/latest/`：它指向「当前最新」，缓存一天会让新版本迟一天才出现。
 *
 * @param {URL} target 请求侧解析出来的目标地址
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {string} [finalUrl] 跟随重定向之后的最终地址（res.url）
 */
function pickCacheTtl(target, cfg, finalUrl) {
  if (/\/releases\/latest\//.test(target.pathname)) return cfg.cacheTtl
  let url = target
  if (finalUrl) {
    try {
      url = new URL(finalUrl)
    } catch {
      /* 非法 url 就退回请求侧地址 */
    }
  }
  const path = url.pathname
  // release 资产走 release-assets 域名，天然不可变
  if (url.hostname === 'release-assets.githubusercontent.com') return cfg.immutableCacheTtl
  if (url.hostname === 'objects.githubusercontent.com') return cfg.immutableCacheTtl
  // raw 用 40 位 commit SHA 时不可变；用分支名时可变的
  if (url.hostname === 'raw.githubusercontent.com') {
    const seg = path.split('/').filter(Boolean)
    // /owner/repo/<ref>/<file...>
    const ref = seg[2] || ''
    if (/^[0-9a-f]{40}$/i.test(ref)) return cfg.immutableCacheTtl
    return cfg.cacheTtl
  }
  // codeload 打包：按分支名会变，按 SHA 不变
  if (url.hostname === 'codeload.github.com') {
    if (/\/zip\/[0-9a-f]{40}$/i.test(path) || /\/tar\.gz\/[0-9a-f]{40}$/i.test(path)) {
      return cfg.immutableCacheTtl
    }
    return cfg.cacheTtl
  }
  return cfg.cacheTtl
}

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  // Cloudflare 会自己处理压缩；转发客户端的 accept-encoding 会让上游按
  // 客户端能力压缩，边缘缓存就无法共享了。
  'accept-encoding',
])
