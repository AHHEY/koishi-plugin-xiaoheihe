'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseDetails, parseReviews, createSteam } = require('../lib/steam')
const { parseXhhGame, formatGame, createGameReader } = require('../lib/game')

const details = { '289070': { success: true, data: { steam_appid: 289070, name: '测试游戏', short_description: '<p>真实简介</p>', developers: ['Dev'], publishers: ['Publisher'], release_date: { date: '2024年1月1日', coming_soon: false }, genres: [{ description: '独立' }], is_free: false, price_overview: { currency: 'CNY', initial: 6800, final: 3400, discount_percent: 50 } } } }
test('Steam details retain exact identity, region, currency and actual observed time', () => {
  const result = parseDetails(details, '289070')
  assert.equal(result.gameId, '289070'); assert.equal(result.price.currency, 'CNY'); assert.equal(result.price.final, 34); assert.equal(result.price.region, 'cn'); assert.ok(result.price.observedAt)
  assert.throws(() => parseDetails(details, '999'), /game-not-found/)
  assert.throws(() => parseDetails({ '289070': { success: true, data: { ...details['289070'].data, steam_appid: 999 } } }, '289070'), /game-not-found/)
})
test('Steam review summary is separate from bounded opinions', () => {
  const result = parseReviews({ success: 1, query_summary: { review_score_desc: '特别好评', total_positive: 800, total_negative: 200, total_reviews: 1000 }, reviews: [{ recommendationid: 'r1', voted_up: true, review: '我喜欢它的玩法', author: { playtime_forever: 3600 }, votes_up: 4, timestamp_created: 1780000000 }] }, '289070')
  assert.equal(result.score, '特别好评'); assert.equal(result.total, 1000); assert.equal(result.sampleSize, 1); assert.equal(result.reviews[0].playtimeHours, 60)
})
test('unknown Xiaoheihe game fields stay partial and never masquerade as a Steam price', () => {
  const result = parseXhhGame({ result: { game: { appid: '289070', name: '测试游戏', description: '简介' } } }, '289070')
  assert.equal(result.status, 'partial'); assert.equal(result.price.status, 'unavailable')
  assert.throws(() => parseXhhGame({ result: { game: { appid: '999', name: '错误游戏' } } }, '289070'), /game-mismatch/)
})
test('game reader marks partial sources and keeps source timestamps distinct', async () => {
  const reader = createGameReader({ client: { async game() { throw Object.assign(new Error(), { code: 'forbidden' }) } }, steam: { async details(id) { return parseDetails(details, id) }, async reviews(id) { return parseReviews({ success: 1, query_summary: { review_score_desc: '好评', total_reviews: 2 }, reviews: [] }, id) } } })
  const result = await reader.read('289070'), output = formatGame(result)
  assert.equal(result.gameId, '289070'); assert.equal(result.status, 'partial'); assert.equal(result.xiaoheihe.status, 'unavailable')
  assert.match(output, /未取得已验证/); assert.match(output, /CNY 34/); assert.match(output, /有限样本/); assert.match(output, /没有促销截止时间时不声称最低价或即将结束/)
})
test('game name resolution only takes a real search candidate, then reads its detail', async () => {
  const calls = []
  const reader = createGameReader({ client: { async game(id) { calls.push(['xhh', id]); throw Error('unavailable') } }, steam: { async search(query) { calls.push(['search', query]); return [{ gameId: '289070', name: '测试游戏' }] }, async details(id) { calls.push(['detail', id]); return parseDetails(details, id) }, async reviews() { return { status: 'unavailable' } } } })
  const result = await reader.read('测试游戏')
  assert.equal(result.gameId, '289070'); assert.equal(result.name, '测试游戏'); assert.deepEqual(calls.map(x => x[0]), ['search', 'xhh', 'detail'])
})
test('if every source fails, no fabricated game summary is returned', async () => {
  const reader = createGameReader({ client: { async game() { throw Error('xhh') } }, steam: { async details() { throw Error('steam') }, async reviews() { throw Error('reviews') } } })
  await assert.rejects(() => reader.read('289070'), /game-unavailable/)
})
