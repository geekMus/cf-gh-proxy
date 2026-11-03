/**
 * cf-gh-proxy v1.2.17 —— GitHub 文件加速 Cloudflare Worker
 *
 * 这个文件是自动构建产物，请勿直接编辑。
 * 源码与构建方式：https://github.com/geekMus/cf-gh-proxy
 *
 * 基于 cmliu/CF-Workers-GitHub 演化而来（MIT, Copyright (c) 2025 CMLiussss）
 * Copyright (c) 2026 cf-gh-proxy contributors
 *
 * 本文件为源码版，**给人看的**：分模块原样拼接，注释一行不丢，便于审计与改动。
 *   部署请用 _worker.min.js（逻辑相同但更短）。
 *
 * 用法（不装任何工具）：整段复制本文件内容，粘贴到
 *   Cloudflare Dashboard → Workers & Pages → Create Worker → 编辑代码。
 */
// ============================================================================
// 模块：src/config.js —— 配置解析
// ============================================================================

'use strict'

// ============================================================================
// 配置解析：把 Worker 的 env（Dashboard 变量 / wrangler vars / .dev.vars）归一化成 cfg
// 每次请求都重新解析，**不保留任何模块级可变状态**。
//
// 这一点很关键：上游 cmliu/CF-Workers-GitHub（MIT, CMLiussss）把屏蔽 UA 列表
// 放在模块全局数组里，每次请求 `屏蔽爬虫UA = 屏蔽爬虫UA.concat(...)`，
// 同一个 isolate 里会无限增长。这里改成每次请求重新解析。
// ============================================================================

const DEFAULT_BLOCKED_UA = ['netcraft']

/** 把 '/gh' / 'gh' / '/gh/' 都归一成 '/gh/'；'/' 保持 '/' */
function normalizePrefix(raw) {
  let p = typeof raw === 'string' && raw.trim() ? raw.trim() : '/'
  if (!p.startsWith('/')) p = '/' + p
  if (!p.endsWith('/')) p = p + '/'
  return p
}

/** 'a b,c|d' → ['a','b','c','d']，统一小写（UA 比较用） */
function parseList(raw) {
  if (typeof raw !== 'string') return []
  return raw
    .split(/[\s,|"'`]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function num(raw, fallback, { min = 0 } = {}) {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min) return fallback
  return n
}

function bool(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

/** 取一个去掉首尾空白的字符串；空值统一成 '' */
function str(raw) {
  return typeof raw === 'string' ? raw.trim() : ''
}

function resolveConfig(env) {
  const e = env || {}
  // 兼容上游（cmliu/CF-Workers-GitHub）的两个伪装变量：
  //   URL     = 主页伪装地址；设为 nginx 则返回 nginx 默认页
  //   URL302  = 主页 302 跳转地址（优先级高于 URL）
  const url302 = str(e.URL302)
  const urlRaw = str(e.URL)
  const urlIsNginx = urlRaw && /^nginx$/i.test(urlRaw)

  return {
    prefix: normalizePrefix(e.PREFIX),
    jsdelivr: bool(e.JSDELIVR, false),
    // 上游响应头到达前的等待上限（毫秒）；拿到响应头后不再计时，下载不受影响
    upstreamTimeout: num(e.UPSTREAM_TIMEOUT, 30000, { min: 1000 }),
    maxRedirects: num(e.MAX_REDIRECTS, 5),
    // 是否把客户端 Cookie / Authorization 转发给上游（默认否，见 README 的安全说明）
    allowAuth: bool(e.ALLOW_AUTH, false),
    blockedUAs: [...DEFAULT_BLOCKED_UA, ...parseList(e.BLOCKED_UA), ...parseList(e.UA)],
    // 页面上的仓库入口是写死的（见 pages.js 的 REPO_URL），不是配置项：
    // 这个页面属于本项目，别人 fork 了要改，改源码里那一行即可。
    // 主页伪装（沿用上游语义）
    disguiseNginx: Boolean(urlIsNginx),
    homeRedirect: absoluteHttp(url302) || (urlRaw && !urlIsNginx ? absoluteHttp(urlRaw) : ''),
  }
}

/**
 * 伪装变量只接受完整的 http(s) 地址。
 *
 * 少了 scheme（`URL=example.com` 是最常见的误配）时 `Response.redirect` 会抛
 * 「Failed to parse URL」，于是每次访问首页都变成 500。这里提前判掉：非法值
 * 当作没配，回退到说明页——宁可露出自己的页面，也不要一个打不开的首页。
 *
 * @param {string} raw
 * @returns {string}
 */
function absoluteHttp(raw) {
  if (!raw) return ''
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

// ============================================================================
// 模块：src/validate.js —— 路径校验
// ============================================================================

// ============================================================================
// 路径形态校验
//
// 为什么需要这一层：白名单只回答「这个域名是不是 GitHub 的」，它管不了
// 「这条路径是不是一个**可下载的文件**」。没有这一层时，`https://github.com/随便什么`
// `https://github.com/login`、`https://github.com/settings/profile` 这类请求
// 都会通过（域名合法），Worker 会老老实实去抓 GitHub 的网页 HTML 回来。
// 那不是「文件加速」，只是把 GitHub 变成了一个通用反向代理。
//
// 本模块只做「形态判定」，不发起任何网络请求。
// ============================================================================

/** GitHub 用户名 / 仓库名：字母数字开头，可含 - _ .，长度 1~100。 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

/** 分支 / tag 名：Git 允许的字符集，禁止空格与 .. 之类的路径穿越。 */
const REF_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,199}$/

/** 路径里的文件名部分：必须有内容，不许是纯目录。 */
const FILE_RE = /^[^\s]+$/

/**
 * 判定结果说明（给调用方拼错误信息用）。
 * @typedef {{ ok: boolean, kind?: string, reason?: string }} Verdict
 */

/**
 * 校验 github.com 上的路径是否是「可下载资源」。
 * 只接受这几类（与 README「支持的路径」一致）：
 *   /owner/repo/releases/download/<tag>/<file...>   release 资产
 *   /owner/repo/releases/latest/download/<file...>  同上，latest 写法
 *   /owner/repo/archive/<ref>.zip|.tar.gz          源码打包
 *   /owner/repo/archive/refs/heads/<branch>.zip    同上，refs 写法
 *   /owner/repo/archive/refs/tags/<tag>.zip        同上，refs 写法
 *   /owner/repo/raw/<ref>/<path...>                单文件
 *   /owner/repo/blob/<ref>/<path...>               同上（会自动转 raw）
 *   /owner/repo/<file>.zip 等直接资产（少数仓库这么发）——不认，避免歧义
 *
 * 明确拒绝：/login、/settings、/search、/explore、/owner/repo（仓库首页）、
 * /owner/repo/issues、/owner/repo/pulls、/owner/repo/tree/...、/owner/repo/actions
 * 这些是网页，不是文件。
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateGithubPath(u) {
  const segs = u.pathname.split('/').filter(Boolean)

  if (segs.length < 2) {
    // 这里要区分两种情况，否则「/login」会被说成「路径太短」，
    // 用户看到「至少要有 owner 和 repo」反而更迷惑——他输入的确实是 GitHub 上的东西。
    const single = segs[0] || ''
    if (/^(login|logout|join|signup|settings|search|explore|topics|notifications|marketplace|sponsors|about|pricing|features|enterprise|team|collections|trending|new|organizations|apps|codespaces|dashboard)$/i.test(single)) {
      return { ok: false, reason: `/${single} 是 GitHub 的网页，不是文件` }
    }
    return { ok: false, reason: '路径里缺少 owner/repo，看起来不是一个 GitHub 文件链接' }
  }

  const [owner, repo] = segs
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner 不合法：${owner}` }
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo 不合法：${repo}` }

  // /owner/repo —— 仓库首页，是网页
  if (segs.length === 2) {
    // settings / search 这类单段词被当成 owner 时（例如 github.com/settings/profile），
    // 报「仓库首页」会误导，明确说它是 GitHub 的网页。
    if (/^(settings|search|explore|topics|notifications|marketplace|sponsors|organizations|apps|codespaces|dashboard|pulls|issues)$/i.test(owner)) {
      return { ok: false, reason: `/${owner} 是 GitHub 的网页，不是文件` }
    }
    return { ok: false, reason: '这是仓库首页（网页），不是文件；请给 releases/download、archive、raw 或 blob 路径' }
  }

  const third = segs[2]

  // ---- releases -----------------------------------------------------------
  if (third === 'releases') {
    // /releases/download/<tag>/<file...>
    // /releases/latest/download/<file...>
    if (segs.length >= 5 && segs[3] === 'download') {
      const tag = segs[4]
      if (!REF_RE.test(tag)) return { ok: false, reason: `tag 不合法：${tag}` }
      if (segs.length < 6) return { ok: false, reason: '缺少文件名' }
      const file = segs.slice(5).join('/')
      if (!FILE_RE.test(file)) return { ok: false, reason: '文件名不合法' }
      return { ok: true, kind: 'release' }
    }
    if (segs.length >= 6 && segs[3] === 'latest' && segs[4] === 'download') {
      const file = segs.slice(5).join('/')
      if (!FILE_RE.test(file)) return { ok: false, reason: '文件名不合法' }
      return { ok: true, kind: 'release' }
    }
    // /releases/tag/v1 —— 发布页，是网页
    return { ok: false, reason: '这是 releases 的网页页面，不是资产；资产路径要含 /download/' }
  }

  // ---- archive ------------------------------------------------------------
  if (third === 'archive') {
    // /archive/refs/heads/<branch>.zip
    // /archive/refs/tags/<tag>.zip
    // /archive/<ref>.zip  （ref 里可能含 /）
    if (segs.length < 4) return { ok: false, reason: 'archive 路径不完整' }
    let refPart
    if (segs[3] === 'refs') {
      if (segs.length < 6) return { ok: false, reason: 'archive/refs 路径不完整' }
      const sub = segs[4] // heads | tags
      if (sub !== 'heads' && sub !== 'tags') {
        return { ok: false, reason: `archive/refs 只支持 heads 或 tags，收到：${sub}` }
      }
      refPart = segs.slice(5).join('/')
    } else {
      refPart = segs.slice(3).join('/')
    }
    if (!/\.(zip|tar\.gz|tgz)$/i.test(refPart)) {
      return { ok: false, reason: 'archive 只支持 .zip / .tar.gz / .tgz' }
    }
    const ref = refPart.replace(/\.(zip|tar\.gz|tgz)$/i, '')
    if (!ref || !REF_RE.test(ref)) return { ok: false, reason: `ref 不合法：${ref}` }
    return { ok: true, kind: 'archive' }
  }

  // ---- raw / blob ---------------------------------------------------------
  if (third === 'raw' || third === 'blob') {
    // /owner/repo/(raw|blob)/<ref>/<path...>
    if (segs.length < 5) return { ok: false, reason: `${third} 路径不完整` }
    const ref = segs[3]
    if (!REF_RE.test(ref)) return { ok: false, reason: `ref 不合法：${ref}` }
    const file = segs.slice(4).join('/')
    if (!FILE_RE.test(file)) return { ok: false, reason: '文件路径不合法' }
    return { ok: true, kind: third }
  }

  // ---- 其它一律拒绝 --------------------------------------------------------
  return {
    ok: false,
    reason: `不支持的路径类型：/${third}（只支持 releases/download、archive、raw、blob）`,
  }
}

/**
 * 校验 raw.githubusercontent.com 上的路径。
 * 形态：/owner/repo/<ref>/<path...>
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateRawPath(u) {
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs.length < 4) {
    return { ok: false, reason: 'raw 路径不完整，需要 /owner/repo/ref/file' }
  }
  const [owner, repo, ref] = segs
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner 不合法：${owner}` }
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo 不合法：${repo}` }
  if (!REF_RE.test(ref)) return { ok: false, reason: `ref 不合法：${ref}` }
  const file = segs.slice(3).join('/')
  if (!FILE_RE.test(file)) return { ok: false, reason: '文件路径不合法' }
  return { ok: true, kind: 'raw' }
}

/**
 * 校验 codeload.github.com 上的路径。
 * 形态：/owner/repo/(zip|tar.gz|legacy.zip|legacy.tar.gz)/<ref>
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateCodeloadPath(u) {
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs.length < 4) {
    return { ok: false, reason: 'codeload 路径不完整，需要 /owner/repo/zip/ref' }
  }
  const [owner, repo, fmt] = segs
  if (!NAME_RE.test(owner)) return { ok: false, reason: `owner 不合法：${owner}` }
  if (!NAME_RE.test(repo)) return { ok: false, reason: `repo 不合法：${repo}` }
  if (!/^(zip|tar\.gz|tgz|legacy\.zip|legacy\.tar\.gz)$/i.test(fmt)) {
    return { ok: false, reason: `codeload 只支持 zip / tar.gz / legacy.zip / legacy.tar.gz，收到：${fmt}` }
  }
  const ref = segs.slice(3).join('/')
  if (!ref || !REF_RE.test(ref)) return { ok: false, reason: `ref 不合法：${ref}` }
  return { ok: true, kind: 'codeload' }
}

/**
 * 校验 gist 路径。
 * 形态：gist.githubusercontent.com/<user>/<id>/raw/<path...>
 *       gist.githubusercontent.com/<user>/<id>/raw        （无文件名，gist 允许）
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateGistPath(u) {
  const segs = u.pathname.split('/').filter(Boolean)
  if (segs.length < 2) return { ok: false, reason: 'gist 路径不完整' }
  const [user, id] = segs
  if (!NAME_RE.test(user)) return { ok: false, reason: `gist 用户名不合法：${user}` }
  if (!/^[0-9a-f]{20,}$/i.test(id) && !NAME_RE.test(id)) {
    return { ok: false, reason: `gist id 不合法：${id}` }
  }
  // gist 的 raw 前缀：gist.githubusercontent.com 可以省略（/user/id 本身就返回原文），
  // 但 gist.github.com 是**网页**——`/user/id` 是带页头页脚的 HTML，必须要求 /raw。
  // 不区分的话「只代理文件、不代理网页」这条承诺就在这一个主机上破了。
  if (u.hostname === 'gist.github.com') {
    if (segs[2] !== 'raw') {
      return { ok: false, reason: 'gist.github.com 是网页；文件要用 /raw/ 路径（或换 gist.githubusercontent.com）' }
    }
  } else if (segs[2] && segs[2] !== 'raw') {
    return { ok: false, reason: `gist 只支持 /raw/ 路径，收到：${segs[2]}` }
  }
  return { ok: true, kind: 'gist' }
}

/**
 * 校验 release-assets / objects 这类「签名资产域名」。
 * 这些 URL 是 GitHub 自己签发的，形态由 GitHub 决定，我们只要求路径非空、
 * 且不含可疑的协议嵌套（防止被当成跳板）。
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateSignedAssetPath(u) {
  const p = u.pathname.replace(/^\/+/, '')
  if (!p) return { ok: false, reason: '路径为空' }
  // 路径里不该出现第二个协议头（那种形态通常意味着有人想借道）
  if (/https?:\/\//i.test(p)) return { ok: false, reason: '路径里嵌套了另一个 URL' }
  return { ok: true, kind: 'signed' }
}

/**
 * 统一入口：按主机名选择对应的形态校验。
 *
 * @param {URL} u
 * @returns {Verdict}
 */
function validateTargetPath(u) {
  const host = u.hostname.toLowerCase()
  switch (host) {
    case 'github.com':
      return validateGithubPath(u)
    case 'raw.githubusercontent.com':
      return validateRawPath(u)
    case 'codeload.github.com':
      return validateCodeloadPath(u)
    case 'gist.githubusercontent.com':
      return validateGistPath(u)
    case 'gist.github.com':
      // gist.github.com/<user>/<id> —— 网页；带 /raw 的才当资源
      return validateGistPath(u)
    case 'api.github.com':
      // API 路径由调用方决定，只要求非空
      return u.pathname.replace(/^\/+/, '')
        ? { ok: true, kind: 'api' }
        : { ok: false, reason: 'api 路径为空' }
    case 'release-assets.githubusercontent.com':
    case 'objects.githubusercontent.com':
    case 'github.githubassets.com':
    case 'avatars.githubusercontent.com':
    case 'user-images.githubusercontent.com':
    case 'private-user-images.githubusercontent.com':
      return validateSignedAssetPath(u)
    default:
      return { ok: false, reason: `不支持的主机：${host}` }
  }
}

// ============================================================================
// 模块：src/proxy.js —— 代理与改写
// ============================================================================

// ============================================================================
// 目标 URL 构建 / 白名单 / 响应头清洗
//
// 路由判定与 URL 形态识别沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 白名单、路径形态校验、响应头清洗、缓存策略、jsDelivr 改写为新增。
// ============================================================================

/** 允许代理的上游主机。收紧到 GitHub 自家域名，避免变成通用开放代理。 */
const ALLOWED_HOSTS = new Set([
  'github.com',
  'raw.githubusercontent.com',
  'gist.githubusercontent.com',
  'gist.github.com',
  'codeload.github.com',
  'api.github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
])

/** 这些主机只接受「已经完整」的 URL，不做补全猜测。 */
const HOSTS_REQUIRING_FULL_URL = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
])

/**
 * 把「前缀后面剩下的东西」还原成真正的上游 URL。
 *
 * 支持三种输入形态：
 *   1. `https://github.com/u/r/releases/download/v1/x.zip`（带协议，最常见）
 *   2. `github.com/u/r/releases/download/v1/x.zip`（不带协议）
 *   3. `u/r/releases/download/v1/x.zip`（省略 github.com，即裸 owner/repo/...）
 *
 * 第 3 种是兼容写法：老的调用方会这么发，后端仍然认。但文档与错误页统一
 * 只教「写完整链接」，因为裸写法在 owner 名带点时会踩到「首段像域名」的
 * 歧义（owner.name/repo/... 会被当成域名，不是仓库）。
 *
 * 返回 URL 对象；无法解析时返回 null。
 *
 * @param {string} rest 去掉前缀后的原始路径（可带 query）
 */
function buildTargetUrl(rest) {
  if (typeof rest !== 'string') return null
  let s = rest.trim().replace(/^\/+/, '')
  if (!s) return null

  // 有的客户端会把 `https://` 压成 `https:/`，先纠正回来
  s = s.replace(/^(https?):\/(?!\/)/i, '$1://')

  // 显式写了别的协议（ftp:// / file:// / javascript: …）一律拒绝，
  // 否则它会被当成「不带协议的 owner 路径」拼成 github.com/ftp://… 这种怪东西。
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i)
  if (scheme && !/^(https?|ftp)$/i.test(scheme[1])) return null
  if (scheme && /^ftp$/i.test(scheme[1])) return null

  let candidate
  if (/^https?:\/\//i.test(s)) {
    candidate = s
  } else {
    // 首段是不是域名？判据：含点、且不是 `owner.repo` 这种仓库名写法。
    // 例：`github.com/u/r/...` 首段 `github.com` 含点 → 当域名。
    //     `geekMus/container-autoupdate/...` 首段不含点 → 当裸 owner/repo。
    const first = s.split(/[/?#]/)[0]
    const looksLikeHost = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(first)
    candidate = looksLikeHost ? `https://${s}` : `https://github.com/${s}`
  }

  let u
  try {
    u = new URL(candidate)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.protocol === 'http:') u.protocol = 'https:'
  return u
}

/**
 * 目标是否在白名单内**且**路径形态是「可下载资源」。
 *
 * 只查主机是不够的：`https://github.com/随便什么`、`https://github.com/login`
 * 的主机都在白名单里，但它们不是文件。没有形态校验时 Worker 会把 GitHub
 * 网页 HTML 抓回来，这个「加速站」就变成了通用反向代理。
 *
 * @param {URL} u
 * @returns {boolean}
 */
function isAllowedTarget(u) {
  return checkTarget(u).ok
}

/**
 * 同上，但返回详细判定结果（`{ ok, kind?, reason? }`），供调用方拼错误信息。
 *
 * @param {URL} u
 * @returns {{ ok: boolean, kind?: string, reason?: string }}
 */
function checkTarget(u) {
  const host = u.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: `不在允许的域名列表里：${host}` }
  }
  // 白名单锁死默认端口：`github.com:8443` 虽然还是 GitHub，但不该借我们的域名
  // 去连非常规端口；带 userinfo（`https://user@github.com/...`）也一并拒绝。
  if (u.port && u.port !== '443') {
    return { ok: false, reason: `不允许的端口：${u.port}` }
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 里不允许带用户名或密码' }
  }
  // 那些「只接受完整 URL」的主机，路径不能为空
  if (HOSTS_REQUIRING_FULL_URL.has(host) && !u.pathname.replace(/^\/+/, '')) {
    return { ok: false, reason: '路径为空' }
  }
  return validateTargetPath(u)
}

/**
 * 可选：把「分支上的单文件」请求改写到 jsDelivr。
 *
 * 为什么默认关闭：jsDelivr 对分支的缓存非常激进，分支更新后它会继续吐旧内容
 * （实测过：同一 URL 返回的还是上一版文件）。只适合「按 tag / 按 commit SHA」的引用。
 *
 * @param {URL} target
 * @param {{ jsdelivr: boolean }} cfg
 * @returns {URL|null} 需要改写时返回新 URL，否则 null
 */
function maybeJsdelivrUrl(target, cfg) {
  if (!cfg.jsdelivr) return null

  const host = target.hostname
  let owner, repo, ref, rest

  if (host === 'github.com') {
    // /owner/repo/(blob|raw)/ref/path...
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/)
    if (!m) return null
    ;[, owner, repo, ref, rest] = m
  } else if (host === 'raw.githubusercontent.com') {
    // /owner/repo/ref/path...
    const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/)
    if (!m) return null
    ;[, owner, repo, ref, rest] = m
  } else {
    return null
  }

  // 只有「按 tag 或 commit SHA」才安全；分支名会吃到过期缓存。
  // tag 只认 semver 形态（`v1.2.3` / `1.2.3`，可带预发布后缀）：`1.x`、`2024-fix`
  // 这类数字开头的**分支名**必须排除，否则 JSDELIVR=1 时会被当成不可变版本。
  const isSemverTag = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(ref)
  if (!isSemverTag && !/^[0-9a-f]{7,40}$/i.test(ref)) return null

  const out = new URL(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`)
  // 保留原始查询串（`?raw`、`?token=` 之类，交给 jsDelivr 判定）
  out.search = target.search
  return out
}

/**
 * `github.com/o/r/blob/<ref>/<path>` 是**网页**（GitHub 会返回渲染好的 HTML，
 * 带导航栏、按钮、语法高亮），拿不到文件字节。要拿到原文必须换成
 * `raw.githubusercontent.com/o/r/<ref>/<path>`。
 *
 * 上游那版是靠 `path.replace('/blob/','/raw/')` 做这件事，我重写时漏掉了，
 * 结果 /blob/ 路径把整页 HTML 当成「文件」回给了客户端——实测 3 次都返回
 * `text/html` 且正文是 `<!DOCTYPE html>`。这里补回来。
 *
 * 注意只改 blob，不动 raw（raw 本来就是对的）。
 */
function maybeRewriteBlob(target) {
  if (target.hostname !== 'github.com') return null
  const m = target.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/)
  if (!m) return null
  const [, owner, repo, rest] = m
  return new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${rest}`)
}

/** 上游响应里这些头必须删掉：要么由 Worker 重新决定，要么会干扰下游。 */
const DROP_RESPONSE_HEADERS = new Set([
  // 由 Worker 统一设置
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
  'access-control-max-age',
  // 会破坏跨域与缓存语义
  'content-security-policy',
  'content-security-policy-report-only',
  'clear-site-data',
  'x-frame-options',
  // 上游的 cookie 绝不能落到访问者身上
  'set-cookie',
  'set-cookie2',
  // 这些是 Cloudflare / Fastly 内部头，透传出去只会误导
  'cf-cache-status',
  'cf-ray',
  'cf-request-id',
  'x-cache',
  'x-cache-hits',
  'x-served-by',
  'x-timer',
  'x-ms-request-id',
  'x-ms-version',
  'x-ms-lease-status',
  'x-ms-lease-state',
  'x-ms-server-encrypted',
  'x-ms-access-tier',
  'x-ms-access-tier-inferred',
  'x-ms-blob-content-md5',
  'x-ms-blob-type',
  'x-ms-creation-time',
  'report-to',
  'nel',
  'speculation-rules',
  'alt-svc',
  'via',
  'age',
  // 编码相关：Worker 返回的是上游原样字节，不让下游误判
  'content-encoding',
  'transfer-encoding',
  'connection',
])

/**
 * 清洗上游响应头：删掉不该透传的，保留对客户端有用的
 * （`content-type` / `content-length` / `content-range` / `accept-ranges` /
 * `etag` / `last-modified` / `content-disposition` 等一律保留）。
 *
 * @param {Headers} upstream
 * @returns {Headers}
 */
function sanitizeUpstreamHeaders(upstream) {
  const out = new Headers()
  for (const [k, v] of upstream) {
    const key = k.toLowerCase()
    if (DROP_RESPONSE_HEADERS.has(key)) continue
    out.set(k, v)
  }
  // 删了 `content-encoding` 就不能再留上游的 `content-length`：那是压缩后的长度，
  // 而 Worker 交出去的是运行时解码后的字节。留着它，客户端会按错误长度读（读到一半
  // 卡住，或截断）。交给运行时按实际 body 重算即可。
  if (upstream.has('content-encoding')) out.delete('content-length')
  return out
}

// 缓存头不在这里生成：这个 Worker 是代理下载服务，所有响应一律 `no-store`，
// 由 index.js 的 handleProxy 统一写死——不留任何「按资源可变性分级」的口子。

// ============================================================================
// 模块：src/upstream.js —— 跟随重定向
// ============================================================================

// ============================================================================
// 上游请求：自己跟随重定向，带总时限
//
// 这是与上游 cmliu/CF-Workers-GitHub（MIT, CMLiussss）差异最大的部分：
// 上游用 `redirect:'manual'` + 「命中白名单就把 302 回写给客户端」，
// 导致客户端要再请求一次 Worker 才拿到文件（多走一跳 github.com 网页链路，
// 带 _gh_sess cookie，实测完整下载 90 秒、Range 直接超时）。
// 这里改为由 Worker 自己把整条链跟完，只回最终响应。
//
// 为什么不用 `redirect: 'follow'`：
//   1. 内置跟随无法限制跳转次数（Cloudflare 上限 20 跳，异常上游可以打满）；
//   2. 需要在上游卡住时主动放弃，而不是让请求挂到平台超时。
// ============================================================================

// ============================================================================
// 不做「重定向结果记忆」。
//
// v1.2.12 曾经把「这条地址最终落在哪」写进边缘缓存 180 秒，第二次直接打签名地址。
// 那 0.9 秒确实省下来了，但它本质上是一份缓存：签名地址指向的是「当时那个对象」，
// 上游要是重新打包、换签名、或者对象被替换，客户端就会拿到旧字节。
// 这个项目是代理下载服务，用户要的是「此刻上游的那个文件」，所以这份记忆被删掉了。
// 每次请求都老老实实把 github.com → release-assets → objects 走完。
// ============================================================================

/**
 * 带总时限地取上游响应，自己跟随重定向。
 *
 * @param {string} href 起始 URL
 * @param {RequestInit} init 请求参数
 * @param {number} timeoutMs 单跳「拿到响应头」的上限（毫秒）
 * @param {number} maxRedirects 最多跟随几跳
 * @param {typeof fetch} fetchImpl 便于测试注入
 * @returns {Promise<Response|null>} null 表示跳转次数超限
 */
async function fetchFollowingRedirects(href, init, timeoutMs, maxRedirects, fetchImpl = fetch) {
  let current = href
  let currentInit = { ...init, redirect: 'manual' }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeoutMs)
    let res
    try {
      res = await fetchImpl(current, { ...currentInit, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }

    const status = res.status
    const loc = res.headers.get('location')
    if (status >= 300 && status < 400 && loc) {
      // 丢弃这一跳的响应体，别占着连接
      try {
        await res.body?.cancel()
      } catch {
        /* 忽略：某些实现不支持 cancel */
      }
      current = new URL(loc, current).href
      const method = currentInit.method || 'GET'
      if (status === 307 || status === 308) {
        // 307/308 要求原样重放方法 + 请求体；请求体是流，重放不了。
        // GET/HEAD 没有体，照原样再发一次；带体的请求把这一跳交回客户端，别假装跟到底。
        if (method !== 'GET' && method !== 'HEAD') return res
        currentInit = { ...currentInit, redirect: 'manual' }
      } else {
        // 301/302/303：浏览器与 curl 都会把方法降级成 GET，并丢掉体的相关头。
        // 不清理的话，GET 请求会带着上一跳的 Content-Length/Content-Type 发出去（上游可能直接 400）。
        const headers = new Headers(currentInit.headers || {})
        for (const name of ['content-length', 'content-type', 'content-encoding', 'transfer-encoding']) {
          headers.delete(name)
        }
        currentInit = {
          method: method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
          redirect: 'manual',
        }
      }
      continue
    }
    return res
  }
  return null
}

/**
 * 解析重定向链（仅用于测试与排障）：返回每一跳的 URL。
 * @param {string} href
 * @param {typeof fetch} fetchImpl
 * @param {number} maxRedirects
 */
async function traceRedirects(href, fetchImpl = fetch, maxRedirects = 5) {
  const hops = []
  let current = href
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetchImpl(current, { redirect: 'manual' })
    hops.push({ url: current, status: res.status })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).href
      continue
    }
    break
  }
  return hops
}

// ============================================================================
// 模块：src/pages.js —— 页面渲染
// ============================================================================

// ============================================================================
// 页面：首页（单屏）与两种错误页。
//
// 首页的设计约束，按优先级：
//
//   1. **一屏放得下，不许往下拉**。用户来这儿只干一件事：把链接变成一条能下的
//      链接。所有文案都为这一个动作让路，讲原理、讲部署一律不出现在页面上。
//   2. **零外部资源**。不引字体、不引图标库、不引 CDN、不引图床；logo、favicon、
//      网格背景全是内联 SVG / data URI。一个 HTML 就是全部。
//   3. **内容不依赖 JS**。标题、说明、示例在禁用 JS 时仍然可读；主题在 <head>
//      里同步落定，不闪白。
//   4. **前端不做业务判定**。点「加速」先问后端 ?check=，拿到的判定与真实代理
//      完全一致；前端只负责展示与跳转，不维护第二份规则（两份必然漂移）。
//
// 说明文字尽量少：怎么用、支持哪些形态，仓库里的 docs 写得更全，页面上只留
// 一句 + 三个示例按钮。用户不需要在这里读说明书。
// ============================================================================

// 两套配色。亮色是偏冷的纸白 + 青蓝；暗色压暗但不用纯黑，避免刺眼。
// 所有正文/次要文字对底色的对比度都在 4.5:1 以上（亮色 muted 5.1，暗色 7.0）。
const LIGHT_TOKENS = `
  --bg:#f6f8fb;
  --surface:#eef1f6;
  --surface-2:#e2e7ee;
  --field:#ffffff;
  --ink:#1b2634;
  --muted:#5b6b7c;
  --accent:#2f6f9f;
  --accent-ink:#ffffff;
  --danger:#a8453c;
  --ok:#2c7a5a;
  --grid-minor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%231b2634' stroke-opacity='.052' stroke-width='1'/%3E%3C/svg%3E");
  --grid-major:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cpath d='M128 0H0V128' fill='none' stroke='%231b2634' stroke-opacity='.075' stroke-width='1'/%3E%3C/svg%3E");
`

const DARK_TOKENS = `
  --bg:#101519;
  --surface:#171d24;
  --surface-2:#1f2730;
  --field:#0b1014;
  --ink:#e2e9f0;
  --muted:#93a2b3;
  --accent:#7fb4d4;
  --accent-ink:#0b1014;
  --danger:#d08a80;
  --ok:#7fbd9c;
  --grid-minor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M32 0H0V32' fill='none' stroke='%23e2e9f0' stroke-opacity='.045' stroke-width='1'/%3E%3C/svg%3E");
  --grid-major:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='128' height='128'%3E%3Cpath d='M128 0H0V128' fill='none' stroke='%23e2e9f0' stroke-opacity='.065' stroke-width='1'/%3E%3C/svg%3E");
`

// 网格背景是两层 SVG 平铺：32px 细线 + 128px 主线。
// 不用 CSS 渐变——渐变会带上一圈假的「光」，而且平铺时接缝更明显。
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{${LIGHT_TOKENS}}
@media (prefers-color-scheme:dark){
  :root{${DARK_TOKENS}}
}
:root[data-theme=light]{${LIGHT_TOKENS}}
:root[data-theme=dark]{${DARK_TOKENS}}

html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{
  margin:0;
  min-height:100svh;
  background:var(--bg);
  color:var(--ink);
  font:400 16px/1.62 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}
body::before{
  content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:var(--grid-minor),var(--grid-major);
  background-size:32px 32px,128px 128px;
  background-position:0 0,0 0;
}

.shell{
  position:relative;z-index:1;
  min-height:100svh;
  max-width:1120px;margin:0 auto;
  padding:clamp(16px,3vw,28px) clamp(18px,4vw,44px) clamp(14px,2.4vw,22px);
  display:flex;flex-direction:column;
}

/* ---- 顶栏：只有标记、名字、主题按钮 ------------------------------------- */
.top{display:flex;align-items:center;gap:10px;flex:0 0 auto}
/* 顶栏左侧「标记 + 名字」是一整块，点它回首页（错误页上尤其需要）。 */
.home{display:inline-flex;align-items:center;gap:10px;flex:0 0 auto;color:inherit;text-decoration:none;padding:2px 6px;margin:-2px -6px}
.home:hover .brand{color:var(--accent)}
.mark{width:26px;height:26px;flex:0 0 auto;color:var(--accent)}
.mark svg{width:100%;height:100%;display:block}
.brand{font-size:15px;font-weight:680;letter-spacing:-.012em;color:var(--ink)}
.top-sp{flex:1 1 auto}
#theme{
  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:40px;min-width:40px;padding:0 10px;
  color:var(--muted);background:transparent;border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:13px;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:color .18s ease,box-shadow .18s ease;
}
#theme:hover{color:var(--ink);box-shadow:inset 0 0 0 1px var(--muted)}
/* 仓库入口：右上角一个 GitHub 图标，点进本仓库；页面底部不再放任何东西 */
.gh{
  flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;
  width:40px;height:40px;
  color:var(--muted);text-decoration:none;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:color .18s ease,box-shadow .18s ease;
}
.gh svg{width:17px;height:17px;display:block;fill:currentColor}
.gh:hover{color:var(--ink);box-shadow:inset 0 0 0 1px var(--muted)}
.ti{display:none;line-height:0}
.tl{display:none}
:root[data-theme=auto] .ti-auto,:root[data-theme=auto] .tl-auto{display:inline-flex}
:root[data-theme=light] .ti-light,:root[data-theme=light] .tl-light{display:inline-flex}
:root[data-theme=dark] .ti-dark,:root[data-theme=dark] .tl-dark{display:inline-flex}

/* ---- 中间：一屏之内把「粘链接」这件事摆正 ------------------------------- */
.stage{
  flex:1 1 auto;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  padding:clamp(20px,5vh,56px) 0 clamp(20px,5vh,56px);
  text-align:center;
}
.core{width:100%;max-width:660px}

/* 右下角的版本号：一行小字，右边缘与顶栏图标对齐，不占中间的操作区。 */
.ver{margin-top:10px;align-self:flex-end;font-size:13px;line-height:1;color:var(--muted);letter-spacing:.01em}
h1{
  margin:0 0 12px;
  font-size:clamp(24px,2.8vw,32px);
  line-height:1.22;
  letter-spacing:-.022em;
  font-weight:660;
}
.lede{
  margin:0 auto 28px;
  max-width:32em;
  color:var(--muted);
  font-size:16px;
  line-height:1.62;
  text-wrap:pretty;
}

/* 输入栏：整页的主角。整条是**一个**对象——白底、1px 内描边、按钮嵌在右端，
   聚焦时整条换成 2px 强调色描边。描边一律用 inset 阴影而不是 border：
   边框会占宽度，换色时整行会跳一下。 */
.bar{
  display:flex;align-items:center;gap:6px;
  width:100%;padding:6px;
  background:var(--field);
  box-shadow:inset 0 0 0 1px var(--surface-2);
  transition:box-shadow .2s ease;
}
.bar:hover{box-shadow:inset 0 0 0 1px var(--muted)}
.bar:focus-within{box-shadow:inset 0 0 0 2px var(--accent)}
.ui-field{position:relative;flex:1 1 auto;min-width:0;display:flex}
#q{
  width:100%;height:46px;
  padding:0 40px 0 12px;
  color:var(--ink);background:transparent;
  border:0;border-radius:0;
  font:inherit;font-size:15px;
}
#q::placeholder{color:var(--muted);opacity:.7}
/* 清空按钮只在有内容时出现，所以空着的时候右边不用留 40px——
   示例占位符（README.md 的 raw 直链）刚好能整条露出来。 */
.ui-field:not(.has-value) #q{padding-right:12px}
#q:focus{outline:none}
#clear{
  position:absolute;top:50%;right:4px;transform:translateY(-50%);
  width:30px;height:30px;padding:0;
  display:none;place-items:center;
  color:var(--muted);background:transparent;border:0;cursor:pointer;
  font:inherit;
}
.ui-field.has-value #clear{display:grid}
#clear:hover{color:var(--ink)}
#go{
  flex:0 0 auto;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  height:46px;padding:0 22px;
  color:var(--accent-ink);background:var(--accent);
  border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:15px;font-weight:620;letter-spacing:.004em;
  transition:filter .18s ease,transform .18s ease;
}
#go:hover{filter:brightness(1.06)}
#go:active{transform:translateY(1px)}
#go[disabled]{opacity:.62;cursor:progress}
.ui-tip{
  min-height:20px;margin:10px 2px 0;
  font-size:13px;line-height:1.45;color:var(--danger);
  opacity:0;transition:opacity .2s ease;
}
.ui-tip.show{opacity:1}
.ui-tip a{color:inherit;text-decoration:underline;text-underline-offset:3px}
.ui-tip a:hover{color:var(--ink)}

/* 三个示例：做成安静的文字按钮而不是一排方框——这一屏的主角只有一个（输入栏），
   示例再用边框框起来就会和它抢视线。保留 32px 的可点高度，比纯文字链接好按。 */
.ex{
  display:flex;flex-wrap:wrap;align-items:center;justify-content:center;
  gap:4px 14px;margin-top:14px;
}
.ex .lbl{color:var(--muted);font-size:13px}
.ex button{
  height:32px;padding:0;margin:0;
  color:var(--ink);background:transparent;
  border:0;border-radius:0;cursor:pointer;
  font:inherit;font-size:13px;
  text-decoration:underline;text-decoration-color:var(--surface-2);
  text-underline-offset:4px;
  transition:color .18s ease,text-decoration-color .18s ease;
}
.ex button:hover{color:var(--accent);text-decoration-color:var(--accent)}

/* ---- 页脚：已移除。仓库入口挪到右上角，页面底部只留空白 ---------------- */

/* ---- 焦点可见与动效兜底 ------------------------------------------------ */
a:focus-visible,button:focus-visible,input:focus-visible{
  outline:2px solid var(--accent);outline-offset:2px;
}
:root[data-theme=dark] a:focus-visible,
:root[data-theme=dark] button:focus-visible,
:root[data-theme=dark] input:focus-visible{outline-color:var(--accent)}

@media (prefers-reduced-motion:no-preference){
  .anim{animation:rise .52s cubic-bezier(.2,.7,.2,1) both}
  .anim.d1{animation-delay:.05s}
  .anim.d2{animation-delay:.11s}
  .anim.d3{animation-delay:.17s}
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important;transition:none!important}
}

@media (max-width:640px){
  body{font-size:16px}
  h1{font-size:clamp(21px,6vw,26px);margin-bottom:10px}
  .lede{font-size:15px;margin-bottom:22px}
  .bar{flex-wrap:wrap}
  .ui-field{flex:1 1 100%}
  #q{height:48px;font-size:16px}   /* 16px 起 iOS 不会自动放大 */
  #go{flex:1 1 100%;height:48px;margin-top:6px}
  #theme{padding:0 8px}
  .gh{width:36px;height:36px}
  .ex{gap:6px}
  .ex button{height:30px;font-size:13px;padding:0 10px}
}

/* ---- 错误页复用的小零件（首页不用） ------------------------------------ */
.err-hero{margin:clamp(18px,4vh,40px) 0 0}
.err-hero .lede{margin-bottom:0;max-width:38em;text-align:left}
.err-hero h1{text-align:left}
.reason{
  color:var(--ink);background:var(--surface);
  padding:14px 16px;font-size:15px;line-height:1.55;
  box-shadow:inset 0 0 0 1px var(--surface-2);
  word-break:break-word;
}
.err-note{color:var(--muted);font-size:14px;margin:10px 0 0}
.paths{color:var(--muted);font-size:14px}
.paths-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.paths-h h3{margin:0;font-size:15px;font-weight:650;color:var(--ink)}
.paths-h span{font-size:13px}
.path-grid{display:grid;grid-template-columns:1fr;gap:1px;background:var(--surface-2)}
.path-grid .item{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline;
  padding:9px 12px;background:var(--bg);
}
.path-grid .k{color:var(--ink);font-size:13.5px;overflow-wrap:anywhere}
.path-grid .v{color:var(--muted);font-size:13px;text-align:right}
.paths-foot{color:var(--muted);font-size:13px;margin:10px 0 0}
.back{
  display:inline-flex;align-items:center;gap:8px;
  color:var(--ink);text-decoration:none;font-size:15px;
  min-height:44px;
}
.back svg{width:16px;height:16px;flex:0 0 auto}
.back:hover{color:var(--accent)}
.sec{margin-top:clamp(22px,3.2vw,34px)}
.sec-h{margin-bottom:10px}
.sec-h h2{margin:0;font-size:20px;letter-spacing:-.02em}
.sec-h p{margin:6px 0 0;color:var(--muted);font-size:14.5px}
`

// 页面输出用的 CSS：去掉注释与行首缩进。注释是写给读源码的人看的（源码版里有），
// 浏览器不需要；删掉是白拿的：体积与解析都省一点。
const CSS_MIN = BASE_CSS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]+/gm, '').replace(/\n{2,}/g, '\n')

// <head> 里的同步脚本：读本地存的主题，在首帧之前把 data-theme 落定，避免闪白。
// 同时给 <html> 挂上 js 类，供需要脚本的样式使用。
const THEME_INIT = `
(function(){
  var root=document.documentElement;
  root.className+=' js';
  var t='auto';
  try{ var s=localStorage.getItem('cfgh.theme'); if(s==='light'||s==='dark') t=s; }catch(e){}
  root.setAttribute('data-theme',t);
})();
`

// 主题按钮的图标与文字：三种状态各一份，由 CSS 按 :root[data-theme] 选择，
// 因此即使 JS 没跑，图标也是对的。
const THEME_ICONS = `
<span class="ti ti-auto" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1"/><path d="M5.5 13.5h5M8 11.5v2" stroke-linecap="round"/></svg></span>
<span class="ti ti-light" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M2.9 2.9l1.1 1.1M12 12l1.1 1.1M13.1 2.9L12 4M4 12l-1.1 1.1" stroke-linecap="round"/></svg></span>
<span class="ti ti-dark" aria-hidden="true"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13 9.8A5.6 5.6 0 0 1 6.2 3a5.6 5.6 0 1 0 6.8 6.8Z" stroke-linejoin="round"/></svg></span>
<span class="tl tl-auto">跟随系统</span><span class="tl tl-light">亮色</span><span class="tl tl-dark">暗色</span>
`

// 主题按钮的点击逻辑：auto 到 light 到 dark 再到 auto。
const THEME_CYCLE = `
(function(){
  var K='cfgh.theme';
  var root=document.documentElement;
  var btn=document.getElementById('theme');
  if(!btn) return;
  function cur(){
    var t=root.getAttribute('data-theme');
    return (t==='light'||t==='dark')?t:'auto';
  }
  btn.addEventListener('click',function(){
    var next={auto:'light',light:'dark',dark:'auto'}[cur()];
    root.setAttribute('data-theme',next);
    try{ localStorage.setItem(K,next); }catch(e){}
  });
})();
`

// 品牌标记：一个直角转折的箭头——302 链在边缘拐个弯走完。
// 同一份几何用在顶栏和 favicon（favicon 多一块底色）。
const LOGO_PATH = `<path d="M5 8.5h10v9h3" fill="none" stroke="currentColor" stroke-width="4"/><path d="M18 11.6 27.6 17.5 18 23.4Z" fill="currentColor"/>`

function logoMark() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true">${LOGO_PATH}</svg>`
}

/** favicon 内联到页面里的 data URI（零外部请求，见文件头说明）。 */
function faviconHref() {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#2f6f9f'/><g fill='none' stroke='#fff'><path d='M5 8.5h10v9h3' stroke-width='4'/></g><path d='M18 11.6 27.6 17.5 18 23.4Z' fill='#fff'/></svg>`
  return (
    'data:image/svg+xml,' +
    svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22').replace(/ /g, '%20')
  )
}

/** Worker 直接返回的 favicon（/favicon.ico 分支用，和页面里那份是同一张图）。 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#2f6f9f"/><path d="M5 8.5h10v9h3" fill="none" stroke="#fff" stroke-width="4"/><path d="M18 11.6 27.6 17.5 18 23.4Z" fill="#fff"/></svg>`

// 顶栏：标记 + 名字 + 仓库图标 + 主题按钮。两页共用。
// 仓库地址写死在这里，不做成环境变量：这个页面属于本项目，别人的 fork 要改，
// 改这一行就行；留一个 LANDING_LINK 只会让线上多一个「指向别处」的入口。
export const REPO_URL = 'https://github.com/geekMus/cf-gh-proxy'

// 版本号只在「页面右下角」露一次：它是元信息，不是身份，和顶栏的品牌不是一回事；
// 放顶栏会在 390px 上跟主题按钮抢位置。改版本时这里和 package.json 要一起改，
// 测试会核对两者一致（见 test/pages.test.js）。
export const VERSION = '1.2.17'

// 右下角那行小字。放在 .stage 之后：.stage 有 flex:1，于是它自然贴在视口底部，
// 右边缘与顶栏图标对齐，不占中间的操作区。
function renderVer() {
  return `<div class="ver" title="当前版本">v${VERSION}</div>`
}

const GITHUB_MARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>'

function renderTop(home = '/') {
  return `<header class="top">
  <a class="home" href="${escapeHtml(home)}" title="回到首页"><span class="mark" aria-hidden="true">${logoMark()}</span><span class="brand">GitHub 文件加速</span></a>
  <span class="top-sp"></span>
  <a class="gh" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" aria-label="打开项目仓库" title="项目仓库">${GITHUB_MARK}</a>
  <button id="theme" type="button" aria-label="切换主题（跟随系统 / 亮色 / 暗色）" title="切换主题">${THEME_ICONS}</button>
</header>`
}

/** 支持的路径表。错误页与首页共用，避免「首页说一套、错误页说另一套」。 */
function renderPathTable() {
  return `<div class="paths-h">
      <h3>可下载</h3>
    </div>
    <div class="path-grid">
      <div class="item"><span class="k">/owner/repo/releases/download/tag/file</span><span class="v">release 资产</span></div>
      <div class="item"><span class="k">/owner/repo/releases/latest/download/file</span><span class="v">最新版</span></div>
      <div class="item"><span class="k">/owner/repo/archive/refs/tags/tag.zip</span><span class="v">源码包</span></div>
      <div class="item"><span class="k">/owner/repo/raw/ref/path</span><span class="v">单文件</span></div>
      <div class="item"><span class="k">/owner/repo/blob/ref/path</span><span class="v">自动转 raw</span></div>
      <div class="item"><span class="k">raw.githubusercontent.com/owner/repo/ref/path</span><span class="v">raw 直链</span></div>
      <div class="item"><span class="k">gist.githubusercontent.com/user/id/raw</span><span class="v">Gist</span></div>
      <div class="item"><span class="k">api.github.com/repos/owner/repo/...</span><span class="v">GitHub API</span></div>
    </div>
    <p class="paths-foot">仓库首页、issues、settings、search 这类网页会被明确拒绝，不会把 HTML 当文件抓回来。</p>`
}

/**
 * 示例里「服务地址」那一截。
 *
 * 用调用方传进来的 origin——也就是这个 Worker 真实被访问的域名，
 * 而不是 `https://your-domain` 这种占位符：用户照抄示例时不用替换任何东西。
 * 只有拿不到 origin 时才退回占位（测试里直接调用 `renderErrorPage(cfg, reason)`）。
 *
 * 另一个关键细节：prefix 是 `/` 时必须补一个结尾斜杠，否则拼出来是
 * `https://gh.example.comhttps://github.com/...` —— 两个 URL 连成一片，
 * 用户会以为要这么写（实测第一版就是这样）。
 */
function exampleBaseOf(prefix, origin = '') {
  const base = origin || 'https://your-domain'
  return `${base}${prefix === '/' ? '/' : prefix}`
}

/** 首页那块真实界面：粘链接 → 问 ?check= → 跳转。整页只有这一件事。 */
function renderCore(prefix) {
  return `<div class="core">
      <h1 class="anim">GitHub 文件，一条更快的链接</h1>
      <p class="lede anim d1">把 release 资产、源码包或单个文件的地址丢进来，走这条链接直接下。</p>
      <div class="bar anim d2" data-ui>
        <div class="ui-field" id="field">
          <input type="text" id="q" placeholder="https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/README.md" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip" aria-label="GitHub 链接">
          <button id="clear" type="button" aria-label="清空输入" tabindex="-1">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <button id="go" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
          加速
        </button>
      </div>
      <p class="ui-tip" id="tip" role="status" aria-live="polite"></p>
      <div class="ex anim d3" id="exs">
        <span class="lbl">试试</span>
        <button type="button" data-ex="https://raw.githubusercontent.com/geekMus/cf-gh-proxy/main/README.md">raw 直链</button>
      </div>
    </div>`
}

/**
 * 首页。
 *
 * 校验不在这里做：点「加速」后先问后端的 ?check= 接口，拿到和真实代理
 * 完全一致的判定（含同样的中文原因），再决定跳转还是就地报错。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 */
function renderLanding(cfg, origin = '') {
  const prefix = cfg.prefix
  const prefixJson = jsonForScript(prefix)
  const canonical = origin ? `${origin}${prefix}` : ''

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="index,follow">
<meta name="description" content="把 GitHub 的 release 资产、源码包、raw 单文件链接换成自己的域名：字节从 Cloudflare 边缘直接给出，跟随 302、支持 Range 续传，单文件 Worker，零外部依赖。">
${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : ''}
<title>GitHub 文件加速</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref()}">
<style>${CSS_MIN}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="shell">
  ${renderTop(prefix)}
  <main class="stage">
    ${renderCore(prefix)}
  </main>
  ${renderVer()}
</div>
<script>
${THEME_CYCLE}
(function(){
  var input=document.getElementById('q');
  var go=document.getElementById('go');
  var tip=document.getElementById('tip');
  var field=document.getElementById('field');
  var clearBtn=document.getElementById('clear');
  var exs=document.getElementById('exs');
  var PREFIX=${prefixJson};

  function showTip(msg,openUrl){
    tip.textContent=msg;
    if(openUrl){
      // 兜底入口：用 <a target="_blank"> 而不是再 window.open——
      // 用户点链接本身就是手势，不会被弹窗拦截器拦掉。
      var a=document.createElement('a');
      a.href=openUrl; a.target='_blank'; a.rel='noopener noreferrer';
      a.textContent='点这里打开';
      tip.appendChild(document.createTextNode(' '));
      tip.appendChild(a);
    }
    tip.classList.add('show');
  }
  function hideTip(){ tip.classList.remove('show'); tip.textContent=''; }
  function syncClear(){
    if(input.value){ field.classList.add('has-value'); } else { field.classList.remove('has-value'); }
  }

  // 归一化：把用户输入整理成 https 形式。
  // 这里只做格式整理，不做合法性判定——判定一律交给后端 ?check=。
  function normalize(v){
    v=v.trim();
    if(!v) return '';
    var i=v.indexOf('://');
    if(i>0){
      var s=v.slice(0,i).toLowerCase();
      if(s!=='http'&&s!=='https') return '';
      return v;
    }
    var first=v.split('/')[0].split('?')[0].split('#')[0];
    if(first.indexOf('.')>0) return 'https://'+v;
    return 'https://github.com/'+v;
  }

  // 本地形态判定：只认 GitHub 上「能下下来的文件」，规则与后端 validate.js 同形。
  // 这一层是为了在点按钮的那一刻就拦下明显不对的输入（少开一个空白标签页），
  // 全程不发网络。真正的判定仍归后端——从地址栏直接敲进来的地址，由错误页拒绝。
  var HOSTS=['github.com','raw.githubusercontent.com','codeload.github.com','gist.github.com','gist.githubusercontent.com','api.github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','github.githubassets.com','avatars.githubusercontent.com','user-images.githubusercontent.com','private-user-images.githubusercontent.com'];
  function looksLikeFile(href){
    var u;
    try{ u=new URL(href); }catch(e){ return '这不是一个能解析的链接'; }
    if(u.protocol!=='http:'&&u.protocol!=='https:') return '只支持 http / https 链接';
    var host=u.hostname.toLowerCase();
    if(HOSTS.indexOf(host)<0) return '只代理 GitHub 上的文件，'+host+' 不在支持名单里';
    var p=u.pathname.split('/').filter(Boolean);
    var kind=p[2];
    if(host==='github.com'){
      if(p.length<3) return '要粘贴完整的文件地址，例如 /<owner>/<repo>/releases/download/…';
      if(kind==='releases'){
        if(p[3]==='download'||(p[3]==='latest'&&p[4]==='download')) return '';
        return '/releases 是网页，资产地址要带 /download/';
      }
      if(kind==='archive') return p.length>=4?'':'源码包地址要写成 /archive/refs/heads/<分支>.zip';
      if(kind==='blob'||kind==='raw') return p.length>=4?'':'文件地址要写成 /<blob|raw>/<分支>/<路径>';
      return '只代理 release 资产、源码包、raw 与 blob；/<owner>/<repo>/'+kind+' 不在支持范围内';
    }
    if(host==='raw.githubusercontent.com') return p.length>=4?'':'raw 地址要写成 /<owner>/<repo>/<分支>/<路径>';
    if(host==='codeload.github.com') return (p.length>=4&&/^(zip|tar\.gz|tgz|legacy\.zip|legacy\.tar\.gz)$/i.test(kind||''))?'':'源码包地址要写成 /<owner>/<repo>/(zip|tar.gz)/<分支>';
    if(host==='gist.github.com') return (p.length>=3&&kind==='raw')?'':'gist 网页不代理，要用带 /raw 的地址';
    return '';
  }

  // 点「加速」直接在**新标签页**里打开代理地址：一个标签页、一次导航，不再先
  // fetch 一次 ?check= 再去导航。那条路要多一个完整往返（实测 0.6 s）加一个空白页
  // 的等待。形态不对的输入在上面就被 looksLikeFile 拦下了；形态对但后端仍不认的
  // （比如分支名不合法），错误页会出现在那个标签页里。
  function submit(){
    var raw=input.value||'';
    if(!raw.trim()){ showTip('先粘一个 GitHub 链接进来'); input.focus(); return; }
    var href=normalize(raw);
    if(!href){ showTip('只支持 http / https 链接'); input.focus(); return; }
    var bad=looksLikeFile(href);
    if(bad){ showTip(bad); input.focus(); return; }
    var target=location.origin+PREFIX+href;
    hideTip();

    var tab=null;
    try{ tab=window.open(target,'_blank'); }catch(e){ tab=null; }
    if(!tab){
      showTip('浏览器拦下了新标签页：允许本站弹窗后再点一次，或者', target);
      input.focus();
      return;
    }
    try{ tab.opener=null; }catch(e){}
  }

  go.addEventListener('click',submit);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  input.addEventListener('input',function(){ syncClear(); hideTip(); });
  clearBtn.addEventListener('click',function(){ input.value=''; syncClear(); hideTip(); input.focus(); });

  // 示例按钮：把地址填进输入框，让用户能立刻试一次，而不是先去找链接。
  exs.addEventListener('click',function(e){
    var b=e.target.closest('button[data-ex]');
    if(!b) return;
    input.value=b.getAttribute('data-ex');
    syncClear(); hideTip(); input.focus();
  });

  syncClear();
})();
</script>
</body>
</html>`
}

/**
 * 链接不合法时的说明页。
 *
 * 为什么不直接返回一行纯文本：首页那个输入框会把任意输入拼成 URL，
 * 用户很容易粘错；给一页说明「错在哪、正确形态是什么」比一句 400 有用得多。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {string} reason 具体原因（由 validate.js 产出）
 * @param {string} [origin] 这个 Worker 真实被访问的地址（如 `https://gh.example.com`）。
 *   传了就把它拼进「正确形态」示例里，用户照抄即可；不传（测试）退回占位符。
 */
function renderErrorPage(cfg, reason, origin = '') {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix, origin)
  const home = `${prefix}`
  const ex = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>不是可加速的 GitHub 文件</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref()}">
<style>${CSS_MIN}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="shell">
  ${renderTop(prefix)}

  <div class="err-hero">
    <h1>这个地址不是一个文件</h1>
    <p class="lede">请求被拦下了，没有去抓取任何内容。本服务只代理 GitHub 上可下载的资源，不代理网页。</p>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>具体原因</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="err-note">仓库首页、issues、settings、search 这类页面会被拒绝，不会把 HTML 当文件抓回来。</p>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>正确形态</h2><p>在链接前面加服务地址</p></div>
    <div class="paths">
      <div class="path-grid"><div class="item"><span class="k">${escapeHtml(ex)}</span></div></div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h2>支持的路径</h2></div>
    <div class="paths">
      ${renderPathTable()}
    </div>
  </div>

  <p><a class="back" href="${escapeHtml(home)}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.5 8h-11M6.5 3.5 2 8l4.5 4.5"/></svg>回到首页重新输入</a></p>

  ${renderVer()}
</div>
<script>${THEME_CYCLE}</script>
</body>
</html>`
}

/** 命中屏蔽 UA 时返回的伪装页。刻意保持和真 nginx 默认页一致，不要美化。 */
function renderDisguise() {
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

/** 把值安全地放进 HTML 里的内联 JS（防 script 提前闭合、防引号）。 */
function jsonForScript(s) {
  return JSON.stringify(String(s))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ============================================================================
// 模块：src/index.js —— 入口
// ============================================================================

// ============================================================================
// cf-gh-proxy —— GitHub 文件加速（Cloudflare Worker）
//
// 本项目基于 cmliu/CF-Workers-GitHub 演化而来：
//   https://github.com/cmliu/CF-Workers-GitHub  （MIT, Copyright (c) 2025 CMLiussss）
// 上游又源自 hunshcn/gh-proxy 与 EtherDream/jsproxy。
// 沿袭：路由判定、伪装机制（URL / URL302）、?q= 入口、首页形态。
// 重写：代理与重定向处理、超时、缓存、白名单、响应头清洗、模块化拆分。
// 详见 README 的「来源与致谢」。
//
// 请求形态：https://<你的域名><PREFIX><GitHub 原始 URL>
//   例：PREFIX=/ 时
//     https://gh.example.com/https://github.com/u/r/releases/download/v1/x.zip
//     https://gh.example.com/u/r/releases/download/v1/x.zip
// ============================================================================

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-max-age': '1728000',
}

// 页面类响应的安全头。都是零成本的静态头，能过 Lighthouse 的 Best Practices
// 里那几条「有没有声明」的检查（HSTS / XFO / COOP / nosniff / Referrer-Policy）。
// 只加在**我们自己的页面**上：代理回来的文件是用户要下载的东西，不该被
// X-Frame-Options 之类的东西改变语义。
const PAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
}

// 首页**不**进缓存：它是一份随部署变化的 HTML，边缘缓存会把新版本挡在门外。
// 实测踩过：`public, max-age=300, s-maxage=3600` 被 zone 的 Browser Cache TTL
// 改写成 `max-age=14400`，于是线上首页带着 `Age: 1059` 一直发旧版本，
// 部署完一小时都看不到新页面。改成 `no-store` 之后每次都由 Worker 现生成
// （渲染只是几毫秒的字符串拼接，这点 CPU 完全不值得用「发旧页面」去换）。

const PREFLIGHT = {
  status: 204,
  headers: {
    ...CORS_HEADERS,
    'access-control-allow-headers':
      'Accept,Accept-Language,Authorization,Content-Type,Range,If-None-Match,If-Modified-Since',
  },
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
   */
  async fetch(request, env, ctx) {
    // 最外层兜底：任何没预料到的异常都在这里收住。
    //
    // 为什么必须有这一层：Worker 里抛出的异常在 Cloudflare 上表现为 1101
    // （「Worker threw exception」），客户端只拿到一个空白错误页，日志之外
    // 没有任何线索。把异常转成一个可读的 500，既能让用户知道发生了什么，
    // 也能避免「页面全白」这种最难排查的形态。
    try {
      return await route(request, env, ctx)
    } catch (err) {
      // 对外只说「内部错误」，具体异常只写日志。
      // 原样回显 err.message 会把内部 URL、上游地址、解析细节漏给客户端，
      // 而这些信息对使用者没有帮助（他要的是一个可读的 500，不是堆栈）。
      console.error('cf-gh-proxy 未捕获异常：', err && err.stack ? err.stack : err)
      try {
        return textResponse('内部错误：请求处理失败，详情见 Worker 日志', 500)
      } catch {
        // 连 textResponse 都失败（极罕见）时，给一个绝对最小化的响应
        return new Response('Internal Error', { status: 500 })
      }
    }
  },
}

/**
 * 真正的路由。所有分支都在 `fetch` 的 try 里被保护。
 *
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 */
async function route(request, env, ctx) {
  const cfg = resolveConfig(env)
  const url = new URL(request.url)

  // ---- 1. 伪装：命中屏蔽 UA 时返回 nginx 页 ------------------------------
  const ua = (request.headers.get('User-Agent') || '').toLowerCase()
  if (cfg.blockedUAs.length && cfg.blockedUAs.some((k) => ua.includes(k))) {
    return htmlResponse(renderDisguise())
  }

  // ---- 2. CORS 预检 ------------------------------------------------------
  // 任何 OPTIONS 都当预检处理：浏览器对 PUT/PATCH/DELETE 发预检时，
  // 只有带自定义头才会带 `access-control-request-headers`；没有这个头时
  // 若把请求当普通 OPTIONS 转给上游，返回里就缺 allow-methods，预检会失败。
  if (request.method === 'OPTIONS') {
    return new Response(null, PREFLIGHT)
  }

  // ---- 3. ?check= 校验接口 -----------------------------------------------
  // 首页那个输入框用它做「先问再跳」。这样前端不需要维护第二份校验规则：
  // 页面说什么、服务端就做什么，永远不会漂移（上一版就是两份规则各自演化）。
  const checkRaw = url.searchParams.get('check')
  if (checkRaw) {
    return handleCheck(checkRaw)
  }

  // ---- 4. ?q= 便捷入口：把裸链接转成前缀形式 -----------------------------
  const q = url.searchParams.get('q')
  if (q) {
    const target = buildTargetUrl(q)
    if (!target) {
      return badRequest(request, cfg, '无法解析这个链接')
    }
    const verdict = checkTarget(target)
    if (!verdict.ok) {
      return badRequest(request, cfg, verdict.reason || '这个链接不是可加速的 GitHub 文件')
    }
    // 用 302 而不是 301：301 会被浏览器永久缓存，之后换域名/换前缀就再也回不来。
    return Response.redirect(`${url.origin}${cfg.prefix}${target.href}`, 302)
  }

  // ---- 5. favicon -------------------------------------------------------
  // 图标是页面自己的一部分：内联 SVG，和 <head> 里那个 data URI 是同一张图。
  // 这里不再对外部站点发 fetch——没有网络抖动、上游 5xx、被墙这些失败面，
  // 也不违反「零外部资源」这条硬约束。
  if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/favicon.ico`) {
    return new Response(FAVICON_SVG, {
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
        ...PAGE_HEADERS,
      },
    })
  }

  // ---- 5b. robots.txt ----------------------------------------------------
  // 说明页是可以被索引的（它就是这个服务本身），给抓取方一份明确的允许规则；
  // 不加的话 `/robots.txt` 会被当成「资源路径」走代理校验，回一个 400，
  // 抓取工具看到的是「站点拒绝抓取」。
  if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/robots.txt`) {
    return new Response('User-agent: *\nAllow: /\n', {
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'cache-control': 'no-store',
        ...PAGE_HEADERS,
      },
    })
  }

  // ---- 6. 首页 -----------------------------------------------------------
  const stripped = stripPrefix(url, cfg.prefix)
  if (stripped === null) {
    return renderHome(cfg, url, ctx)
  }

  // ---- 7. 代理 -----------------------------------------------------------
  const target = buildTargetUrl(stripped)
  if (!target) {
    return badRequest(request, cfg, '无法解析这个链接')
  }
  const verdict = checkTarget(target)
  if (!verdict.ok) {
    return badRequest(request, cfg, verdict.reason || '这个链接不是可加速的 GitHub 文件')
  }

  // /blob/ 是网页，换成 raw 才能拿到文件字节（见 maybeRewriteBlob 注释）
  const rawTarget = maybeRewriteBlob(target) || target

  // 可选：分支单文件改写走 jsDelivr（默认关闭，见 maybeJsdelivrUrl 注释）
  const viaCdn = maybeJsdelivrUrl(rawTarget, cfg)

  return handleProxy(request, viaCdn || rawTarget, cfg, ctx)
}

/**
 * `?check=<链接>` 的应答。永远返回 200 + JSON（它是一个「询问」，
 * 不是一个失败），让前端只写一条 happy path。
 *
 * 响应带 no-store：校验结果不能进 CDN 缓存，否则换了目标却拿到旧结论。
 *
 * @param {string} raw 用户给的原始链接
 */
function handleCheck(raw) {
  const target = buildTargetUrl(raw)
  if (!target) {
    return jsonResponse({ ok: false, reason: '无法解析这个链接' })
  }
  const verdict = checkTarget(target)
  if (!verdict.ok) {
    return jsonResponse({ ok: false, reason: verdict.reason || '这个链接不是可加速的 GitHub 文件' })
  }
  return jsonResponse({ ok: true, href: target.href, kind: verdict.kind || '' })
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': 'no-store',
      ...CORS_HEADERS,
    },
  })
}

function htmlResponse(html, extra = {}) {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...PAGE_HEADERS, ...extra },
  })
}

// ---------------------------------------------------------------------------
// 路由辅助
// ---------------------------------------------------------------------------

/**
 * 首页。沿用上游 cmliu/CF-Workers-GitHub 的两个伪装变量：
 *   URL302 → 主页 302 跳走（优先级最高）
 *   URL    → 主页伪装成该地址；设为 `nginx` 则返回 nginx 默认页
 * 都没设时返回本项目的说明页。
 */
function renderHome(cfg, url, ctx) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302)
  }
  if (cfg.disguiseNginx) {
    return htmlResponse(renderDisguise())
  }
  const html = renderLanding(cfg, url ? url.origin : '')
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...PAGE_HEADERS, 'cache-control': 'no-store' },
  })
}

/**
 * 去掉前缀，得到 GitHub 侧的原始路径（可能形如 `https://github.com/...` 或 `u/r/...`）。
 * 返回 null 表示「这不是一个资源请求」（应该给首页）。
 */
function stripPrefix(url, prefix) {
  let rest
  if (prefix === '/') {
    rest = url.pathname.slice(1) + url.search
  } else {
    const bare = prefix.replace(/\/$/, '')
    if (url.pathname !== bare && !url.pathname.startsWith(bare + '/')) return null
    rest = url.pathname.slice(bare.length)
    // `/gh` 本身（后面没东西）也当首页
    if (!rest || rest === '/') return null
    rest = rest.replace(/^\//, '') + url.search
  }
  // 只有查询串（`/?cb=123`）：这是访问首页时带的缓存参数，不是资源路径
  if (!rest || rest.startsWith('?')) return null
  return rest
}

function textResponse(body, status = 200) {
  return new Response(body + '\n', {
    status,
    headers: { 'content-type': 'text/plain; charset=UTF-8', ...CORS_HEADERS },
  })
}

/**
 * 链接不合法时的响应。
 *
 * 浏览器（Accept 含 text/html）给一页可读的说明，含返回首页的链接；
 * 命令行（curl / wget）给纯文本，方便脚本 grep。
 *
 * @param {Request} request
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {string} reason
 */
function badRequest(request, cfg, reason) {
  const wantsHtml = (request.headers.get('Accept') || '').includes('text/html')
  if (!wantsHtml) {
    return textResponse(`不是可加速的 GitHub 文件：${reason}`, 400)
  }
  return new Response(renderErrorPage(cfg, reason, new URL(request.url).origin), {
    status: 400,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...PAGE_HEADERS, ...CORS_HEADERS },
  })
}

// ---------------------------------------------------------------------------
// 代理主流程
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {URL} target
 * @param {ReturnType<typeof resolveConfig>} cfg
 * @param {{ waitUntil(p: Promise<unknown>): void }} ctx
 */
async function handleProxy(request, target, cfg, ctx) {
  const method = request.method
  const isHead = method === 'HEAD'

  // 只透传必要请求头。**默认不转发 Cookie / Authorization**：
  // 这个 Worker 是公开服务，把访问者凭据送给上游既无必要也不安全。
  const upstreamHeaders = new Headers()
  for (const [k, v] of request.headers) {
    const key = k.toLowerCase()
    if ((key === 'cookie' || key === 'authorization') && !cfg.allowAuth) continue
    if (SKIP_REQUEST_HEADERS.has(key)) continue
    upstreamHeaders.set(k, v)
  }

  // Range 必须原样带上，否则「只取前 4KB 探测版本」的请求会退化成全量下载。
  const range = request.headers.get('Range')
  if (range) {
    upstreamHeaders.set('Range', range)
    // Range + 压缩不能同时要：上游会按「压缩后的表示」切字节，回来的是压缩流碎片。
    // 这里显式要 identity（Cloudflare 的边缘 fetch 未必听，所以下面还有兜底）。
    upstreamHeaders.set('Accept-Encoding', 'identity')
  }

  const init = { method, headers: upstreamHeaders }
  if (!isHead && method !== 'GET' && request.body) {
    init.body = request.body
    init.duplex = 'half'
  }

  let res
  try {
    // 关键：由 Worker 自己把整条重定向链跟完，只回最终响应。
    res = await fetchFollowingRedirects(target.href, init, cfg.upstreamTimeout, cfg.maxRedirects)
  } catch (err) {
    console.error('上游请求失败：', err)
    return textResponse('上游请求失败', 502)
  }

  if (!res) {
    return textResponse('上游重定向次数过多', 508)
  }

  // Range 落在「压缩后的表示」上时，206 是不可用的：上游按 br/gzip 的字节切，
  // 回来的 content-range 总数是压缩长度，正文是压缩流碎片——客户端续传拼出来
  // 的文件是坏的（实测 37913 字节的文本报成 13173 字节的「总数」）。
  //
  // 怎么判断「这是压缩表示」：Cloudflare 会把 subrequest 的 `content-encoding`
  // 头抹掉（v1.2.3/v1.2.4 实测都拿不到），但它会保留弱 ETag —— `W/` 前缀正是
  // RFC 7232 里「语义相同、字节不同」的标记，压缩就是这种情况。所以两路信号
  // 任一命中就认压缩。二进制资产不会被压缩，走不到这里。
  //
  // 判成压缩表示后别给 206：丢掉 Range 重取全量回 200，让客户端从头下——
  // 慢一点，但拿到的一定是原始字节，不会写坏文件。
  const compressedEtag = /^W\//i.test(res.headers.get('etag') || '')
  // 只在「上游确实按 Range 返回了 206」且请求体没被消费过时才重取：
  //   - 上游忽略 Range、直接回 200/416 时，重取等于白下一遍整包（大文件尤其致命）；
  //   - POST/PUT 带 Range 时 `init.body` 已经被这次 fetch 消费掉，第二次 fetch
  //     会抛「body object should not be disturbed or locked」，只能放弃重取。
  const canRetry = res.status === 206 && !init.body
  if (range && canRetry && (res.headers.has('content-encoding') || compressedEtag)) {
    try {
      await res.body?.cancel()
    } catch {
      /* 取消失败不影响后续重取 */
    }
    const fullHeaders = new Headers(upstreamHeaders)
    fullHeaders.delete('Range')
    const retry = { ...init, headers: fullHeaders }
    try {
      res = await fetchFollowingRedirects(target.href, retry, cfg.upstreamTimeout, cfg.maxRedirects)
    } catch (err) {
      console.error('range 重取失败：', err)
      return textResponse('上游请求失败', 502)
    }
    if (!res) {
      return textResponse('上游重定向次数过多', 508)
    }
  }

  // ---- 响应头清洗 ---------------------------------------------------------
  const outHeaders = sanitizeUpstreamHeaders(res.headers)
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('access-control-expose-headers', '*')

  // ---- 缓存：一律不缓存 ---------------------------------------------------
  // 这是一个代理下载服务：用户要的是「此刻上游的那个文件」，不是「几天前某个
  // 边缘节点存下的副本」。所以每个响应都显式 `no-store`，也不留 `cdn-cache-control`。
  //
  // 早先按资源可变性分级缓存（200 给 300 秒 / release 资产给 86400 秒），代价是
  // 刚发布的 release、刚推上分支的 raw 都可能拿到旧字节——对下载服务来说这是
  // 错误答案，不是性能优化。206 本来就不缓存（缓存键里没有 Range），现在 200 也一样。
  outHeaders.set('cache-control', 'no-store')
  outHeaders.set('cdn-cache-control', 'no-store')

  return new Response(res.body, { status: res.status, headers: outHeaders })
}

const SKIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'cf-worker',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-real-ip',
  // Cloudflare 会自己处理压缩；转发客户端的 accept-encoding 会让上游按
  // 客户端能力压缩，Worker 还要再解压一遍才能交出去，没有好处。
  'accept-encoding',
])
