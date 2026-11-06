'use strict'
const { ReadOnlyClient, numericId, cleanText } = require('./security')

// Steam public endpoints: no account credentials, no write calls.
const DETAILS = '/api/appdetails'
const REVIEWS = '/appreviews/'
const SEARCH = '/api/storesearch/'
const DETAIL_HOST = 'store.steampowered.com'
const SEARCH_HOST = DETAIL_HOST
function cents(value) { return Number.isFinite(value) ? value / 100 : null }
function parseDetails(payload, appId, country = 'cn', language = 'schinese') {
  const node = payload?.[appId]
  if (!node || node.success !== true || !node.data || String(node.data.steam_appid) !== String(appId)) throw new Error('game-not-found')
  const data = node.data, price = data.price_overview
  return { gameId: String(appId), name: cleanText(data.name, 200), description: cleanText(data.short_description, 1200),
    developers: (data.developers || []).map(x => cleanText(x, 100)).slice(0, 8), publishers: (data.publishers || []).map(x => cleanText(x, 100)).slice(0, 8),
    releaseDate: cleanText(data.release_date?.date, 60), comingSoon: data.release_date?.coming_soon === true,
    genres: (data.genres || []).map(x => cleanText(x.description, 80)).slice(0, 10), isFree: data.is_free === true,
    price: price ? { store: 'Steam', region: country, currency: price.currency, initial: cents(price.initial), final: cents(price.final), discountPercent: Number(price.discount_percent) || 0, observedAt: new Date().toISOString() } : { status: data.is_free ? 'free' : 'unavailable', store: 'Steam', region: country },
    sourceUrl: `https://${DETAIL_HOST}/app/${appId}/`, language, status: 'success' }
}
function parseReviews(payload, appId, language = 'schinese') {
  if (payload?.success !== 1) throw new Error('reviews-unavailable')
  const summary = payload.query_summary || {}
  const reviews = (payload.reviews || []).slice(0, 12).map(review => ({ id: String(review.recommendationid || ''), recommended: review.voted_up === true,
    content: cleanText(review.review, 600), playtimeHours: Number.isFinite(review.author?.playtime_forever) ? Math.round(review.author.playtime_forever / 60 * 100) / 100 : null,
    helpful: Number(review.votes_up) || 0, createdAt: review.timestamp_created ? new Date(review.timestamp_created * 1000).toISOString() : null }))
  return { gameId: String(appId), score: cleanText(summary.review_score_desc, 100), positive: Number(summary.total_positive) || 0, negative: Number(summary.total_negative) || 0,
    total: Number(summary.total_reviews) || 0, sampleSize: reviews.length, reviews, language, status: 'success', sampledAt: new Date().toISOString() }
}
function createSteam({ request, now, timeout = 15000 } = {}) {
  const client = new ReadOnlyClient({ hostnames: [DETAIL_HOST, SEARCH_HOST], request, now, timeout, interval: 350, maxAttempts: 1 })
  return {
    async details(appId, { country = 'cn', language = 'schinese', signal } = {}) { return parseDetails(await client.get(DETAILS, { appids: numericId(appId, 'appid'), cc: country, l: language }, { auth: false, signal }), numericId(appId), country, language) },
    async reviews(appId, { country = 'cn', language = 'schinese', signal, limit = 12 } = {}) {
      const id = numericId(appId, 'appid')
      const payload = await client.get(REVIEWS + id, { json: 1, language, filter: 'recent', purchase_type: 'all', num_per_page: Math.min(100, Math.max(1, limit)) }, { auth: false, signal, host: DETAIL_HOST, extraHeaders: { Referer: `https://${DETAIL_HOST}/app/${id}/` } })
      return parseReviews(payload, id, language)
    },
    async search(query, { country = 'cn', language = 'schinese', signal } = {}) {
      const payload = await client.get(SEARCH, { term: query, cc: country, l: language }, { auth: false, signal, host: SEARCH_HOST, extraHeaders: { Referer: `https://${DETAIL_HOST}/` } })
      return (payload.items || []).slice(0, 8).map(item => ({ gameId: String(item.id), name: cleanText(item.name, 200), type: cleanText(item.type, 30) })).filter(item => /^[1-9]\d*$/.test(item.gameId))
    },
    dispose() { client.dispose() },
  }
}
module.exports = { createSteam, parseDetails, parseReviews }
