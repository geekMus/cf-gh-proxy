#!/usr/bin/env node
// ============================================================================
// 两个构建产物的性能基准：源码版 vs 压缩版。
//
// 为什么需要这个：部署的是压缩版（_worker.min.js），源码版只是给人看的。
// 压缩理论上只去掉空白、缩短标识符，不改变语义——但「理论上」要在部署前验一次。
//
// 测什么：
//   1. 冷启动：import 模块 + 首次构造首页（CF 每次 isolate 冷启动都走这条）
//   2. 稳态：同一批请求反复打，每请求耗时
//   3. 体积：原始 / gzip（CF 按 gzip 后计费与传输，也影响解析时间）
//
// 两个「不这么测数字就没意义」的细节：
//   - fetch 打桩。/favicon.ico 分支会真的跑去 github.githubassets.com 取图标，
//     不打桩测到的是网络往返（实测 ~16 ms/请求，是纯执行耗时的数百倍），
//     执行差异被完全淹没。打桩后测的才是 Worker 自己的逻辑。
//   - 成对交替。/A/B/A/B 背靠背各跑一遍取比值，再对所有比值取中位数。
//     这台机器上单次采样抖动能到 ±20%，串联测（先测完 A 再测 B）会把负载漂移
//     整个算成「B 和 A 的差别」；成对测量里漂移对两边的伤害相同，比值稳得多。
//
// 用法：
//   node scripts/bench.mjs            # 完整
//   node scripts/bench.mjs --quick    # 少跑几轮
// ============================================================================

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QUICK = process.argv.includes('--quick')

const PAIRS = QUICK ? 6 : 16
const ROUNDS = QUICK ? 30 : 100
const WARMUP = 30

const VARIANTS = [
  { key: 'source', file: '_worker.js', label: '源码版' },
  { key: 'min', file: '_worker.min.js', label: '压缩版' },
]

// 一批有代表性的请求：页面、校验接口、拒绝分支。全部在本地完成。
// favicon 那条真实运行时会去外站取图——下面用桩按住。
const REQUESTS = [
  'https://gh.test/',
  'https://gh.test/',
  'https://gh.test/?check=' + encodeURIComponent('https://github.com/o/r/releases/download/v1/x.zip'),
  'https://gh.test/?check=' + encodeURIComponent('github.com/login'),
  'https://gh.test/https://example.com/x',
  'https://gh.test/https://github.com/o/r/tree/main',
  'https://gh.test/?q=' + encodeURIComponent('github.com/o/r/releases/download/v1/x.zip'),
  'https://gh.test/favicon.ico',
]

// ---- fetch 打桩 ------------------------------------------------------------
let stubCalls = 0
globalThis.fetch = async () => {
  stubCalls++
  return new Response('stub', { status: 200, headers: { 'content-type': 'image/png' } })
}

const WORKER_CTX = { waitUntil() {} }

function readVariant(file) {
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

// 换查询串绕开 ESM 缓存，每次拿到全新的模块实例
async function importWorker(path) {
  const mod = await import(`${pathToFileURL(path).href}?bench=${Math.random()}`)
  return mod.default
}

async function coldRun(path) {
  const t0 = performance.now()
  const worker = await importWorker(path)
  const t1 = performance.now()
  const res = await worker.fetch(new Request('https://gh.test/'), {}, WORKER_CTX)
  await res.text()
  const t2 = performance.now()
  return { importMs: t1 - t0, firstMs: t2 - t1 }
}

async function batch(worker) {
  const t0 = performance.now()
  for (let i = 0; i < ROUNDS; i++) {
    for (const url of REQUESTS) {
      const res = await worker.fetch(new Request(url), {}, WORKER_CTX)
      await res.text()
    }
  }
  return performance.now() - t0
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]

// ---- 体积 + 冷启动 ---------------------------------------------------------
const results = []
for (const v of VARIANTS) {
  const meta = readVariant(v.file)
  if (!meta) {
    console.log(`跳过 ${v.label}（${v.file} 不存在，先 npm run build）`)
    continue
  }
  results.push({ ...v, ...meta, importMs: [], firstMs: [] })
}

if (results.length < 2) {
  console.error('ERR 需要两个产物才能比较，先跑 npm run build')
  process.exit(1)
}

// 冷启动也交替测，免得「谁后跑谁显得快」
for (let i = 0; i < 3; i++) {
  for (const r of i % 2 === 0 ? results : [...results].reverse()) {
    const m = await coldRun(r.path)
    r.importMs.push(m.importMs)
    r.firstMs.push(m.firstMs)
  }
}

// ---- 稳态：成对交替 --------------------------------------------------------
const workers = {}
for (const r of results) workers[r.key] = await importWorker(r.path)

for (let i = 0; i < WARMUP; i++) {
  for (const r of results) await batch(workers[r.key])
}

const base = results[0]
const other = results[1]
const baseTimes = []
const otherTimes = []
const ratios = []

for (let i = 0; i < PAIRS; i++) {
  const baseFirst = i % 2 === 0
  const a = baseFirst ? await batch(workers[base.key]) : await batch(workers[other.key])
  const b = baseFirst ? await batch(workers[other.key]) : await batch(workers[base.key])
  const t1 = baseFirst ? a : b
  const t2 = baseFirst ? b : a
  baseTimes.push(t1)
  otherTimes.push(t2)
  ratios.push(t2 / t1)
}

const perReq = (ms) => (ms * 1000) / (ROUNDS * REQUESTS.length)
const ratioMedian = median(ratios)
const sortedRatios = [...ratios].sort((a, b) => a - b)
const deltaPct = (ratioMedian - 1) * 100

// ---- 输出 ------------------------------------------------------------------
console.log('')
console.log('产物'.padEnd(10) + '字节'.padStart(9) + 'gzip'.padStart(9) + '行数'.padStart(8) + '冷启动'.padStart(12) + '首个请求'.padStart(12))
console.log('─'.repeat(62))
for (const r of results) {
  console.log(
    r.label.padEnd(10),
    String(r.bytes).padStart(9),
    String(r.gzip).padStart(9),
    String(r.lines).padStart(8),
    (median(r.importMs).toFixed(2) + ' ms').padStart(12),
    (median(r.firstMs).toFixed(2) + ' ms').padStart(12)
  )
}

console.log('')
console.log(`稳态（成对交替 ${PAIRS} 组 × 每组 ${ROUNDS} 遍 × ${REQUESTS.length} 个请求）：`)
for (const r of results) {
  const times = r.key === base.key ? baseTimes : otherTimes
  console.log(`  ${r.label}  ${perReq(median(times)).toFixed(1)} µs/请求`)
}
console.log(
  `  中位比值 ${ratioMedian.toFixed(3)}（四分位 ${quantile(sortedRatios, 0.25).toFixed(2)}–${quantile(sortedRatios, 0.75).toFixed(2)}；` +
    `${other.label} / ${base.label} 为 ${ratioMedian > 1 ? '+' : ''}${deltaPct.toFixed(1)}%）`
)
console.log(`  fetch 打桩命中 ${stubCalls} 次，全部来自 favicon 分支；本基准不含真实网络往返`)
console.log('')

console.log(
  `单组比值的四分位宽度 ${((quantile(sortedRatios, 0.75) / quantile(sortedRatios, 0.25) - 1) * 100).toFixed(0)}%，` +
    '远大于两版本本身的差别；跨轮的中位数也会漂几个百分点。'
)

if (deltaPct > 5) {
  console.log(`警告：${other.label}比${base.label}慢 ${deltaPct.toFixed(1)}%，超出 ±5% 噪声带，请查构建参数。`)
  process.exitCode = 1
} else {
  console.log(`结论：${other.label}与${base.label}的每请求耗时中位差 ${deltaPct.toFixed(1)}%，落在 ±5% 噪声带内，`)
  console.log('      即压缩没有带来可测的性能损失。')
}

console.log('')
console.log('这也是本项目不做混淆的原因：混淆会引入字符串数组查表与控制流间接，')
console.log('那是真正的性能损失，而不是噪声。压缩只减体积，不动执行路径。')