'use strict'

// jsDelivr 改写的行为测试

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'
import { buildTargetUrl, maybeJsdelivrUrl } from '../src/proxy.js'

const ON = resolveConfig({ JSDELIVR: '1' })
const OFF = resolveConfig({ JSDELIVR: '0' })

test('默认关闭时不改写', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/v1.2.3/x.js')
  assert.equal(maybeJsdelivrUrl(u, OFF), null)
})

test('按 tag 的 raw 会被改写到 jsDelivr', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/v1.2.3/x.js')
  const out = maybeJsdelivrUrl(u, ON)
  assert.equal(out.hostname, 'cdn.jsdelivr.net')
  assert.equal(out.pathname, '/gh/o/r@v1.2.3/x.js')
})

test('按 commit SHA 的 raw 会被改写', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/0123456789abcdef0123456789abcdef01234567/x.js')
  const out = maybeJsdelivrUrl(u, ON)
  assert.equal(out.pathname, '/gh/o/r@0123456789abcdef0123456789abcdef01234567/x.js')
})

test('按分支名（main）不改写——会被 jsDelivr 的旧缓存坑到', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/main/x.js')
  assert.equal(maybeJsdelivrUrl(u, ON), null)
})

test('github.com/blob 形态会被改写', () => {
  const u = buildTargetUrl('https://github.com/o/r/blob/v1.0.0/src/x.js')
  const out = maybeJsdelivrUrl(u, ON)
  assert.equal(out.pathname, '/gh/o/r@v1.0.0/src/x.js')
})

test('github.com/raw 形态会被改写', () => {
  const u = buildTargetUrl('https://github.com/o/r/raw/v2.0.0/x.js')
  const out = maybeJsdelivrUrl(u, ON)
  assert.equal(out.pathname, '/gh/o/r@v2.0.0/x.js')
})

test('release 资产不会被改写（jsDelivr 不支持）', () => {
  const u = buildTargetUrl('https://github.com/o/r/releases/download/v1/x.zip')
  assert.equal(maybeJsdelivrUrl(u, ON), null)
})

test('codeload 打包不会被改写', () => {
  const u = buildTargetUrl('https://codeload.github.com/o/r/zip/main')
  assert.equal(maybeJsdelivrUrl(u, ON), null)
})

test('嵌套路径（含多级目录）保持完整', () => {
  const u = buildTargetUrl('https://raw.githubusercontent.com/o/r/v1.0.0/a/b/c/x.js')
  const out = maybeJsdelivrUrl(u, ON)
  assert.equal(out.pathname, '/gh/o/r@v1.0.0/a/b/c/x.js')
})
