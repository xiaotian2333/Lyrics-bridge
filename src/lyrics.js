import { toMilliseconds } from './utils.js'

// 从 LyricLine 构建逐字数据（可选扩展字段，无数据时不发送）
export function buildLineDetail(line) {
  const detail = {}

  const chars = line?.characters
  if (Array.isArray(chars) && chars.length > 0) {
    detail.characters = chars.map(c => ({
      s: c.startTime,
      e: c.endTime,
      t: String(c.text ?? ''),
    }))
  }

  const translated = String(line?.translated ?? '')
  if (translated) {
    detail.translated = translated

    const tChars = line?.translatedCharacters
    if (Array.isArray(tChars) && tChars.length > 0) {
      detail.translated_characters = tChars.map(c => ({
        s: c.startTime,
        e: c.endTime,
        t: String(c.text ?? ''),
      }))
    }
  }

  const romanized = String(line?.romanized ?? '')
  if (romanized) {
    detail.romanized = romanized

    const rChars = line?.romanizedCharacters
    if (Array.isArray(rChars) && rChars.length > 0) {
      detail.romanized_characters = rChars.map(c => ({
        s: c.startTime,
        e: c.endTime,
        t: String(c.text ?? ''),
      }))
    }
  }

  return detail
}

export const buildLyrics = lyricLines => lyricLines.map(line => ({
  time_ms: toMilliseconds(line?.time),
  text: String(line?.text ?? ''),
  ...buildLineDetail(line),
}))
