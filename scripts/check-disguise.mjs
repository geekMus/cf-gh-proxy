import worker from '../src/index.js'

const base = {
  PREFIX: '/',
  JSDELIVR: '0',
  CACHE_TTL: '300',
  IMMUTABLE_CACHE_TTL: '86400',
  UPSTREAM_TIMEOUT: '30000',
  MAX_REDIRECTS: '5',
  ALLOW_AUTH: '0',
  BLOCKED_UA: 'netcraft',
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

async function home(env) {
  const req = new Request('https://gh.test/')
  return worker.fetch(req, { ...base, ...env }, { waitUntil() {} })
}

const cases = [
  ['都不设 → 说明页', {}, 200, 'text/html', 'GitHub 文件加速'],
  ['URL302 → 302 跳转', { URL302: 'https://t.me/x' }, 302, null, null],
  ['URL=nginx → nginx 页', { URL: 'nginx' }, 200, 'text/html', 'Welcome to nginx'],
  ['URL=普通地址 → 302', { URL: 'https://www.baidu.com/' }, 302, null, null],
  ['URL302 优先于 URL', { URL302: 'https://t.me/x', URL: 'nginx' }, 302, null, null],
]

for (const [name, env, wantStatus, wantCt, wantBody] of cases) {
  const res = await home(env)
  ok(`${name}：状态码 ${wantStatus}`, res.status === wantStatus, `实际 ${res.status}`)
  if (wantCt) {
    const ct = res.headers.get('content-type') || ''
    ok(`${name}：content-type`, ct.includes(wantCt.replace('text/', '')), ct || '(无)')
  }
  if (wantBody) {
    const text = await res.text()
    ok(`${name}：正文含「${wantBody}」`, text.includes(wantBody))
  }
  const loc = res.headers.get('location')
  if (wantStatus === 302) {
    ok(`${name}：有 location`, loc !== null, loc || '(无)')
  }
}

console.log(`\n===== 结果：PASS=${pass} FAIL=${fail} =====`)
process.exit(fail === 0 ? 0 : 1)
