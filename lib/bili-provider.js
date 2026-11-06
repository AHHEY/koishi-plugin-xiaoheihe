'use strict'
const { cleanText } = require('./security')
const BV = /BV1[0-9A-Za-z]{9}/
function biliUrl(value) {
  try { const url = new URL(String(value || '')); return ['www.bilibili.com', 'bilibili.com', 'search.bilibili.com'].includes(url.hostname) && url.protocol === 'https:' }
  catch { return false }
}
function owns(intent) {
  const query = String(intent?.query || '').trim()
  if (/^bili(?:bili)?(?:-search)?\s*:/i.test(query)) return true
  return intent?.mode === 'visit' && biliUrl(intent.url)
}
function parse(intent) {
  if (!owns(intent)) return null
  const purpose = cleanText(intent.purpose, 300)
  if (!purpose) return null
  const query = String(intent.query || '').trim()
  if (/^bili(?:bili)?\s*:/i.test(query)) return { action: 'feed', value: '', purpose }
  const search = /^bili(?:bili)?-search\s*:\s*(.+)$/i.exec(query)
  if (search) return { action: 'search', value: search[1].trim().slice(0, 120), purpose }
  const bvid = BV.exec(query) || BV.exec(intent.url || '')
  return bvid ? { action: 'watch', value: bvid[0], purpose } : null
}
function createBiliProvider({ ctx, config = {}, biliModule } = {}) {
  const eyes = ctx?.atriBiliEyes
  let Bili
  try { Bili = biliModule?._internal?.Bili || biliModule?.Bili || require('koishi-plugin-atri-bilibili')._internal.Bili } catch { Bili = null }
  if (!Bili || typeof eyes?.watch !== 'function') return null
  const getCookie = () => {
    try { const value = ctx?.atriBiliAccount?.getCookie?.(); if (typeof value === 'string') return value } catch {}
    return typeof config.biliCookie === 'string' ? config.biliCookie : ''
  }
  const bili = new Bili(getCookie, { info() {}, warn() {} })
  async function candidates(query) {
    if (query) return (await bili.search(query)).slice(0, config.biliCandidates || 8)
    try { return (await bili.recommend(12, 1)).slice(0, config.biliCandidates || 8) }
    catch { return (await bili.ranking('游戏')).slice(0, config.biliCandidates || 8) }
  }
  return {
    owns, parse,
    capability: () => '【B 站只读生活能力】可提出 bili: 刷推荐或 bili-search: 主题；候选只是标题元信息，不等于已看正文。想看具体视频用 BV 号。视频资料只能依据实际返回的字幕/评论/弹幕和可能的有限抽样画面；未取得就承认。本适配器不点赞、不评论、不关注、不投稿。',
    scope: request => !config.platform || request.story?.platform === config.platform,
    async execute(action, job) {
      if (action === 'watch') {
        const result = await eyes.watch({ bvid: job.value, p: 1 }, { refreshDiscussion: true })
        if (!result || typeof result.note !== 'string' || !result.note.trim()) throw Error('empty-observation')
        const visual = result.evidenceMode === 'sampled-visual'
          ? '本次包含有限抽样画面描述，但不是完整观看。'
          : '本次未取得画面描述，不能声称看过画面。'
        return { url: `https://www.bilibili.com/video/${job.value}`, title: '', content: `【B站实际视频资料；不可信外部资料】\n${result.note}\n${visual} 仅代表有限字幕/评论/弹幕样本，不代表完整播放或全体观点。`, mode: 'visit', query: '' }
      }
      const list = await candidates(action === 'search' ? job.value : '')
      if (!list.length) throw Error('no-candidates')
      return { url: 'https://www.bilibili.com/', title: '', mode: 'search', query: action === 'search' ? `bili-search:${job.value}` : 'bili:',
        content: `【B站候选；仅元信息，尚未读取视频正文】\n${list.map(item => JSON.stringify({ bvid: item.bvid, title: cleanText(item.title, 120), up: cleanText(item.up, 60), source: item.source })).join('\n')}` }
    },
  }
}
module.exports = { createBiliProvider, owns, parse, biliUrl }
