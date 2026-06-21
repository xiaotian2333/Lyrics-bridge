export function unwrapValue(value) {
  if (value && typeof value === 'object' && 'value' in value) return value.value
  return value
}

export const toText = value => String(value ?? '').trim()

export const splitArtists = value => toText(value)
  .split(/\s*(?:、|,|\/|&|；|;|\|)\s*/)
  .map(item => item.trim())
  .filter(Boolean)

export function normalizeArtistList(artistList) {
  if (!Array.isArray(artistList)) return []

  const artists = artistList
    .map(artist => artist?.name || artist?.title || artist?.nickname || artist)
    .map(toText)
    .filter(Boolean)

  return Array.from(new Set(artists))
}

export function toMilliseconds(time) {
  const value = Number(time)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value * 1000))
}

export function toSeekSeconds(data, msgPayload) {
  const rawPositionMs = data?.position_ms ?? data?.time_ms ?? msgPayload?.position_ms ?? msgPayload?.time_ms
  if (rawPositionMs != null) {
    const value = Number(rawPositionMs)
    return Number.isFinite(value) ? Math.max(0, value / 1000) : null
  }

  const rawSeconds = data?.position ?? data?.time ?? data?.currentTime ?? msgPayload?.position ?? msgPayload?.time ?? msgPayload?.currentTime
  if (rawSeconds != null) {
    const value = Number(rawSeconds)
    return Number.isFinite(value) ? Math.max(0, value) : null
  }

  return null
}

export function normalizeCoverUrl(url, size = 400) {
  const rawUrl = toText(url)
  if (!rawUrl) return ''
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(rawUrl)) return rawUrl

  let cover = rawUrl.replace(/^http:\/\//i, 'https://')
  if (cover.includes('{size}')) {
    cover = cover.split('{size}').join(String(size))
  }
  return cover.replace('c1.kgimg.com', 'imge.kugou.com')
}

export function stripDataUrlPrefix(value) {
  const text = toText(value)
  const match = text.match(/^data:[^,]+;base64,(.*)$/i)
  return match ? match[1].trim() : text
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.byteLength; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}
