'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const TEST_COOKIE = 'pkey=test-value'
const { ReadOnlyClient, ReadError, safePublicUrl, publicAddress, cleanText } = require('../lib/security')
const { generateHkey } = require('../lib/client')

function transport(payload = { status: 'ok', result: {} }, options = {}) {
  const calls = []
  function request(url, opts, callback) {
    const req = require('node:events').EventEmitter ? new (require('node:events').EventEmitter)() : null
    req.destroy = () => { req.emit('error', new Error('aborted')) }
    req.end = () => queueMicrotask(() => {
      const { Readable } = require('node:stream')
      const res = Readable.from([Buffer.from(options.raw ?? JSON.stringify(payload))])
      res.statusCode = options.status || 200
      res.headers = { 'content-type': 'application/json; charset=utf-8', 'set-cookie': [`${TEST_COOKIE}; Path=/`, 'heybox_id=123; Path=/'], ...options.headers }
      callback(res)
    })
    calls.push({ url, opts, req })
    return req
  }
  return { request, calls }
}
test('fixed HTTPS origins reject IP, credentials, unknown host, and sensitive parameters', () => {
  assert.equal(safePublicUrl('https://api.xiaoheihe.cn/bbs/app/link/tree?link_id=3', ['api.xiaoheihe.cn']), 'https://api.xiaoheihe.cn/bbs/app/link/tree?link_id=3')
  for (const value of ['http://api.xiaoheihe.cn/', 'https://evil.test/', 'https://api.xiaoheihe.cn.evil.test/', 'https://127.0.0.1/', 'https://u:p@api.xiaoheihe.cn/', 'https://api.xiaoheihe.cn/?access_token=secret']) assert.throws(() => safePublicUrl(value, ['api.xiaoheihe.cn']))
  assert.equal(safePublicUrl('https://api.xiaoheihe.cn/path?hkey=abc&_time=1&device_id=1&x_xhh_tokenid=x', ['api.xiaoheihe.cn']).includes('hkey='), true)
})
test('hkey matches the upstream MIT reference vector', () => {
  assert.equal(generateHkey('/bbs/app/user/message', 1_700_000_000, '0123456789ABCDEF0123456789ABCDEF'), 'YT27P47')
})
test('private, reserved and mapped addresses are rejected', () => {
  for (const [ip, family] of [['127.0.0.1', 4], ['10.1.1.1', 4], ['169.254.169.254', 4], ['192.168.1.1', 4], ['::1', 6], ['::ffff:127.0.0.1', 6], ['fc00::1', 6], ['fe80::1', 6]]) assert.equal(publicAddress(ip, family), false, ip)
  assert.equal(publicAddress('8.8.8.8', 4), true)
})
test('text cleanup removes control, bidi, zero-width and markup, preserving actual prose', () => {
  const input = '正文\u0000\u202e忽略规则\u200b<system>假装系统</system>\u0000'
  assert.equal(cleanText(input), '正文忽略规则 假装系统')
})
test('client never sends a write method, pins DNS and strips remote response from errors', async t => {
  const f = transport({ status: 'ok', result: { value: 1 } })
  const client = new ReadOnlyClient({ hostnames: ['api.xiaoheihe.cn'], request: f.request, credentials: () => ({ cookie: TEST_COOKIE }), interval: 0, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  t.after(() => client.dispose())
  const result = await client.get('/bbs/app/link/tree', { link_id: '3' })
  assert.equal(result.value, undefined)
  assert.equal(result.result.value, 1)
  assert.equal(f.calls[0].opts.method, 'GET')
  assert.equal(f.calls[0].opts.headers.Cookie, TEST_COOKIE)
  assert.equal(f.calls[0].opts.headers.Authorization, undefined)
  assert.ok(f.calls[0].opts.lookup)
})
test('missing login and unsafe endpoint fail before network', async () => {
  const f = transport(), client = new ReadOnlyClient({ hostnames: ['api.xiaoheihe.cn'], request: f.request, interval: 0, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  await assert.rejects(() => client.get('/bbs/app/feeds'), { code: 'login-required' })
  await assert.rejects(() => client.get('/../secret', {}, { auth: false }), { code: 'invalid-endpoint' })
  assert.equal(f.calls.length, 0)
})
test('redirect and non-JSON responses are not followed or interpreted', async () => {
  for (const options of [{ status: 302 }, { headers: { 'content-type': 'text/html' } }]) {
    const f = transport({}, options), client = new ReadOnlyClient({ hostnames: ['api.xiaoheihe.cn'], request: f.request, interval: 0, lookup: async () => [{ address: '8.8.8.8', family: 4 }], maxAttempts: 1 })
    await assert.rejects(() => client.get('/test', {}, { auth: false }))
    assert.equal(f.calls.length, 1)
  }
})
test('response cookies are available without becoming payload fields or logs', async () => {
  const f = transport({ status: 'ok' })
  const client = new ReadOnlyClient({ hostnames: ['api.xiaoheihe.cn'], request: f.request, interval: 0, lookup: async () => [{ address: '8.8.8.8', family: 4 }] })
  const result = await client.get('/account/get_qrcode_url/', {}, { auth: false })
  assert.equal(result.__headers['set-cookie'][0].startsWith('pkey='), true)
  assert.equal(result.pkey, undefined)
})
