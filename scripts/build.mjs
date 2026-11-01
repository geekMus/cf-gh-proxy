#!/usr/bin/env node
// ============================================================================
// 把 src/ 下分模块的源码打包成**可直接粘贴的单文件**，产出两个版本。
//
// 为什么要有这个脚本：
//   上游 cmliu/CF-Workers-GitHub 是单文件分发——别人不用克隆仓库，把内容粘进
//   Cloudflare Dashboard 的编辑器就能跑。本项目源码分模块（好维护），但也必须
//   能产出同样的单文件，否则对使用者是倒退。
//
// 两个版本（同一份源码，两种用途）：
//   _worker.min.js   压缩版 —— **部署用这个**。变量名缩短、空白与换行去掉，
//                    执行逻辑与源码版完全相同，只是文件更短：上传更快、解析更快。
//                    不混淆（混淆会引入字符串数组查表与控制流间接，实测拖慢执行）。
//   _worker.js       源码版 —— **给人看的**。可读、带注释、带归属声明。想看懂它在
//                    干什么、想改一行、想审计安全，都用这个。它也能直接跑。
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
      : '本文件为源码版，**给人看的**：可读、带注释，便于审计与改动。\n *   部署请用 _worker.min.js（逻辑相同但更短）。\n *\n * 用法（不装任何工具）：整段复制本文件内容，粘贴到\n *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。'
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

async function bundle(minify) {
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
      minify,
      sourcemap: false,
      write: false,
      // banner 在落盘前统一拼（见 writeArtifact），避免影响压缩率
      legalComments: 'none',
      logLevel: 'warning',
    })
  } catch (err) {
    console.error('ERR 构建失败：')
    console.error(err.message || err)
    process.exit(1)
  }
  return result.outputFiles[0].text
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
    return { file, bytes }
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
  return { file, bytes }
}

if (!existsSync(ENTRY)) {
  console.error(`ERR 找不到入口文件：${ENTRY}`)
  process.exit(1)
}

const built = []

// ---- 压缩版（部署用） ------------------------------------------------------
if (want.min) {
  const code = await bundle(true)
  built.push(writeArtifact('_worker.min.js', code, bannerFor('min'), '压缩版', 'minified · 部署用'))
}

// ---- 源码版（给人看的） ----------------------------------------------------
if (want.source) {
  const code = await bundle(false)
  built.push(writeArtifact('_worker.js', code, bannerFor('source'), '源码版', '可读 · 供审计与改动'))
}

if (!built.length) {
  console.error('ERR 没有产出任何文件')
  process.exit(1)
}
