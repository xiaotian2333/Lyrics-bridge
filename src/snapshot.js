import { SEEK_THRESHOLD_MS } from './constants.js'
import { getMusicDataKey, sendMusicData } from './musicdata.js'
import { detectTrackDirection, getTrackKey } from './track.js'
import { toMilliseconds } from './utils.js'
import { isWsOpen, sendPluginCommand } from './websocket.js'

export async function refreshLatestSnapshot(state, ctx) {
  if (!ctx.nowPlaying?.getSnapshot) return state.latestSnapshot

  try {
    const snapshot = await ctx.nowPlaying.getSnapshot()
    state.latestSnapshot = snapshot
    const trackKey = getTrackKey(snapshot)
    if (trackKey && !state.lastTrackKey) state.lastTrackKey = trackKey
    return snapshot
  } catch {
    return state.latestSnapshot
  }
}

export function handleSnapshot(state, ctx, snapshot) {
  if (state.disposed) return

  state.latestSnapshot = snapshot

  const playback = snapshot.playback || {}
  const newTrackKey = getTrackKey(snapshot)
  const newIsPlaying = playback.isPlaying === true
  const newPositionMs = toMilliseconds(playback.currentTime || playback.position || 0)
  const now = Date.now()

  if (!newTrackKey) return

  // 曲目切换
  if (newTrackKey !== state.lastTrackKey) {
    const prevTrackKey = state.lastTrackKey
    state.lastTrackKey = newTrackKey
    state.lastSentMusicDataKey = ''
    state.lastPositionMs = newPositionMs
    state.lastPositionTimestamp = now
    state.lastIsPlaying = newIsPlaying

    if (isWsOpen(state)) {
      const direction = prevTrackKey ? detectTrackDirection(state, ctx, newTrackKey) : 'next'
      sendPluginCommand(state, direction, { position_ms: newPositionMs })
      sendMusicData(state, ctx, { force: true, expectedTrackKey: newTrackKey })
    }
    return
  }

  // 播放/暂停状态变化
  if (newIsPlaying !== state.lastIsPlaying) {
    state.lastIsPlaying = newIsPlaying
    state.lastPositionMs = newPositionMs
    state.lastPositionTimestamp = now
    if (isWsOpen(state)) {
      sendPluginCommand(state, newIsPlaying ? 'play' : 'pause', { position_ms: newPositionMs })
    }
    return
  }

  // 非自然 seek 检测（仅播放中）
  if (newIsPlaying && state.lastPositionTimestamp > 0) {
    const elapsed = now - state.lastPositionTimestamp
    const expectedPosition = state.lastPositionMs + elapsed
    const diff = Math.abs(newPositionMs - expectedPosition)

    if (diff > SEEK_THRESHOLD_MS && !state.lastServerSeekTriggered) {
      if (isWsOpen(state)) {
        sendPluginCommand(state, 'seek', { position_ms: newPositionMs, cause: 'user' })
      }
    }
    state.lastPositionMs = newPositionMs
    state.lastPositionTimestamp = now
  } else if (newIsPlaying) {
    state.lastPositionMs = newPositionMs
    state.lastPositionTimestamp = now
  } else {
    state.lastPositionMs = newPositionMs
    state.lastPositionTimestamp = now
  }

  // 歌词数据变更（同曲目）
  if (isWsOpen(state) && newTrackKey) {
    const musicDataKey = getMusicDataKey(ctx, snapshot)
    if (state.lastSentMusicDataKey && state.lastSentMusicDataKey !== musicDataKey) {
      const lyricLines = snapshot.lyric?.lines || []
      if (lyricLines.length > 0 || state.lastSentMusicDataKey) {
        sendMusicData(state, ctx, { force: true, expectedTrackKey: newTrackKey })
      }
    }
  }
}

export async function initNowPlayingSubscription(state, ctx) {
  await refreshLatestSnapshot(state, ctx)

  // 初始化状态值
  if (state.latestSnapshot) {
    const playback = state.latestSnapshot.playback || {}
    state.lastIsPlaying = playback.isPlaying === true
    state.lastPositionMs = toMilliseconds(playback.currentTime || playback.position || 0)
    state.lastPositionTimestamp = Date.now()
  }

  if (!ctx.nowPlaying?.onSnapshot) return

  state.unsubNowPlaying = ctx.nowPlaying.onSnapshot((snapshot) => {
    if (state.disposed) return
    handleSnapshot(state, ctx, snapshot)
  })
}
