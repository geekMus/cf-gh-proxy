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
  .tip {
    display: none; margin-top: 10px; padding: 8px 12px;
    border-left: 3px solid var(--warn); background: rgba(248,81,73,.08);
    border-radius: 6px; font-size: .88rem; color: var(--fg); word-break: break-all;
  }
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
    <p class="tip" id="tip"></p>
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
    var tip = document.getElementById('tip');

    // 与后端 validate.js 的规则保持一致。前端校验只是「少跑一趟」，
    // 真正的判定在后端——这里放过的任何东西后端都会再验一遍。
    var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
    var REF = /^[A-Za-z0-9._-][A-Za-z0-9._\\/-]{0,199}$/;

    function fail(msg) {
      tip.textContent = msg;
      tip.style.display = 'block';
      input.focus();
      return null;
    }

    function ok() {
      tip.style.display = 'none';
      return true;
    }

    // 把用户输入归一成「https://...」形式，再拆出 host 与 path 做形态判定
    function normalize(v) {
      v = v.replace(/^(https?):\\/(?!\\/)/i, '$1://');
      var scheme = v.match(/^([a-z][a-z0-9+.-]*):/i);
      if (scheme) {
        if (!/^https?$/i.test(scheme[1])) return fail('只支持 http / https 链接，收到：' + scheme[1]);
      }
      if (!/^https?:\\/\\//i.test(v)) {
        var first = v.split(/[/?#]/)[0];
        // 首段含点当域名，否则当裸 owner/repo
        v = /^[a-z0-9-]+(?:\\.[a-z0-9-]+)+$/i.test(first)
          ? 'https://' + v
          : 'https://github.com/' + v;
      }
      return v;
    }

    function checkPath(u) {
      var segs = u.pathname.split('/').filter(Boolean);

      if (u.hostname === 'github.com') {
        if (segs.length < 2) return fail('路径太短，至少要 owner/repo');
        if (!NAME.test(segs[0]) || !NAME.test(segs[1])) return fail('owner 或 repo 名字不合法');
        if (segs.length === 2) return fail('这是仓库首页，不是文件。请给 releases/download、archive、raw 或 blob 路径');
        var t = segs[2];
        if (t === 'releases') {
          if (segs.length >= 5 && segs[3] === 'download') {
            if (!REF.test(segs[4])) return fail('tag 不合法');
            if (segs.length < 6) return fail('releases/download 后面缺文件名');
            return ok();
          }
          if (segs.length >= 6 && segs[3] === 'latest' && segs[4] === 'download') return ok();
          return fail('这是 releases 的网页页面，资产路径要含 /download/');
        }
        if (t === 'archive') {
          if (segs.length < 4) return fail('archive 路径不完整');
          var rest = segs[3] === 'refs' ? segs.slice(5).join('/') : segs.slice(3).join('/');
          if (segs[3] === 'refs' && (segs[4] !== 'heads' && segs[4] !== 'tags')) {
            return fail('archive/refs 只支持 heads 或 tags');
          }
          if (!/\\.(zip|tar\\.gz|tgz)$/i.test(rest)) return fail('archive 只支持 .zip / .tar.gz / .tgz');
          return ok();
        }
        if (t === 'raw' || t === 'blob') {
          if (segs.length < 5) return fail(t + ' 路径不完整，需要 ref 和文件路径');
          if (!REF.test(segs[3])) return fail('ref 不合法');
          return ok();
        }
        return fail('不支持的路径类型：/' + t + '（只支持 releases/download、archive、raw、blob）');
      }

      if (u.hostname === 'raw.githubusercontent.com') {
        if (segs.length < 4) return fail('raw 路径不完整，需要 owner/repo/ref/file');
        if (!NAME.test(segs[0]) || !NAME.test(segs[1])) return fail('owner 或 repo 名字不合法');
        if (!REF.test(segs[2])) return fail('ref 不合法');
        return ok();
      }

      if (u.hostname === 'gist.githubusercontent.com' || u.hostname === 'gist.github.com') {
        if (segs.length < 2) return fail('gist 路径不完整');
        return ok();
      }

      if (u.hostname === 'codeload.github.com') {
        if (segs.length < 4) return fail('codeload 路径不完整，需要 owner/repo/zip/ref');
        if (!/^(zip|tar\\.gz|tgz|legacy\\.zip|legacy\\.tar\\.gz)$/i.test(segs[2])) return fail('codeload 只支持 zip / tar.gz');
        return ok();
      }

      return fail('只支持 GitHub 的域名：github.com / raw.githubusercontent.com / gist.githubusercontent.com / codeload.github.com');
    }

    function run() {
      var v = (input.value || '').trim();
      if (!v) { fail('请输入一个 GitHub 链接'); return; }

      var href = normalize(v);
      if (!href) return;

      var u;
      try { u = new URL(href); } catch (e) { fail('这个链接解析不出来，检查一下格式'); return; }

      if (!checkPath(u)) return;

      location.href = location.origin + ${JSON.stringify(prefix)} + u.href;
    }

    go.addEventListener('click', run);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') run(); });
  })();
</script>
</body>
</html>`
}

/**
 * 链接不合法时的说明页。
 *
 * 为什么不直接返回 404/403 纯文本：首页那个输入框会把任意输入拼成 URL，
 * 用户很容易粘错；给一页说明「错在哪、正确形态是什么」比一句 403 有用得多。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {string} reason 具体原因（由 validate.js 产出）
 */
export function renderErrorPage(cfg, reason) {
  const prefix = cfg.prefix
  const exampleBase = `https://your-domain${prefix === '/' ? '' : prefix}`
  const home = `${escapeHtml(prefix)}`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>不是可加速的 GitHub 文件</title>
<style>
  :root { --fg:#e6edf3; --dim:#8b949e; --bg:#0d1117; --card:#161b22; --line:#30363d; --accent:#4493f8; --warn:#f85149; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg); color: var(--fg); line-height: 1.6;
    padding: 48px 20px; display: flex; justify-content: center;
  }
  .wrap { width: 100%; max-width: 760px; }
  h1 { font-size: 1.6rem; font-weight: 600; margin-bottom: .4rem; }
  .sub { color: var(--dim); margin-bottom: 2rem; font-size: .95rem; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 20px 22px; margin-bottom: 18px;
  }
  .card h2 { font-size: 1rem; font-weight: 600; margin-bottom: .9rem; }
  .reason {
    border-left: 3px solid var(--warn); background: rgba(248,81,73,.08);
    padding: 10px 14px; border-radius: 6px; font-size: .92rem;
    color: var(--fg); word-break: break-all;
  }
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
  <h1>不是可加速的 GitHub 文件</h1>
  <p class="sub">这个地址不是一个可以下载的文件路径，所以没有去抓取。</p>

  <div class="card">
    <h2>具体原因</h2>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="note">本服务只代理 GitHub 上<strong>可下载的资源</strong>，不代理网页。仓库首页、issues、settings、search 这类页面会被拒绝。</p>
  </div>

  <div class="card">
    <h2>正确形态</h2>
    <pre>${escapeHtml(exampleBase)}https://github.com/owner/repo/releases/download/v1.0.0/app.zip</pre>
    <p class="note">省略 <code>https://github.com/</code> 也行：</p>
    <pre>${escapeHtml(exampleBase)}owner/repo/releases/download/v1.0.0/app.zip</pre>
  </div>

  <div class="card">
    <h2>支持的路径</h2>
    <ul>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/download/&lt;tag&gt;/&lt;file&gt;</code> — release 资产</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/releases/latest/download/&lt;file&gt;</code> — 最新 release</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/archive/&lt;ref&gt;.zip</code> — 源码打包</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/raw/&lt;ref&gt;/&lt;path&gt;</code> — 分支/提交里的单文件</li>
      <li><code>github.com/&lt;owner&gt;/&lt;repo&gt;/blob/&lt;ref&gt;/&lt;path&gt;</code> — 同上，自动转成 raw</li>
      <li><code>raw.githubusercontent.com/&lt;owner&gt;/&lt;repo&gt;/&lt;ref&gt;/&lt;path&gt;</code> — raw 直链</li>
      <li><code>gist.githubusercontent.com/…</code> — Gist</li>
    </ul>
  </div>

  <p class="note"><a href="${home}">← 回到首页重新输入</a></p>
</div>
</body>
</html>`
}

/** 命中屏蔽 UA 时返回的伪装页 */
export function renderDisguise() {  return `<!DOCTYPE html>
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
