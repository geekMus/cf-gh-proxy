'use strict'

// 单元测试：不需要网络，用桩 fetch 覆盖 URL 构建、白名单、重定向跟随、缓存头。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { buildTargetUrl, isAllowedTarget, sanitizeUpstreamHeaders, withCacheHeaders } from '../src/proxy.js'
import worker from '../src/index.js'

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------

test('resolveConfig：前缀归一化', () => {
  const cases = [
    ['/', '/'],
    ['', '/'],
    ['gh', '/gh/'],
    ['/gh', '/gh/'],
    ['/gh/', '/gh/'],
    ['/a/b', '/a/b/'],
  ]
  for (const [input, want] of cases) {
    assert.equal(resolveConfig({ PREFIX: input }).prefix, want, `PREFIX=${JSON.stringify(input)}`)
  }
})

test('resolveConfig：布尔与数字的容错', () => {
  assert.equal(resolveConfig({ JSDELIVR: '1' }).jsdelivr, true)
  assert.equal(resolveConfig({ JSDELIVR: 'true' }).jsdelivr, true)
  assert.equal(resolveConfig({ JSDELIVR: 'yes' }).jsdelivr, true)
  assert.equal(resolveConfig({ JSDELIVR: '0' }).jsdelivr, false)
  assert.equal(resolveConfig({ JSDELIVR: '' }).jsdelivr, false)
  assert.equal(resolveConfig({}).jsdelivr, false)

  // 非法数字回落默认值
  assert.equal(resolveConfig({ CACHE_TTL: 'abc' }).cacheTtl, 300)
  assert.equal(resolveConfig({ CACHE_TTL: '-1' }).cacheTtl, 300)
  assert.equal(resolveConfig({ CACHE_TTL: '60' }).cacheTtl, 60)
  // upstreamTimeout 有最小值保护
  assert.equal(resolveConfig({ UPSTREAM_TIMEOUT: '10' }).upstreamTimeout, 30000)
  assert.equal(resolveConfig({ UPSTREAM_TIMEOUT: '5000' }).upstreamTimeout, 5000)
})

test('resolveConfig：屏蔽 UA 累积但不污染全局', () => {
  const a = resolveConfig({ BLOCKED_UA: 'foo,bar' })
  assert.deepEqual(a.blockedUAs.sort(), ['bar', 'foo', 'netcraft'].sort())
  // 再解析一次，不会带上上一次的内容（上游那版就是在这里无限增长的）
  const b = resolveConfig({})
  assert.deepEqual(b.blockedUAs, ['netcraft'])
  const c = resolveConfig({ UA: 'baz' })
  assert.deepEqual(c.blockedUAs.sort(), ['baz', 'netcraft'].sort())
})

test('resolveConfig：ALLOW_AUTH 默认关闭', () => {
  assert.equal(resolveConfig({}).allowAuth, false)
  assert.equal(resolveConfig({ ALLOW_AUTH: '1' }).allowAuth, true)
})

// ---------------------------------------------------------------------------
// URL 构建
// ---------------------------------------------------------------------------

test('buildTargetUrl：三种输入形态', () => {
  const full = buildTargetUrl('https://github.com/o/r/releases/download/v1/x.zip')
  assert.equal(full.hostname, 'github.com')
  assert.equal(full.pathname, '/o/r/releases/download/v1/x.zip')

  const noScheme = buildTargetUrl('github.com/o/r/releases/download/v1/x.zip')
  assert.equal(noScheme.hostname, 'github.com')

  const bare = buildTargetUrl('o/r/releases/download/v1/x.zip')
  assert.equal(bare.hostname, 'github.com')
  assert.equal(bare.pathname, '/o/r/releases/download/v1/x.zip')
})

test('buildTargetUrl：纠正被压扁的协议头', () => {
  const u = buildTargetUrl('https:/github.com/o/r/archive/v1.zip')
  assert.equal(u.hostname, 'github.com')
})

test('buildTargetUrl：http 升级为 https', () => {
  const u = buildTargetUrl('http://github.com/o/r/archive/v1.zip')
  assert.equal(u.protocol, 'https:')
})

test('buildTargetUrl：保留 query', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/main/x.sh?token=abc')
  assert.equal(u.searchParams.get('token'), 'abc')
})

test('buildTargetUrl：非法输入返回 null', () => {
  assert.equal(buildTargetUrl(''), null)
  assert.equal(buildTargetUrl('/'), null)
  assert.equal(buildTargetUrl(null), null)
  assert.equal(buildTargetUrl('ftp://github.com/o/r'), null)
})

test('buildTargetUrl：首段含点当域名，不含点当 owner', () => {
  // `o.r` 这种像域名的会被当域名（真实场景里 owner 名不会带点）
  assert.equal(buildTargetUrl('raw.githubusercontent.com/o/r/main/x').hostname, 'raw.githubusercontent.com')
  assert.equal(buildTargetUrl('geekMus/container-autoupdate/main/x').hostname, 'github.com')
})

// ---------------------------------------------------------------------------
// 白名单
// ---------------------------------------------------------------------------

test('isAllowedTarget：只放行 GitHub 域名', () => {
  assert.equal(isAllowedTarget(buildTargetUrl('https://github.com/o/r/archive/v1.zip')), true)
  assert.equal(isAllowedTarget(buildTargetUrl('https://raw.githubusercontent.com/o/r/main/x')), true)
  assert.equal(isAllowedTarget(buildTargetUrl('https://codeload.github.com/o/r/zip/main')), true)
  assert.equal(isAllowedTarget(buildTargetUrl('https://release-assets.githubusercontent.com/x')), true)

  // 这是上游那版的开放代理问题
  assert.equal(isAllowedTarget(buildTargetUrl('https://example.com/')), false)
  assert.equal(isAllowedTarget(buildTargetUrl('https://evil.com/github.com/o/r')), false)
})

test('isAllowedTarget：大小写与子路径欺骗', () => {
  // 主机名大小写不敏感
  assert.equal(isAllowedTarget(buildTargetUrl('https://GitHub.COM/o/r/archive/v1.zip')), true)
  // 用 github.com 作为路径而不是主机
  const spoof = buildTargetUrl('https://evil.com/https://github.com/o/r')
  assert.equal(isAllowedTarget(spoof), false)
})

// ---------------------------------------------------------------------------
// 响应头清洗
// ---------------------------------------------------------------------------

test('sanitizeUpstreamHeaders：删掉 cookie 与 Cloudflare 内部头', () => {
  const h = new Headers({
    'set-cookie': 'a=1',
    'content-type': 'application/octet-stream',
    'content-length': '68917',
    'content-range': 'bytes 0-4000/68917',
    'accept-ranges': 'bytes',
    'content-disposition': 'attachment; filename=x.sh',
    'cf-cache-status': 'DYNAMIC',
    'cf-ray': 'abc',
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-request-id': 'xyz',
    'via': '1.1 varnish',
    'age': '1293',
    'report-to': '{}',
    'nel': '{}',
  })
  const out = sanitizeUpstreamHeaders(h)
  // 必须删
  for (const k of ['set-cookie', 'cf-cache-status', 'cf-ray', 'x-ms-blob-type', 'x-ms-request-id', 'via', 'age', 'report-to', 'nel']) {
    assert.equal(out.has(k), false, `应删除 ${k}`)
  }
  // 必须留
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition']) {
    assert.equal(out.get(k) !== null, true, `应保留 ${k}`)
  }
})

test('sanitizeUpstreamHeaders：保留 etag 与 last-modified', () => {
  const h = new Headers({ etag: '"abc"', 'last-modified': 'Sun, 01 Nov 2026 06:45:32 GMT' })
  const out = sanitizeUpstreamHeaders(h)
  assert.equal(out.get('etag'), '"abc"')
  assert.equal(out.get('last-modified'), 'Sun, 01 Nov 2026 06:45:32 GMT')
})

// ---------------------------------------------------------------------------
// 缓存头
// ---------------------------------------------------------------------------

test('withCacheHeaders：写入 Cache-Control 与 CDN-Cache-Control', () => {
  const h = new Headers()
  const up = new Headers({ 'cache-control': 'public' })
  const out = withCacheHeaders(h, 300, up)
  assert.equal(out.get('cache-control'), 'public, max-age=300')
  assert.equal(out.get('cdn-cache-control'), 'public, max-age=300')
})

test('withCacheHeaders：尊重上游 no-store', () => {
  const h = new Headers()
  const up = new Headers({ 'cache-control': 'no-store' })
  const out = withCacheHeaders(h, 300, up)
  assert.equal(out.get('cache-control'), 'no-store')
  assert.equal(out.has('cdn-cache-control'), false)
})

// ---------------------------------------------------------------------------
// 转发的请求头
// ---------------------------------------------------------------------------

test('带 Range 的请求向上游要 identity，不带 Range 时不动 accept-encoding', async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    seen.push(new Headers(init && init.headers))
    return new Response('body', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  const url = 'https://gh.test/https://raw.githubusercontent.com/o/r/main/x.js'
  try {
    const ranged = await worker.fetch(new Request(url, { headers: { Range: 'bytes=0-99' } }), {}, { waitUntil() {} })
    assert.equal(ranged.status, 200)
    assert.equal(seen[0].get('range'), 'bytes=0-99')
    // 关键：Range 与压缩不能同时要，否则上游按压缩表示切片
    assert.equal(seen[0].get('accept-encoding'), 'identity')

    const plain = await worker.fetch(new Request(url), {}, { waitUntil() {} })
    assert.equal(plain.status, 200)
    assert.equal(seen[1].get('range'), null)
    assert.equal(seen[1].get('accept-encoding'), null)
  } finally {
    globalThis.fetch = realFetch
  }
})
