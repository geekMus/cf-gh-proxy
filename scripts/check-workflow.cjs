// 校验 build-worker.yml：YAML 能否解析、关键字段是否就位、
// 以及工作流里那些 shell 断言在本地跑一遍会不会误判。

const fs = require('fs')
const path = require('path')

const WF = path.join(__dirname, '..', '.github', 'workflows', 'build-worker.yml')
const out = []
let bad = 0

function ck(name, cond, detail = '') {
  if (cond) out.push(`  OK   ${name}${detail ? '  ' + detail : ''}`)
  else {
    bad++
    out.push(`  FAIL ${name}${detail ? '  ' + detail : ''}`)
  }
}

if (!fs.existsSync(WF)) {
  console.error('ERR 找不到 build-worker.yml')
  process.exit(1)
}
const raw = fs.readFileSync(WF, 'utf8')

// 1) YAML 基本形态（不引入依赖，用逐行粗校验 + 关键字符串）
ck('文件非空', raw.length > 500, `${raw.length} 字节`)
ck('无 CRLF', (raw.match(/\r/g) || []).length === 0)
ck('有 name 字段', /^name:\s/m.test(raw))
ck('on.push.branches 含 main', /branches:\s*\[\s*main\s*\]/.test(raw))
ck('有 workflow_dispatch', /workflow_dispatch:/.test(raw))
ck('permissions.contents 为 write', /contents:\s*write/.test(raw))
ck('runs-on 显式版本', /runs-on:\s*ubuntu-24\.04/.test(raw))
ck('checkout 用 v6', /actions\/checkout@v6/.test(raw))
ck('setup-node 用 v6', /actions\/setup-node@v6/.test(raw))
ck('用 npm ci 而非 npm install', /\bnpm ci\b/.test(raw) && !/\bnpm install\b/.test(raw))
ck('有 [skip build] 防循环', raw.includes('[skip build]'))
ck('回填前先判断产物是否变化', /git diff --quiet -- _worker\.js/.test(raw))
ck('提交用 bot 身份', raw.includes('github-actions[bot]'))

// 2) paths 触发范围必须包含 src 与 build 脚本，且不应包含 _worker.js（否则自触发）
const pathsBlock = raw.split('paths:')[1]?.split('workflow_dispatch')[0] || ''
ck('paths 含 src/**', pathsBlock.includes("'src/**'"))
ck('paths 含 scripts/build.mjs', pathsBlock.includes("'scripts/build.mjs'"))
ck('paths 含 package.json', pathsBlock.includes("'package.json'"))
ck('paths 不含 _worker.js（避免自触发）', !pathsBlock.includes('_worker.js'))

// 3) 产物形态断言：拿本地真实 _worker.js 跑一遍，确认不会误报
const W = path.join(__dirname, '..', '_worker.js')
if (!fs.existsSync(W)) {
  bad++
  out.push('  FAIL 本地没有 _worker.js，先跑 npm run build')
} else {
  const code = fs.readFileSync(W, 'utf8')
  ck('产物无行首 import', !/^[ \t]*import[ \t]/m.test(code))
  ck('产物无 sourceMappingURL', !code.includes('sourceMappingURL'))
  ck('产物含 export', code.includes('export'))
  ck('产物含上游版权 CMLiussss', code.includes('CMLiussss'))
  ck('产物字节数 > 10KB', code.length > 10240, `${code.length} 字节`)
}

// 4) package-lock 与 package.json 同步（npm ci 的前置条件）
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'))
const lockDev = (lock.packages[''] || {}).devDependencies || {}
const pkgDev = pkg.devDependencies || {}
const missing = Object.keys(pkgDev).filter((k) => !(k in lockDev))
const extra = Object.keys(lockDev).filter((k) => !(k in pkgDev))
ck('lock 与 pkg 的 devDependencies 完全一致', missing.length === 0 && extra.length === 0,
   missing.length || extra.length ? `缺 ${missing.join(',')} 多 ${extra.join(',')}` : '')

// 5) build 脚本存在且 package.json 里注册了
ck('package.json 有 build 脚本', typeof (pkg.scripts || {}).build === 'string')
ck('package.json 有 test:build 脚本', typeof (pkg.scripts || {})['test:build'] === 'string')
ck('esbuild 在 devDependencies', 'esbuild' in pkgDev)

out.push(`\n问题数 = ${bad}`)
console.log(out.join('\n'))
process.exit(bad === 0 ? 0 : 1)
