'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { parseFeed, parsePost, parseTopics, parseQr, parseLogin, parseCredentials } = require('../lib/parsers')
const { findPosts, parseGameReference } = require('../lib/links')
const fixtures = path.join(__dirname, 'fixtures')
const read = name => JSON.parse(fs.readFileSync(path.join(fixtures, name), 'utf8'))

test('sanitized local fixture feed is normalized without interpreting text as commands', () => {
  const [post] = parseFeed(read('feed_recommendation.json'))
  assert.equal(post.postId, '81001'); assert.equal(post.title, '脱敏推荐流帖子')
  assert.equal(post.authorId, '51001'); assert.equal(post.imageCount, 1); assert.deepEqual(post.topics, ['Steam', 'PC游戏'])
})
test('sanitized local fixture post reads actual body and bounded comment evidence', () => {
  const post = parsePost(read('thread_context.json'), '30003')
  assert.equal(post.body, '帖子正文'); assert.equal(post.comments[0].author, 'Alice'); assert.equal(post.commentStatus, 'sampled')
  assert.equal(post.imageCount, 1)
})
test('response post id mismatch and malformed payload fail closed', () => {
  assert.throws(() => parsePost(read('thread_context.json'), '999'), { code: 'post-mismatch' })
  assert.throws(() => parsePost({ result: [] }, '3'), { code: 'response-shape' })
  assert.throws(() => parseFeed({ result: { not_links: [] } }), { code: 'response-shape' })
})
test('post images are deduplicated, bounded and retained for opt-in visual reading', () => {
  const post = parsePost({ result: { post: {
    link_id: '3',
    content: JSON.stringify([
      { type: 'text', text: '正文' },
      { type: 'image', url: 'https://imgheybox.max-c.com/1.png' },
      { type: 'image', url: 'https://imgheybox.max-c.com/1.png' },
      { type: 'image', url: 'http://imgheybox.max-c.com/insecure.png' },
    ]),
    imgs: [
      { url: 'https://imgheybox.max-c.com/1.png' },
      { url: 'https://imgheybox.max-c.com/2.png' },
      { url: 'https://imgheybox.max-c.com/3.png' },
      { url: 'https://imgheybox.max-c.com/4.png' },
      { url: 'https://imgheybox.max-c.com/5.png' },
    ],
  } } }, '3')
  assert.equal(post.imageCount, 5); assert.equal(post.imageUrls.length, 4)
  assert.deepEqual(post.imageUrls, [1, 2, 3, 4].map(n => `https://imgheybox.max-c.com/${n}.png`))
})
test('image-only HTML posts remain readable without inventing text', () => {
  const post = parsePost({ result: { post: { link_id: '4', content: '<p> </p><img src="https://cdn.max-c.com/web/bbs/a.png">' } } }, '4')
  assert.equal(post.imageCount, 1); assert.equal(post.body, ''); assert.equal(post.imageUrls[0], 'https://cdn.max-c.com/web/bbs/a.png')
})
test('hex share id may map to a numeric canonical post id without accepting arbitrary hex', () => {
  const result = parsePost({ result: { post: { link_id: '12345', content: '正文' } } }, '6ffb72c37640')
  assert.equal(result.postId, '6ffb72c37640'); assert.equal(result.canonicalId, '12345')
  assert.throws(() => parsePost({ result: { post: { link_id: 'other-hex', content: '正文' } } }, '6ffb72c37640'), { code: 'post-mismatch' })
})
test('comments preserve nesting and limit, ignoring non-record nodes', () => {
  const result = parsePost({ result: { post: { link_id: '1', content: '正文' }, comments: [{ comment_id: '2', text: '一楼', children: [{ comment_id: '3', text: '回复', user: { nickname: 'B' } }] }] } }, '1')
  assert.deepEqual(result.comments.map(x => [x.commentId, x.depth]), [['2', 0], ['3', 1]])
  assert.equal(parsePost({ result: { post: { link_id: 'f51a6fb04c88', content: '正文' } } }, 'f51a6fb04c88').postId, 'f51a6fb04c88')
})
test('links accept only explicit supported public post shapes', () => {
  for (const url of ['https://www.xiaoheihe.cn/bbs/app/link/30003', 'https://xiaoheihe.cn/link/30003', 'https://www.xiaoheihe.cn/app/bbs/link/139989072', 'https://www.xiaoheihe.cn/community/1/list/138694376', 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=f51a6fb04c88', '帖子 30003', '#30003']) assert.notDeepEqual(findPosts(url), [])
  assert.deepEqual(findPosts('https://www.xiaoheihe.cn/app/bbs/link/139989072'), ['139989072'])
  assert.deepEqual(findPosts('https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=f51a6fb04c88'), ['f51a6fb04c88'])
  for (const url of ['https://evil.test/bbs/app/link/3', 'https://www.xiaoheihe.cn.evil.test/link/3', 'http://www.xiaoheihe.cn/link/3', 'https://www.xiaoheihe.cn/redirect?url=https://evil.test', 'file:///3']) assert.deepEqual(findPosts(url), [])
})
test('game reference validates ids and names without inventing id', () => {
  assert.deepEqual(parseGameReference('appid:289070'), { gameId: '289070' })
  assert.deepEqual(parseGameReference('289070'), { gameId: '289070' })
  assert.deepEqual(parseGameReference('星露谷物语'), { query: '星露谷物语' })
  assert.throws(() => parseGameReference('https://evil.test/a'))
})
test('QR and credentials accept official shape and keep secrets in store only', () => {
  const qr = parseQr({ result: { qrcode: 'https://www.xiaoheihe.cn/scan?request_id=abc', expires_in: 180 } })
  assert.equal(qr.poll.request_id, 'abc'); assert.equal(parseLogin({ result: { status: 'success' } }), 'success')
  const c = parseCredentials({ result: { user: { uid: '123', nickname: 'test', pkey: 'private' } } }, { 'x_xhh_tokenid': 'public-token' }, 'device')
  assert.equal(c.uid, '123'); assert.equal(c.cookies.pkey, 'private'); assert.equal(c.deviceId, 'device')
  assert.throws(() => parseQr({ result: { qrcode: 'https://evil.test/scan' } }), { code: 'response-shape' })
})
test('topic catalog recursively flattens valid IDs and ignores malformed values', () => {
  const result = parseTopics({ result: { topics_list: [{ name: '游戏', children: [{ topic_id: '42', name: '独立游戏' }] }] } })
  assert.deepEqual(result[0], { topicId: '42', name: '独立游戏', group: '游戏' })
})
