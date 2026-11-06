'use strict'
const { ReadError } = require('./security')

function pluginConfig(ctx, name) {
  const roots = [ctx?.loader?.config, ctx?.config, ctx?.root?.config, ctx?.root?.loader?.config].filter(Boolean)
  const pattern = new RegExp(`^${name}(?::|$)`)
  const seen = new Set()
  const walk = (value, depth) => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return null
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (pattern.test(key) && child && typeof child === 'object') return child
    }
    for (const child of Object.values(value)) {
      const found = walk(child, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const root of roots) {
    const found = walk(root, 0)
    if (found) return found
  }
  return null
}

function validEndpoint(value) {
  let url
  try { url = new URL(String(value || '').trim()) } catch { return null }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !url.pathname.endsWith('/chat/completions')) return null
  return url.href
}

function resolveVisionConfig(ctx) {
  if (!ctx?.atriBiliEyes) throw new ReadError('vision-not-configured')
  const source = pluginConfig(ctx, 'atri-bili-eyes')
  if (!source) throw new ReadError('vision-not-configured')
  const endpoint = validEndpoint(source.visionEndpoint)
  const apiKey = typeof source.visionApiKey === 'string' ? source.visionApiKey.trim() : ''
  const model = typeof source.visionModel === 'string' ? source.visionModel.trim() : ''
  if (!endpoint || !apiKey || !model || model.length > 200) throw new ReadError('vision-not-configured')
  // Callers may use these values only for the request. They are never serialized,
  // returned by status(), logged, or written to an observation.
  return { endpoint, apiKey, model }
}

module.exports = { pluginConfig, validEndpoint, resolveVisionConfig }
