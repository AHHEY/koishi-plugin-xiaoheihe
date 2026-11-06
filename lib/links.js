'use strict'
const { ReadError, numericId, postId, safePublicUrl } = require('./security')

const HOSTS = ['www.xiaoheihe.cn', 'xiaoheihe.cn', 'api.xiaoheihe.cn']
const PATHS = [
  /^\/bbs\/app\/link\/([A-Za-z0-9]{1,32})\/?$/,
  /^\/app\/bbs\/link\/([A-Za-z0-9]{1,32})\/?$/,
  /^\/link\/([A-Za-z0-9]{1,32})\/?$/,
  /^\/post\/([A-Za-z0-9]{1,32})\/?$/,
  /^\/bbs\/(?:detail|link)\/([A-Za-z0-9]{1,32})\/?$/,
  /^\/community\/[0-9]+\/list\/([A-Za-z0-9]{1,32})\/?$/,
]
function findPosts(input) {
  const value = String(input || '').normalize('NFC').replace(/\\+\//g, '/').replace(/&amp;/g, '&')
  const result = [], seen = new Set()
  const add = id => { try { const value = postId(id, 'link_id'); if (!seen.has(value)) { seen.add(value); result.push(value) } } catch {} }
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'）)\]]+/gi)) {
    let url
    try { url = new URL(match[0]) } catch { continue }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !HOSTS.includes(url.hostname.toLowerCase())) continue
    for (const pattern of PATHS) { const found = pattern.exec(url.pathname); if (found) add(found[1]) }
    // App share links use link_id in a query string; some are hexadecimal.
    if (/^\/(?:v3\/)?bbs\/app\/api\/web\/share\/?$/i.test(url.pathname) || /^\/bbs\/app\/link\/tree\/?$/.test(url.pathname)) {
      add(url.searchParams.get('link_id') || url.searchParams.get('linkid') || url.searchParams.get('post_id'))
    }
    if (/^\/(?:bbs\/)?(?:link|post|detail)\/?$/.test(url.pathname)) add(url.searchParams.get('link_id') || url.searchParams.get('linkid') || url.searchParams.get('post_id'))
  }
  if (!result.length && /^\s*(?:#|帖子\s*)?([1-9]\d{0,31}|[A-Fa-f0-9]{6,32})\s*$/.test(value)) {
    const id = /^\s*(?:#|帖子\s*)?([1-9]\d{0,31}|[A-Fa-f0-9]{6,32})\s*$/.exec(value)[1]
    add(id)
  }
  return result.slice(0, 2)
}
function parseGameReference(value) {
  const input = String(value || '').normalize('NFC').trim()
  const idMatch = /(?:^|\b)(?:app(?:id)?[:#\s]*)?([1-9]\d{0,9})\s*$/i.exec(input)
  const steam = /https:\/\/store\.steampowered\.com\/app\/([1-9]\d{0,9})(?:\/[^\s]*)?/i.exec(input)
  if (steam) return { gameId: steam[1], sourceUrl: safePublicUrl(steam[0], ['store.steampowered.com']) }
  if (idMatch && /^(?:app|appid|#|\d)/i.test(input)) return { gameId: numericId(idMatch[1], 'appid') }
  if (!input || [...input].length > 80 || /https?:\/\/|[\r\n\0]|密码|私钥|token\s*[:=]/i.test(input)) throw new ReadError('invalid-game-query')
  return { query: input }
}
module.exports = { HOSTS, findPosts, parseGameReference }
