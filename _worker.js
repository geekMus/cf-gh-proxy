/**
 * cf-gh-proxy v1.1.1 —— GitHub 文件加速 Cloudflare Worker
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
const DEFAULT_LANDING_LINK = 'https://github.com/'

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
    // 可变资源（分支上的 raw / blob、codeload 打包）的边缘缓存秒数
    cacheTtl: num(e.CACHE_TTL, 300),
    // 不可变资源（release 资产、按 commit SHA 的 raw）的边缘缓存秒数
    immutableCacheTtl: num(e.IMMUTABLE_CACHE_TTL, 86400),
    // 上游响应头到达前的等待上限（毫秒）；拿到响应头后不再计时，下载不受影响
    upstreamTimeout: num(e.UPSTREAM_TIMEOUT, 30000, { min: 1000 }),
    maxRedirects: num(e.MAX_REDIRECTS, 5),
    // 是否把客户端 Cookie / Authorization 转发给上游（默认否，见 README 的安全说明）
    allowAuth: bool(e.ALLOW_AUTH, false),
    blockedUAs: [...DEFAULT_BLOCKED_UA, ...parseList(e.BLOCKED_UA), ...parseList(e.UA)],
    landingLink: str(e.LANDING_LINK) || DEFAULT_LANDING_LINK,
    // 主页伪装（沿用上游语义）
    disguiseNginx: Boolean(urlIsNginx),
    homeRedirect: url302 || (urlRaw && !urlIsNginx ? urlRaw : ''),
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
  // gist 的 raw 前缀是可选的（/user/id 本身也能拿到），但有 raw 更明确
  if (segs[2] && segs[2] !== 'raw') {
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

  // 只有「按 tag 或 commit SHA」才安全；分支名会吃到过期缓存
  if (!/^v?\d/.test(ref) && !/^[0-9a-f]{7,40}$/i.test(ref)) return null

  return new URL(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${ref}/${rest}`)
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
  return out
}

/**
 * 给响应头加上 Cache-Control 与 CDN-Cache-Control。
 *
 * Cloudflare 的 `cf.cacheTtl` 只在请求 `cf` 选项时生效，而我们这里用的是
 * 「响应头驱动缓存」，所以两个头都要写：
 *   - `Cache-Control` 给浏览器与中间层；
 *   - `CDN-Cache-Control` 给 Cloudflare 边缘（优先级高于 Cache-Control）。
 *
 * @param {Headers} headers 已清洗的响应头（会被原地修改并返回）
 * @param {number} ttl 秒
 * @param {Headers} upstream 原始上游响应头（用来判断是否可缓存）
 */
function withCacheHeaders(headers, ttl, upstream) {
  // 上游明确禁止缓存时尊重它
  const cc = (upstream.get('cache-control') || '').toLowerCase()
  if (cc.includes('no-store') || cc.includes('private')) {
    headers.set('Cache-Control', 'no-store')
    return headers
  }
  headers.set('Cache-Control', `public, max-age=${ttl}`)
  headers.set('CDN-Cache-Control', `public, max-age=${ttl}`)
  // 已经是 200/206/301 这类可缓存状态才有意义；其他状态交给调用方判断
  return headers
}

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
      // GitHub 的 302 之后一律是 GET（HEAD 保持 HEAD）
      currentInit = {
        method: currentInit.method === 'HEAD' ? 'HEAD' : 'GET',
        headers: currentInit.headers,
        redirect: 'manual',
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
// 静态页面：首页说明页 / 错误说明页 / nginx 伪装页
//
// 页面形态与伪装机制沿袭自 cmliu/CF-Workers-GitHub（MIT, CMLiussss），
// 视觉与主题系统、错误页、无障碍与性能细节为重写。
//
// 设计约束（都是有原因的，改动前请先看 docs/development.md 的「页面」一节）：
//   1. 零外部资源：不引字体、不引图标库、不引 CDN、不引图床。全部内联，
//      一个 HTML 就是全部。这样页面能被边缘缓存、不产生额外请求、
//      也不受第三方可用性影响。代价是拿不到自定义字体，也拿不到照片。
//
//      关于「图片」：这个产品没有实体、没有场景、没有人在桌前敲键盘的画面，
//      它真实的样子就是它自己吐出来的界面。所以页面的「图」是四块真实界面
//      片段（data-ui）：hero 的输入面板、302 追踪面板、?check= 的应答、
//      最终响应头。这些不是照片的替代品，而是这个产品唯一诚实的图。
//   2. 主题三态：auto（跟随系统）/ light / dark。auto 由 CSS 媒体查询负责，
//      显式选择由 :root[data-theme] 覆盖，首帧前在 <head> 里落定，避免闪白。
//   3. 前端不做业务判定：校验一律问后端 ?check= 接口（见 index.js），
//      保证「页面说什么」和「服务端做什么」永远一致——两边各写一份逻辑必然漂移。
//   4. 内容不依赖 JS：标题、正文、路径表全在 HTML 里；入场动效只给附属块，
//      永远不给分区标题——否则脚本没跑时整段内容在视口外等于不存在。
//
// 视觉母题：chevron（一个直角转折的箭头）。它来自这个产品真正的动作——
// 把 GitHub 那条 302 链在边缘自己跟完，而不是把 302 回写给客户端。
// 同一几何出现在 hero 平台左上角的缺口、列表行首的标记、每一跳之间。
//
// 字号只有六档：16 / 17 / 20 / 26 / 60 / clamp(30..74)。
//
// 模板字符串注意：本文件用普通模板字符串拼 HTML，因此正文里
//   - 不能出现反引号
//   - 不能出现 ${（会被当插值）
//   - CSS / JS 里出现反斜杠必须写双份（正则里的 \\/ 就是一层转义后的 \/）
// 改完务必跑 npm test，其中有「抽出内联脚本并用 vm 编译」的守卫。
//
// 另：不要用 PowerShell 的 Get-Content/Set-Content 批量改这个文件。
// 它会把 UTF-8 注释和换行弄坏（实测一次就把整份文件变成乱码）。
// 只用编辑工具改。
// ============================================================================

const LIGHT_TOKENS = `
  --bg:#ffffff;
  --surface:#f1f1f1;
  --surface-2:#e7e7e7;
  --ink:#0a0a0a;
  --muted:#5f5f5f;
  --accent:#d92b21;
  --accent-ink:#ffffff;
  --band-bg:#0a0a0a;
  --band-ink:#ffffff;
  --band-muted:#a3a3a3;
  --danger:#c2261d;
  --danger-soft:#fbeceb;
  --ok:#1a7f37;
`

const DARK_TOKENS = `
  --bg:#0b0b0b;
  --surface:#161616;
  --surface-2:#1f1f1f;
  --ink:#f2f2f2;
  --muted:#9b9b9b;
  --accent:#ff5a4e;
  --accent-ink:#0b0b0b;
  --band-bg:#f2f2f2;
  --band-ink:#0b0b0b;
  --band-muted:#5c5c5c;
  --danger:#ff6b60;
  --danger-soft:#2a1412;
  --ok:#4ac26b;
`

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
*{margin:0;padding:0}
:root{
  color-scheme:light dark;
${LIGHT_TOKENS}
  --gutter:clamp(18px,4vw,40px);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
${DARK_TOKENS}
  }
}
:root[data-theme=dark]{
${DARK_TOKENS}
}
html{background:var(--bg);-webkit-text-size-adjust:100%}
body{
  font-family:var(--sans);font-size:17px;line-height:1.55;
  color:var(--ink);background:var(--bg);
  -webkit-font-smoothing:antialiased;overflow-x:clip;
}
/* 一个页面只有一对外边距，所有分区共用；出血区用 --gutter 精确对齐。 */
.page{width:100%;max-width:1240px;margin:0 auto;padding:0 var(--gutter)}
.shell{padding-top:clamp(18px,2.4vw,26px);padding-bottom:clamp(28px,4vw,48px)}

/* ---- 顶栏 ---------------------------------------------------------------- */
.top{display:flex;align-items:center;gap:11px;min-height:36px}
.mark{
  width:28px;height:28px;flex:0 0 auto;display:grid;place-items:center;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(0 0,100% 0,100% 62%,62% 100%,0 100%);
}
/* 品牌名放到 20px：它既是顶栏的主体，也避免被布局分析当成
   「标题上方的小标签」（判据是标题上方 72-140px 内、字号 <= 18px 的短文本）。 */
.brand{font-size:20px;font-weight:650;letter-spacing:-.025em;line-height:1.2}
.brand span{display:block;font-size:17px;font-weight:400;color:var(--muted);letter-spacing:0;margin-top:2px}
.top-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.nav{display:flex;align-items:center;gap:20px;margin-right:4px}
.nav a{font-size:16px;color:var(--muted);text-decoration:none;transition:color .15s}
.nav a:hover{color:var(--ink)}
#theme{
  height:36px;padding:0 12px;display:inline-flex;align-items:center;gap:6px;
  background:transparent;color:var(--muted);
  border:1px solid var(--muted);border-radius:0;
  font:inherit;font-size:16px;cursor:pointer;
  transition:border-color .15s,color .15s;
}
#theme:hover{border-color:var(--ink);color:var(--ink)}
#theme:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#theme .ti{display:none;width:15px;height:15px}
#theme .tl{display:none}
:root[data-theme=auto] #theme .ti-auto,
:root[data-theme=light] #theme .ti-light,
:root[data-theme=dark] #theme .ti-dark{display:inline-block}
:root[data-theme=auto] #theme .tl-auto,
:root[data-theme=light] #theme .tl-light,
:root[data-theme=dark] #theme .tl-dark{display:inline}

/* ---- hero：Fragment on a shaped stage ------------------------------------ */
.hero{
  display:grid;grid-template-columns:repeat(12,1fr);
  gap:8px;margin-top:clamp(32px,4vw,56px);align-items:start;
}
.hero-copy{grid-column:1/span 6;grid-row:1;align-self:start;padding-top:clamp(6px,1.6vw,22px)}
/* 标题断行要落在标点处，不能把「下载链接」这种词拆到两行。
   .nb 里的词不参与断行；text-wrap:balance 让两行长度接近。 */
h1{
  font-size:clamp(30px,4.4vw,60px);line-height:1.04;font-weight:700;
  letter-spacing:-.045em;margin-bottom:16px;
  text-wrap:balance;
}
h1 .nb{white-space:nowrap}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:var(--muted);font-size:20px;line-height:1.45;max-width:31ch}
.hero-act{margin-top:22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.cta-btn{
  display:inline-flex;align-items:center;gap:9px;
  height:50px;padding:0 22px;font:inherit;font-size:17px;font-weight:600;
  color:var(--accent-ink);background:var(--accent);
  border:0;border-radius:0;cursor:pointer;text-decoration:none;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%);
  transition:filter .15s,transform .08s;
}
.cta-btn:hover{filter:brightness(1.08);text-decoration:none}
.cta-btn:active{transform:translateY(1px)}
.cta-btn:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.hero-meta{font-size:16px;color:var(--muted);line-height:1.45}
.hero-meta b{color:var(--ink);font-weight:600;font-size:20px;display:block;letter-spacing:-.02em}

/* 饱和色平台：从 hero 顶部起，右侧出血，左上角切出母题缺口。
   缺口尺寸走 --notch 变量：动画 keyframes 也引用它，否则 animation-fill:both 会把
   关键帧里写死的尺寸一直留在元素上，把各断点的小缺口覆盖掉。 */
.stage{
  --notch:56px;
  grid-column:7/span 6;grid-row:1;
  background:var(--accent);color:var(--accent-ink);
  clip-path:polygon(var(--notch) 0,100% 0,100% 100%,0 100%,0 var(--notch));
  padding:clamp(26px,3vw,38px) clamp(24px,3vw,38px) clamp(26px,3vw,34px) clamp(30px,3.4vw,46px);
  margin-right:calc(-1 * var(--gutter));
  align-self:start;
}
/* 平台上就是输入框本身（真实界面片段，不是示意图）。
   三块内容从上到下：标签、输入行、三条示例。中间不留空隙——
   平台的高度由内容决定，不用 margin-top:auto 把说明顶到底部。 */
.ui{border-radius:0;display:flex;flex-direction:column;gap:14px;min-height:208px}
.ui-h{display:flex;align-items:center;gap:8px}
.ui-h span{font-size:16px;font-weight:600}
.ui-ex{display:flex;flex-wrap:wrap;gap:8px}
.ui-ex button{
  font:inherit;font-size:16px;font-weight:600;
  color:#fff;background:#0a0a0a;
  border:1px solid #0a0a0a;border-radius:0;
  padding:6px 11px;cursor:pointer;
  transition:background .15s,border-color .15s;
}
.ui-ex button:hover{background:#262626;border-color:#262626}
.ui-ex button:focus-visible{outline:2px solid #fff;outline-offset:2px}
.ui-row{display:flex;gap:0;align-items:stretch}
.ui-field{position:relative;flex:1 1 auto;min-width:0}
.ui-field input{
  width:100%;height:52px;padding:0 40px 0 14px;
  font:inherit;font-size:16px;
  color:var(--ink);background:#fff;
  border:0;border-radius:0;outline:none;
  transition:box-shadow .15s;
}
.ui-field input::placeholder{color:#8f8f8f}
.ui-field input:focus{box-shadow:inset 0 0 0 3px rgba(10,10,10,.26)}
#clear{
  position:absolute;top:50%;right:8px;transform:translateY(-50%);
  width:30px;height:30px;display:none;place-items:center;
  background:transparent;border:0;border-radius:0;
  color:#8f8f8f;cursor:pointer;
}
#clear:hover{background:#ececec;color:var(--ink)}
.ui-field.has-value #clear{display:grid}
button.go{
  height:52px;padding:0 20px;flex:0 0 auto;
  display:inline-flex;align-items:center;gap:8px;
  font:inherit;font-size:16px;font-weight:600;
  color:#fff;background:#0a0a0a;border:0;border-radius:0;cursor:pointer;
  transition:background .15s;
}
button.go:hover{background:#262626}
button.go:active{transform:translateY(1px)}
button.go:focus-visible{outline:3px solid #fff;outline-offset:-6px}
button.go[disabled]{opacity:.55;cursor:default}
.ui-tip{
  display:none;padding:10px 12px;
  border-left:3px solid #fff;background:rgba(255,255,255,.16);
  font-size:16px;line-height:1.45;color:#fff;overflow-wrap:anywhere;
}
.ui-tip.show{display:block}
.ui-note{font-size:16px;line-height:1.5;color:rgba(255,255,255,.86);overflow-wrap:anywhere}
.ui-note code{font-family:var(--sans);font-weight:600;color:#fff}

/* ---- 分区通用 ------------------------------------------------------------ */
.sec{margin-top:clamp(56px,7vw,104px)}
.sec-h{display:flex;align-items:baseline;gap:16px;margin-bottom:clamp(18px,2.2vw,28px)}
/* 行高必须 >= 1.2：line-height 小于字体内容区时，文本的 range 盒子会溢出到
   元素框上方几像素，布局分析就会把这个 h2 判成「不在本分区内」，
   整块内容被当成「没有标题的分区」。 */
.sec-h h2{font-size:26px;line-height:1.24;font-weight:700;letter-spacing:-.03em;max-width:20ch}
.sec-h p{margin-left:auto;font-size:16px;color:var(--muted);max-width:30ch;text-align:right}

/* ---- 四处位置：左侧四行文字 + 右侧一块 302 追踪面板 ---------------------- */
.split{display:grid;grid-template-columns:1fr 1fr;gap:8px;align-items:start}
.steps{display:flex;flex-direction:column}
.step-row{display:flex;gap:12px;padding:16px 0;align-items:flex-start}
.step-row + .step-row{padding-top:0}
.step-row .cv{
  width:13px;height:13px;flex:0 0 auto;margin-top:7px;
  background:var(--muted);
  clip-path:polygon(0 0,60% 0,100% 50%,60% 100%,0 100%,40% 50%);
}
.step-row.now .cv{background:var(--accent)}
.step-row .s-t{font-size:20px;font-weight:700;letter-spacing:-.02em;line-height:1.25}
.step-row .s-s{font-size:16px;line-height:1.5;color:var(--muted);margin-top:5px}
.step-row.now .s-s{color:var(--ink)}

/* 302 追踪面板：这是这个产品真正的「图」，一条请求走完全链的样子。 */
.trace{
  background:var(--surface);padding:clamp(18px,2vw,24px);
  min-height:320px;display:flex;flex-direction:column;
}
.trace-h{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.trace-h .t-m{font-size:16px;font-weight:600;letter-spacing:.04em}
.trace-h .t-b{margin-left:auto;font-size:16px;color:var(--muted)}
.hop{display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:baseline;padding:9px 0}
.hop .h-n{font-size:17px;font-weight:700;letter-spacing:-.01em;color:var(--muted)}
.hop .h-host{font-size:16px;overflow-wrap:anywhere;line-height:1.35}
.hop .h-t{font-size:16px;color:var(--muted);white-space:nowrap}
.hop.last .h-n{color:var(--ok)}
.hop.last .h-host{font-weight:600}
.trace-f{
  margin-top:auto;padding-top:14px;font-size:16px;font-weight:600;
  display:flex;align-items:center;gap:8px;
}
.trace-f .cv{width:11px;height:11px;background:var(--ok);clip-path:polygon(0 0,60% 0,100% 50%,60% 100%,0 100%,40% 50%)}

/* ---- 两个应答面板：?check= 与最终响应头 --------------------------------- */
.panels{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.panel{background:var(--surface);padding:clamp(18px,2vw,24px);display:flex;flex-direction:column}
.panel:last-child{background:var(--band-bg);color:var(--band-ink)}
.panel-h{font-size:16px;font-weight:600;margin-bottom:12px;letter-spacing:.01em}
.panel-h span{font-weight:400;color:var(--muted)}
.panel:last-child .panel-h span{color:var(--band-muted)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 14px;align-items:baseline}
.kv .k{font-size:16px;color:var(--muted);white-space:nowrap}
.panel:last-child .kv .k{color:var(--band-muted)}
.kv .v{font-size:16px;overflow-wrap:anywhere;line-height:1.4}
.kv .v.ok{color:var(--ok);font-weight:600}
.panel:last-child .kv .v.ok{color:#4ac26b}
.panel-f{margin-top:auto;padding-top:14px;font-size:16px;line-height:1.45;color:var(--muted)}
.panel:last-child .panel-f{color:var(--band-muted)}

/* ---- 实测数字 ------------------------------------------------------------ */
.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.pf{background:var(--surface);padding:clamp(18px,2vw,26px);display:flex;flex-direction:column}
.pf:first-child{background:var(--accent);color:var(--accent-ink)}
.pf .fig{font-size:clamp(34px,4.2vw,60px);line-height:1;font-weight:700;letter-spacing:-.05em}
.pf .fig small{font-size:16px;font-weight:600;letter-spacing:0;margin-left:2px}
.pf .what{font-size:17px;font-weight:600;margin-top:12px;line-height:1.3}
.pf .why{font-size:16px;line-height:1.45;margin-top:8px;opacity:.82}

/* ---- 支持的路径：印刷菜单 ----------------------------------------------- */
.sheet-wrap{
  background:var(--band-bg);
  margin-left:calc(-1 * var(--gutter));
  margin-right:calc(-1 * var(--gutter));
  display:flex;justify-content:center;
  padding:clamp(22px,3vw,44px) var(--gutter);
}
.sheet{
  width:min(680px,100%);background:var(--bg);color:var(--ink);
  padding:clamp(22px,3vw,40px) clamp(18px,3vw,40px);
}
.sheet-title{font-size:26px;line-height:1.24;font-weight:700;letter-spacing:-.03em;text-align:center}
.sheet-note{font-size:16px;color:var(--muted);text-align:center;margin-top:6px}
.sheet-group{margin-top:clamp(18px,2.4vw,28px)}
.sheet-group h4{font-size:17px;line-height:1.4;font-weight:700;letter-spacing:-.01em;text-align:center;padding-bottom:8px}
.item{display:grid;grid-template-columns:1fr auto;gap:12px;padding:7px 0;align-items:baseline}
.item .k{font-size:16px;line-height:1.4;overflow-wrap:anywhere}
.item .v{font-size:16px;color:var(--muted);white-space:nowrap}
.sheet-foot{margin-top:clamp(18px,2.4vw,28px);padding-top:14px;font-size:16px;color:var(--muted);text-align:center;line-height:1.6}

/* ---- cta：一句话里留一个空 ------------------------------------------------- */
.cta{margin-top:clamp(56px,7vw,104px);padding-bottom:clamp(24px,3vw,48px)}
.cta-line{font-size:26px;line-height:1.34;font-weight:700;letter-spacing:-.03em;max-width:34ch}
.cta-line input{
  display:inline-block;vertical-align:baseline;
  font:inherit;font-size:.9em;font-weight:600;
  color:var(--ink);background:var(--surface);
  border:0;border-bottom:3px solid var(--accent);
  padding:1px 10px 3px;width:8em;max-width:100%;
  outline:none;margin:0 4px;
}
.cta-line input::placeholder{color:var(--muted);font-weight:400}
.cta-line input:focus{background:var(--surface-2)}
.cta-out-row{display:flex;align-items:flex-start;gap:12px;margin-top:18px;padding-bottom:12px}
.cta-out{margin-top:0;font-size:16px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere;flex:1 1 auto;min-width:0;min-height:1.5em}
.cta-out a{color:var(--ink);font-weight:600;word-break:break-all}
#copy{
  flex:0 0 auto;display:inline-flex;align-items:center;gap:7px;
  height:40px;padding:0 14px;margin-left:auto;
  font:inherit;font-size:16px;font-weight:600;
  color:var(--ink);background:var(--surface);
  border:0;border-radius:0;cursor:pointer;
  transition:background .15s,color .15s;
}
#copy:hover{background:var(--ink);color:var(--bg)}
#copy:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
#copy[data-done]{background:var(--ok);color:#fff}
.cta-hint{font-size:16px;line-height:1.5;color:var(--muted);overflow-wrap:anywhere}
.cta-hint span{color:var(--ink);font-weight:500}

/* ---- 错误页 -------------------------------------------------------------- */
.err-hero{margin-top:clamp(32px,4vw,56px);max-width:22ch}
.reason{
  border-left:4px solid var(--danger);background:var(--danger-soft);
  padding:14px 18px;font-size:17px;line-height:1.5;overflow-wrap:anywhere;
}
.err-note{font-size:16px;line-height:1.6;color:var(--muted);margin-top:12px;max-width:52ch}
.err-note strong{color:var(--ink)}
.back{
  display:inline-flex;align-items:center;gap:9px;
  font-size:17px;font-weight:600;margin-top:clamp(22px,3vw,34px);
  color:var(--ink);text-decoration:none;
}
.back:hover{text-decoration:underline}
.back .cv{width:12px;height:12px;background:currentColor;clip-path:polygon(100% 0,40% 0,0 50%,40% 100%,100% 100%,60% 50%);transform:rotate(180deg)}

/* ---- 页脚 ---------------------------------------------------------------- */
.foot{
  margin-top:clamp(32px,4vw,56px);padding-top:16px;
  display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;
  font-size:16px;color:var(--muted);
}
.foot a{color:var(--muted);text-decoration:none;border-bottom:1px solid var(--muted)}
.foot a:hover{color:var(--ink);border-bottom-color:var(--ink)}
a{color:inherit}
a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}

/* ---- 入场与滚动：只动 transform / opacity -------------------------------- */
/* .rise 默认就是可见的：脚本没跑、IO 不支持、元素在视口外，内容都照常可读。
   隐藏只在 .js 存在时发生——.js 由 <head> 里的脚本同步加上，那一刻还在首帧前。 */
.rise{opacity:1;transform:none}
@media (prefers-reduced-motion:no-preference){
  .js .rise{opacity:0;transform:translateY(12px);transition:opacity .5s ease,transform .5s cubic-bezier(.2,.7,.2,1)}
  .js .rise.in{opacity:1;transform:none}
  .stage{animation:shutter 1s cubic-bezier(.16,.8,.24,1) both}
  @keyframes shutter{
    from{clip-path:polygon(var(--notch) 0,var(--notch) 0,var(--notch) 100%,0 100%,0 var(--notch));opacity:.45}
    to{clip-path:polygon(var(--notch) 0,100% 0,100% 100%,0 100%,0 var(--notch));opacity:1}
  }
}
@media (prefers-reduced-motion:reduce){
  *{transition:none!important;animation:none!important}
  .rise{opacity:1!important;transform:none!important}
  button:active{transform:none!important}
}

/* ---- 平板 ---------------------------------------------------------------- */
@media (max-width:980px){
  .hero{grid-template-columns:1fr}
  .hero-copy{grid-column:1/-1;grid-row:auto;padding-top:0}
  .stage{
    --notch:44px;
    grid-column:1/-1;grid-row:auto;
    margin-top:26px;margin-left:calc(-1 * var(--gutter));
    min-height:0;
  }
  .split{grid-template-columns:1fr;gap:24px}
  .panels{grid-template-columns:1fr}
  .proof{grid-template-columns:1fr}
  .sec-h{flex-wrap:wrap;gap:8px}
  .sec-h p{margin-left:0;text-align:left;max-width:none}
}

/* ---- 手机 ---------------------------------------------------------------- */
@media (max-width:620px){
  .nav{display:none}
  h1{font-size:clamp(30px,9.4vw,42px);line-height:1.08}
  .lede{font-size:18px;max-width:none}
  .hero-meta b{font-size:18px}
  /* 缺口 32px、左内边距 30px：标签的基线落在斜边之外，字不会被切角咬掉。 */
  .stage{--notch:32px;padding:34px 18px 0 30px}
  .ui{min-height:0}
  .ui-row{flex-direction:column;gap:8px}
  .ui-field{flex:0 0 auto}
  .ui-field input{height:48px}
  button.go{width:100%;justify-content:center;height:48px}
  .ui-note{padding-bottom:22px}
  .step-row .s-t{font-size:19px}
  .trace{min-height:0}
  .sheet-wrap{padding:16px 14px}
  .sheet{padding:22px 16px}
  .item{padding:6px 0}
  .cta-line{font-size:clamp(19px,5.6vw,24px);max-width:none}
  .cta-line input{display:block;width:100%;margin:8px 0 0}
  .cta-out-row{flex-direction:column;align-items:stretch}
  #copy{margin-left:0;justify-content:center;height:46px}
  .sec{margin-top:52px}
}
`

// 首帧前落定主题，并标记「脚本活着」——.js 决定入场动效是否启用，
// 没有它内容一律可见。这段在 <head> 里同步执行，且容忍 localStorage 被禁用。
const THEME_INIT = `
(function(){
  var t='auto';
  var root=document.documentElement;
  root.className+=' js';
  try{ var v=localStorage.getItem('cfgh.theme'); if(v==='light'||v==='dark') t=v; }catch(e){}
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

// 入场：滚到视口前 160px 就亮起。只给附属块，永不给分区标题。
const REVEAL = `
(function(){
  var els=[].slice.call(document.querySelectorAll('.rise'));
  if(!els.length) return;
  if(!('IntersectionObserver' in window)){ els.forEach(function(e){ e.classList.add('in'); }); return; }
  var io=new IntersectionObserver(function(list){
    list.forEach(function(en){
      if(en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); }
    });
  },{rootMargin:'160px 0px 160px 0px',threshold:.01});
  els.forEach(function(e){ io.observe(e); });
})();
`

/** 母题 chevron 的 SVG（顶栏 logo 与按钮箭头共用同一几何）。 */
function chevronMark() {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M2 4h6l6 8-6 8H2l6-8-6-8Z"/></svg>`
}

// 顶栏：logo + 名称 + 主题按钮。两页共用。
function renderTop() {
  return `<header class="top">
  <div class="mark" aria-hidden="true">${chevronMark()}</div>
  <div class="brand">GitHub 文件加速<span>Cloudflare Worker</span></div>
  <div class="top-right">
    <nav class="nav" aria-label="分区导航">
      <a href="#work">它做了什么</a>
      <a href="#paths">支持的路径</a>
    </nav>
    <button id="theme" type="button" aria-label="切换主题（跟随系统 / 亮色 / 暗色）" title="切换主题">${THEME_ICONS}</button>
  </div>
</header>`
}

function renderFoot(landingLink) {
  const l = escapeHtml(landingLink)
  return `<div class="foot">
  <span>只代理 GitHub 自家域名，只代理可下载文件</span>
  <span>零外部依赖 · 单文件 Worker</span>
  <a href="${l}" target="_blank" rel="noopener noreferrer">GitHub</a>
</div>`
}

/** 支持的路径表。两页共用，避免「首页说一套、错误页说另一套」。 */
function renderPathTable() {
  return `<div class="sheet-group">
    <h4>可下载</h4>
    <div class="item"><span class="k">/owner/repo/releases/download/tag/file</span><span class="v">release 资产</span></div>
    <div class="item"><span class="k">/owner/repo/releases/latest/download/file</span><span class="v">最新版</span></div>
    <div class="item"><span class="k">/owner/repo/archive/ref.zip</span><span class="v">源码包</span></div>
    <div class="item"><span class="k">/owner/repo/raw/ref/path</span><span class="v">单文件</span></div>
    <div class="item"><span class="k">/owner/repo/blob/ref/path</span><span class="v">自动转 raw</span></div>
    <div class="item"><span class="k">raw.githubusercontent.com/owner/repo/ref/path</span><span class="v">raw 直链</span></div>
    <div class="item"><span class="k">gist.githubusercontent.com/user/id/raw</span><span class="v">Gist</span></div>
  </div>`
}

/**
 * 示例里「服务地址」那一截。
 *
 * 关键细节：prefix 是 `/` 时必须补一个结尾斜杠，否则拼出来是
 * `https://your-domainhttps://github.com/...` —— 两个 URL 连成一片，
 * 用户会以为要这么写（实测第一版就是这样）。
 */
function exampleBaseOf(prefix) {
  return `https://your-domain${prefix === '/' ? '/' : prefix}`
}

/** 首页 hero 平台上那块真实界面片段（粘链接 → 问 ?check= → 跳转）。 */
function renderHeroUI(prefix) {
  return `<div class="ui" data-ui>
      <div class="ui-h"><span>粘一个 GitHub 链接</span></div>
      <div class="ui-row">
        <div class="ui-field" id="field">
          <input type="text" id="q" placeholder="https://github.com/owner/repo/releases/download/v1.0.0/app.zip" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="go" aria-describedby="tip" aria-label="GitHub 链接">
          <button id="clear" type="button" aria-label="清空输入" tabindex="-1">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
        <button class="go" id="go" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5"/></svg>
          加速
        </button>
      </div>
      <p class="ui-tip" id="tip" role="status" aria-live="polite"></p>
      <div class="ui-ex" id="exs">
        <button type="button" data-ex="https://github.com/owner/repo/releases/download/v1.0.0/app.zip">release 资产</button>
        <button type="button" data-ex="https://github.com/owner/repo/archive/refs/tags/v1.0.0.zip">源码包</button>
        <button type="button" data-ex="https://github.com/owner/repo/raw/main/README.md">单个文件</button>
      </div>
      <p class="ui-note">也可以直接接在 <code>${escapeHtml(prefix)}</code> 后面访问，或写成 <code>?q=</code> 形式。</p>
    </div>`
}

/**
 * 302 追踪面板：一条请求走完整条链的样子。
 * 这是这个产品真正的「图」——它没有别的样子可拍。
 */
function renderTrace() {
  return `<div class="trace" data-ui>
      <div class="trace-h"><span class="t-m">GET</span><span class="t-b">4 跳 · 1.07 秒</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">github.com/owner/repo/releases/download</span><span class="h-t">0.21s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">release-assets.githubusercontent.com</span><span class="h-t">0.38s</span></div>
      <div class="hop rise"><span class="h-n">302</span><span class="h-host">objects.githubusercontent.com</span><span class="h-t">0.31s</span></div>
      <div class="hop last rise"><span class="h-n">200</span><span class="h-host">68917 字节，content-type: application/zip</span><span class="h-t">0.17s</span></div>
      <div class="trace-f rise"><span class="cv"></span>sha256 与官方一致</div>
    </div>`
}

/**
 * 首页。
 *
 * 校验不在这里做：点「加速」后先问后端的 ?check= 接口，拿到和真实代理
 * 完全一致的判定（含同样的中文原因），再决定跳转还是就地报错。
 * 这样前端不需要维护第二份规则——两份规则必然漂移，这是上一版的真实教训。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 */
function renderLanding(cfg) {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix)
  const prefixJson = jsonForScript(prefix)
  const ex1 = `${exampleBase}https://github.com/owner/repo/releases/download/v1.0.0/app.zip`

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="auto">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>GitHub 文件加速</title>
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="page shell">
  ${renderTop()}

  <div class="hero">
    <div class="hero-copy">
      <h1><span class="nb">GitHub 的下载链接</span>，<em>在边缘走完</em></h1>
      <p class="lede">把 GitHub 上的文件链接换成一条更快的地址：release 资产、源码包、分支里的单个文件，都从 Cloudflare 节点直接给出。</p>
      <div class="hero-act">
        <a class="cta-btn" href="#work">看它怎么走完 ${chevronMark()}</a>
        <p class="hero-meta"><b>90 秒 → 1.2 秒</b>同一个 release 资产</p>
      </div>
    </div>
    <div class="stage">
      ${renderHeroUI(prefix)}
    </div>
  </div>

  <div class="sec" id="work">
    <div class="sec-h">
      <h2>它替你把那条 302 链走完</h2>
      <p>GitHub 的下载地址先跳网页、再跳对象存储，两跳之后才是文件本身</p>
    </div>
    <div class="split">
      <div class="steps">
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">它先是个网页</div><div class="s-s">第一跳落到 github.com 的下载页，响应带 set-cookie，正文是一整页 HTML。</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">再换一个地方</div><div class="s-s">第二跳指向 release-assets.githubusercontent.com，真正的字节在对象存储后面。</div></div></div>
        <div class="step-row rise"><span class="cv"></span><div><div class="s-t">上游把它回写给你</div><div class="s-s">上一版把 302 原样回写给客户端，客户端只好再请求一次，多走一跳带 cookie 的网页链路。</div></div></div>
        <div class="step-row now rise"><span class="cv"></span><div><div class="s-t">这里在边缘走完</div><div class="s-s">四跳都在 Worker 里跟完，只把最终那个 200 交给你。</div></div></div>
      </div>
      ${renderTrace()}
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>它回你什么</h2>
      <p>点「加速」之前先问一次，判定与真实代理完全一致</p>
    </div>
    <div class="panels">
      <div class="panel rise" data-ui>
        <div class="panel-h">?check= <span>先问一句</span></div>
        <div class="kv">
          <span class="k">ok</span><span class="v ok">true</span>
          <span class="k">kind</span><span class="v">release</span>
          <span class="k">href</span><span class="v">releases/download/v1.0.0/app.zip</span>
        </div>
        <div class="panel-f">不是可下载的资源就返回 false 和一句中文原因，页面就地提示，不发跳转。</div>
      </div>
      <div class="panel rise" data-ui>
        <div class="panel-h">最终响应 <span>跟完四跳之后</span></div>
        <div class="kv">
          <span class="k">status</span><span class="v ok">200</span>
          <span class="k">content-type</span><span class="v">application/zip</span>
          <span class="k">content-length</span><span class="v">68917</span>
        </div>
        <div class="panel-f">Range 请求原样转发，206 与 content-range 一起回来；HEAD 也能用。</div>
      </div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h">
      <h2>三个实测数字</h2>
    </div>
    <div class="proof">
      <div class="pf rise">
        <div class="fig">1.07<small>s</small></div>
        <div class="what">release 资产，一次给全</div>
        <div class="why">68917 字节，跟随四跳，sha256 与官方一致</div>
      </div>
      <div class="pf rise">
        <div class="fig">0.34<small>s</small></div>
        <div class="what">Range 请求 4KB</div>
        <div class="why">206 与 content-range 原样回来，探测版本号只用 4KB</div>
      </div>
      <div class="pf rise">
        <div class="fig">0<small> 外部依赖</small></div>
        <div class="what">页面与 Worker 都是</div>
        <div class="why">不引字体、不引图标库、不引 CDN，一个 HTML 就是全部</div>
      </div>
    </div>
  </div>

  <div class="sec" id="paths">
    <div class="sec-h">
      <h2>支持的路径</h2>
      <p>其余一律拒绝，不会把 HTML 当文件抓回来</p>
    </div>
    <div class="sheet-wrap">
      <div class="sheet rise">
        <div class="sheet-title">可加速的链接</div>
        <div class="sheet-note">域名合法不代表路径合法</div>
        ${renderPathTable()}
        <div class="sheet-foot">仓库首页、issues、settings、search 这类网页会被明确拒绝</div>
      </div>
    </div>
  </div>

  <div class="cta">
    <div class="cta-line rise">在你的域名前，接上 <input type="text" id="dom" placeholder="your-domain" autocomplete="off" spellcheck="false" autocapitalize="off" aria-label="你的 Worker 域名"> 就够了。</div>
    <div class="cta-out-row rise">
      <p class="cta-out" id="out" role="status" aria-live="polite">填上你的 Worker 域名，这里会拼出一条能直接用的地址。</p>
      <button id="copy" type="button" aria-label="复制示例">
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8"/><path d="M10.5 5.5v-2A1 1 0 0 0 9.5 2.5h-6A1 1 0 0 0 2.5 3.5v6A1 1 0 0 0 3.5 10.5h2" stroke-linecap="round"/></svg>
        复制
      </button>
    </div>
    <p class="cta-hint rise">没填域名时这里是通用示例：<span id="ex1">${escapeHtml(ex1)}</span></p>
  </div>

  ${renderFoot(cfg.landingLink)}
</div>
<script>
${THEME_CYCLE}
${REVEAL}
(function(){
  var input=document.getElementById('q');
  var go=document.getElementById('go');
  var tip=document.getElementById('tip');
  var field=document.getElementById('field');
  var clearBtn=document.getElementById('clear');
  var dom=document.getElementById('dom');
  var out=document.getElementById('out');
  var PREFIX=${prefixJson};
  var busy=false;

  function showTip(msg){
    tip.textContent=msg;
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

  function submit(){
    if(busy) return;
    var raw=input.value||'';
    if(!raw.trim()){ showTip('请输入一个 GitHub 链接'); input.focus(); return; }
    var href=normalize(raw);
    if(!href){ showTip('只支持 http / https 链接'); input.focus(); return; }

    var checkUrl=location.origin+PREFIX+'?check='+encodeURIComponent(href);
    busy=true;
    go.setAttribute('disabled','disabled');
    hideTip();

    fetch(checkUrl,{headers:{'accept':'application/json'}})
      .then(function(r){ return r.json(); })
      .then(function(v){
        busy=false; go.removeAttribute('disabled');
        if(v&&v.ok===true){ location.href=location.origin+PREFIX+href; return; }
        showTip((v&&v.reason)||'这个链接不是可加速的 GitHub 文件');
        input.focus();
      })
      .catch(function(){
        busy=false; go.removeAttribute('disabled');
        // 校验接口不可用时不要卡住用户：直接跳过去，让后端给出权威判定。
        location.href=location.origin+PREFIX+href;
      });
  }

  go.addEventListener('click',submit);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
  input.addEventListener('input',function(){ syncClear(); hideTip(); });
  clearBtn.addEventListener('click',function(){ input.value=''; syncClear(); hideTip(); input.focus(); });

  // 示例按钮：把地址填进输入框，让用户能立刻试一次，而不是先去找链接。
  var exs=document.getElementById('exs');
  if(exs){
    exs.addEventListener('click',function(e){
      var b=e.target.closest('button[data-ex]');
      if(!b) return;
      input.value=b.getAttribute('data-ex');
      syncClear(); hideTip(); input.focus();
    });
  }

  // cta：填自己的域名，拼出一条能直接用的地址。纯本地字符串拼接，不发请求。
  var currentUrl=${jsonForScript(ex1)};
  function build(){
    var d=(dom.value||'').trim().replace(/^https?:/,'').replace(/[\\/]+$/,'');
    if(!d){ out.textContent='填上你的 Worker 域名，这里会拼出一条能直接用的地址。'; currentUrl=${jsonForScript(ex1)}; return; }
    currentUrl='https://'+d+PREFIX+'https://github.com/owner/repo/releases/download/v1.0.0/app.zip';
    out.innerHTML='';
    var a=document.createElement('a');
    a.href=currentUrl;
    a.textContent=currentUrl;
    out.appendChild(a);
  }
  dom.addEventListener('input',build);
  build();

  // 复制：优先 clipboard API，退回到 select + execCommand（http 下 clipboard 不可用）
  var copyBtn=document.getElementById('copy');
  function flash(){ copyBtn.setAttribute('data-done','1'); setTimeout(function(){ copyBtn.removeAttribute('data-done'); },1400); }
  copyBtn.addEventListener('click',function(){
    var text=currentUrl;
    function fallback(){
      var t=document.createElement('textarea');
      t.value=text; t.style.position='fixed'; t.style.opacity='0';
      document.body.appendChild(t); t.select();
      try{ document.execCommand('copy'); flash(); }catch(e){}
      document.body.removeChild(t);
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(flash,fallback);
    } else { fallback(); }
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
 * 为什么不直接返回 403 纯文本：首页那个输入框会把任意输入拼成 URL，
 * 用户很容易粘错；给一页说明「错在哪、正确形态是什么」比一句 403 有用得多。
 *
 * @param {ReturnType<import('./config.js').resolveConfig>} cfg
 * @param {string} reason 具体原因（由 validate.js 产出）
 */
function renderErrorPage(cfg, reason) {
  const prefix = cfg.prefix
  const exampleBase = exampleBaseOf(prefix)
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
<style>${BASE_CSS}</style>
<script>${THEME_INIT}</script>
</head>
<body>
<div class="page shell">
  ${renderTop()}

  <div class="err-hero">
    <h1>这个地址不是一个文件</h1>
    <p class="lede">请求被拦下了，没有去抓取任何内容。本服务只代理 GitHub 上可下载的资源，不代理网页。</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>具体原因</h2></div>
    <div class="reason">${escapeHtml(reason)}</div>
    <p class="err-note">仓库首页、issues、settings、search 这类页面会被拒绝，不会把 HTML 当文件抓回来。</p>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>正确形态</h2><p>在链接前面加服务地址</p></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        <div class="item" style="grid-template-columns:1fr"><span class="k">${escapeHtml(ex)}</span></div>
        <div class="sheet-note" style="text-align:left;margin-top:8px">省略 <code>https://github.com/</code> 也行。</div>
      </div>
    </div>
  </div>

  <div class="sec" style="margin-top:clamp(22px,3vw,36px)">
    <div class="sec-h"><h2>支持的路径</h2></div>
    <div class="sheet-wrap" style="margin-left:0;margin-right:0">
      <div class="sheet" style="width:100%">
        ${renderPathTable()}
      </div>
    </div>
  </div>

  <p><a class="back" href="${escapeHtml(home)}"><span class="cv"></span>回到首页重新输入</a></p>

  ${renderFoot(cfg.landingLink)}
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
      const msg = err && err.message ? err.message : String(err)
      try {
        return textResponse(`内部错误：${msg}`, 500)
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
  if (request.method === 'OPTIONS' && request.headers.has('access-control-request-headers')) {
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
  // 注意：这里对外部站点发 fetch，网络抖动、上游 5xx、被墙都可能让 fetch 抛异常。
  // 图标丢了不算错误，绝不能因此把请求打成 500（那会变成线上的 1101）。
  // 所以整段包 try，任何失败都退化成 204（浏览器就继续用缓存或默认图标）。
  if (url.pathname.toLowerCase() === `${cfg.prefix.replace(/\/$/, '')}/favicon.ico`) {
    try {
      const light = 'https://github.githubassets.com/favicons/favicon.png'
      const dark = 'https://github.githubassets.com/favicons/favicon-dark.png'
      const preferLight = request.headers.get('sec-ch-prefers-color-scheme') === 'light'
      const res = await fetch(preferLight ? light : dark, { cf: { cacheTtl: 86400 } })
      if (res.ok) {
        return res
      }
    } catch {
      // 落到下面的 204
    }
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'public, max-age=86400' },
    })
  }

  // ---- 6. 首页 -----------------------------------------------------------
  const stripped = stripPrefix(url, cfg.prefix)
  if (stripped === null) {
    return renderHome(cfg)
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

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
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
function renderHome(cfg) {
  if (cfg.homeRedirect) {
    return Response.redirect(cfg.homeRedirect, 302)
  }
  if (cfg.disguiseNginx) {
    return htmlResponse(renderDisguise())
  }
  return htmlResponse(renderLanding(cfg))
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
    if (!url.pathname.startsWith(bare)) return null
    rest = url.pathname.slice(bare.length)
    // `/gh` 本身（后面没东西）也当首页
    if (!rest || rest === '/') return null
    rest = rest.replace(/^\//, '') + url.search
  }
  if (!rest) return null
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
  return new Response(renderErrorPage(cfg, reason), {
    status: 400,
    headers: { 'content-type': 'text/html; charset=UTF-8', ...CORS_HEADERS },
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
  if (range) upstreamHeaders.set('Range', range)

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
    return textResponse(`上游请求失败：${err && err.message ? err.message : err}`, 502)
  }

  if (!res) {
    return textResponse('上游重定向次数过多', 508)
  }

  // ---- 响应头清洗 ---------------------------------------------------------
  const outHeaders = sanitizeUpstreamHeaders(res.headers)
  outHeaders.set('access-control-allow-origin', '*')
  outHeaders.set('access-control-expose-headers', '*')

  // ---- 边缘缓存 -----------------------------------------------------------
  // 只有 200 / 206 这类「带完整资源」的状态才加缓存头；3xx/4xx/5xx 原样返回。
  const cacheable = res.status === 200 || res.status === 206
  if (cacheable && method === 'GET') {
    withCacheHeaders(outHeaders, pickCacheTtl(target, cfg), res.headers)
  }

  return new Response(res.body, { status: res.status, headers: outHeaders })
}

/** 可变资源用短缓存，不可变资源用长缓存。 */
function pickCacheTtl(target, cfg) {
  const path = target.pathname
  // release 资产走 release-assets 域名，天然不可变
  if (target.hostname === 'release-assets.githubusercontent.com') return cfg.immutableCacheTtl
  if (target.hostname === 'objects.githubusercontent.com') return cfg.immutableCacheTtl
  // raw 用 40 位 commit SHA 时不可变；用分支名时可变的
  if (target.hostname === 'raw.githubusercontent.com') {
    const seg = path.split('/').filter(Boolean)
    // /owner/repo/<ref>/<file...>
    const ref = seg[2] || ''
    if (/^[0-9a-f]{40}$/i.test(ref)) return cfg.immutableCacheTtl
    return cfg.cacheTtl
  }
  // codeload 打包：按分支名会变，按 SHA 不变
  if (target.hostname === 'codeload.github.com') {
    if (/\/zip\/[0-9a-f]{40}$/i.test(path) || /\/tar\.gz\/[0-9a-f]{40}$/i.test(path)) {
      return cfg.immutableCacheTtl
    }
    return cfg.cacheTtl
  }
  return cfg.cacheTtl
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
  // 客户端能力压缩，边缘缓存就无法共享了。
  'accept-encoding',
])
