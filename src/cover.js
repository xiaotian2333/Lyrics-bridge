import { COVER_SIZE, COVER_TIMEOUT_MS, MAX_COVER_BYTES, MAX_COVER_CACHE_SIZE } from './constants.js'
import { arrayBufferToBase64, normalizeCoverUrl, stripDataUrlPrefix } from './utils.js'

export function rememberCoverBase64(state, url, base64) {
  if (!url || !base64) return
  state.coverBase64Cache.set(url, base64)
  if (state.coverBase64Cache.size <= MAX_COVER_CACHE_SIZE) return

  const firstKey = state.coverBase64Cache.keys().next().value
  if (firstKey) state.coverBase64Cache.delete(firstKey)
}

export async function fetchCoverBase64(state, ctx, url) {
  const normalizedUrl = normalizeCoverUrl(url, COVER_SIZE)
  if (!normalizedUrl) return ''

  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(normalizedUrl)) {
    const base64 = stripDataUrlPrefix(normalizedUrl)
    rememberCoverBase64(state, normalizedUrl, base64)
    return base64
  }

  if (state.coverBase64Cache.has(normalizedUrl)) {
    return state.coverBase64Cache.get(normalizedUrl) || ''
  }

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timeout = controller ? setTimeout(() => controller.abort(), COVER_TIMEOUT_MS) : null

  try {
    const fetcher = ctx.net?.fetch || fetch
    const response = await fetcher(normalizedUrl, controller ? { signal: controller.signal } : undefined)
    if (!response?.ok) return ''

    const contentLength = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_COVER_BYTES) return ''

    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_COVER_BYTES) return ''

    const base64 = arrayBufferToBase64(buffer)
    rememberCoverBase64(state, normalizedUrl, base64)
    return base64
  } catch {
    return ''
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function getCoverBase64(state, ctx, snapshot, track) {
  const coverUrl = normalizeCoverUrl(snapshot?.playback?.coverUrl || track?.coverUrl || track?.cover, COVER_SIZE)
  if (!coverUrl) return ''

  if (state.coverBase64Cache.has(coverUrl)) {
    return state.coverBase64Cache.get(coverUrl) || ''
  }

  return fetchCoverBase64(state, ctx, coverUrl)
}
