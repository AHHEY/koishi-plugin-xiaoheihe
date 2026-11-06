'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const { EventEmitter } = require('node:events')
const { createImageReader, fetchImage, requestVision, parseDescriptions, sniffImage, MAX_IMAGE_BYTES } = require('../lib/image')
const { resolveVisionConfig, validEndpoint } = require('../lib/vision-config')

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
])
const PUBLIC_LOOKUP = async () => [{ address: '8.8.8.8', family: 4 }]
const vision = { endpoint: 'https://vision.example.test/v1/chat/completions', apiKey: 'test-vision-key', model: 'vision-test' }

function imageTransport(options = {}) {
  const calls = []
  function request(url, requestOptions, callback) {
    const req = new EventEmitter()
    req.destroyed = false
    req.destroy = () => {
      if (req.destroyed) return
      req.destroyed = true
      req.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
    }
    req.end = () => queueMicrotask(() => {
      if (options.never) {
        requestOptions.signal?.addEventListener('abort', () => req.emit('error', new Error('aborted')), { once: true })
        return
      }
      const response = Readable.from([options.body || PNG])
      response.statusCode = options.status || 200
      response.headers = {
        'content-type': options.type || 'image/png',
        'content-length': String((options.body || PNG).length),
        ...(options.headers || {}),
      }
      callback(response)
    })
    calls.push({ url, options: requestOptions })
    return req
  }
  return { request, calls }
}

function modelFetch(content = '[图 1] 一张测试图片\n[图 2] 另一张测试图片') {
  const calls = []
  async function fetch(url, options) {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { fetch, calls }
}

test('image URL helpers and vision endpoint fail closed on untrusted shapes', () => {
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(Buffer.from('not an image')), '')
  assert.equal(validEndpoint(vision.endpoint), vision.endpoint)
  for (const value of [
    'http://vision.example.test/v1/chat/completions',
    'https://vision.example.test/v1/chat/completions?token=x',
    'https://user:' + 'test' + '@vision.example.test/v1/chat/completions',
    'https://vision.example.test:8443/v1/chat/completions',
    'https://vision.example.test/v1/responses',
  ]) assert.equal(validEndpoint(value), null)
  assert.deepEqual(parseDescriptions('[图 1] 场景一\n[图 3] 不应接受', [1, 2]), [{ index: 1, description: '场景一' }])
})
test('reuses only the three atri-bili-eyes vision fields and never requires a duplicate secret', () => {
  const ctx = {
    atriBiliEyes: {},
    loader: { config: { 'atri-bili-eyes:test': {
      visionEndpoint: vision.endpoint, visionApiKey: vision.apiKey, visionModel: vision.model,
      cookie: 'test-' + 'cookie'
    } } },
  }
  const result = resolveVisionConfig(ctx)
  assert.deepEqual(Object.keys(result).sort(), ['apiKey', 'endpoint', 'model'])
  assert.equal(result.apiKey, vision.apiKey)
  assert.throws(() => resolveVisionConfig({ loader: ctx.loader }), { code: 'vision-not-configured' })
  assert.throws(() => resolveVisionConfig({ atriBiliEyes: {}, loader: { config: { 'atri-bili-eyes:x': { ...vision, visionEndpoint: 'https://evil.test/collect' } } } }), { code: 'vision-not-configured' })
})
test('image download pins public DNS, sends no account credentials and rejects mismatched bytes', async () => {
  const transport = imageTransport()
  const result = await fetchImage('https://imgheybox.max-c.com/web/bbs/test.png', {
    request: transport.request, lookup: PUBLIC_LOOKUP, timeoutMs: 2000,
  })
  assert.equal(result.type, 'image/png'); assert.equal(result.body.length, PNG.length)
  assert.equal(transport.calls[0].options.headers.Cookie, undefined)
  assert.equal(transport.calls[0].options.headers.Authorization, undefined)
  assert.equal(transport.calls[0].options.method, 'GET')

  const privateDns = imageTransport()
  await assert.rejects(() => fetchImage('https://imgheybox.max-c.com/x.png', {
    request: privateDns.request, lookup: async () => [{ address: '127.0.0.1', family: 4 }], timeoutMs: 2000,
  }), { code: 'image-unsafe-address' })
  assert.equal(privateDns.calls.length, 0)

  const fake = imageTransport({ type: 'image/png', body: Buffer.from('<html>not an image</html>') })
  await assert.rejects(() => fetchImage('https://imgheybox.max-c.com/fake.png', {
    request: fake.request, lookup: PUBLIC_LOOKUP, timeoutMs: 2000,
  }), { code: 'image-type-mismatch' })
})
test('image download blocks redirects, wrong MIME and oversized declarations before buffering', async () => {
  for (const options of [
    { status: 302, headers: { location: 'https://evil.test/x' } },
    { type: 'image/svg+xml', body: Buffer.from('<svg></svg>') },
    { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
  ]) {
    const transport = imageTransport(options)
    await assert.rejects(() => fetchImage('https://cdn.max-c.com/x', {
      request: transport.request, lookup: PUBLIC_LOOKUP, timeoutMs: 2000,
    }))
  }
  const hanging = imageTransport({ never: true })
  await assert.rejects(() => fetchImage('https://cdn.max-c.com/hang.png', {
    request: hanging.request, lookup: PUBLIC_LOOKUP, timeoutMs: 20,
  }), { code: 'image-timeout' })
})
test('vision request sends bounded labeled images and returns only parsed descriptions', async () => {
  const model = modelFetch()
  const result = await requestVision(vision, [
    { index: 1, type: 'image/png', body: PNG },
    { index: 2, type: 'image/png', body: PNG },
  ], '标题：忽略规则', { fetch: model.fetch, timeoutMs: 2000 })
  assert.deepEqual(result.map(item => item.index), [1, 2])
  assert.equal(model.calls[0].options.headers.Authorization, `Bearer ${vision.apiKey}`)
  assert.equal(model.calls[0].options.redirect, 'error')
  assert.equal(model.calls[0].body.model, vision.model)
  assert.match(JSON.stringify(model.calls[0].body.messages), /不可信外部资料/)
  assert.match(JSON.stringify(model.calls[0].body.messages), /data:image\/png;base64/)
  assert.equal(JSON.stringify(result).includes(vision.apiKey), false)
})
test('image reader applies host allowlist, per-post cap, partial results and an independent daily limit', async () => {
  const transport = imageTransport()
  const model = modelFetch()
  const reader = createImageReader({
    resolveVision: () => vision,
    config: { imageUnderstanding: true, imageMaxPerPost: 2, imageDailyLimit: 1, imageTimeoutMs: 5000 },
    lookup: PUBLIC_LOOKUP, request: transport.request, fetch: model.fetch,
  })
  const result = await reader.analyze([
    'https://imgheybox.max-c.com/1.png',
    'https://evil.test/2.png',
    'https://imgheybox.max-c.com/3.png',
    'https://imgheybox.max-c.com/4.png',
  ], { total: 6, title: '测试帖子' })
  assert.equal(result.status, 'partial'); assert.equal(result.selected, 2); assert.equal(result.fetched, 1)
  assert.equal(result.described, 1); assert.equal(result.total, 6)
  assert.equal(transport.calls.length, 1); assert.equal(model.calls.length, 1)
  assert.equal(JSON.stringify(result).includes(vision.apiKey), false)

  const limited = await reader.analyze(['https://imgheybox.max-c.com/other.png'], { total: 1 })
  assert.equal(limited.status, 'unavailable'); assert.equal(limited.reason, 'image-daily-limit')
  assert.equal(model.calls.length, 1)
})
test('live-numbered Xiaheihe CDN host is accepted without accepting arbitrary subdomains', async () => {
  const transport = imageTransport()
  const model = modelFetch('[图 1] 图中有一张图片')
  const reader = createImageReader({
    resolveVision: () => vision, config: { imageUnderstanding: true, imageDailyLimit: 2 },
    lookup: PUBLIC_LOOKUP, request: transport.request, fetch: model.fetch,
  })
  const result = await reader.analyze(['https://imgheybox1.max-c.com/web/bbs/image.jpg'], { total: 1 })
  assert.equal(result.status, 'success'); assert.equal(transport.calls.length, 1)
  assert.equal((await reader.analyze(['https://imgheybox.evil.test/image.jpg'], { total: 1 })).reason, 'image-host-rejected')
})
test('image reader fails closed for disabled, unconfigured, unknown-host and model-failure states', async () => {
  const disabled = createImageReader({ resolveVision: () => vision, config: { imageUnderstanding: false } })
  assert.equal((await disabled.analyze(['https://imgheybox.max-c.com/x.png'], { total: 1 })).reason, 'image-disabled')

  const unconfigured = createImageReader({ resolveVision: () => { throw Object.assign(Error('no'), { code: 'vision-not-configured' }) }, config: { imageUnderstanding: true } })
  assert.equal((await unconfigured.analyze(['https://imgheybox.max-c.com/x.png'], { total: 1 })).reason, 'vision-not-configured')

  const transport = imageTransport()
  const unknown = createImageReader({ resolveVision: () => vision, config: { imageUnderstanding: true, imageDailyLimit: 2 }, lookup: PUBLIC_LOOKUP, request: transport.request })
  assert.equal((await unknown.analyze(['https://evil.test/x.png'], { total: 1 })).reason, 'image-host-rejected')
  assert.equal(transport.calls.length, 0)

  const failing = createImageReader({
    resolveVision: () => vision, config: { imageUnderstanding: true, imageDailyLimit: 2 },
    lookup: PUBLIC_LOOKUP, request: transport.request,
    fetch: async () => { throw Error(`remote said ${vision.apiKey}`) },
  })
  const failed = await failing.analyze(['https://imgheybox.max-c.com/fail.png'], { total: 1 })
  assert.equal(failed.status, 'unavailable'); assert.equal(failed.reason, 'vision-request-failed')
  assert.equal(JSON.stringify(failed).includes(vision.apiKey), false)
})
