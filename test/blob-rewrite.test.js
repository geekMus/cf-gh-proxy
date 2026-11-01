'use strict'

// /blob/ 改写测试
//
// 为什么需要它：`github.com/o/r/blob/<ref>/<path>` 是**网页**，GitHub 会返回
// 渲染好的 HTML（导航栏、按钮、语法高亮），不是文件字节。上游那版靠
// `path.replace('/blob/','/raw/')` 修正，我重写时漏掉了，实测 3 次都返回
// `text/html` 且正文以 `<!DOCTYPE html>` 开头 —— 等于把网页当文件卖。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTargetUrl, maybeRewriteBlob } from '../src/proxy.js'

test('blob 路径改写为 raw.githubusercontent.com', () => {
  const u = buildTargetUrl('https://github.com/o/r/blob/main/x.js')
  const out = maybeRewriteBlob(u)
  assert.ok(out, '应当返回新 URL')
  assert.equal(out.hostname, 'raw.githubusercontent.com')
  assert.equal(out.pathname, '/o/r/main/x.js')
})

test('blob 的多级目录保持完整', () => {
  const u = buildTargetUrl('https://github.com/o/r/blob/v1.0.0/a/b/c/x.js')
  const out = maybeRewriteBlob(u)
  assert.equal(out.pathname, '/o/r/v1.0.0/a/b/c/x.js')
})

test('blob 带 commit SHA 的 ref 也改写', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567'
  const u = buildTargetUrl(`https://github.com/o/r/blob/${sha}/x.js`)
  const out = maybeRewriteBlob(u)
  assert.equal(out.pathname, `/o/r/${sha}/x.js`)
})

test('raw 路径不动（本来就是对的）', () => {
  const u = buildTargetUrl('https://github.com/o/r/raw/main/x.js')
  assert.equal(maybeRewriteBlob(u), null)
})

test('raw.githubusercontent.com 不动', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/main/x.js')
  assert.equal(maybeRewriteBlob(u), null)
})

test('release 资产不动', () => {
  const u = buildTargetUrl('https://github.com/o/r/releases/download/v1/x.zip')
  assert.equal(maybeRewriteBlob(u), null)
})

test('archive 不动', () => {
  const u = buildTargetUrl('https://github.com/o/r/archive/refs/heads/main.zip')
  assert.equal(maybeRewriteBlob(u), null)
})

test('codeload 不动', () => {
  const u = buildTargetUrl('https://codeload.github.com/o/r/zip/main')
  assert.equal(maybeRewriteBlob(u), null)
})

test('仓库首页（没有 /blob/）不动', () => {
  const u = buildTargetUrl('https://github.com/o/r')
  assert.equal(maybeRewriteBlob(u), null)
})

test('tree 路径不动（它不是 blob）', () => {
  const u = buildTargetUrl('https://github.com/o/r/tree/main')
  assert.equal(maybeRewriteBlob(u), null)
})
