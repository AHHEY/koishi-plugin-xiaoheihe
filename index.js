'use strict'
const path = require('node:path')
const { Schema, Service, h } = require('koishi')
const { createClient } = require('./lib/client')
const { createCredentialStore, createAuth } = require('./lib/auth')
const { createSteam } = require('./lib/steam')
const { createGameReader } = require('./lib/game')
const { createReader } = require('./lib/reader')
const { createImageReader } = require('./lib/image')
const { resolveVisionConfig } = require('./lib/vision-config')
const { provideCommunityObservations, createXhhProvider } = require('./lib/community-service')
const { findPosts } = require('./lib/links')

exports.name = 'xiaoheihe'
exports.inject = { optional: ['interlude', 'database', 'atriBiliEyes', 'communityObservations'] }
exports.usage = '只读小黑盒与 Steam 游戏资料。不包含发帖、评论、点赞、关注或其他账号写入能力。'
exports.Config = Schema.object({
  enabled: Schema.boolean().default(true).description('启用只读读取服务'),
  ownerId: Schema.string().default('').description('允许使用命令/扫码的 QQ；留空不开放聊天命令'),
  selfId: Schema.string().default('').description('机器人 QQ；留空不限定'),
  platform: Schema.string().default('onebot'),
  biliBridge: Schema.boolean().default(true).description('启用时把小盒子只读桥同时用于 B 站视频/候选；需 atri-bili-eyes 已加载'),
  expectedUid: Schema.string().default('').description('可选：只允许扫码登录此小黑盒 UID'),
  feedLimit: Schema.natural().min(1).max(30).default(12).description('每轮候选帖子数'),
  commentLimit: Schema.natural().min(1).max(30).default(12).description('每帖评论样本上限'),
  imageUnderstanding: Schema.boolean().default(false).description('可选：把帖子公开图片交给 atri-bili-eyes 已配置的视觉模型；可能计费'),
  imageMaxPerPost: Schema.natural().min(1).max(4).default(4).description('每帖最多识别几张图片；其余只计数量'),
  imageDailyLimit: Schema.natural().min(1).max(100).default(10).description('每日视觉模型调用上限；与文本读取限额分开'),
  imageTimeoutMs: Schema.natural().min(5000).max(30000).default(15000).description('单张图片下载超时毫秒数；整体另有硬上限'),
  dailyLimit: Schema.natural().min(1).max(200).default(40).description('每日真实读取尝试上限，失败也计入'),
  cacheMinutes: Schema.natural().min(1).max(1440).default(30).description('临时读取缓存分钟数'),
  observationTtlHours: Schema.natural().min(1).max(72).default(24).description('HDS 外部正文观察保留小时数'),
  gameCountry: Schema.string().default('cn').description('Steam 价格地区，例如 cn'),
  gameLanguage: Schema.string().default('schinese').description('Steam 文本与评论语言'),
  gameReviews: Schema.boolean().default(true).description('读取 Steam 有限评论样本'),
  gameSearch: Schema.boolean().default(true).description('允许用 Steam 公开搜索解析游戏名称；不据此编造详情'),
  timeoutMs: Schema.natural().min(5000).max(60000).default(15000),
  intervalMs: Schema.natural().min(500).max(10000).default(1000).description('小黑盒请求最小间隔'),
  debug: Schema.boolean().default(false).description('输出不含凭据与正文的状态日志'),
})

function apply(ctx, config) {
  const logger = ctx.logger('xiaoheihe')
  if (!config.enabled) return
  try { require('./lib/observation-store').extendModel(ctx) } catch {}
  const file = path.join(ctx.baseDir || process.cwd(), 'data', 'xiaoheihe', 'account.json')
  const store = createCredentialStore(file)
  if (store.fault) { logger.warn('账号文件无法安全读取；已停止读取，不覆盖原文件'); return }
  const client = createClient({ store, config })
  const steam = createSteam({ timeout: config.timeoutMs })
  const games = createGameReader({ client, steam, config })
  const images = createImageReader({ resolveVision: () => resolveVisionConfig(ctx), config })
  const reader = createReader({ client, games, images, config })
  const auth = createAuth({ store, client, config })
  class XiaoheiheService extends Service {
    constructor() { super(ctx, 'xiaoheihe', true) }
    readPost(reference, options) { return reader.post(reference, options) }
    browse(options) { return reader.feed(options) }
    readGame(reference, options) { return reader.game(reference, options) }
    status() { return { account: store.public(), ...reader.status() } }
  }
  new XiaoheiheService()
  const allowed = session => !!config.ownerId && session?.isDirect !== false && !session.guildId && String(session.userId) === String(config.ownerId)
    && session.platform === config.platform && (!config.selfId || String(session.selfId) === String(config.selfId))
  const safeFailure = error => `没有读取成功（${error?.code || 'read-failed'}）。本次没有取得可据此回答的正文或资料。`
  ctx.command('xhh.read <target:text>', '只读读取小黑盒帖子正文和评论样本').action(async ({ session }, target) => {
    if (!allowed(session)) return
    try { const record = await reader.post(target); return reader.format(record) } catch (error) { return safeFailure(error) }
  })
  ctx.command('xhh.feed [topicId:string]', '只读小黑盒推荐流或数字分区 ID 的候选帖子').action(async ({ session }, topicId) => {
    if (!allowed(session)) return
    try { const record = await reader.feed({ topicId: topicId || '' }); return reader.format(record) } catch (error) { return safeFailure(error) }
  })
  ctx.command('xhh.game <target:text>', '读取游戏详情、价格、评价及有限评论').action(async ({ session }, target) => {
    if (!allowed(session)) return
    try { const record = await reader.game(target); return reader.format(record) } catch (error) { return safeFailure(error) }
  })
  ctx.command('xhh.status', '只读运行状态').action(({ session }) => {
    if (!allowed(session)) return
    const status = reader.status()
    const image = status.image
    const imageState = !image.enabled ? '关闭' : image.configured ? '已开启，视觉模型配置可用' : '已开启，但未找到 atri-bili-eyes 的完整视觉模型配置'
    return [`小黑盒账号：${store.load() ? '已保存登录态' : '未登录'}`, `今日读取尝试：${status.reads}/${config.dailyLimit}`, `临时缓存：${status.cacheEntries}；在途读取：${status.pending}`, `图片理解：${imageState}；今日视觉调用 ${image.calls}/${image.limit}`, '公开写入：未实现，所有操作均为只读', ctx.communityObservations?.status() || 'HDS 桥待连接'].join('\n')
  })
  ctx.command('xhh.login', '生成小黑盒官方扫码登录二维码；仅在本人私聊使用').action(async ({ session }) => {
    if (!allowed(session)) return
    try {
      const url = await auth.begin()
      const qr = require('./lib/qrcode.cjs')(0, 'M')
      qr.addData(url)
      qr.make()
      await session.send([h.text('请用手机小黑盒 App 扫码并在手机上确认，二维码约 3 分钟有效。扫码不会执行任何发帖或评论。'), h.image(qr.createDataURL(6, 24), 'image/gif')])
      return '扫码后发送 xhh.login.check 检查登录状态。不要把二维码或登录链接转发给他人。'
    } catch (error) { return safeFailure(error) }
  })
  ctx.command('xhh.login.check', '检查扫码状态').action(async ({ session }) => {
    if (!allowed(session)) return
    try { const result = await auth.check(); return `登录状态：${result.state}${result.uid ? `；UID ${result.uid}` : ''}` } catch (error) { return safeFailure(error) }
  })
  ctx.command('xhh.login.cancel', '取消本次扫码，不删除已保存登录态').action(({ session }) => { if (allowed(session)) { auth.cancel(); return '已取消本次扫码' } })
  ctx.command('xhh.clear [confirm:string]', '清空本插件保存的外部观察原文缓存').action(async ({ session }, confirm) => {
    if (!allowed(session)) return
    if (confirm !== 'yes') return '这会清空插件自己的外部资料缓存，不影响 HDS 剧本。确认请发送 xhh.clear yes'
    reader.clearCache()
    try { await ctx.communityObservations?.clear?.(); return '已清空外部资料缓存；剧本中的读取记录保留为无正文的审计记录' } catch { return '清理未完成；未删除其它数据' }
  })
  let unregister = () => {}
  if (typeof ctx.inject === 'function') ctx.inject(['interlude', 'database'], child => {
    try {
      const shared = provideCommunityObservations(child, { config })
      unregister = shared.register('xiaoheihe', createXhhProvider(reader, config))
      let stopBili = () => {}
      const registerBili = biliChild => {
        if (config.biliBridge === false) return
        try {
          const { createBiliProvider } = require('./lib/bili-provider')
          const biliProvider = createBiliProvider({ ctx: biliChild, config })
          if (biliProvider) stopBili = shared.register('bilibili', biliProvider)
        } catch { /* Bili plugin is optional; xhh-only mode remains usable */ }
      }
      if (child.atriBiliEyes) registerBili(child)
      else if (typeof child.inject === 'function') child.inject(['atriBiliEyes'], registerBili)
      const stopXhh = unregister
      unregister = () => { stopBili(); stopXhh() }
      child.on('dispose', () => unregister())
    } catch (error) { logger.warn('HDS 共享桥未连接：%s', error?.code || 'incompatible') }
  })
  // Only register a link. Never append external content to session.content: that
  // would make HDS store untrusted material as a user's message and recall it later.
  ctx.middleware(async (session, next) => {
    if (!allowed(session)) return next()
    const text = [session.content, JSON.stringify(session.event?._data?.message || ''), session.event?._data?.raw_message || ''].join('\n')
    if (/^\s*(?:xhh\b|interlude\b|bili\b|eyes\b)/i.test(session.content || '')) return next()
    const postId = findPosts(text)[0]
    if (postId) {
      try {
        const story = ctx.interlude?.findStory ? await ctx.interlude.findStory(session) : null
        const participant = story && ctx.interlude?.findParticipant ? await ctx.interlude.findParticipant(session, story) : null
        // Do not download public images or call the vision model when this link
        // cannot become an HDS observation anyway.
        if (!story || !participant) return next()
        const record = await reader.post(postId)
        await ctx.communityObservations?.record?.({
          storyId: story.id, participantId: participant.id, url: record.url,
          content: reader.format(record), status: 'success', source: 'xiaoheihe', kind: 'post', mode: 'visit',
        })
        if (config.debug) logger.info('已登记链接观察 %s', postId)
      } catch (error) { if (config.debug) logger.info('链接读取未完成：%s', error?.code || 'read-failed') }
    }
    return next()
  }, true)
  ctx.on('dispose', () => { unregister(); reader.dispose(); client.dispose(); steam.dispose(); auth.cancel() })
}
exports.apply = apply
