'use strict'

// ============================================================================
// 上游请求：自己跟随重定向，带总时限
//
// 这是与上游 cmliu/CF-Workers-GitHub（MIT, CMLiussss）差异最大的部分：
// 上游用 `redirect:'manual'` + 「命中白名单就把 302 回写给客户端」，
// 导致客户端要再请求一次 Worker 才拿到文件（多走一跳 github.com 网页链路，
// 带 _gh_sess cookie，实测完整下载 90 秒、Range 直接超时）。
// 这里改为由 Worker 自己把整条链跟完，只回最终响应。
//
// 为什么不用 `redirect: 'follow'`：
//   1. 内置跟随无法限制跳转次数（Cloudflare 上限 20 跳，异常上游可以打满）；
//   2. 需要在上游卡住时主动放弃，而不是让请求挂到平台超时。
// ============================================================================

/**
 * 带总时限地取上游响应，自己跟随重定向。
 *
 * @param {string} href 起始 URL
 * @param {RequestInit} init 请求参数
 * @param {number} timeoutMs 单跳「拿到响应头」的上限（毫秒）
 * @param {number} maxRedirects 最多跟随几跳
 * @param {typeof fetch} fetchImpl 便于测试注入
 * @returns {Promise<Response|null>} null 表示跳转次数超限
 */
export async function fetchFollowingRedirects(href, init, timeoutMs, maxRedirects, fetchImpl = fetch) {
  let current = href
  let currentInit = { ...init, redirect: 'manual' }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(current, { ...currentInit, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }

    const status = res.status
    const loc = res.headers.get('location')
    if (status >= 300 && status < 400 && loc) {
      // 丢弃这一跳的响应体，别占着连接
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略：某些实现不支持 cancel */
      }
      current = new URL(loc, current).href
      const method = currentInit.method || 'GET'
      if (status === 307 || status === 308) {
        // 307/308 要求原样重放方法 + 请求体；请求体是流，重放不了。
        // GET/HEAD 没有体，照原样再发一次；带体的请求把这一跳交回客户端，别假装跟到底。
        if (method !== 'GET' && method !== 'HEAD') return res
        currentInit = { ...currentInit, redirect: 'manual' }
      } else {
        // 301/302/303：浏览器与 curl 都会把方法降级成 GET，并丢掉体的相关头。
        // 不清理的话，GET 请求会带着上一跳的 Content-Length/Content-Type 发出去（上游可能直接 400）。
        const headers = new Headers(currentInit.headers || {})
        for (const name of ['content-length', 'content-type', 'content-encoding', 'transfer-encoding']) {
          headers.delete(name)
        }
        currentInit = {
          method: method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
          redirect: 'manual',
        }
      }
      continue
    }
    return res
  }
  return null
}

/**
 * 解析重定向链（仅用于测试与排障）：返回每一跳的 URL。
 * @param {string} href
 * @param {typeof fetch} fetchImpl
 * @param {number} maxRedirects
 */
export async function traceRedirects(href, fetchImpl = fetch, maxRedirects = 5) {
  const hops = []
  let current = href
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchImpl(current, { redirect: 'manual' })
    hops.push({ url: current, status: res.status })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href
      continue
    }
    break
  }
  return hops
}
