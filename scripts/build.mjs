#!/usr/bin/env node
// ============================================================================
// 把 src/ 下分模块的源码打包成**一个可直接粘贴的文件** `_worker.js`。
//
// 为什么要有这个脚本：
//   上游 cmliu/CF-Workers-GitHub 是单文件分发——别人不用克隆仓库，把内容粘进
//   Cloudflare Dashboard 的编辑器就能跑。本项目源码分模块（好维护），但也必须
//   能产出同样的单文件，否则对使用者是倒退。
//
// 用法：
//   node scripts/build.mjs            # 产出 _worker.js（可读，约 20KB）
//   node scripts/build.mjs --minify   # 产出压缩版（约 8KB，粘起来更省事）
//   node scripts/build.mjs --check    # 只校验能构建成功，不落盘
//
// 产物特性：
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
const OUT = resolve(ROOT, '_worker.js')

const args = process.argv.slice(2)
const MINIFY = args.includes('--minify')
const CHECK_ONLY = args.includes('--check')

// 版本号与 wrangler.toml / package.json 保持单一来源：读 package.json
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))

const banner = `/**
 * cf-gh-proxy v${pkg.version} —— GitHub 文件加速 Cloudflare Worker
 *
 * 这个文件是自动构建产物，请勿直接编辑。
 * 源码与构建方式：https://github.com/geekMus/cf-gh-proxy
 * 本文件原始地址：https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/_worker.js
 *
 * 基于 cmliu/CF-Workers-GitHub 演化而来（MIT, Copyright (c) 2025 CMLiussss）
 * Copyright (c) 2026 cf-gh-proxy contributors
 *
 * 用法一（推荐，不装任何工具）：整段复制本文件内容，粘贴到
 *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。
 * 用法二（用 wrangler）：npm run deploy（构建后以 --main _worker.js 部署）。
 * 配置：在 Dashboard 的 Settings → Variables and Secrets 里加环境变量，见 README。
 */`

if (!existsSync(ENTRY)) {
  console.error(`ERR 找不到入口文件：${ENTRY}`)
  process.exit(1)
}

let result
try {
  result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // 关键：不要 keepNames，否则 esbuild 会注入大量 __name(...) 调用，
    // 既增大体积又让产物难读。
    keepNames: false,
    minify: MINIFY,
    // 不生成 sourcemap（单文件分发场景下没人会去看它，只会多一行无用注释）
    sourcemap: false,
    write: false,
    banner: { js: banner },
    legalComments: 'none',
    logLevel: 'warning',
  })
} catch (err) {
  console.error('ERR 构建失败：')
  console.error(err.message || err)
  process.exit(1)
}

const code = result.outputFiles[0].text

// 自检：产物里不许残留模块语法
const problems = []
if (/^\s*import\s/m.test(code)) problems.push('残留 import 语句')
if (/\brequire\s*\(/.test(code)) problems.push('残留 require()')
if (code.includes('sourceMappingURL')) problems.push('残留 sourcemap 引用')
if (!/export\s*\{/.test(code) && !/export\s+default/.test(code)) problems.push('缺少 export')

if (problems.length) {
  console.error('ERR 产物不合格：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

const bytes = Buffer.byteLength(code, 'utf8')
const gz = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(1)

if (CHECK_ONLY) {
  console.log(`OK 构建校验通过：${bytes} 字节（约 ${gz} KB，未压缩）${MINIFY ? ' [minified]' : ''}`)
  process.exit(0)
}

writeFileSync(OUT, code, 'utf8')

// 复核落盘结果
const written = readFileSync(OUT, 'utf8')
if (written !== code) {
  console.error('ERR 写入后内容不一致')
  process.exit(1)
}
if ((written.match(/\r/g) || []).length > 0) {
  console.error('ERR 产物含 CR，应为纯 LF')
  process.exit(1)
}

console.log(`OK 已生成 _worker.js`)
console.log(`   入口   ${ENTRY}`)
console.log(`   产物   ${OUT}`)
console.log(`   大小   ${bytes} 字节（约 ${gz} KB）${MINIFY ? ' [minified]' : ' [可读]'}`)
console.log(`   行数   ${code.split('\n').length}`)
console.log(`   形态   单文件 ESM，零 import，export default 保留`)
