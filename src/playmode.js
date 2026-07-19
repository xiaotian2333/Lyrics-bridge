import { isWsOpen, sendPluginCommand } from './websocket.js'

const VALID_PLAY_MODES = ['sequential', 'list', 'random', 'single']

export function normalizePlayMode(value) {
  if (VALID_PLAY_MODES.includes(value)) return value
  return null
}

export function getCurrentPlayMode(ctx) {
  const mode = ctx?.stores?.player?.playMode
  const normalized = normalizePlayMode(mode)
  if (normalized) return normalized
  return 'list'
}

export function sendPlayModeState(state, ctx, options = {}) {
  const mode = getCurrentPlayMode(ctx)
  const modeKey = mode
  if (options.force !== true && state.lastSentPlayModeKey === modeKey) return true

  const sent = sendPluginCommand(state, 'set_play_mode', { mode })
  if (sent) state.lastSentPlayModeKey = modeKey
  return sent
}

export function handleSetPlayMode(state, ctx, data) {
  const mode = normalizePlayMode(data?.mode)
  if (!mode) return
  if (typeof ctx?.player?.setPlayMode !== 'function') return

  state.lastSentPlayModeKey = mode

  try {
    ctx.player.setPlayMode(mode)
  } catch {
  }
}

export function initPlayModeWatch(state, ctx) {
  if (typeof ctx.vue?.watch !== 'function') return

  state.unsubPlayModeWatch = ctx.vue.watch(
    () => {
      const mode = getCurrentPlayMode(ctx)
      return mode
    },
    (nextKey, previousKey) => {
      if (state.disposed || !isWsOpen(state)) return
      if (!nextKey || nextKey === previousKey) return
      sendPlayModeState(state, ctx)
    },
  )
}
