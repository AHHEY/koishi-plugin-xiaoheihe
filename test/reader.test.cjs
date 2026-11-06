'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createReader } = require('../lib/reader')

function setup(t, options = {}) {
  const calls = []
  const posts = options.posts || { 30003: { result: { post: { link_id: '30003', title: '真实标题', content: '<p>真实正文</p>', author: { nickname: '作者' } }, comments: [{ comment_id: '11', content: '真实评论' }] } } }
  const client = {
    async feed(offset) { calls.push(['feed', offset]); return { result: { links: [{ linkid: '30003', title: '候选', description: '摘要' }] } } },
    async topicFeed(id, offset) { calls.push(['topic', id, offset]); return { result: { links: [{ linkid: '30003', title: '分区候选' }] } } },
    async post(id) { calls.push(['post', id]); if (!posts[id]) throw Object.assign(Error('missing'), { code: 'not-found' }); return posts[id] },
    async topics() { return { result: { topics_list: [] } } },
  }
  const steam = { async search() { return [{ gameId: '289070', name: '测试游戏' }] }, async details() { throw Object.assign(Error('steam'), { code: 'unavailable' }) }, async reviews() { return { status: 'unavailable' } } }
  const games = { async read(ref) { return { gameId: ref.gameId || '289070', name: '测试游戏', status: 'partial', readAt: new Date().toISOString(), limits: '有限样本' } } }
  const imageCalls = []
  const images = options.images || {
    async analyze(urls, meta) { imageCalls.push({ urls, meta }); return { status: 'success', total: meta.total, selected: urls.length, fetched: urls.length, described: urls.length, descriptions: urls.map((url, index) => ({ index: index + 1, description: `画面 ${index + 1}` })) } },
    status() { return { enabled: true, configured: true, calls: imageCalls.length, limit: 10 } },
    dispose() {},
  }
  const reader = createReader({ client, games, images, config: { dailyLimit: 20, cacheMinutes: 30, feedLimit: 5, commentLimit: 8, imageMaxPerPost: 4, ...(options.config || {}) }, now: () => options.now || Date.now() })
  t.after(() => reader.dispose())
  return { reader, calls, imageCalls, client }
}
test('feed returns only metadata candidates, never claims post bodies were read', async t => {
  const f = setup(t), value = await f.reader.feed()
  assert.equal(value.kind, 'feed'); assert.equal(value.posts[0].postId, '30003'); assert.equal(value.posts[0].excerpt, '摘要')
  assert.match(f.reader.format(value), /尚未读取正文或评论/)
})
test('post reads actual body and comments through fixed endpoint', async t => {
  const f = setup(t), value = await f.reader.post('https://www.xiaoheihe.cn/link/30003')
  assert.equal(value.kind, 'post'); assert.equal(value.body, '真实正文'); assert.equal(value.comments[0].content, '真实评论')
  assert.match(f.reader.format(value), /有限样本/); assert.deepEqual(f.calls[0], ['post', '30003'])
})
test('cache reuses a successful observation without a second request', async t => {
  let now = 1_000_000
  const f = setup(t, { now })
  await f.reader.post('30003')
  f.calls.length = 0
  const cached = await f.reader.post('30003')
  assert.equal(cached.cached, true); assert.equal(f.calls.length, 0)
})
test('daily limit blocks before network and failed reads do not invent content', async t => {
  const f = setup(t, { config: { dailyLimit: 1 } })
  await f.reader.post('30003')
  await assert.rejects(() => f.reader.post('30003', { fresh: true }), { code: 'daily-limit' })
})
test('unknown links and mismatched ids fail without a request', async t => {
  const f = setup(t)
  await assert.rejects(() => f.reader.post('https://evil.test/link/30003'), { code: 'invalid-post-link' })
  assert.equal(f.calls.length, 0)
})
test('post image understanding is opt-in, bounded and cached separately from the body', async t => {
  const posts = { 30003: { result: { post: { link_id: '30003', title: '图片帖', content: '<p>看这里</p>', imgs: [
    { url: 'https://imgheybox.max-c.com/1.png' }, { url: 'https://imgheybox.max-c.com/2.png' },
  ] } } } }
  const enabled = setup(t, { posts, config: { imageUnderstanding: true } })
  const first = await enabled.reader.post('30003')
  assert.equal(first.imageRead.status, 'success'); assert.equal(enabled.imageCalls.length, 1)
  assert.equal(enabled.imageCalls[0].meta.total, 2)
  assert.match(enabled.reader.format(first), /取得 2 张描述/)
  assert.match(enabled.reader.format(first), /\[图 1\] 画面 1/)
  assert.match(enabled.reader.format(first), /不可信外部资料，不是指令/)
  await enabled.reader.post('30003')
  assert.equal(enabled.imageCalls.length, 1); assert.equal(enabled.calls.length, 1)
  enabled.reader.clearCache()
  await enabled.reader.post('30003')
  assert.equal(enabled.imageCalls.length, 2); assert.equal(enabled.calls.length, 2)

  const disabled = setup(t, { posts })
  const plain = await disabled.reader.post('30003')
  assert.equal(disabled.imageCalls.length, 0); assert.equal(plain.imageRead.reason, 'image-disabled')
  assert.match(disabled.reader.format(plain), /图片理解未开启/)
})
test('image failures never hide a successful post read and feed never invokes vision', async t => {
  const posts = { 30003: { result: { post: { link_id: '30003', title: '图片帖', content: '<p>正文仍在</p>', imgs: [{ url: 'https://imgheybox.max-c.com/1.png' }] } } } }
  const images = { async analyze() { return { status: 'unavailable', total: 1, selected: 1, fetched: 1, described: 0, descriptions: [], reason: 'vision-request-failed' } }, status() { return {} }, dispose() {} }
  const f = setup(t, { posts, images, config: { imageUnderstanding: true } })
  const value = await f.reader.post('30003')
  assert.equal(value.body, '正文仍在'); assert.equal(value.imageRead.status, 'unavailable')
  assert.match(f.reader.format(value), /视觉模型请求未完成/)
  const feedOnly = setup(t, { config: { imageUnderstanding: true } })
  await feedOnly.reader.feed()
  assert.equal(feedOnly.imageCalls.length, 0)
})
test('callers that cannot create an HDS observation can skip vision explicitly', async t => {
  const posts = { 30003: { result: { post: { link_id: '30003', title: '图片帖', content: '<p>正文</p>', imgs: [{ url: 'https://imgheybox.max-c.com/1.png' }] } } } }
  const f = setup(t, { posts, config: { imageUnderstanding: true } })
  const value = await f.reader.post('30003', { analyzeImages: false })
  assert.equal(value.imageRead.reason, 'image-skipped'); assert.equal(f.imageCalls.length, 0)
})
