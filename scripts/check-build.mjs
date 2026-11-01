// 验证构建产物 _worker.js 与源码 src/index.js 行为完全一致
// 做法：同一组请求分别打到「源码模块」和「单文件产物」，逐项比对状态码/头/正文。

import { createHash } from 'node:crypto'

const ENV = {
  PREFIX: '/',
  JSDELIVR: '0',
  CACHE_TTL: '300',
  IMMUTABLE_CACHE_TTL: '86400',
  UPSTREAM_TIMEOUT: '30000',
  MAX_REDIRECTS: '5',
  ALLOW_AUTH: '0',
  BLOCKED_UA: 'netcraft',
  LANDING_LINK: 'https://github.com/',
}
const ORIGIN = 'https://gh.test'
const CTX = { waitUntil() {} }

const srcWorker = (await import('../src/index.js')).default
const builtWorker = (await import('../_worker.js')).default

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
]

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
    r2 = await builtWorker.fetch(req2, env, CTX)
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
const builtText = (await import('node:fs')).readFileSync(new URL('../_worker.js', import.meta.url), 'utf8')
ok('产物无 import 语句', !/^\s*import\s/m.test(builtText))
ok('产物无 require()', !/\brequire\s*\(/.test(builtText))
ok('产物无 sourcemap 引用', !builtText.includes('sourceMappingURL'))
ok('产物有 export default', /export\s*\{[\s\S]*default/.test(builtText) || /export\s+default/.test(builtText))
ok('产物含上游归属声明', builtText.includes('CMLiussss'))
ok('产物含本项目版权', builtText.includes('cf-gh-proxy contributors'))
ok('产物无 __name 噪音', (builtText.match(/__name\(/g) || []).length === 0)

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
