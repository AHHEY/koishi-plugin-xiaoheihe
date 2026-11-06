'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { App } = require('koishi')
const { CommunityObservationService, provideCommunityObservations } = require('../lib/community-service')
const { createHdsBridge } = require('../lib/hds-bridge')

function makeHds(app) {
  const original = { decide: async () => ({ script: '原剧本' }) }
  const service = {
    narrator: original,
    getNarrator() { return this.narrator },
    setNarrator(next) { this.narrator = next },
    async persistDecision() { return { messages: [], scriptEntry: null } },
    async serial(_id, fn) { return fn() },
    async dbSet() {}, async appendEntry() { return {} },
    getDesktopRuntimePhase: () => 'running',
  }
  app.set('interlude', service)
  return { service, original }
}
test('service acquire/release keeps bridge until last owner leaves', () => {
  const app = new App()
  const hds = makeHds(app)
  const service = provideCommunityObservations(app, { hdsVersion: '1.0.1-rc57' })
  const bridge = service.bridge
  const stopA = service.acquire('a'), stopB = service.acquire('b')
  stopA()
  assert.equal(service.bridge, bridge)
  stopB()
  service.stop()
  assert.equal(hds.service.getNarrator(), hds.original)
})
test('two shared services for different children use one root bridge', () => {
  const app = new App()
  const hds = makeHds(app)
  const child = app.extend({})
  const a = provideCommunityObservations(app, { hdsVersion: '1.0.1-rc57' })
  const b = provideCommunityObservations(child, { hdsVersion: '1.0.1-rc57' })
  assert.equal(a, b)
  assert.equal(app.get('communityObservations')?.bridge, a.bridge)
  a.stop()
  assert.equal(hds.service.getNarrator(), hds.original)
})
test('legacy wrapper is not stacked when shared bridge exists', () => {
  const app = new App()
  const hds = makeHds(app)
  const service = provideCommunityObservations(app, { hdsVersion: '1.0.1-rc57' })
  const before = hds.service.getNarrator()
  // The staging Bili plugin checks this exact marker and does not call createAutonomy.
  assert.ok(service.bridge)
  assert.equal(hds.service.getNarrator(), before)
  service.stop()
  assert.equal(hds.service.getNarrator(), hds.original)
})
test('failed HDS version never changes narrator', () => {
  const app = new App()
  const hds = makeHds(app)
  const service = provideCommunityObservations(app, { hdsVersion: '1.0.2' })
  assert.equal(service.bridge, null)
  assert.equal(hds.service.getNarrator(), hds.original)
  service.stop()
})
