'use strict'

// ============================================================================
// 页面与前端逻辑的守卫测试
//
// 这一组测的不是「像素级好看」，而是几类会让线上出事的错误：
//
//   1. **内联脚本语法错误**。页面里的 <script> 是拼字符串拼出来的，一旦少个
//      括号，浏览器会静默丢弃整段脚本——按钮点了没反应，控制台之外毫无线索。
//      这里把每段内联脚本抽出来丢进 vm 编译一次，语法错立刻报。
//   2. **引用了外部资源**。零外部资源是本项目的硬约束（不引字体/图标/CDN），
//      一旦有人加了 <link href="https://fonts...">，边缘缓存和可用性都会受影响。
//   3. **主题三态缺失**。auto / light / dark 必须都可用，且首帧前落定。
//   4. **?check= 接口与真实代理判定不一致**。两者必须用同一个 checkTarget，
//      否则「页面说能加速、实际 400」这种漂移会重新出现。
//   5. **异常没有被兜住**。Worker 里未捕获的异常 = Cloudflare 1101 空白页。
// ============================================================================

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import worker from '../src/index.js'
import { renderLanding, renderErrorPage, renderDisguise, REPO_URL, VERSION } from '../src/pages.js'
import { resolveConfig } from '../src/config.js'

const CFG = resolveConfig({})

/** 抽出页面里所有内联 <script> 的内容。 */
function inlineScripts(html) {
  const out = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let m
  while ((m = re.exec(html)) !== null) out.push(m[1])
  return out
}

/** 编译一段脚本（不执行），语法错就抛。 */
function compile(code) {
  // eslint-disable-next-line no-new
  new vm.Script(code)
}

/** 抽出页面里所有 src=/href= 的外部地址。 */
function externalRefs(html) {
  const out = []
  const re = /(?:src|href)="([^"]+)"/g
  let m
  while ((m = re.exec(html)) !== null) {
    const v = m[1]
    if (/^(https?:)?\/\//i.test(v) || v.startsWith('//')) out.push(v)
  }
  return out
}

/** 造一个打 Worker 的请求。 */
function req(path, opts = {}) {
  return new Request(`https://gh.test${path}`, opts)
}

async function callWorker(path, opts) {
  const res = await worker.fetch(req(path, opts), {}, { waitUntil() {} })
  return res
}

// ---------------------------------------------------------------------------
// 1. 首页结构
// ---------------------------------------------------------------------------

test('首页：内联脚本都能编译（语法错会让整段脚本被静默丢弃）', () => {
  const html = renderLanding(CFG)
  const scripts = inlineScripts(html)
  // head 里一段（主题首帧落定）+ body 末尾一段（主题切换 + 交互）
  assert.ok(scripts.length >= 2, `应至少有 2 段内联脚本，实际 ${scripts.length}`)
  for (const [i, code] of scripts.entries()) {
    assert.doesNotThrow(() => compile(code), `第 ${i + 1} 段内联脚本有语法错误`)
  }
})

test('首页：没有引用任何外部资源（零外部依赖是硬约束）', () => {
  const html = renderLanding(CFG)
  const refs = externalRefs(html)
  // 唯一允许的是右上角那个指向本仓库的外链（它是 <a href>，不是资源）
  const allowed = [REPO_URL]
  const unexpected = refs.filter((r) => !allowed.includes(r))
  assert.deepEqual(unexpected, [], `不该引用外部资源，发现：${unexpected.join(', ')}`)
})

test('右下角显示版本号，且与 package.json 一致（发版只改一处必被发现）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version, '页脚版本号必须与 package.json 同步')
  const re = new RegExp(`<div class="ver" title="当前版本">v${VERSION.replace(/\./g, '\\.')}</div>`)
  for (const html of [renderLanding(CFG), renderErrorPage(CFG, '测试原因')]) {
    assert.match(html, re, '首页与错误页都要显示版本号')
  }
})

test('顶栏：logo 整块是回首页的链接（首页与错误页都有）', () => {
  for (const html of [renderLanding(CFG), renderErrorPage(CFG, '测试原因')]) {
    assert.match(html, /<a class="home" href="\/" title="回到首页">/, 'logo 应当包在回首页的 <a> 里')
  }
})

test('顶栏：logo 的 href 跟着 PREFIX 走（挂在 /gh/ 下就回 /gh/）', () => {
  const prefixed = { ...CFG, prefix: '/gh/' }
  assert.match(renderLanding(prefixed), /<a class="home" href="\/gh\/"/)
  assert.match(renderErrorPage(prefixed, 'x'), /<a class="home" href="\/gh\/"/)
})

test('首页：有输入框、加速按钮、清空按钮；示例只有一个 raw 直链、没有复制按钮', () => {
  const html = renderLanding(CFG)
  assert.match(html, /id="q"/)
  assert.match(html, /id="go"/)
  assert.match(html, /id="clear"/)
  // 示例：只留一条 README.md 的 raw 直链
  const exs = [...html.matchAll(/data-ex="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(exs, ['https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/README.md'])
  // 输入框的占位符与示例一致，用户一眼能照着改
  assert.match(html, /placeholder="https:\/\/raw\.githubusercontent\.com\/geekMus\/cf-gh-proxy\/main\/README\.md"/)
  // 复制示例按钮已去掉
  assert.doesNotMatch(html, /id="copy"/)
  assert.doesNotMatch(html, /复制示例/)
  // 无障碍：按钮必须有可读标签
  assert.match(html, /aria-label="清空输入"/)
})

test('首页：提示区带 role=status 与 aria-live（屏幕阅读器能听到校验结果）', () => {
  const html = renderLanding(CFG)
  assert.match(html, /role="status"/)
  assert.match(html, /aria-live="polite"/)
})

// ---------------------------------------------------------------------------
// 2. 主题三态
// ---------------------------------------------------------------------------

test('主题：默认 auto，且三态的选择器与图标都在', () => {
  for (const html of [renderLanding(CFG), renderErrorPage(CFG, '测试原因')]) {
    assert.match(html, /data-theme="auto"/)
    // 跟随系统
    assert.match(html, /prefers-color-scheme:dark/)
    // 显式选择
    assert.match(html, /:root\[data-theme=dark\]/)
    assert.match(html, /:root\[data-theme=light\]/)
    // 三套图标/文字，由 CSS 按当前 data-theme 选
    for (const k of ['auto', 'light', 'dark']) {
      assert.match(html, new RegExp(`ti-${k}`), `缺少 ${k} 的图标`)
      assert.match(html, new RegExp(`tl-${k}`), `缺少 ${k} 的文字`)
    }
  }
})

test('主题：在 <head> 里同步落定，避免首帧闪白', () => {
  const html = renderLanding(CFG)
  const head = html.slice(0, html.indexOf('</head>'))
  assert.match(head, /cfgh\.theme/, '<head> 里应读取 localStorage 并立即 setAttribute')
  assert.match(head, /setAttribute\('data-theme'/)
})

test('主题：切换逻辑是 auto → light → dark → auto 的闭环', () => {
  const html = renderLanding(CFG)
  assert.match(html, /auto:'light',light:'dark',dark:'auto'/)
  // localStorage 被禁用时不能抛（隐私模式里 getItem/setItem 会 throw）
  assert.match(html, /try\{ localStorage/)
})

// ---------------------------------------------------------------------------
// 3. 错误页
// ---------------------------------------------------------------------------

test('错误页：内联脚本能编译，且把原因原样展示', () => {
  const html = renderErrorPage(CFG, '这是仓库首页（网页），不是文件')
  for (const code of inlineScripts(html)) {
    assert.doesNotThrow(() => compile(code))
  }
  assert.ok(html.includes('这是仓库首页（网页），不是文件'))
})

test('错误页：原因里的 HTML 被转义（防 XSS）', () => {
  const html = renderErrorPage(CFG, '<img src=x onerror=alert(1)>')
  assert.ok(!html.includes('<img src=x'), '未转义的标签会形成 XSS')
  assert.ok(html.includes('&lt;img src=x'))
})

test('错误页：有返回首页的链接', () => {
  const html = renderErrorPage(CFG, 'x')
  assert.match(html, /回到首页重新输入/)
})

test('错误页：正确形态用的是真实域名，不是 your-domain 占位符', () => {
  const html = renderErrorPage(CFG, 'x', 'https://gh.example.com')
  assert.ok(
    html.includes('https://gh.example.com/https://github.com/owner/repo/releases/download/v1.0.0/app.zip'),
    '示例应当拼上当前请求的 origin'
  )
  assert.ok(!html.includes('your-domain'), '有 origin 时不该再出现占位符')
})

test('错误页：拿不到 origin 时退回占位符（别拼出半个 URL）', () => {
  const html = renderErrorPage(CFG, 'x')
  assert.ok(html.includes('https://your-domain/https://github.com/owner/repo/'))
})

// ---------------------------------------------------------------------------
// 4. ?check= 接口
// ---------------------------------------------------------------------------

test('?check=：合法链接返回 ok:true 与归一后的 href', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('https://github.com/o/r/releases/download/v1/x.zip'))
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/json/)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.href, 'https://github.com/o/r/releases/download/v1/x.zip')
  assert.equal(body.kind, 'release')
})

test('?check=：裸 owner/repo 路径也能归一', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('o/r/releases/download/v1/x.zip'))
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.href, 'https://github.com/o/r/releases/download/v1/x.zip')
})

test('?check=：网页路径返回 ok:false 与可读原因', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('https://github.com/login'))
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.ok(body.reason.includes('/login'), `原因应点名 /login，实际：${body.reason}`)
})

test('?check=：随意输入被拒', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('随便什么'))
  const body = await res.json()
  assert.equal(body.ok, false)
})

test('?check=：非 GitHub 域名被拒', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('https://example.com/x.zip'))
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.ok(body.reason.includes('example.com'))
})

test('?check=：结果不进缓存（否则换了目标会拿到旧结论）', async () => {
  const res = await callWorker('/?check=' + encodeURIComponent('https://github.com/o/r/releases/download/v1/x.zip'))
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('?check= 与真实代理的判定必须一致（同一套规则，不许漂移）', async () => {
  const cases = [
    'https://github.com/o/r/releases/download/v1/x.zip',
    'https://github.com/login',
    'https://github.com/o/r',
    'https://github.com/o/r/tree/main',
    'https://example.com/x.zip',
    'https://github.com/o/r/archive/refs/heads/main.zip',
    'https://github.com/o/r/blob/main/README.md',
  ]
  for (const link of cases) {
    const checkRes = await callWorker('/?check=' + encodeURIComponent(link))
    const { ok } = await checkRes.json()
    // 真实代理路径：把链接直接接在前缀后面
    const proxyRes = await callWorker('/' + link)
    // 放行的会去真的抓 GitHub（这里用 HEAD 避免下载正文），拒绝的必须是 400
    if (!ok) {
      assert.equal(proxyRes.status, 400, `${link} 校验说不合法，代理却给了 ${proxyRes.status}`)
      await proxyRes.body?.cancel()
    } else {
      // 合法时不该是 400；具体状态取决于上游，这里只断言「没有被校验拦下」
      assert.notEqual(proxyRes.status, 400, `${link} 校验说合法，代理却 400 了`)
      await proxyRes.body?.cancel()
    }
  }
})

test('页面内的本地形态判定与 ?check= 结论一致（前端不许说「能」，后端说「不能」）', async () => {
  const html = renderLanding(CFG)
  const start = html.indexOf('var HOSTS=')
  const end = html.indexOf('  // 点「加速」')
  assert.notEqual(start, -1, '页面里找不到本地判定 looksLikeFile')
  assert.notEqual(end, -1, '页面里找不到提交函数 submit')
  // 把那段纯函数抠出来直接跑：它只依赖 URL 与 HOSTS，不碰 DOM。
  const looksLikeFile = new Function('URL', html.slice(start, end) + '\nreturn looksLikeFile;')(URL)

  const cases = [
    // 该放行的
    'https://github.com/o/r/releases/download/v1/x.zip',
    'https://github.com/o/r/releases/latest/download/x.zip',
    'https://github.com/o/r/archive/refs/heads/main.zip',
    'https://github.com/o/r/blob/main/README.md',
    'https://github.com/o/r/raw/main/a.js',
    'https://raw.githubusercontent.com/o/r/main/a.js',
    'https://codeload.github.com/o/r/zip/main',
    'https://gist.github.com/u/abc123/raw',
    'https://gist.githubusercontent.com/u/abc123',
    'https://api.github.com/repos/o/r/releases/latest',
    // 该拦下的
    'https://github.com/o/r',
    'https://github.com/login',
    'https://github.com/o/r/tree/main',
    'https://github.com/o/r/releases',
    'https://example.com/x.zip',
    'https://raw.githubusercontent.com/o/r/main',
    'https://gist.github.com/u/abc123',
  ]
  for (const link of cases) {
    const clientOk = looksLikeFile(link) === ''
    const checkRes = await callWorker('/?check=' + encodeURIComponent(link))
    const { ok } = await checkRes.json()
    assert.equal(clientOk, ok, `${link}：前端判定「${clientOk ? '放行' : '拦下'}」，后端 ?check= 判定「${ok ? '放行' : '拦下'}」`)
  }
})

// ---------------------------------------------------------------------------
// 5. 1101 防线：异常必须被兜住
// ---------------------------------------------------------------------------

test('兜底：未预料到的异常变成可读 500，而不是 1101 空白页', async () => {
  // 用「env 是 Proxy，任何读取都抛」来强制 resolveConfig 内部抛异常
  const boom = new Proxy(
    {},
    {
      get() {
        throw new Error('模拟内部异常')
      },
    },
  )
  const res = await worker.fetch(req('/'), boom, { waitUntil() {} })
  assert.equal(res.status, 500, '异常应被兜底成 500')
  const text = await res.text()
  assert.match(text, /内部错误/)
  // 具体异常只写日志，不回显给客户端（免得把内部地址/细节漏出去）
  assert.doesNotMatch(text, /模拟内部异常/)
})

test('兜底：各种畸形请求都不会抛（抛了就是 1101）', async () => {
  const paths = [
    '/',
    '/%',
    '/%zz',
    '/..',
    '/../../etc/passwd',
    '/' + 'a'.repeat(2000),
    '/?check=',
    '/?check=%00',
    '/?q=',
    '/?q=%00',
    '/favicon.ico',
    '/gh/https://github.com/o/r',
    '/https://github.com/o/r/releases/download/v1/x.zip',
  ]
  for (const p of paths) {
    const res = await callWorker(p, { method: 'GET' })
    assert.ok(res.status < 500 || res.status === 502 || res.status === 508,
      `${p} 返回了 ${res.status}（5xx 意味着异常逃出来了）`)
    await res.body?.cancel()
  }
})

test('兜底：HEAD 与非 GET 方法也不会抛', async () => {
  for (const method of ['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await callWorker('/https://github.com/o/r/releases/download/v1/x.zip', { method })
    assert.ok(res.status > 0)
    await res.body?.cancel()
  }
})

// ---------------------------------------------------------------------------
// 6. 伪装页必须保持原样
// ---------------------------------------------------------------------------

test('伪装页：和真 nginx 默认页一致，不要被美化', () => {
  const html = renderDisguise()
  assert.match(html, /Welcome to nginx!/)
  assert.match(html, /nginx\.org/)
  // 不该掺进本项目的任何样式或主题逻辑
  assert.ok(!html.includes('data-theme'), '伪装页不能带主题标记')
  assert.ok(!html.includes('cfgh'), '伪装页不能带本项目痕迹')
})
