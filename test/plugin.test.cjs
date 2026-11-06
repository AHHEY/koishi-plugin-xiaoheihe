'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
let Koishi
try { Koishi = require('koishi') } catch { Koishi = null }
test('config defaults are read-only and credentials are not requested by default', { skip: !Koishi }, () => {
  const plugin = require('../index')
  const config = plugin.Config({})
  assert.equal(config.enabled, true); assert.equal(config.gameReviews, true); assert.equal(config.gameSearch, true)
  assert.equal(config.ownerId, ''); assert.equal(config.expectedUid, ''); assert.equal(config.dailyLimit, 40)
  assert.equal(config.imageUnderstanding, false); assert.equal(config.imageMaxPerPost, 4); assert.equal(config.imageDailyLimit, 10)
  assert.equal(['visionEndpoint', 'visionApiKey', 'visionModel', 'writeMode', 'allowLike', 'allowComment', 'allowPost', 'allowCoin', 'allowFavorite', 'allowFollow', 'allowDynamic'].some(key => key in config), false)
})
test('plugin registers commands and loads under real Koishi without touching HDS', { skip: !Koishi }, () => {
  const plugin = require('../index')
  const app = new Koishi.App()
  assert.doesNotThrow(() => app.plugin(plugin, { enabled: true, ownerId: '10001' }))
  assert.ok(app.$commander.get('xhh.read'))
  assert.ok(app.$commander.get('xhh.feed'))
  assert.ok(app.$commander.get('xhh.game'))
  assert.ok(app.$commander.get('xhh.status'))
  assert.equal(app.$commander.get('xhh.comment'), undefined)
  assert.equal(app.$commander.get('xhh.post'), undefined)
})
