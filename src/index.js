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
import { renderLanding, renderDisguise, renderErrorPage } from './pages.js'
import { buildTargetUrl, checkTarget, maybeJsdelivrUrl, maybeRewriteBlob, sanitizeUpstreamHeaders, withCacheHeaders } from './proxy.js'
import { fetchFollowingRedirects } from './upstream.js'

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '1728000',
}

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
    const cfg = resolveConfig(env)
    const url = new URL(request.url)

    // ---- 1. 伪装：命中屏蔽 UA 时返回 nginx 页 ------------------------------
    const ua = (request.headers.get('User-Agent') || '').toLowerCase()
    if (cfg.blockedUAs.length && cfg.blockedUAs.some((k) => ua.includes(k))) {
      return new Response(renderDisguise(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=UTF-8' },
      })
    }

    // ---- 2. CORS 预检 ------------------------------------------------------
    if (request.method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
      return new Response(null, PREFLIGHT)
    }

    // ---- 3. ?q= 便捷入口：把裸链接转成前缀形式 -----------------------------
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

    // ---- 4. favicon -------------------------------------------------------
    if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/favicon.ico`) {
      const light = 'https://github.githubassets.com/favicons/favicon.png'
      const dark = 'https://github.githubassets.com/favicons/favicon-dark.png'
      const preferLight = request.headers.get('sec-ch-prefers-color-scheme') === 'light'
      return fetch(preferLight ? light : dark, { cf: { cacheTtl: 86400 } })
    }

    // ---- 5. 首页 -----------------------------------------------------------
    const stripped = stripPrefix(url, cfg.prefix)
    if (stripped === null) {
      return renderHome(cfg)
    }

    // ---- 6. 代理 -----------------------------------------------------------
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
  },
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
function renderHome(cfg) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302)
  }
  if (cfg.disguiseNginx) {
    return new Response(renderDisguise(), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    })
  }
  return new Response(renderLanding(cfg), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  })
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
    if (!url.pathname.startsWith(bare)) return null
    rest = url.pathname.slice(bare.length)
    // `/gh` 本身（后面没东西）也当首页
    if (!rest || rest === '/') return null
    rest = rest.replace(/^\//, '') + url.search
  }
  if (!rest) return null
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
  return new Response(renderErrorPage(cfg, reason), {
    status: 400,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...CORS_HEADERS },
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
  if (range) upstreamHeaders.set('Range', range)

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
    return textResponse(`上游请求失败：${err && err.message ? err.message : err}`, 502)
  }

  if (!res) {
    return textResponse('上游重定向次数过多', 508)
  }

  // ---- 响应头清洗 ---------------------------------------------------------
  const outHeaders = sanitizeUpstreamHeaders(res.headers)
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('access-control-expose-headers', '*')

  // ---- 边缘缓存 -----------------------------------------------------------
  // 只有 200 / 206 这类「带完整资源」的状态才加缓存头；3xx/4xx/5xx 原样返回。
  const cacheable = res.status === 200 || res.status === 206
  if (cacheable && method === 'GET') {
    withCacheHeaders(outHeaders, pickCacheTtl(target, cfg), res.headers)
  }

  return new Response(res.body, { status: res.status, headers: outHeaders })
}

/** 可变资源用短缓存，不可变资源用长缓存。 */
function pickCacheTtl(target, cfg) {
  const path = target.pathname
  // release 资产走 release-assets 域名，天然不可变
  if (target.hostname === 'release-assets.githubusercontent.com') return cfg.immutableCacheTtl
  if (target.hostname === 'objects.githubusercontent.com') return cfg.immutableCacheTtl
  // raw 用 40 位 commit SHA 时不可变；用分支名时可变的
  if (target.hostname === 'raw.githubusercontent.com') {
    const seg = path.split('/').filter(Boolean)
    // /owner/repo/<ref>/<file...>
    const ref = seg[2] || ''
    if (/^[0-9a-f]{40}$/i.test(ref)) return cfg.immutableCacheTtl
    return cfg.cacheTtl
  }
  // codeload 打包：按分支名会变，按 SHA 不变
  if (target.hostname === 'codeload.github.com') {
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
