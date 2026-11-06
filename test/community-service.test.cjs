'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { CommunityObservationService, provideCommunityObservations } = require('../lib/community-service')

test('shared service stays available and accepts late providers', () => {
  const { App } = require('koishi')
  const app = new App()
  const service = provideCommunityObservations(app, { config: {}, hdsVersion: '1.0.1-rc57' })
  assert.equal(app.get('communityObservations')?.bridge !== undefined, true)
  assert.equal(service.providers.size, 0)
  let registered = 0
  const unregister = service.register('test', { execute: async () => { registered++ } })
  assert.equal(service.providers.size, 1)
  unregister()
  assert.equal(service.providers.size, 0)
  service.stop()
})
test('shared service installs only one HDS wrapper', () => {
  const { App } = require('koishi')
  const app = new App()
  const original = { decide: async () => ({ script: '原剧本' }) }
  const hds = { getNarrator: () => app.narrator, setNarrator: n => { app.narrator = n }, persistDecision: async () => ({ scriptEntry: null }), serial: async (id, fn) => fn(), dbSet: async () => {}, appendEntry: async () => ({}), getDesktopRuntimePhase: () => 'running' }
  app.set('interlude', hds)
  app.narrator = original
  const service = provideCommunityObservations(app, { config: {}, hdsVersion: '1.0.1-rc57' })
  const bridge = service.attachHds(app, {})
  assert.equal(bridge.installed, true)
  assert.notEqual(app.narrator, original)
  service.stop()
  assert.equal(app.narrator, original)
})
