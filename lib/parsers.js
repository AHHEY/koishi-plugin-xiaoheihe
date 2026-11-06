'use strict'
const { ReadError, numericId, postId, cleanText } = require('./security')

function object(value, message = '响应结构已变化') { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReadError('response-shape', message); return value }
function data(payload) { return object(payload?.result ?? payload?.data ?? payload) }
function first(source, keys, fallback = '') { for (const key of keys) if (source?.[key] !== undefined && source?.[key] !== null && source[key] !== '') return source[key]; return fallback }
function id(source, keys) { const value = first(source, keys); return value === '' || value === undefined ? '' : String(value) }
function timestamp(value) { const number = Number(value); if (!Number.isFinite(number) || number <= 0) return null; return new Date(number > 1e10 ? number : number * 1000).toISOString() }
function text(value, limit) { return cleanText(value, limit) }
function imageUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim().replace(/&amp;/gi, '&'))
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
      || parsed.hash || parsed.href.length > 2048) return ''
    return parsed.href
  } catch { return '' }
}
function addImages(result, seen, values, limit = 12) {
  for (const value of values) {
    const candidate = typeof value === 'string' ? value : first(value, ['url', 'src', 'original', 'image_url', 'large_url'])
    const url = imageUrl(candidate)
    if (url && !seen.has(url) && result.length < limit) { seen.add(url); result.push(url) }
  }
}
function embeddedImages(value) {
  const source = String(value || '')
  const values = []
  for (const match of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) values.push(match[1] || match[2] || match[3])
  for (const match of source.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)) values.push(match[1])
  return values
}
function images(post) {
  const result = [], seen = new Set()
  for (const field of ['imgs', 'thumbs', 'images', 'image_urls']) addImages(result, seen, Array.isArray(post?.[field]) ? post[field] : [])
  return result
}
function topics(post) {
  const result = []
  for (const field of ['topics', 'hashtags', 'content_tags', 'list_content_tags', 'link_tag']) {
    const list = Array.isArray(post?.[field]) ? post[field] : post?.[field] ? [post[field]] : []
    for (const value of list) { const name = text(typeof value === 'object' ? first(value, ['name', 'title', 'text', 'tag']) : value, 60); if (name) result.push(name) }
  }
  return [...new Set(result)].slice(0, 12)
}
function parseFeed(payload) {
  const body = data(payload)
  if (!Array.isArray(body) && !['links', 'items', 'list'].some(key => Object.hasOwn(body, key))) throw new ReadError('response-shape', '帖子列表字段已变化')
  const list = Array.isArray(body) ? body : first(body, ['links', 'items', 'list'], [])
  if (!Array.isArray(list)) throw new ReadError('response-shape', '帖子列表字段已变化')
  return list.filter(x => x && typeof x === 'object' && !Array.isArray(x)).map(raw => {
    const postId = id(raw, ['linkid', 'link_id', 'post_id', 'id'])
    if (!/^[1-9]\d{0,31}$/.test(postId)) return null
    const author = raw.user || raw.author || {}
    return { postId, title: text(raw.title || raw.subject, 200), excerpt: text(first(raw, ['description', 'summary', 'content', 'text']), 500),
      createdAt: timestamp(first(raw, ['create_at', 'created_at', 'time', 'timestamp'])), author: text(first(author, ['username', 'nickname', 'name']), 80),
      authorId: id(author, ['userid', 'uid', 'heybox_id', 'heyboxid', 'user_id', 'id']), topics: topics(raw), imageCount: images(raw).length,
      comments: Number(raw.comment_num) || 0, likes: Number(raw.up) || 0, contentType: text(raw.content_type, 30) }
  }).filter(Boolean)
}
function richContent(value) {
  const urls = [], seen = new Set()
  let decoded = value
  if (typeof value === 'string') {
    addImages(urls, seen, embeddedImages(value))
    try { decoded = JSON.parse(value) } catch { return { body: text(value, 12000), imageCount: urls.length, imageUrls: urls } }
  }
  if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) decoded = first(decoded, ['items', 'content', 'list'], decoded)
  if (!Array.isArray(decoded)) return { body: text(value, 12000), imageCount: urls.length, imageUrls: urls }
  const parts = []
  for (const part of decoded) {
    if (!part || typeof part !== 'object') { if (part !== null) parts.push(String(part)); continue }
    const kind = String(first(part, ['type', 'kind'])).toLowerCase()
    const content = first(part, ['text', 'content', 'html'])
    if (content && (['', 'text', 'html'].includes(kind) || !first(part, ['url', 'src', 'image_url']))) parts.push(String(content))
    if (!['text', 'html'].includes(kind)) {
      addImages(urls, seen, [first(part, ['url', 'src', 'image_url', 'large_url', 'original'])])
      if (kind === 'image' && /^https:\/\//i.test(String(content || ''))) addImages(urls, seen, [content])
    }
  }
  addImages(urls, seen, embeddedImages(parts.join('\n')))
  return { body: text(parts.join('\n'), 12000), imageCount: urls.length, imageUrls: urls }
}
function parseComments(raw, limit = 20) {
  if (!Array.isArray(raw)) return []
  const result = []
  const visit = (items, depth = 0) => {
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      const commentId = id(item, ['commentid', 'comment_id', 'id'])
      const content = text(first(item, ['content', 'text', 'comment', 'message']), 600)
      if (commentId && content) {
        const author = item.user || item.author || {}
        result.push({ commentId, parentId: id(item, ['parent_id', 'reply_id', 'root_comment_id']), depth,
          author: text(first(author, ['username', 'nickname', 'name']), 80), authorId: id(author, ['userid', 'uid', 'heybox_id', 'heyboxid', 'user_id']),
          content, createdAt: timestamp(first(item, ['create_at', 'created_at', 'time', 'timestamp'])), likes: Number(item.like_num ?? item.likes ?? item.up) || 0 })
      }
      if (result.length >= limit) return
      for (const field of ['children', 'comments', 'replies', 'comment_list']) if (Array.isArray(item[field])) visit(item[field], depth + 1)
      if (result.length >= limit) return
    }
  }
  visit(raw)
  return result
}
function parsePost(payload, requestedId, commentLimit = 20) {
  const expected = postId(requestedId, 'link_id')
  const body = data(payload)
  const post = object(body.post || body.link || body, '缺少帖子正文')
  const actualId = id(post, ['linkid', 'link_id', 'post_id', 'id'])
  const shareAlias = !!actualId && /^[1-9]\d{0,31}$/.test(actualId) && /^[A-Fa-f0-9]{6,32}$/.test(expected)
  if (actualId && actualId !== expected && !shareAlias) throw new ReadError('post-mismatch', '返回的不是目标帖子')
  const canonicalId = actualId || expected
  const author = post.author || post.user || {}
  const rich = richContent(first(post, ['content', 'text', 'description']))
  const rawComments = first(body, ['comments', 'comment_list', 'children'], [])
  const comments = parseComments(rawComments, commentLimit)
  const imageUrls = []
  const seenImages = new Set()
  addImages(imageUrls, seenImages, images(post))
  addImages(imageUrls, seenImages, rich.imageUrls)
  const imageCount = imageUrls.length
  const title = text(post.title || post.subject, 200)
  const authorName = text(first(author, ['nickname', 'username', 'name']), 80)
  if (!title && !rich.body && !imageCount) throw new ReadError('response-shape', '帖子缺少标题、正文与可用图片')
  return { postId: expected, canonicalId, title, body: rich.body,
    author: authorName, authorId: id(author, ['uid', 'heybox_id', 'heyboxid', 'user_id', 'userid', 'id']),
    createdAt: timestamp(first(post, ['created_at', 'create_at', 'timestamp', 'time'])), imageCount,
    imageUrls: imageUrls.slice(0, 4), comments,
    commentStatus: Array.isArray(rawComments) ? comments.length ? 'sampled' : 'empty' : 'unavailable' }
}
function flattenTopics(value) {
  const result = [], seen = new Set()
  const visit = (node, group = '') => {
    if (Array.isArray(node)) { for (const child of node) visit(child, group); return }
    if (!node || typeof node !== 'object') return
    const topicId = id(node, ['topic_id', 'id']), name = text(first(node, ['name', 'title', 'topic_name']), 100)
    if (/^[1-9]\d{0,31}$/.test(topicId) && name && !seen.has(topicId)) { seen.add(topicId); result.push({ topicId, name, group }) }
    for (const [key, child] of Object.entries(node)) if (!['topic_id', 'id', 'name', 'title', 'topic_name'].includes(key) && child && typeof child === 'object') visit(child, group || name)
  }
  visit(value)
  return result.slice(0, 500)
}
function parseTopics(payload) { const body = data(payload); return flattenTopics(body.topics_list ?? payload.topics_list ?? body) }
function parseQr(payload) {
  const body = data(payload), content = String(first(body, ['qrcode', 'qr_url', 'url', 'qr_content']))
  let url
  try { url = new URL(content) } catch { throw new ReadError('response-shape', '二维码内容无效') }
  if (url.protocol !== 'https:' || !/(^|\.)xiaoheihe\.cn$/.test(url.hostname) || url.username || url.password) throw new ReadError('response-shape', '二维码来源不受信')
  const expires = Number(first(body, ['expires_in', 'ttl', 'expire'], 180))
  return { content: url.href, poll: Object.fromEntries(url.searchParams), expiresAt: Date.now() + Math.max(10, Math.min(Number.isFinite(expires) ? expires : 180, 600)) * 1000 }
}
function parseLogin(payload) {
  const body = data(payload), marker = String(first(body, ['error', 'err'])).toLowerCase(), state = String(first(body, ['state', 'status', 'qr_state'])).toLowerCase()
  const message = String(first(body, ['message', 'msg', 'error_msg', 'err_msg']))
  if (['2', 'success', 'confirmed'].includes(state) || ['ok', 'success', 'confirmed'].includes(marker)) return 'success'
  if (/expired|timeout|过期|失效|超时/.test(state + message)) return 'expired'
  if (['1', 'scanned', 'confirm'].includes(state) || /scanned|confirm|已扫码|待确认/.test(state + message)) return 'scanned'
  return 'waiting'
}
function parseCredentials(payload, headers, deviceId) {
  const body = data(payload), containers = [body, body.user, body.account, body.profile, body.account_detail].filter(x => x && typeof x === 'object')
  const cookies = {}
  for (const [key, value] of Object.entries(headers || {})) if (/^[A-Za-z0-9_]+$/.test(key) && !/[\r\n;]/.test(String(value))) cookies[key] = String(value)
  for (const container of containers) {
    const pairs = { pkey: ['pkey', 'user_pkey', 'key'], heybox_id: ['heybox_id', 'user_heybox_id', 'heyboxid', 'user_id', 'userid'], x_xhh_tokenid: ['x_xhh_tokenid'] }
    for (const [target, keys] of Object.entries(pairs)) { const val = first(container, keys); if (val && !cookies[target]) cookies[target] = String(val) }
  }
  const uid = containers.map(x => id(x, ['uid', 'heybox_id', 'user_heybox_id', 'heyboxid', 'user_id', 'userid', 'id'])).find(Boolean) || cookies.heybox_id || cookies.user_heybox_id
  const accessToken = String(first(body, ['access_token', 'token']))
  const refreshToken = String(first(body, ['refresh_token']))
  if (!/^[1-9]\d{0,31}$/.test(uid || '')) throw new ReadError('response-shape', '登录响应缺少有效 UID')
  if (!Object.keys(cookies).some(key => !['heybox_id', 'user_heybox_id', 'heyboxid', 'uid', 'userid', 'user_id'].includes(key.toLowerCase())) && !accessToken && !refreshToken) throw new ReadError('response-shape', '登录响应缺少凭据')
  if (!cookies.x_xhh_tokenid) cookies.x_xhh_tokenid = require('./client').tokenId()
  return { version: 1, uid, nickname: text(first(body, ['nickname', 'username', 'name']), 80), cookies, accessToken, refreshToken, deviceId, loggedInAt: new Date().toISOString() }
}
module.exports = { parseFeed, parsePost, parseComments, parseTopics, parseQr, parseLogin, parseCredentials, richContent, timestamp, text }
