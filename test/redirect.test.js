'use strict'

// 重定向跟随的行为测试（纯桩，无网络）。
// 这一组是本次改造的核心：上游那版把 302 回写给客户端，导致要请求两次 Worker。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchFollowingRedirects, traceRedirects } from '../src/upstream.js'

/** 造一个 Response，body 是给定文本 */
function resp(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers })
}

/** 记录调用过程的桩 fetch */
function makeStub(handler) {
  const calls = []
  const stub = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init, calls.length)
  }
  stub.calls = calls
  return stub
}

test('跟随一次 302：Worker 自己跟完，只回最终 200', async () => {
  const stub = makeStub((url) => {
    if (url === 'https://github.com/o/r/releases/download/v1/x.zip') {
      return resp('', {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/asset/123' },
      })
    }
    if (url === 'https://release-assets.githubusercontent.com/asset/123') {
      return resp('FILE-BYTES', { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    throw new Error(`未预期的 URL: ${url}`)
  })

  const res = await fetchFollowingRedirects(
    'https://github.com/o/r/releases/download/v1/x.zip',
    { method: 'GET', headers: new Headers() },
    30000,
    5,
    stub,
  )

  assert.equal(res.status, 200, '最终应拿到 200，而不是把 302 回给客户端')
  assert.equal(await res.text(), 'FILE-BYTES')
  // 关键断言：Worker 自己发了两次请求（不是让客户端再请求一次）
  assert.equal(stub.calls.length, 2)
  assert.equal(stub.calls[0].url, 'https://github.com/o/r/releases/download/v1/x.zip')
  assert.equal(stub.calls[1].url, 'https://release-assets.githubusercontent.com/asset/123')
})

test('跟随两次 302（latest 那条链）', async () => {
  // 真实链路：latest → github.com/…/v0.3.2/… → release-assets
  const stub = makeStub((url) => {
    if (url.includes('/releases/latest/download/')) {
      return resp('', {
        status: 302,
        headers: { location: '/o/r/releases/download/v1/x.zip' },
      })
    }
    if (url.includes('/releases/download/v1/')) {
      return resp('', {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/a' },
      })
    }
    return resp('OK', { status: 200 })
  })

  const res = await fetchFollowingRedirects(
    'https://github.com/o/r/releases/latest/download/x.zip',
    { method: 'GET', headers: new Headers() },
    30000,
    5,
    stub,
  )

  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'OK')
  assert.equal(stub.calls.length, 3)
})

test('相对路径的 Location 能正确解析', async () => {
  const stub = makeStub((url) => {
    if (url === 'https://github.com/o/r/releases/latest/download/x.zip') {
      // 上游真实返回的就是相对路径
      return resp('', { status: 302, headers: { location: '/o/r/releases/download/v1/x.zip' } })
    }
    return resp('FINAL', { status: 200 })
  })

  const res = await fetchFollowingRedirects(
    'https://github.com/o/r/releases/latest/download/x.zip',
    { method: 'GET', headers: new Headers() },
    30000,
    5,
    stub,
  )
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'FINAL')
  assert.equal(stub.calls[1].url, 'https://github.com/o/r/releases/download/v1/x.zip')
})

test('跳转次数超限返回 null', async () => {
  const stub = makeStub((url, init, n) =>
    resp('', { status: 302, headers: { location: `https://github.com/loop/${n}` } }),
  )
  const res = await fetchFollowingRedirects('https://github.com/start', { method: 'GET' }, 30000, 3, stub)
  assert.equal(res, null)
  assert.equal(stub.calls.length, 4) // 1 起始 + 3 次跟随
})

test('302 之后方法降级为 GET（HEAD 保持 HEAD）', async () => {
  const stub = makeStub((url, init) => {
    if (url === 'https://github.com/o/r/releases/download/v1/x.zip') {
      return resp('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a' } })
    }
    assert.equal(init.method, 'GET')
    return resp('BYTES', { status: 200 })
  })

  const res = await fetchFollowingRedirects(
    'https://github.com/o/r/releases/download/v1/x.zip',
    { method: 'POST', headers: new Headers() },
    30000,
    5,
    stub,
  )
  assert.equal(res.status, 200)
})

test('HEAD 请求保持 HEAD', async () => {
  const stub = makeStub((url, init) => {
    if (url === 'https://github.com/o/r/releases/download/v1/x.zip') {
      return resp('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a' } })
    }
    assert.equal(init.method, 'HEAD')
    return resp('', { status: 200, headers: { 'content-length': '68917' } })
  })

  const res = await fetchFollowingRedirects(
    'https://github.com/o/r/releases/download/v1/x.zip',
    { method: 'HEAD', headers: new Headers() },
    30000,
    5,
    stub,
  )
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-length'), '68917')
})

test('上游超时会被中止（不会挂到平台上限）', async () => {
  const stub = async (url, init) => {
    // 永不 resolve，只在 signal abort 时 reject
    return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  }
  await assert.rejects(
    () => fetchFollowingRedirects('https://github.com/slow', { method: 'GET' }, 50, 5, stub),
    /aborted/,
  )
})

test('traceRedirects 能打印出完整链路（排障用）', async () => {
  const stub = makeStub((url) => {
    if (url.includes('/latest/')) {
      return resp('', { status: 302, headers: { location: '/o/r/releases/download/v1/x.zip' } })
    }
    if (url.includes('/releases/download/')) {
      return resp('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/a' } })
    }
    return resp('X', { status: 200 })
  })
  const hops = await traceRedirects('https://github.com/o/r/releases/latest/download/x.zip', stub)
  assert.equal(hops.length, 3)
  assert.equal(hops[0].status, 302)
  assert.equal(hops[1].status, 302)
  assert.equal(hops[2].status, 200)
})
