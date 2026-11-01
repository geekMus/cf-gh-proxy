'use strict'

// 上游兼容性测试：cmliu/CF-Workers-GitHub 的 URL / URL302 伪装变量语义

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.js'

test('URL302 优先于 URL', () => {
  const cfg = resolveConfig({ URL302: 'https://t.me/x', URL: 'https://www.baidu.com/' })
  assert.equal(cfg.homeRedirect, 'https://t.me/x')
})

test('只设 URL302 → 302 跳转', () => {
  const cfg = resolveConfig({ URL302: 'https://t.me/x' })
  assert.equal(cfg.homeRedirect, 'https://t.me/x')
  assert.equal(cfg.disguiseNginx, false)
})

test('URL=nginx → 伪装成 nginx 默认页（不跳转）', () => {
  const cfg = resolveConfig({ URL: 'nginx' })
  assert.equal(cfg.disguiseNginx, true)
  assert.equal(cfg.homeRedirect, '')
})

test('URL=NGINX（大小写不敏感）同样生效', () => {
  const cfg = resolveConfig({ URL: 'NGINX' })
  assert.equal(cfg.disguiseNginx, true)
})

test('URL 填普通地址 → 302 到该地址', () => {
  const cfg = resolveConfig({ URL: 'https://www.baidu.com/' })
  assert.equal(cfg.homeRedirect, 'https://www.baidu.com/')
  assert.equal(cfg.disguiseNginx, false)
})

test('都不设 → 显示说明页（不跳转、不伪装）', () => {
  const cfg = resolveConfig({})
  assert.equal(cfg.homeRedirect, '')
  assert.equal(cfg.disguiseNginx, false)
})

test('空字符串等同于不设', () => {
  const cfg = resolveConfig({ URL: '', URL302: '   ' })
  assert.equal(cfg.homeRedirect, '')
  assert.equal(cfg.disguiseNginx, false)
})

test('LANDING_LINK 默认为本仓库地址', () => {
  assert.equal(resolveConfig({}).landingLink, 'https://github.com/geekMus/cf-gh-proxy')
  assert.equal(resolveConfig({ LANDING_LINK: 'https://example.org/' }).landingLink, 'https://example.org/')
})
