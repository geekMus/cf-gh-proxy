// 验证两个构建产物与源码 src/index.js 行为完全一致。
// 做法：同一组请求分别打到「源码模块」和每个「单文件产物」，逐项比对状态码/头/正文。
//
// 为什么要测两个产物：_worker.min.js 是**部署版本**，_worker.js 是给人看的。
// 两者都由同一份源码构建，但压缩可能改变行为（例如正则、字符串转义、ASI 边界），
// 所以必须各自与源码逐一比对，不能只测其中一个。

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

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

const srcWorker = (await import('../src/index.js')).default

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

// 只比对不依赖网络的路径（首页 / 伪装 / 白名单 / 静态行为）
const cases = [
  ['首页说明页', '/', ENV],
  ['UA 伪装', '/', { ...ENV, BLOCKED_UA: 'netcraft' }, 'netcraft-scanner'],
  ['URL=nginx 伪装', '/', { ...ENV, URL: 'nginx' }],
  ['URL302 跳转', '/', { ...ENV, URL302: 'https://t.me/x' }],
  ['非 GitHub 域名被拒', '/example.com/x', ENV],
  // 注意：不要用 `/gh/geekMus/x` 这类「会真的打到 GitHub」的路径来做字节比对——
  // GitHub 的 404 页面每次带不同的 CSRF token，两边字节必然不同，那是用例的问题，
  // 不是构建的问题。这里只用纯本地判定的路径。
  ['前缀剥离后仍拒绝非 GitHub', '/gh/example.com/x', { ...ENV, PREFIX: '/gh' }],
  ['前缀剥离后首页', '/gh', { ...ENV, PREFIX: '/gh' }],
  ['favicon', '/favicon.ico', ENV],
  ['?q= 快捷入口', '/?q=https://github.com/geekMus/container-autoupdate', ENV],
  ['?check 合法链接', '/?check=' + encodeURIComponent('https://github.com/o/r/releases/download/v1/x.zip'), ENV],
  ['?check 网页路径被拒', '/?check=' + encodeURIComponent('github.com/login'), ENV],
  ['?check 空值', '/?check=', ENV],
]

const ARTIFACTS = [
  { file: '_worker.min.js', label: '压缩版（部署用）' },
  { file: '_worker.js', label: '源码版（供阅读）' },
]

for (const art of ARTIFACTS) {
  const url = new URL('../' + art.file, import.meta.url)
  const text = readFileSync(url, 'utf8')
  console.log(`\n--- ${art.label}  ${art.file}  ${Buffer.byteLength(text)} 字节 ---`)
  const worker = (await import(url.href)).default

  for (const [name, path, env, ua] of cases) {
    const headers = ua ? { 'user-agent': ua } : {}
    const req1 = new Request(ORIGIN + path, { headers })
    const req2 = new Request(ORIGIN + path, { headers })

    let r1, r2, err1 = null, err2 = null
    try {
      r1 = await srcWorker.fetch(req1, env, CTX)
    } catch (e) {
      err1 = e.message
    }
    try {
      r2 = await worker.fetch(req2, env, CTX)
    } catch (e) {
      err2 = e.message
    }

    if (err1 || err2) {
      // 两边都报错（例如需要联网）视为一致
      ok(`${name}：两边行为一致（都抛错）`, err1 === err2, `${err1} / ${err2}`)
      continue
    }

    const sameStatus = r1.status === r2.status
    const ct1 = r1.headers.get('content-type')
    const ct2 = r2.headers.get('content-type')
    const loc1 = r1.headers.get('location')
    const loc2 = r2.headers.get('location')
    const b1 = await r1.text()
    const b2 = await r2.text()
    const h1 = createHash('sha256').update(b1).digest('hex')
    const h2 = createHash('sha256').update(b2).digest('hex')

    ok(
      `${name}：状态码/头/正文一致`,
      sameStatus && ct1 === ct2 && loc1 === loc2 && h1 === h2,
      `status ${r1.status}/${r2.status}  body ${h1.slice(0, 8)}/${h2.slice(0, 8)}`
    )
  }

  // 产物本身的形态检查
  ok(`${art.file} 无 import 语句`, !/^\s*import\s/m.test(text))
  ok(`${art.file} 无 require()`, !/\brequire\s*\(/.test(text))
  ok(`${art.file} 无 sourcemap 引用`, !text.includes('sourceMappingURL'))
  ok(
    `${art.file} 有 export default`,
    /export\s*\{[\s\S]*default/.test(text) || /export\s+default/.test(text)
  )
  ok(`${art.file} 含上游归属声明`, text.includes('CMLiussss'))
  ok(`${art.file} 含本项目版权`, text.includes('cf-gh-proxy contributors'))
  ok(`${art.file} 无 __name 噪音`, (text.match(/__name\(/g) || []).length === 0)
  ok(`${art.file} 纯 LF（无 CR）`, (text.match(/\r/g) || []).length === 0)
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
