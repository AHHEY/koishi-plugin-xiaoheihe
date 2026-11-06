'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createBiliProvider, owns, parse } = require('../lib/bili-provider')

const BV_ID = 'BV1xx411c7mD'

class FakeBili {
  constructor(getCookie) { this.getCookie = getCookie }
  async search(query) { return [{ bvid: BV_ID, title: `关于${query}`, up: 'UP' }] }
  async recommend() { return [{ bvid: BV_ID, title: '推荐', up: 'UP' }] }
  async ranking() { return [] }
  async detail(bvid) { return { bvid, aid: 1, cid: 2 } }
}
test('Bili intent parser accepts only read namespaces and real BV', () => {
  assert.equal(parse({ mode: 'search', query: 'bili:', purpose: '随便看看' }).action, 'feed')
  assert.equal(parse({ mode: 'search', query: 'bili-search: 独立游戏', purpose: '想搜' }).value, '独立游戏')
  assert.equal(parse({ mode: 'visit', url: `https://www.bilibili.com/video/${BV_ID}`, purpose: '想看' }).value, BV_ID)
  assert.equal(parse({ mode: 'search', query: `bili-comment:${BV_ID} 发评论`, purpose: '写' }), null)
  assert.equal(parse({ mode: 'visit', url: `https://evil.test/video/${BV_ID}`, purpose: '看' }), null)
})
test('Bili provider returns candidates and uses eyes for actual reading, never public write', async () => {
  const calls = []
  const ctx = { 'atriBiliEyes': { async watch(video) { calls.push(['watch', video.bvid]); return { note: '实际字幕/评论样本及抽样画面描述', got: { comments: true }, evidenceMode: 'sampled-visual' } } }, atriBiliAccount: { getCookie: () => 'SESSDATA=test-cookie' } }
  const provider = createBiliProvider({ ctx, biliModule: { _internal: { Bili: FakeBili } } })
  const feed = await provider.execute('feed', { value: '', purpose: '看看' })
  const watch = await provider.execute('watch', { value: BV_ID, purpose: '想看' })
  assert.match(feed.content, /候选/); assert.match(watch.content, /实际视频资料/); assert.match(watch.content, /包含有限抽样画面描述/)
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(feed).includes('private'), false)
})
test('without eyes the Bili provider stays disabled instead of inventing a read path', () => {
  assert.equal(createBiliProvider({ ctx: {}, biliModule: { _internal: { Bili: FakeBili } } }), null)
})
