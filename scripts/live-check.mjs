'use strict'

// ============================================================================
// 真机联调：在 Node 里直接跑 Worker（Node 有 fetch/Headers/Request/Response/AbortController，
// 与 Cloudflare 的运行时接口一致），对真实 GitHub 发请求。
//
// 这一组不是单元测试，需要联网，所以单独跑：
//   node scripts/live-check.mjs
//
// 它验证的是本次改造的核心：
//   客户端只发一次请求，302 由 Worker 内部跟完，不回写 302、不带 Set-Cookie。
// ============================================================================

import { createHash } from 'node:crypto'

import worker from '../src/index.js'

const ENV = {
  PREFIX: '/',
  JSDELIVR: '0',
  CACHE_TTL: '300',
  IMMUTABLE_CACHE_TTL: '86400',
  UPSTREAM_TIMEOUT: '30000',
  MAX_REDIRECTS: '5',
  ALLOW_AUTH: '0',
  BLOCKED_UA: 'netcraft',
}

const ORIGIN = 'https://gh.test'
const CTX = { waitUntil() {} }

/** 发一次「客户端视角」的请求给 Worker */
async function callWorker(pathAndQuery, { method = 'GET', headers = {} } = {}) {
  const req = new Request(ORIGIN + pathAndQuery, { method, headers })
  const t0 = Date.now()
  const res = await worker.fetch(req, ENV, CTX)
  return { res, ms: Date.now() - t0 }
}

let pass = 0
let fail = 0

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ✖ ${name}${detail ? '  ' + detail : ''}`)
  }
}

async function main() {
  const assetPath =
    '/https://github.com/geekMus/container-autoupdate/releases/latest/download/container-autoupdate.sh'
  const expectSize = 68917
  const expectSha = '8a21d06da79672b91f9a3bfd367f090ea481260531e8a708ae6627331773d6dc'

  // ---------------------------------------------------------------------
  console.log('\n[1] latest 资产：一次请求拿到文件（核心）')
  {
    const { res, ms } = await callWorker(assetPath)
    const buf = Buffer.from(await res.arrayBuffer())
    const sha = createHash('sha256').update(buf).digest('hex')

    ok('状态码是 200（不是把 302 回给客户端）', res.status === 200, `实际 ${res.status}`)
    ok('没有 location 响应头（说明 Worker 自己跟完了）', res.headers.get('location') === null)
    ok('没有 set-cookie（说明没走 github 网页前端）', res.headers.get('set-cookie') === null)
    ok('字节数正确', buf.length === expectSize, `${buf.length} / ${expectSize}`)
    ok('sha256 与官方一致', sha === expectSha, sha.slice(0, 16) + '…')
    ok('content-type 是文件而不是 html', (res.headers.get('content-type') || '').includes('octet-stream'), res.headers.get('content-type') || '(无)')
    ok('带缓存头', (res.headers.get('cache-control') || '').includes('max-age'), res.headers.get('cache-control') || '(无)')
    ok('耗时在合理范围', ms < 15000, `${ms}ms`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[2] Range 请求（引导器探测版本时用的就是这个）')
  {
    const { res, ms } = await callWorker(assetPath, { headers: { Range: 'bytes=0-4000' } })
    const buf = Buffer.from(await res.arrayBuffer())
    ok('状态码 206', res.status === 206, `实际 ${res.status}`)
    ok('只返回 4001 字节', buf.length === 4001, `${buf.length}`)
    ok('content-range 正确', (res.headers.get('content-range') || '').includes('0-4000'), res.headers.get('content-range') || '(无)')
    const text = buf.toString('utf8')
    ok('前 4KB 里能读到 VERSION', /^VERSION="[^"]+"/m.test(text))
    ok('耗时远低于改造前的 90 秒超时', ms < 15000, `${ms}ms`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[3] HEAD 请求')
  {
    const { res, ms } = await callWorker(assetPath, { method: 'HEAD' })
    ok('状态码 200', res.status === 200, `实际 ${res.status}`)
    ok('content-length 正确', res.headers.get('content-length') === String(expectSize), res.headers.get('content-length') || '(无)')
    ok('没有 set-cookie', res.headers.get('set-cookie') === null)
    ok('耗时在合理范围', ms < 15000, `${ms}ms`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[4] 省略 github.com 的裸路径')
  {
    const { res } = await callWorker('/geekMus/container-autoupdate/releases/latest/download/container-autoupdate.sh')
    const buf = Buffer.from(await res.arrayBuffer())
    ok('状态码 200', res.status === 200, `实际 ${res.status}`)
    ok('字节数正确', buf.length === expectSize, `${buf.length}`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[5] 安全：非 GitHub 域名必须 400')
  {
    const { res } = await callWorker('/https://example.com/')
    ok('example.com → 400', res.status === 400, `实际 ${res.status}`)
    const { res: r2 } = await callWorker('/https://evil.com/github.com/o/r')
    ok('把 github.com 塞进路径也 → 400', r2.status === 400, `实际 ${r2.status}`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[6] 首页与伪装页')
  {
    const { res } = await callWorker('/')
    const text = await res.text()
    ok('首页 200', res.status === 200, `实际 ${res.status}`)
    ok('首页是 html', (res.headers.get('content-type') || '').includes('text/html'))
    ok('首页含用法示例', text.includes('粘贴 GitHub 链接') || text.includes('GitHub 文件加速'))

    const { res: r2 } = await callWorker('/https://github.com/o/r/archive/refs/heads/main.zip', {
      headers: { 'User-Agent': 'netcraft-scanner/1.0' },
    })
    const t2 = await r2.text()
    ok('netcraft UA → 伪装页', t2.includes('Welcome to nginx'), `实际 ${r2.status}`)
  }

  // ---------------------------------------------------------------------
  console.log('\n[7] 源码打包（302 到 codeload）')
  {
    const { res, ms } = await callWorker('/https://github.com/geekMus/container-autoupdate/archive/refs/heads/main.zip')
    const ct = res.headers.get('content-type') || ''
    let errBody = ''
    if (res.status !== 200) errBody = (await res.text()).slice(0, 300)
    ok('状态码 200', res.status === 200, `实际 ${res.status}${errBody ? ' / ' + errBody : ''}`)
    ok('没有 location', res.headers.get('location') === null)
    ok('content-type 是 zip', ct.includes('zip'), ct || '(无)')
    ok('耗时在合理范围', ms < 20000, `${ms}ms`)
    if (res.body) {
      try {
        await res.body.cancel()
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n[8] raw 直链')
  {
    const { res } = await callWorker('/https://raw.githubusercontent.com/geekMus/container-autoupdate/main/README.md')
    const text = await res.text()
    ok('状态码 200', res.status === 200, `实际 ${res.status}`)
    ok('拿到的是 README 内容', text.includes('container-autoupdate'))
  }

  // ---------------------------------------------------------------------
  console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('联调脚本异常：', err)
  process.exit(2)
})
