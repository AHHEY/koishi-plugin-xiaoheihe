'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { ReadError, numericId, redact } = require('./security')
const { parseQr, parseLogin, parseCredentials } = require('./parsers')

function validCredential(value) {
  return value && value.version === 1 && /^[1-9]\d{0,31}$/.test(value.uid || '')
    && value.cookies && typeof value.cookies === 'object' && !Array.isArray(value.cookies)
    && Object.entries(value.cookies).every(([key, val]) => /^[A-Za-z0-9_]+$/.test(key) && typeof val === 'string' && !/[;\r\n]/.test(val))
    && ['accessToken', 'refreshToken', 'deviceId', 'nickname', 'loggedInAt'].every(key => value[key] === undefined || typeof value[key] === 'string')
}
function createCredentialStore(file) {
  let fault = false, cached
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!validCredential(parsed)) throw Error('invalid-credential-file')
    cached = parsed
  } catch (error) { if (error.code !== 'ENOENT') fault = true }
  function save(value) {
    if (fault || !validCredential(value)) throw new ReadError('credential-store-failed')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const descriptor = fs.openSync(file + '.tmp', 'wx', 0o600)
    try { fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    fs.renameSync(file + '.tmp', file)
    try { fs.chmodSync(file, 0o600) } catch {}
    cached = value
  }
  return {
    load() { return cached },
    save,
    get fault() { return fault },
    public() { const v = cached; return v ? { uid: v.uid, nickname: v.nickname, loggedInAt: v.loggedInAt, hasCredentials: true } : { hasCredentials: false } },
  }
}
function createAuth({ store, client, config = {}, logger = console } = {}) {
  let session = null, epoch = 0
  const owner = config.ownerId
  async function begin() {
    if (store.fault) throw new ReadError('credential-store-failed')
    const generation = ++epoch
    const { payload, cookies, deviceId } = await client.requestQr()
    const qr = parseQr(payload)
    session = { ...qr, cookies, deviceId, generation }
    return qr.content
  }
  async function check() {
    if (!session) return { state: store.load() ? 'saved' : 'idle', ...store.public() }
    const current = session
    if (current.generation !== epoch) return { state: 'cancelled' }
    if (Date.now() >= current.expiresAt) { session = null; return { state: 'expired' } }
    const { payload, cookies } = await client.pollQr(current.poll)
    const state = parseLogin(payload)
    if (state !== 'success') return { state }
    const credentials = parseCredentials(payload, { ...current.cookies, ...cookies }, current.deviceId)
    if (config.expectedUid && credentials.uid !== numericId(config.expectedUid, 'uid')) throw new ReadError('account-mismatch', '扫码账号与配置的账号不一致')
    store.save(credentials)
    if (current.generation !== epoch) return { state: 'cancelled' }
    session = null
    return { state: 'success', ...store.public() }
  }
  return {
    begin, check,
    cancel() { epoch++; session = null },
    status() { return session ? { state: Date.now() >= session.expiresAt ? 'expired' : 'waiting', ...store.public() } : { state: store.load() ? 'saved' : 'idle', ...store.public() } },
    safeError(error) { return redact(error?.code || 'read-failed') },
  }
}
module.exports = { createCredentialStore, createAuth, validCredential }
