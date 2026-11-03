'use strict'

// ============================================================================
// 路径形态校验的回归测试
//
// 背景：白名单只查域名时，`https://github.com/随便什么` 也会被当成合法目标，
// Worker 会把 GitHub 网页 HTML 抓回来。下面这些用例锁定「只代理文件、不代理网页」。
// ============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  validateGithubPath,
  validateRawPath,
  validateCodeloadPath,
  validateGistPath,
  validateSignedAssetPath,
  validateTargetPath,
} from '../src/validate.js'
import { buildTargetUrl, checkTarget, isAllowedTarget } from '../src/proxy.js'

/** 便捷断言：给一个原始输入，期望被拒绝。 */
function denied(raw) {
  const u = buildTargetUrl(raw)
  if (!u) return true
  return !checkTarget(u).ok
}

/** 便捷断言：给一个原始输入，期望被接受，并返回 kind。 */
function accepted(raw) {
  const u = buildTargetUrl(raw)
  assert.ok(u, `应当能解析：${raw}`)
  const v = checkTarget(u)
  assert.ok(v.ok, `应当被接受：${raw}（实际：${v.reason}）`)
  return v.kind
}

// ---------------------------------------------------------------------------
// 1. 随意输入必须被拒
// ---------------------------------------------------------------------------

test('随意输入不被当作文件', () => {
  for (const raw of ['随便什么', 'hello', 'abc123', 'notarepo', 'a', 'foo bar', '!!!']) {
    assert.ok(denied(raw), `不应放行：${raw}`)
  }
})

test('中文路径不被当作文件', () => {
  assert.ok(denied('https://github.com/随便什么'))
  assert.ok(denied('随便什么'))
})

// ---------------------------------------------------------------------------
// 2. GitHub 网页路径必须被拒（这是本次修复的核心）
// ---------------------------------------------------------------------------

test('仓库首页 / 网页路径被拒', () => {
  const webPages = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo/',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/issues',
    'https://github.com/owner/repo/pulls',
    'https://github.com/owner/repo/actions',
    'https://github.com/owner/repo/wiki',
    'https://github.com/owner/repo/settings',
    'https://github.com/login',
    'https://github.com/logout',
    'https://github.com/settings/profile',
    'https://github.com/search?q=x',
    'https://github.com/explore',
    'https://github.com/topics',
    'https://github.com/notifications',
  ]
  for (const raw of webPages) {
    assert.ok(denied(raw), `网页路径不应被代理：${raw}`)
  }
})

test('releases 的网页页面被拒，只放行 download', () => {
  assert.ok(denied('https://github.com/owner/repo/releases'))
  assert.ok(denied('https://github.com/owner/repo/releases/tag/v1.0.0'))
  assert.ok(denied('https://github.com/owner/repo/releases/latest'))
  // 资产路径放行
  assert.equal(accepted('https://github.com/owner/repo/releases/download/v1.0.0/app.zip'), 'release')
  assert.equal(accepted('https://github.com/owner/repo/releases/latest/download/app.zip'), 'release')
})

// ---------------------------------------------------------------------------
// 3. 真正的文件路径必须放行（不能把功能改坏）
// ---------------------------------------------------------------------------

test('release 资产放行（完整链接与不带协议两种写法）', () => {
  assert.equal(accepted('https://github.com/o/r/releases/download/v1/x.zip'), 'release')
  assert.equal(accepted('github.com/o/r/releases/download/v1/x.zip'), 'release')
  // 资产文件名里带路径分隔也允许（有些项目这么发）
  assert.equal(accepted('https://github.com/o/r/releases/download/v1/sub/x.zip'), 'release')
})

test('裸 owner/repo 写法不再支持（v1.2.18 起与前端一致）', () => {
  // 首段不含点 → 不再猜成 github.com，buildTargetUrl 直接返回 null（400）。
  assert.equal(buildTargetUrl('o/r/releases/download/v1/x.zip'), null)
  assert.equal(buildTargetUrl('geekMus/container-autoupdate/main/x'), null)
  assert.ok(denied('o/r/releases/download/v1/x.zip'))

  // 首段带点的（owner.name/repo/...）仍会被当成主机名，然后卡在白名单这一层。
  // 两条路都拒绝，这正是「只认完整链接」的原因：同一形态的归属取决于 owner 里有没有点。
  const dotted = buildTargetUrl('owner.name/repo/releases/download/v1/x.zip')
  assert.ok(dotted, '首段像域名，仍能解析成 URL')
  assert.equal(dotted.hostname, 'owner.name')
  assert.ok(denied('owner.name/repo/releases/download/v1/x.zip'))
})

test('archive 放行三种写法', () => {
  assert.equal(accepted('https://github.com/o/r/archive/v1.0.0.zip'), 'archive')
  assert.equal(accepted('https://github.com/o/r/archive/refs/heads/main.zip'), 'archive')
  assert.equal(accepted('https://github.com/o/r/archive/refs/tags/v1.0.0.tar.gz'), 'archive')
  assert.equal(accepted('https://github.com/o/r/archive/refs/heads/feature/x.zip'), 'archive')
})

test('archive 的非法形态被拒', () => {
  assert.ok(denied('https://github.com/o/r/archive/v1.0.0'), `缺扩展名应拒`)
  assert.ok(denied('https://github.com/o/r/archive/v1.0.0.exe'), `不支持的扩展名应拒`)
  assert.ok(denied('https://github.com/o/r/archive/refs/remotes/origin/main.zip'), `refs/remotes 应拒`)
})

test('raw / blob 放行', () => {
  assert.equal(accepted('https://github.com/o/r/raw/main/x.js'), 'raw')
  assert.equal(accepted('https://github.com/o/r/blob/main/x.js'), 'blob')
  assert.equal(accepted('https://github.com/o/r/raw/v1.0.0/src/a/b.js'), 'raw')
})

test('raw / blob 的非法形态被拒', () => {
  assert.ok(denied('https://github.com/o/r/raw'), `缺 ref 应拒`)
  assert.ok(denied('https://github.com/o/r/raw/main'), `缺文件名应拒`)
})

test('raw.githubusercontent.com 放行与拒绝', () => {
  assert.equal(accepted('https://raw.githubusercontent.com/o/r/main/x.js'), 'raw')
  assert.equal(accepted('https://raw.githubusercontent.com/o/r/v1.0.0/a/b/c.js'), 'raw')
  assert.ok(denied('https://raw.githubusercontent.com/o/r/main'), `缺文件名应拒`)
  assert.ok(denied('https://raw.githubusercontent.com/o'), `路径太短应拒`)
})

test('codeload 放行与拒绝', () => {
  assert.equal(accepted('https://codeload.github.com/o/r/zip/main'), 'codeload')
  assert.equal(accepted('https://codeload.github.com/o/r/tar.gz/v1.0.0'), 'codeload')
  assert.ok(denied('https://codeload.github.com/o/r/exe/main'), `不支持的格式应拒`)
  assert.ok(denied('https://codeload.github.com/o/r/zip'), `缺 ref 应拒`)
})

test('gist 放行', () => {
  assert.equal(accepted('https://gist.githubusercontent.com/user/abc123/raw/x.txt'), 'gist')
  assert.equal(accepted('https://gist.githubusercontent.com/user/abc123/raw'), 'gist')
})

// ---------------------------------------------------------------------------
// 4. 域名层面的防线仍然有效（不能被形态校验绕过）
// ---------------------------------------------------------------------------

test('非 GitHub 域名仍然被拒', () => {
  assert.ok(denied('https://example.com/o/r/releases/download/v1/x.zip'))
  assert.ok(denied('https://evil.com/github.com/o/r'))
  assert.ok(denied('https://github.com.evil.com/o/r'))
})

test('域名欺骗写法被拒', () => {
  // 把 github.com 塞进路径里，hostname 是 evil.com
  assert.ok(denied('https://evil.com/https://github.com/o/r/releases/download/v1/x.zip'))
})

test('只接受完整 URL 的主机，路径不能空', () => {
  assert.ok(denied('https://release-assets.githubusercontent.com/'))
  assert.equal(accepted('https://release-assets.githubusercontent.com/github-production-release-asset/1/x'), 'signed')
})

test('签名资产域名拒绝路径里嵌套 URL', () => {
  const u = buildTargetUrl('https://objects.githubusercontent.com/https://github.com/o/r')
  assert.ok(!validateSignedAssetPath(u).ok)
})

// ---------------------------------------------------------------------------
// 5. 直接测 validate.js 的各个导出（不经过 buildTargetUrl）
// ---------------------------------------------------------------------------

test('validateGithubPath：名字合法性', () => {
  const mk = (p) => new URL('https://github.com' + p)
  assert.ok(!validateGithubPath(mk('/a.b/c.d/releases/download/v1/x.zip')).ok === false, '点号在名字里是允许的')
  // 名字里带空格（URL 编码后）应拒
  assert.ok(!validateGithubPath(mk('/%20bad/r/releases/download/v1/x.zip')).ok)
  // 超长名字
  assert.ok(!validateGithubPath(mk('/' + 'a'.repeat(200) + '/r/releases/download/v1/x.zip')).ok)
})

test('validateGithubPath：tag 合法性', () => {
  const mk = (p) => new URL('https://github.com' + p)
  assert.ok(validateGithubPath(mk('/o/r/releases/download/v1.0.0/x.zip')).ok)
  assert.ok(validateGithubPath(mk('/o/r/releases/download/nightly-2024/x.zip')).ok)
  // tag 里带空格（编码后）应拒
  assert.ok(!validateGithubPath(mk('/o/r/releases/download/v%201/x.zip')).ok)
})

test('validateTargetPath：未知主机被拒', () => {
  const u = new URL('https://unknown.example.com/x')
  assert.ok(!validateTargetPath(u).ok)
  assert.ok(validateTargetPath(u).reason.includes('不支持的主机'))
})

test('checkTarget 返回可读原因', () => {
  const u = buildTargetUrl('https://github.com/owner/repo')
  const v = checkTarget(u)
  assert.ok(!v.ok)
  assert.ok(v.reason.includes('仓库首页'), `原因应提到仓库首页，实际：${v.reason}`)
})

test('isAllowedTarget 与 checkTarget 结论一致', () => {
  const samples = [
    'https://github.com/o/r/releases/download/v1/x.zip',
    'https://github.com/o/r',
    'https://github.com/login',
    'https://raw.githubusercontent.com/o/r/main/x.js',
    'https://example.com/x',
    '随便什么',
  ]
  for (const raw of samples) {
    const u = buildTargetUrl(raw)
    const expected = u ? checkTarget(u).ok : false
    const actual = u ? isAllowedTarget(u) : false
    assert.equal(actual, expected, `两者结论应一致：${raw}`)
  }
})
