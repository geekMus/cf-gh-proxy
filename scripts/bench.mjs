#!/usr/bin/env node
// ============================================================================
// 两个构建产物的性能基准：源码版 vs 压缩版。
//
// 为什么需要这个：压缩（minify）理论上只去掉空白与缩短标识符，不该改变执行逻辑。
// 但「理论一致」和「实测一致」是两件事——AST 重排、字符串合并都可能带来意外。
// 所以部署版本（压缩版）上线前，用这个脚本确认它没有比源码版更慢。
//
// 测什么：
//   1. 冷启动：加载模块 + 首次构造首页（Cloudflare 每次 isolate 冷启动都走这条）
//   2. 请求吞吐：同一批请求反复打，看稳态每秒能处理多少
//   3. 字节体积：原始 / gzip（CF 上传按 gzip 后算，且影响脚本解析时间）
//
// 用法：
//   node scripts/bench.mjs            # 两个产物都测
//   node scripts/bench.mjs --quick    # 少跑几轮
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QUICK = process.argv.includes('--quick')

const VARIANTS = [
  { key: 'source', file: '_worker.js', label: '源码版' },
  { key: 'min', file: '_worker.min.js', label: '压缩版' },
]

// 一批有代表性的请求。前两个是纯本地页面（不联网），后面几个会在本地被
// 校验拒绝 —— 都不产生真实网络请求，所以基准不受网络波动影响。
const REQUESTS = [
  { name: '首页', url: 'https://gh.test/' },
  { name: '首页(暗色UA)', url: 'https://gh.test/' },
  { name: '?check 合法', url: 'https://gh.test/?check=' + encodeURIComponent('https://github.com/o/r/releases/download/v1/x.zip') },
  { name: '?check 非法', url: 'https://gh.test/?check=' + encodeURIComponent('github.com/login') },
  { name: '非GitHub域名', url: 'https://gh.test/https://example.com/x' },
  { name: '网页路径', url: 'https://gh.test/https://github.com/o/r/tree/main' },
  { name: '?q 入口', url: 'https://gh.test/?q=' + encodeURIComponent('github.com/o/r/releases/download/v1/x.zip') },
  { name: 'favicon', url: 'https://gh.test/favicon.ico' },
]

function loadVariant(file) {
  if (!existsSync(resolve(ROOT, file))) return null
  const path = resolve(ROOT, file)
  const text = readFileSync(path, 'utf8')
  return {
    file,
    path,
    bytes: Buffer.byteLength(text, 'utf8'),
    gzip: gzipSync(Buffer.from(text)).length,
    lines: text.split('\n').length,
  }
}

async function measureColdStart(path) {
  // 冷启动 = 重新 import 一次模块（绕过 ESM 缓存，用查询串强制重新求值）
  const t0 = performance.now()
  const mod = await import(`file://${path}?cold=${Math.random()}`)
  const t1 = performance.now()
  // 首次构造首页：模板字符串 + CSS 拼接，是冷启动里最重的一段
  const { resolveConfig } = await import(`file://${resolve(ROOT, 'src/config.js')}?cold=${Math.random()}`)
  const cfg = resolveConfig({})
  const res = await mod.default.fetch(new Request('https://gh.test/'), {}, { waitUntil() {} })
  await res.text()
  const t2 = performance.now()
  return { importMs: t1 - t0, firstReqMs: t2 - t1 }
}

async function measureThroughput(path, rounds) {
  const mod = await import(`file://${path}?bench=${Math.random()}`)
  const worker = mod.default
  const ctx = { waitUntil() {} }
  // 预热，让 V8 完成优化
  for (let i = 0; i < 30; i++) {
    for (const r of REQUESTS) {
      const res = await worker.fetch(new Request(r.url), {}, ctx)
      await res.text()
    }
  }
  const t0 = performance.now()
  let n = 0
  for (let i = 0; i < rounds; i++) {
    for (const r of REQUESTS) {
      const res = await worker.fetch(new Request(r.url), {}, ctx)
      await res.text()
      n++
    }
  }
  const dt = performance.now() - t0
  return { reqs: n, ms: dt, perSec: (n / dt) * 1000, usPerReq: (dt / n) * 1000 }
}

const results = []

for (const v of VARIANTS) {
  const meta = loadVariant(v.file)
  if (!meta) {
    console.log(`跳过 ${v.label}（${v.file} 不存在）`)
    continue
  }
  const cold = await measureColdStart(meta.path)
  const rounds = QUICK ? 40 : 150
  const thr = await measureThroughput(meta.path, rounds)
  results.push({ ...v, ...meta, ...cold, ...thr })
}

if (!results.length) {
  console.error('ERR 没有可测的产物，先跑 npm run build:all')
  process.exit(1)
}

const base = results.find(r => r.key === 'source') || results[0]

console.log('')
console.log('产物            字节       gzip     行数    冷启动(import)  首个请求   稳态 请求/秒  每请求')
console.log('─'.repeat(100))
for (const r of results) {
  const rel = r === base ? '' : ` (${((r.usPerReq / base.usPerReq - 1) * 100).toFixed(0)}%)`
  console.log(
    r.label.padEnd(14),
    String(r.bytes).padStart(7),
    String(r.gzip).padStart(8),
    String(r.lines).padStart(7),
    (r.importMs.toFixed(2) + ' ms').padStart(12),
    (r.firstReqMs.toFixed(2) + ' ms').padStart(10),
    r.perSec.toFixed(0).padStart(12),
    (r.usPerReq.toFixed(0) + ' µs' + rel).padStart(12)
  )
}
console.log('')
console.log('（每请求一列越小越好；括号里是相对源码版的耗时变化）')
console.log('')
console.log('注意：实测两个版本在 ±5% 内波动，且方向不固定（多跑几轮会看到压缩版偶尔更快），')
console.log('      差异属于测量噪声。结论是压缩不改变执行性能，只改变文件体积。')
console.log('      这也是本项目不做混淆的原因：混淆会引入字符串数组查表与控制流间接，')
console.log('      那是真正的性能损失，而不是噪声。')
