'use strict'

// ============================================================================
// 静态页面：说明页 / nginx 伪装页
//
// 页面形态与伪装机制沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 去掉了原版内嵌的第三方站点引用。
// ============================================================================

/**
 * 首页。刻意保持精简：只说明用法与合法输入，不引用任何第三方站点。
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 */
export function renderLanding(cfg) {
  const prefix = cfg.prefix
  const exampleBase = `https://your-domain${prefix === '/' ? '' : prefix}`
  const landing = escapeHtml(cfg.landingLink)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>GitHub 文件加速</title>
<style>
  :root { --fg:#e6edf3; --dim:#8b949e; --bg:#0d1117; --card:#161b22; --line:#30363d; --accent:#4493f8; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.6;
    padding: 48px 20px; display: flex; justify-content: center;
  }
  .wrap { width: 100%; max-width: 760px; }
  h1 { font-size: 1.9rem; font-weight: 600; margin-bottom: .4rem; }
  .sub { color: var(--dim); margin-bottom: 2rem; font-size: .95rem; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 20px 22px; margin-bottom: 18px;
  }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .9rem; }
  .row { display: flex; gap: 10px; }
  input[type=text] {
    flex: 1; height: 44px; padding: 0 14px; font-size: .95rem;
    color: var(--fg); background: var(--bg);
    border: 1px solid var(--line); border-radius: 8px; outline: none;
  }
  input[type=text]:focus { border-color: var(--accent); }
  button {
    height: 44px; padding: 0 20px; font-size: .95rem; font-weight: 500;
    color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { filter: brightness(1.1); }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre {
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
    padding: 12px 14px; overflow-x: auto; font-size: .85rem; color: var(--fg);
    white-space: pre; margin: 8px 0;
  }
  ul { list-style: none; }
  li { padding: 5px 0; color: var(--dim); font-size: .9rem; }
  li code { color: var(--fg); }
  .note { color: var(--dim); font-size: .85rem; margin-top: .8rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="wrap">
  <h1>GitHub 文件加速</h1>
  <p class="sub">把 GitHub 的 release / archive / raw 链接换成下面的形式，走 Cloudflare 边缘节点。</p>

  <div class="card">
    <h2>输入 GitHub 链接</h2>
    <div class="row">
      <input type="text" id="q" placeholder="https://github.com/user/repo/releases/download/v1.0.0/file.zip" autocomplete="off">
      <button id="go">加速</button>
    </div>
    <p class="note">也可以直接在浏览器地址栏里把链接接在 <code>${escapeHtml(prefix)}</code> 后面。</p>
  </div>

  <div class="card">
    <h2>用法</h2>
    <pre>${escapeHtml(exampleBase)}https://github.com/owner/repo/releases/download/v1.0.0/app.zip</pre>
    <p class="note">省略 <code>https://github.com/</code> 也能用：</p>
    <pre>${escapeHtml(exampleBase)}owner/repo/releases/download/v1.0.0/app.zip</pre>
  </div>

  <div class="card">
    <h2>支持的路径</h2>
    <ul>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/download/&lt;tag&gt;/&lt;file&gt;</code> — release 资产</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/archive/&lt;ref&gt;.zip</code> — 源码打包</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/raw/&lt;ref&gt;/&lt;path&gt;</code> — 分支/提交里的单文件</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/blob/&lt;ref&gt;/&lt;path&gt;</code> — 同上，自动转成 raw</li>
      <li><code>raw.githubusercontent.com/&lt;owner&gt;/&lt;repo&gt;/&lt;ref&gt;/&lt;path&gt;</code> — raw 直链</li>
      <li><code>gist.githubusercontent.com/…</code> — Gist</li>
    </ul>
    <p class="note">只代理 GitHub 自家域名，其它域名一律 403。</p>
  </div>

  <p class="note">没有提供有效链接时，请访问 <a href="${landing}">${landing}</a>。</p>
</div>

<script>
  (function () {
    var input = document.getElementById('q');
    var go = document.getElementById('go');
    function run() {
      var v = (input.value || '').trim();
      if (!v) { input.focus(); return; }
      v = v.replace(/^https?:\\/\\//i, 'https://');
      var base = location.origin + ${JSON.stringify(prefix)};
      if (!/^https?:\\/\\//i.test(v)) v = 'https://github.com/' + v;
      location.href = base + v;
    }
    go.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  })();
</script>
</body>
</html>`
}

/** 命中屏蔽 UA 时返回的伪装页 */
export function renderDisguise() {
  return `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>

<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>`
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
