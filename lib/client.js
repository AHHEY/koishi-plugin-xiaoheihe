'use strict'
const crypto = require('node:crypto')
const { ReadOnlyClient, numericId, postId } = require('./security')

const API_HOST = 'api.xiaoheihe.cn'
const ENDPOINTS = Object.freeze({
  qr: '/account/get_qrcode_url/', qrState: '/account/qr_state/', account: '/bbs/app/api/user/permission',
  feed: '/bbs/app/feeds', topics: '/bbs/app/api/topic/index/', topicFeed: '/bbs/app/topic/feeds',
  post: '/bbs/app/link/tree', game: '/game/web/get_game_detail/',
})
const HKEY_ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89'
function mapAlphabet(value, alphabet) { return [...String(value)].map(char => alphabet[char.charCodeAt(0) % alphabet.length]).join('') }
function xtime(value) { return value & 128 ? (255 & ((value << 1) ^ 27)) : value << 1 }
function mul3(value) { return xtime(value) ^ value }
function mul4(value) { return mul3(xtime(value)) }
function mul8(value) { return mul4(mul3(xtime(value))) }
function mul14(value) { return mul8(value) ^ mul4(value) ^ mul3(value) }
function mixTail(values) {
  const [a, b, c, d] = values
  return [mul14(a) ^ mul8(b) ^ mul4(c) ^ mul3(d), mul3(a) ^ mul14(b) ^ mul8(c) ^ mul4(d), mul4(a) ^ mul3(b) ^ mul14(c) ^ mul8(d), mul8(a) ^ mul4(b) ^ mul3(c) ^ mul14(d), ...values.slice(4)]
}
// Compatibility implementation of the MIT-licensed heybox-core request contract.
// MD5 is an upstream protocol field, not a local password or integrity decision.
function generateHkey(path, timestamp, nonce) {
  const normalized = '/' + String(path).split('/').filter(Boolean).join('/') + '/'
  const parts = [mapAlphabet(String(timestamp), HKEY_ALPHABET.slice(0, -2)), mapAlphabet(normalized, HKEY_ALPHABET), mapAlphabet(nonce, HKEY_ALPHABET)]
  const interleaved = Array.from({ length: Math.max(...parts.map(x => x.length)) }, (_, index) => parts.map(part => part[index] || '').join('')).join('').slice(0, 20)
  const digest = crypto.createHash('md5').update(interleaved).digest('hex')
  const suffix = String(mixTail([...digest.slice(-6)].map(x => x.charCodeAt(0))).reduce((a, b) => a + b, 0) % 100).padStart(2, '0')
  return mapAlphabet(digest.slice(0, 5), HKEY_ALPHABET.slice(0, -4)) + suffix
}
function tokenId(now = Date.now(), random = crypto.randomBytes) {
  const values = [String(Math.floor(now / 1000)), random(16).toString('hex'), random(16).toString('hex'), random(16).toString('hex')]
  const bytes = Buffer.concat(values.map(value => crypto.createHash('md5').update(value).digest()))
  return Buffer.concat([bytes, Buffer.from([0])]).toString('base64')
}
function cookieString(cookies) {
  return Object.entries(cookies || {}).filter(([key, value]) => /^[A-Za-z0-9_]+$/.test(key) && !/[;\r\n]/.test(String(value))).map(([key, value]) => `${key}=${value}`).join('; ')
}
function responseCookies(headers) {
  const list = headers?.getSetCookie?.() || (Array.isArray(headers?.['set-cookie']) ? headers['set-cookie'] : [headers?.['set-cookie'] || ''])
  const result = {}
  for (const line of list) {
    const match = /^\s*([A-Za-z0-9_]+)=([^;\r\n]*)/.exec(line)
    if (match) result[match[1]] = match[2]
  }
  return result
}
function createClient({ store, config = {}, request, now = () => Date.now() } = {}) {
  const deviceId = crypto.randomBytes(16).toString('hex')
  let anonymousCookies = {}
  const signer = (url, { credential = {} }) => {
    const params = { os_type: 'web', app: 'web', client_type: 'web', version: '999.0.4', web_version: '2.5', x_client_type: 'web', x_app: 'heybox_website', x_os_type: 'Windows', device_info: 'Chrome', _notip: 'true' }
    for (const [key, val] of Object.entries(params)) if (!url.searchParams.has(key)) url.searchParams.set(key, val)
    if (credential.uid && !url.searchParams.has('heybox_id')) url.searchParams.set('heybox_id', credential.uid)
    const timestamp = Math.floor(now() / 1000)
    const nonce = crypto.createHash('md5').update(`${timestamp}${crypto.randomBytes(16).toString('hex')}`).digest('hex').toUpperCase()
    url.searchParams.set('_time', timestamp)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('hkey', generateHkey(url.pathname, timestamp, nonce))
    url.searchParams.set('device_id', credential.deviceId || deviceId)
    return url.href
  }
  const http = new ReadOnlyClient({ hostnames: [API_HOST], credentials: () => ({ cookie: cookieString({ ...anonymousCookies, ...(store.load()?.cookies || {}) }), accessToken: store.load()?.accessToken, uid: store.load()?.uid, deviceId: store.load()?.deviceId || deviceId }), request, now, signer, timeout: config.timeoutMs || 15000, interval: config.intervalMs || 1000, maxAttempts: 2, extraHeaders: { Referer: 'https://www.xiaoheihe.cn/' } })
  return {
    async account() { return http.get(ENDPOINTS.account) },
    async feed(offset = 0) { return http.get(ENDPOINTS.feed, { app: 'heybox', pull: 0, offset: Math.max(0, Number(offset) || 0) }) },
    async topics() { return http.get(ENDPOINTS.topics, { type: 'list' }) },
    async topicFeed(topicId, offset = 0, limit = 10) { return http.get(ENDPOINTS.topicFeed, { topic_id: numericId(topicId, 'topic_id'), offset, limit: Math.min(30, Math.max(1, limit)), lastval: '', dw: 720 }) },
    async post(id, rootCommentId = '') { return http.get(ENDPOINTS.post, { link_id: postId(id, 'link_id'), root_comment_id: rootCommentId ? numericId(rootCommentId, 'root_comment_id') : undefined, h_src: '' }) },
    async game(gameId) { return http.get(ENDPOINTS.game, { appid: numericId(gameId, 'appid') }, { auth: false }) },
    async requestQr() {
      const payload = await http.get(ENDPOINTS.qr, {}, { auth: false })
      anonymousCookies = { ...anonymousCookies, ...responseCookies(payload.__headers) }
      return { payload, cookies: responseCookies(payload.__headers), deviceId }
    },
    async pollQr(params) {
      const payload = await http.get(ENDPOINTS.qrState, params, { auth: false })
      anonymousCookies = { ...anonymousCookies, ...responseCookies(payload.__headers) }
      return { payload, cookies: { ...anonymousCookies, ...responseCookies(payload.__headers) } }
    },
    dispose() { http.dispose() },
    _test: { http, signer },
  }
}
module.exports = { API_HOST, ENDPOINTS, createClient, generateHkey, tokenId, cookieString, responseCookies }
