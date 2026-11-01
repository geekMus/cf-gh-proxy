'use strict'
// 本地预览：把 Node http 请求包成 Workers 的 Request 交给真实 worker.fetch。
// 这样浏览器里看到的是**线上会跑的那份代码**，不是静态 HTML——改完 src/ 刷新即见，
// 不用先 npm run build，也不会出现「预览的是旧产物」这种假象。
//
// 用法：
//   node scripts/preview.mjs              # 预览 src/index.js（源码）
//   node scripts/preview.mjs --built      # 预览 _worker.min.js（真正要部署的产物）
//   PORT=8801 node scripts/preview.mjs    # 换端口
//
// 然后浏览器打开 http://127.0.0.1:8800/
import http from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.env.PORT || 8800)
const BUILT = process.argv.includes('--built')
const WORKER = process.env.WORKER || (BUILT ? '_worker.min.js' : 'src/index.js')

// 注意：必须用 pathToFileURL，不能用 new URL()——后者在 Windows 上会把盘符当协议
// （ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'）。
const mod = await import(pathToFileURL(resolve(ROOT, WORKER)).href)
const worker = mod.default

const server = http.createServer(async (req, res) => {
  const url = `http://127.0.0.1:${PORT}${req.url}`
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v)
    else if (Array.isArray(v)) headers.set(k, v.join(','))
  }
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    body = Buffer.concat(chunks)
  }
  let out
  try {
    const request = new Request(url, { method: req.method, headers, body })
    out = await worker.fetch(request, {}, { waitUntil() {}, passThroughOnException() {} })
  } catch (e) {
    out = new Response(`preview server error: ${e && e.message}`, { status: 500 })
  }
  res.statusCode = out.status
  const set = {}
  out.headers.forEach((v, k) => { set[k] = v })
  for (const [k, v] of Object.entries(set)) {
    if (k === 'content-encoding' || k === 'content-length') continue
    try { res.setHeader(k, v) } catch {}
  }
  const buf = Buffer.from(await out.arrayBuffer())
  res.setHeader('content-length', buf.length)
  res.end(buf)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`preview  http://127.0.0.1:${PORT}/   worker=${WORKER}`)
})
