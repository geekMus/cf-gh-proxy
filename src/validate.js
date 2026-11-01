'use strict'

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
export function validateGithubPath(u) {
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
export function validateRawPath(u) {
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
export function validateCodeloadPath(u) {
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
export function validateGistPath(u) {
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
export function validateSignedAssetPath(u) {
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
export function validateTargetPath(u) {
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
