import { unwrapValue } from './utils.js'
import { isWsOpen, sendPluginCommand } from './websocket.js'

export function normalizeVolume(value) {
  const rawValue = unwrapValue(value)
  if (rawValue == null) return null
  if (typeof rawValue !== 'number' && typeof rawValue !== 'string') return null
  if (typeof rawValue === 'string' && rawValue.trim() === '') return null

  const numberValue = Number(rawValue)
  if (!Number.isFinite(numberValue)) return null

  const clampedValue = Math.min(100, Math.max(0, numberValue))
  return Math.round(clampedValue * 1000) / 1000
}

function getVolumeKey(volume) {
  return volume.toFixed(3)
}

export function getCurrentVolume(ctx) {
  const candidates = [
    ctx?.player?.volume,
    ctx?.player?.store?.volume,
    ctx?.stores?.player?.volume,
  ]

  for (const candidate of candidates) {
    const volume = normalizeVolume(candidate)
    if (volume != null) return volume
  }

  return null
}

export function sendVolumeState(state, ctx, options = {}) {
  const volume = getCurrentVolume(ctx)
  if (volume == null) return false

  const volumeKey = getVolumeKey(volume)
  if (options.force !== true && state.lastSentVolumeKey === volumeKey) return true

  const sent = sendPluginCommand(state, 'set_volume', { volume })
  if (sent) state.lastSentVolumeKey = volumeKey
  return sent
}

export function handleSetVolume(state, ctx, data) {
  const volume = normalizeVolume(data?.volume)
  if (volume == null) return
  if (typeof ctx?.player?.setVolume !== 'function') return

  state.lastSentVolumeKey = getVolumeKey(volume)

  try {
    ctx.player.setVolume(volume)
  } catch {
    // 设置音量失败时保持静默，避免服务端误判协议失败。
  }
}

export function initVolumeWatch(state, ctx) {
  if (typeof ctx.vue?.watch !== 'function') return

  state.unsubVolumeWatch = ctx.vue.watch(
    () => {
      const volume = getCurrentVolume(ctx)
      return volume == null ? '' : getVolumeKey(volume)
    },
    (nextKey, previousKey) => {
      if (state.disposed || !isWsOpen(state)) return
      if (!nextKey || nextKey === previousKey) return
      sendVolumeState(state, ctx)
    },
  )
}
