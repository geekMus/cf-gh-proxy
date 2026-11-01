#!/usr/bin/env node
// ============================================================================
// 把 src/ 下分模块的源码产出**两个可直接粘贴的单文件**。
//
// 为什么要有这个脚本：
//   上游 cmliu/CF-Workers-GitHub 是单文件分发——别人不用克隆仓库，把内容粘进
//   Cloudflare Dashboard 的编辑器就能跑。本项目源码分模块（好维护），但也必须
//   能产出同样的单文件，否则对使用者是倒退。
//
// 两个版本（同一份源码，两种用途）：
//   _worker.min.js   压缩版 —— **部署用这个**。变量名缩短、空白与换行去掉、
//                    中文不转义成 \uXXXX（charset:'utf8'），文件最短：上传更快、
//                    解析更快。执行逻辑与源码版完全相同。
//                    不混淆（混淆会引入字符串数组查表与控制流间接，实测拖慢执行）。
//   _worker.js       源码版 —— **给人看的**。带**全部注释**、带归属声明，分模块
//                    拼接而成（不走压缩器，所以注释一行不丢）。想看懂它在干什么、
//                    想改一行、想审计安全，都用这个。它也能直接跑。
//
// 为什么源码版不用 esbuild：
//   esbuild 即使在 minify:false 下也会把 `//` 注释全部剥掉（只有 legalComments
//   管法务注释）。那样产出的「源码版」只剩代码骨架，注释全无，对「方便用户自己
//   看」这个目的等于没有。所以源码版改为按依赖顺序拼接六个模块：只删 import 行、
//   把 `export function` 还原成 `function`，其余（含所有注释）原样保留。
//
// 用法：
//   node scripts/build.mjs           # 产出两个版本
//   node scripts/build.mjs --min     # 只产出压缩版 _worker.min.js
//   node scripts/build.mjs --source  # 只产出源码版 _worker.js
//   node scripts/build.mjs --check   # 只校验能构建成功，不落盘
//
// 产物特性（两个版本共有）：
//   - 单个 ESM 文件，零 import / 零 require
//   - 保留 `export default { fetch }`，Dashboard 编辑器与 wrangler 都能直接用
//   - 顶部带归属声明与版本号（MIT 要求保留上游版权）
//   - 不含 sourcemap 引用
// ============================================================================

import { build } from 'esbuild'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = resolve(ROOT, 'src/index.js')

const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const ONLY_MIN = args.includes('--min')
const ONLY_SOURCE = args.includes('--source')

// 没给任何目标时，两个版本都产出
const want = {
  source: ONLY_SOURCE || (!ONLY_MIN),
  min: ONLY_MIN || (!ONLY_SOURCE),
}

const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

// 归属声明。MIT 要求保留上游版权，两个版本都带。
function bannerFor(kind) {
  const how =
    kind === 'min'
      ? '本文件为压缩版，**部署用这个**：与源码版执行逻辑完全一致，只是去掉了\n *   空白、换行与长变量名，上传与解析更快。想看可读的实现请用 _worker.js。'
      : '本文件为源码版，**给人看的**：分模块原样拼接，注释一行不丢，便于审计与改动。\n *   部署请用 _worker.min.js（逻辑相同但更短）。\n *\n * 用法（不装任何工具）：整段复制本文件内容，粘贴到\n *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。'
  return `/**
 * cf-gh-proxy v${pkg.version} —— GitHub 文件加速 Cloudflare Worker
 *
 * 这个文件是自动构建产物，请勿直接编辑。
 * 源码与构建方式：https://github.com/geekMus/cf-gh-proxy
 *
 * 基于 cmliu/CF-Workers-GitHub 演化而来（MIT, Copyright (c) 2025 CMLiussss）
 * Copyright (c) 2026 cf-gh-proxy contributors
 *
 * ${how}
 */`
}

// ---- 压缩版：交给 esbuild ------------------------------------------------
async function bundleMin() {
  let result
  try {
    result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      // 不要 keepNames，否则 esbuild 会注入大量 __name(...)，既增大体积又难读
      keepNames: false,
      minify: true,
      sourcemap: false,
      write: false,
      // banner 在落盘前统一拼（见 writeArtifact），避免影响压缩率
      legalComments: 'none',
      // 关键：默认 charset 是 'ascii'，会把每个汉字转义成 \uXXXX（3 字节变 6 字节）。
      // 本项目界面文案与错误原因全是中文，实测转义会明显变大。
      charset: 'utf8',
      logLevel: 'warning',
    })
  } catch (err) {
    console.error('ERR 压缩版构建失败：')
    console.error(err.message || err)
    process.exit(1)
  }
  return result.outputFiles[0].text
}

// ---- 源码版：按依赖顺序拼接，保留全部注释 --------------------------------
// 顺序必须是拓扑序：被依赖的在前。已核查六模块无同名顶层声明，所以拼接安全。
const MODULES = [
  { file: 'config.js', title: '配置解析' },
  { file: 'validate.js', title: '路径校验' },
  { file: 'proxy.js', title: '代理与改写' },
  { file: 'upstream.js', title: '跟随重定向' },
  { file: 'pages.js', title: '页面渲染' },
  { file: 'index.js', title: '入口' },
]

function stripModuleSyntax(text, isFirst) {
  let out = text
  // 去掉模块内的 'use strict'（拼接后只在文件最顶部保留一份）
  out = out.replace(/^'use strict'\s*\n+/, isFirst ? "'use strict'\n\n" : '')
  // 去掉全部 import 行（拼接后同处一个作用域，不需要 import）
  out = out.replace(/^import\s[^\n]*\n/gm, '')
  // 把导出的函数声明还原成普通声明（导出由末尾唯一的 export default 承担）
  out = out.replace(/^export\s+(async\s+function\s)/gm, '$1')
  out = out.replace(/^export\s+(function\s)/gm, '$1')
  // 折叠被 import 行留下的空行（连续三个以上空行压成两个）
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim() + '\n'
}

function buildSource() {
  const parts = []
  for (const m of MODULES) {
    const p = resolve(ROOT, 'src', m.file)
    if (!existsSync(p)) {
      console.error(`ERR 找不到模块：${p}`)
      process.exit(1)
    }
    const raw = readFileSync(p, 'utf8')
    const head =
      `// ============================================================================\n` +
      `// 模块：src/${m.file} —— ${m.title}\n` +
      `// ============================================================================\n\n`
    parts.push(head + stripModuleSyntax(raw, m.file === 'config.js'))
  }
  return parts.join('\n')
}

// 产物形态自检：任何版本都不许残留模块语法或 sourcemap 引用
function lint(code, label) {
  const problems = []
  if (/^\s*import\s/m.test(code)) problems.push('残留 import 语句')
  if (/\brequire\s*\(/.test(code)) problems.push('残留 require()')
  if (code.includes('sourceMappingURL')) problems.push('残留 sourcemap 引用')
  if (!/export\s*\{/.test(code) && !/export\s+default/.test(code)) problems.push('缺少 export')
  if (problems.length) {
    console.error(`ERR ${label} 产物不合格：`)
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
}

function writeArtifact(file, code, banner, label, note) {
  const full = banner + '\n' + code
  lint(full, label)
  if ((full.match(/\r/g) || []).length > 0) {
    console.error(`ERR ${label} 产物含 CR，应为纯 LF`)
    process.exit(1)
  }
  const bytes = Buffer.byteLength(full, 'utf8')
  if (CHECK_ONLY) {
    console.log(`OK ${label} 构建校验通过：${bytes} 字节（约 ${(bytes / 1024).toFixed(1)} KB）`)
    return { file, bytes, full }
  }
  const out = resolve(ROOT, file)
  writeFileSync(out, full, 'utf8')
  const written = readFileSync(out, 'utf8')
  if (written !== full) {
    console.error(`ERR ${label} 写入后内容不一致`)
    process.exit(1)
  }
  console.log(
    `OK 已生成 ${file.padEnd(16)} ${String(bytes).padStart(7)} 字节  ${(bytes / 1024).toFixed(1).padStart(6)} KB  ${String(full.split('\n').length).padStart(5)} 行  ${note}`
  )
  return { file, bytes, full }
}

if (!existsSync(ENTRY)) {
  console.error(`ERR 找不到入口文件：${ENTRY}`)
  process.exit(1)
}

const built = []

// ---- 压缩版（部署用） ------------------------------------------------------
if (want.min) {
  const code = await bundleMin()
  built.push(writeArtifact('_worker.min.js', code, bannerFor('min'), '压缩版', 'minified · 部署用'))
}

// ---- 源码版（给人看的） ----------------------------------------------------
if (want.source) {
  const code = buildSource()
  const rec = writeArtifact('_worker.js', code, bannerFor('source'), '源码版', '可读 · 供审计与改动')
  // 源码版的核心承诺是「注释一行不丢」，落盘后立刻**逐行**核对。
  //
  // 为什么不能用「产物 >= 源文件」：每个模块的 3 行分隔头本身就以 `//` 开头，
  // 六个模块一共有 18 行，用 `>=` 比较时它们会把最多 18 行丢失抵消掉 —— 检查
  // 看着通过，注释其实少了。所以判据是**精确相等**：
  //   `//` 行数 = 各模块（去过模块语法后）的 `//` 行数 + 18 行分隔头
  //   `/*` 个数 = 各模块的 `/*` 个数 + 1（顶部归属声明）
  // 再逐行确认源文件里的每一条注释行都能在产物里原样找到。
  const stripped = MODULES.map((m) =>
    stripModuleSyntax(readFileSync(resolve(ROOT, 'src', m.file), 'utf8'), m.file === 'config.js')
  )
  const count = (text, re) => (text.match(re) || []).length
  const expectedSlash = stripped.reduce((n, t) => n + count(t, /^\s*\/\//gm), 0) + MODULES.length * 3
  const gotSlash = count(rec.full, /^\s*\/\//gm)
  const expectedBlock = stripped.reduce((n, t) => n + count(t, /\/\*/g), 0) + 1
  const gotBlock = count(rec.full, /\/\*/g)

  if (gotSlash !== expectedSlash || gotBlock !== expectedBlock) {
    console.error('ERR 源码版注释丢失：')
    console.error(`  行注释（//）：期望 ${expectedSlash} 行，产物 ${gotSlash} 行`)
    console.error(`  块注释（/*）：期望 ${expectedBlock} 个，产物 ${gotBlock} 个`)
    process.exit(1)
  }

  // 计数相等还不够：万一分隔头恰好补上了丢失的行，数目也会对得上。
  // 再逐行比对一遍，确保每一条源注释都在产物里原样存在。
  const outLines = new Set(rec.full.split('\n'))
  const missing = []
  for (const text of stripped) {
    for (const line of text.split('\n')) {
      if (/^\s*\/\//.test(line) && !outLines.has(line)) missing.push(line.trim())
    }
  }
  if (missing.length) {
    console.error(`ERR 源码版有 ${missing.length} 行注释没有原样出现在产物里：`)
    for (const line of missing.slice(0, 5)) console.error(`  - ${line.slice(0, 72)}`)
    process.exit(1)
  }

  console.log(
    `OK 源码版注释完整：${expectedSlash - MODULES.length * 3} 行 // + ${MODULES.length * 3} 行分隔头 = ${gotSlash} 行，` +
      `块注释 ${gotBlock} 个（含横幅），逐行核对无缺失`
  )
  built.push(rec)
}

if (!built.length) {
  console.error('ERR 没有产出任何文件')
  process.exit(1)
}
