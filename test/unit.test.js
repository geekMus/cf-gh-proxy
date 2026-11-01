'use strict'

// 单元测试：不需要网络，用桩 fetch 覆盖 URL 构建、白名单、重定向跟随、响应头清洗。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { buildTargetUrl, isAllowedTarget, sanitizeUpstreamHeaders } from '../src/proxy.js'
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
// 响应头清洗
// ---------------------------------------------------------------------------

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

test('Range 打到压缩表示上：不给 206，丢掉 Range 重取全量', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const h = new Headers(init && init.headers)
    calls.push(h)
    if (h.has('range')) {
      // 上游按 br 表示切片：content-range 是压缩后的长度，正文是压缩流
      return new Response('compressed', {
        status: 206,
        headers: { 'content-type': 'text/plain', 'content-encoding': 'br', 'content-range': 'bytes 0-9/13' },
      })
    }
    return new Response('full-body', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
  try {
    const res = await worker.fetch(
      new Request('https://gh.test/https://raw.githubusercontent.com/o/r/main/x.js', { headers: { Range: 'bytes=0-9' } }),
      {},
      { waitUntil() {} }
    )
    assert.equal(res.status, 200, '压缩表示上的 206 不可用，必须回 200')
    assert.equal(await res.text(), 'full-body')
    assert.equal(res.headers.has('content-range'), false)
    assert.equal(calls.length, 2, '先带 Range 试一次，再丢掉 Range 重取')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('Range + 弱 ETag（压缩表示，content-encoding 被边缘抹掉）同样重取全量', async () => {
  let n = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const h = new Headers(init && init.headers)
    n++
    if (h.has('range')) {
      return new Response('sliced', {
        status: 206,
        headers: { 'content-type': 'text/plain', 'etag': 'W/"abc"', 'content-range': 'bytes 0-5/9' },
      })
    }
    return new Response('whole', { status: 200, headers: { 'content-type': 'text/plain', 'etag': '"abc"' } })
  }
  try {
    const res = await worker.fetch(
      new Request('https://gh.test/https://raw.githubusercontent.com/o/r/main/x.js', { headers: { Range: 'bytes=0-5' } }),
      {},
      { waitUntil() {} }
    )
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'whole')
    assert.equal(res.headers.has('content-range'), false)
    assert.equal(n, 2)
  } finally {
    globalThis.fetch = realFetch
  }
})

// ---------------------------------------------------------------------------
// 首页与缓存边界
// ---------------------------------------------------------------------------

test('根路径只带查询串（/?cb=123）仍给首页，不当作资源路径', async () => {
  const res = await worker.fetch(new Request('https://gh.test/?cb=123'), {}, { waitUntil() {} })
  assert.equal(res.status, 200, '带缓存参数的首页不该变成 400')
  assert.match(res.headers.get('content-type') || '', /text\/html/)
})

test('代理响应一律不缓存：200 与 206 都是 no-store，不留 cdn-cache-control', async () => {
  const realFetch = globalThis.fetch
  let status = 200
  globalThis.fetch = async () =>
    new Response('BYTES', {
      status,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400' },
    })
  try {
    const ok = await worker.fetch(
      new Request('https://gh.test/https://github.com/o/r/releases/download/v1/x.zip'),
      {},
      { waitUntil() {} }
    )
    assert.equal(ok.status, 200)
    // 上游说缓存一天也不行：这个服务只交付「此刻上游的字节」
    assert.equal(ok.headers.get('cache-control'), 'no-store')
    assert.equal(ok.headers.get('cdn-cache-control'), 'no-store')

    status = 206
    const ranged = await worker.fetch(
      new Request('https://gh.test/https://github.com/o/r/releases/download/v1/x.zip', {
        headers: { Range: 'bytes=0-3' },
      }),
      {},
      { waitUntil() {} }
    )
    assert.equal(ranged.status, 206)
    assert.equal(ranged.headers.get('cache-control'), 'no-store')
    assert.equal(ranged.headers.get('cdn-cache-control'), 'no-store')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('首页可被抓取：robots 允许索引、有 description 与 canonical', async () => {
  const res = await worker.fetch(new Request('https://gh.test/'), {}, { waitUntil() {} })
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(res.headers.get('content-type'), /text\/html/)
  assert.match(html, /<meta name="robots" content="index,follow">/)
  assert.doesNotMatch(html, /name="robots" content="noindex"/)
  assert.match(html, /<meta name="description" content="[^"]{20,}">/)
  assert.match(html, /<link rel="canonical" href="https:\/\/gh\.test\/">/)
})

test('robots.txt 是允许抓取，不是把 /robots.txt 当资源路径拒绝', async () => {
  const res = await worker.fetch(new Request('https://gh.test/robots.txt'), {}, { waitUntil() {} })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/plain/)
  const text = await res.text()
  assert.match(text, /User-agent: \*/)
  assert.match(text, /Allow: \//)
})

test('首页明确不入缓存（页面要跟着部署走），安全头照旧', async () => {
  const res = await worker.fetch(new Request('https://gh.test/'), {}, { waitUntil() {} })
  assert.equal(res.headers.get('cache-control'), 'no-store', '首页不缓存：边缘缓存会把新部署挡在门外')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=31536000/)
})
