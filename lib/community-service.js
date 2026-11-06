'use strict'
const { Service } = require('koishi')
const { createHdsBridge, createXhhProvider } = require('./hds-bridge')
const { createBiliProvider } = require('./bili-provider')

const registry = new WeakMap()

class CommunityObservationService extends Service {
  constructor(ctx) {
    super(ctx, 'communityObservations', true)
    this.bridge = null
    this.providers = new Map()
    this.disposed = false
    this.provided = true
    this.owners = new Set()
  }
  register(name, options) {
    if (this.disposed) return () => {}
    this.providers.set(name, options)
    if (this.bridge) this.bridge.register(name, options)
    return () => {
      if (this.providers.get(name) === options) this.providers.delete(name)
      this.bridge?.unregister?.(name)
    }
  }
  unregister(name) { this.providers.delete(name); this.bridge?.unregister?.(name) }
  record(data) { return this.bridge?.record?.(data) }
  clear() { return this.bridge?.clear?.() }
  status() { return this.bridge?.status() || '共享 HDS 观察桥尚未连接' }
  attachHds(ctx, config = {}, forcedVersion = '') {
    if (this.disposed || this.bridge) return this.bridge
    const version = forcedVersion || (() => { try { return require(require.resolve('koishi-plugin-hds-interlude/package.json', { paths: [ctx.baseDir || process.cwd(), __dirname] })).version } catch { return '' } })()
    const bridge = createHdsBridge(ctx, config, { hdsVersion: version })
    if (!bridge.installed) return null
    this.bridge = bridge
    for (const [name, options] of this.providers) this.bridge.register(name, options)
    return this.bridge
  }
  acquire(owner) {
    this.owners.add(owner)
    return () => { this.owners.delete(owner) }
  }
  stop() { this.disposed = true; this.bridge?.dispose(); this.providers.clear() }
}
function provideCommunityObservations(ctx, options = {}) {
  const root = ctx.root || ctx
  let service = registry.get(root)
  if (!service || service.disposed) {
    service = new CommunityObservationService(ctx)
    registry.set(root, service)
  }
  // Cordis stores the service under a per-name symbol, but ctx.get() may return
  // a traceable proxy. Keep the canonical object in the root registry so
  // attachHds() and provider registration always share the same bridge.
  if (root.get('communityObservations') !== service) root.set('communityObservations', service)
  if (options.hdsVersion || ctx.interlude) service.attachHds(ctx, options.config || {}, options.hdsVersion || '')
  return service
}
module.exports = { CommunityObservationService, provideCommunityObservations, createHdsBridge, createXhhProvider, createBiliProvider, registry }
