'use strict'
// Fixed-origin, read-only clients. The agent-facing API must not accept arbitrary URLs.
const crypto = require('node:crypto')
const net = require('node:net')
const dns = require('node:dns').promises
const { setTimeout: timeout } = require('node:timers/promises')

const MAX_BODY = 1024 * 1024
const IP_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]
const blocked = new net.BlockList()
for (const [address, prefix] of IP_RANGES) blocked.addSubnet(address, prefix, 'ipv4')

class ReadError extends Error {
  constructor(code, message = code, cause) { super(message); this.name = 'ReadError'; this.code = code; if (cause) this.cause = cause }
}
function numericId(value, kind = 'id') {
  const id = String(value ?? '').trim()
  if (!/^[1-9]\d{0,31}$/.test(id)) throw new ReadError('invalid-id', `${kind} 必须是有效数字 ID`)
  return id
}
function postId(value, kind = 'link_id') {
  const id = String(value ?? '').trim()
  if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw new ReadError('invalid-post-id', `${kind} 必须是有效帖子 ID`)
  return id
}
function safePublicUrl(value, hostnames) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { throw new ReadError('invalid-url') }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || url.href.length > 2048 || net.isIP(host) || !hostnames.includes(host)) throw new ReadError('invalid-url')
  for (const [key, val] of url.searchParams) {
    if (/(?:^|_)(?:token|secret|session|password|signature|cookie|csrf)$/i.test(key)
      || /(?:api[_-]?key|access_token|refresh_token|auth_token|private_key)/i.test(key)
      || /https?:\/\//i.test(val)) throw new ReadError('sensitive-url')
  }
  return url.href
}
function publicAddress(address, family) {
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family !== 6) return false
  const ip = address.toLowerCase().split('%')[0]
  if (/^::ffff:(\d+\.){3}\d+$/.test(ip)) return publicAddress(ip.slice(7), 4)
  return !(ip === '::' || ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd')
    || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')
    || ip.startsWith('ff') || /^2001:db8:/i.test(ip) || /^2001:10:/i.test(ip))
}
function redact(value, secrets = []) {
  let result = String(value ?? '')
  for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) result = result.split(secret).join('[已隐藏]')
  return result.replace(/(?:Bearer\s+)[A-Za-z0-9._-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/(?:Cookie|Authorization|pkey|token|session|api[_-]?key)\s*[:=]\s*[^;\s]+/gi, '$1=[已隐藏]')
}
function cleanText(value, limit = 12000) {
  return String(value ?? '').normalize('NFC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/g, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#(?:0*39|x0*27);|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit)
}
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ReadError('aborted'))
    const done = () => { signal?.removeEventListener('abort', cancel); resolve() }
    const cancel = () => { clearTimeout(timer); reject(new ReadError('aborted')) }
    const timer = setTimeout(done, ms)
    timer.unref?.()
    signal?.addEventListener('abort', cancel, { once: true })
  })
}
class ReadOnlyClient {
  constructor({ hostnames, credentials = () => ({}), request, timeout = 15000, interval = 1000, maxAttempts = 2, now = () => Date.now(), signer, extraHeaders = {}, lookup = host => dns.lookup(host, { all: true, verbatim: true }) } = {}) {
    this.hostnames = hostnames
    this.credentials = credentials
    this.request = request || require('node:https').request
    this.timeout = timeout; this.interval = interval; this.maxAttempts = maxAttempts; this.now = now
    this.signer = signer || (url => url)
    this.extraHeaders = extraHeaders
    this.lookup = lookup
    this.lastRequestAt = 0; this.tail = Promise.resolve(); this.controller = new AbortController()
    this.cooldownUntil = 0
  }
  async get(path, params = {}, { auth = true, signal, host, extraHeaders = {} } = {}) {
    if (this.controller.signal.aborted) throw new ReadError('disposed')
    if (this.now() < this.cooldownUntil) throw new ReadError('rate-limited', '读取冷却中')
    const task = this.tail.then(() => this._get(path, params, { auth, signal, host, extraHeaders }), () => this._get(path, params, { auth, signal, host, extraHeaders }))
    this.tail = task.then(() => {}, () => {})
    return task
  }
  async _get(path, params, { auth, signal, host, extraHeaders }) {
    if (!/^\/[A-Za-z0-9_./-]*$/.test(path) || path.includes('..') || path.includes('//')) throw new ReadError('invalid-endpoint')
    const targetHost = host || this.hostnames[0]
    if (!this.hostnames.includes(targetHost)) throw new ReadError('invalid-host')
    const credential = this.credentials() || {}
    if (auth && !credential.cookie && !credential.accessToken) throw new ReadError('login-required', '尚未登录')
    let url = new URL(path, `https://${targetHost}`)
    for (const [key, val] of Object.entries(params)) if (val !== undefined && val !== null) url.searchParams.set(key, String(val))
    url = new URL(this.signer(url, { auth, credential }))
    const checkedUrl = safePublicUrl(url.href, [targetHost])
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    let addresses
    try {
      const dnsResult = await Promise.race([Promise.resolve(this.lookup(new URL(checkedUrl).hostname)), delay(5000, combined).then(() => { throw new ReadError('dns-timeout') })])
      addresses = Array.isArray(dnsResult) ? (dnsResult.length === 2 && typeof dnsResult[0] === 'string' && typeof dnsResult[1] === 'number' ? [{ address: dnsResult[0], family: dnsResult[1] }] : dnsResult) : [dnsResult]
    } catch { throw new ReadError('dns-failed') }
    if (!addresses.length || addresses.some(item => !publicAddress(item.address, item.family))) throw new ReadError('unsafe-address')
    const address = addresses[0].address, family = addresses[0].family || net.isIP(address)
    if (!address || !family) throw new ReadError('dns-failed')
    const headers = { Accept: 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Koishi-Xiaoheihe-Reader/0.1.0', ...this.extraHeaders, ...extraHeaders }
    if (credential.cookie) headers.Cookie = credential.cookie
    if (credential.accessToken) headers.Authorization = `Bearer ${credential.accessToken}`
    let lastError
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const wait = Math.max(0, this.lastRequestAt + this.interval - this.now())
      if (wait) await delay(wait, combined)
      this.lastRequestAt = this.now()
      try {
        const result = await this._requestOnce(new URL(checkedUrl), address, family, headers, combined)
        if ([401, 403].includes(result.status)) throw new ReadError(result.status === 401 ? 'login-expired' : 'forbidden', `HTTP ${result.status}`)
        if (result.status === 429) { this.cooldownUntil = this.now() + 60000; throw new ReadError('rate-limited') }
        if (result.status >= 500) throw new ReadError('server-error')
        if (result.status !== 200) throw new ReadError('http-error', `HTTP ${result.status}`)
        if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:;|$)/i.test(result.type)) throw new ReadError('response-shape')
        const payload = JSON.parse(result.body)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ReadError('response-shape')
        const marker = String(payload.status ?? payload.stat ?? '').toLowerCase()
        if (auth && marker && !['ok', 'success', '200'].includes(marker)) {
          const msg = String(payload.msg ?? payload.message ?? payload.error ?? '')
          if (/relogin|not login|unauthorized|重新登录|请登录|未登录|登录失效/i.test(marker + ' ' + msg)) throw new ReadError('login-expired')
          throw new ReadError('upstream-rejected')
        }
        return { ...payload, __headers: result.headers }
      } catch (error) {
        lastError = error
        if (error instanceof ReadError && !['network', 'timeout', 'server-error'].includes(error.code)) throw error
        if (combined.aborted) throw new ReadError('aborted')
        if (attempt + 1 < this.maxAttempts) await delay(300 * (attempt + 1), combined)
      }
    }
    throw lastError instanceof ReadError ? lastError : new ReadError('network')
  }
  _requestOnce(url, address, family, headers, signal) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value) }
      const timeout = AbortSignal.timeout(this.timeout)
      const combined = AbortSignal.any([signal, timeout])
      let req
      try {
        req = this.request(url, { method: 'GET', agent: false, signal: combined, headers,
          lookup(hostname, options, callback) {
            if (hostname !== url.hostname) return callback(new Error('host-mismatch'))
            if (options?.all) return callback(null, [{ address, family }])
            callback(null, address, family)
          },
        }, res => {
          if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return finish(new ReadError('redirect-blocked')) }
          const type = String(res.headers['content-type'] || '')
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.resume(); return finish(new ReadError('unsupported-encoding')) }
          const chunks = []; let size = 0
          res.on('data', chunk => {
            size += chunk.length
            if (size > MAX_BODY) { req.destroy(); finish(new ReadError('response-too-large')) }
            else chunks.push(Buffer.from(chunk))
          })
          res.on('end', () => finish(null, { status: res.statusCode, type, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }))
          res.on('error', error => finish(new ReadError('network', error?.code || 'network', error)))
          res.on('aborted', () => finish(new ReadError('network')))
        })
      } catch (error) {
        finish(new ReadError('network', error?.code || 'network', error))
        return
      }
      timer = setTimeout(() => { req.destroy(); finish(new ReadError('timeout')) }, this.timeout)
      timer.unref?.()
      req.on('error', error => finish(combined.aborted ? new ReadError('timeout') : error instanceof ReadError ? error : new ReadError('network', error.code || 'network', error)))
      req.end()
    })
  }
  dispose() { this.controller.abort() }
}
function fingerprint(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex') }
module.exports = { ReadOnlyClient, ReadError, numericId, postId, safePublicUrl, publicAddress, redact, cleanText, fingerprint, delay, MAX_BODY }
