import { normalizeArtistList, splitArtists, toMilliseconds, toText, unwrapValue } from './utils.js'

export function getCurrentTrack(ctx) {
  const currentTrack = ctx.stores?.player?.currentTrackSnapshot ?? ctx.player?.currentTrack
  return unwrapValue(currentTrack) || null
}

export function getTrackKey(snapshot) {
  const playback = snapshot?.playback
  return toText(playback?.lyricHash || playback?.trackId)
}

export function getCurrentTrackForSnapshot(ctx, snapshot) {
  const track = getCurrentTrack(ctx)
  if (!track) return null

  const trackKey = getTrackKey(snapshot)
  if (!trackKey) return track

  const currentTrackId = unwrapValue(ctx.stores?.player?.currentTrackId)
  const candidates = [track.hash, track.id, track.songId, currentTrackId]
    .map(toText)
    .filter(Boolean)

  return candidates.includes(trackKey) ? track : null
}

export function getTrackProtocolId(track, playback = {}) {
  return toText(track?.id ?? track?.songId ?? playback.trackId ?? track?.hash ?? playback.lyricHash)
}

export function getTrackIdentityCandidates(ctx, track, playback = {}) {
  return [
    track?.id,
    track?.songId,
    track?.hash,
    track?.mixSongId,
    track?.fileId,
    playback.trackId,
    playback.lyricHash,
    unwrapValue(ctx.stores?.player?.currentTrackId),
  ].map(toText).filter(Boolean)
}

export function isFavoriteTrack(ctx, track) {
  if (!track) return false
  try {
    return ctx.stores?.playlist?.isFavoriteSong?.(track) === true
  } catch {
    return false
  }
}

export function getFavoriteStateForSnapshot(ctx, snapshot) {
  return isFavoriteTrack(ctx, getCurrentTrackForSnapshot(ctx, snapshot))
}

export function getCurrentFavoriteWatchKey(state, ctx) {
  const snapshot = state.latestSnapshot
  const track = snapshot ? getCurrentTrackForSnapshot(ctx, snapshot) : getCurrentTrack(ctx)
  const playback = snapshot?.playback || {}
  const id = getTrackProtocolId(track, playback)
  if (!id) return ''
  return `${id}:${isFavoriteTrack(ctx, track) ? '1' : '0'}`
}

export function parseFavoriteWatchKey(key) {
  const text = toText(key)
  if (!text) return { id: '', isFavorite: false }
  const index = text.lastIndexOf(':')
  if (index < 0) return { id: text, isFavorite: false }
  return {
    id: text.slice(0, index),
    isFavorite: text.slice(index + 1) === '1',
  }
}

export function getTrackArtists(track, playback) {
  const artistList = normalizeArtistList(track?.artists)
  if (artistList.length > 0) return artistList

  const singerList = normalizeArtistList(track?.singers)
  if (singerList.length > 0) return singerList

  const artists = splitArtists(playback?.artist || track?.artist)
  return Array.from(new Set(artists))
}

export function detectTrackDirection(state, ctx, newTrackId) {
  try {
    const queue = ctx.playlist?.getActiveQueue?.() || []
    if (!queue.length || !state.lastTrackKey) return 'next'

    const matchesId = (item, id) => {
      const itemId = toText(item?.id || item?.songId || item?.hash)
      return itemId === id
    }

    const oldIndex = queue.findIndex(item => matchesId(item, state.lastTrackKey))
    const newIndex = queue.findIndex(item => matchesId(item, newTrackId))

    if (oldIndex >= 0 && newIndex >= 0) {
      return newIndex > oldIndex ? 'next' : 'prev'
    }
  } catch { }

  return 'next'
}

export function getCurrentPositionMs(state) {
  const playback = state.latestSnapshot?.playback || {}
  return toMilliseconds(playback.currentTime || playback.position || 0)
}

export function getInterpolatedPositionMs(state) {
  const playback = state.latestSnapshot?.playback || {}
  const isPlaying = playback.isPlaying === true

  if (isPlaying && state.lastPositionTimestamp > 0) {
    const elapsed = Date.now() - state.lastPositionTimestamp
    return state.lastPositionMs + elapsed
  }

  return getCurrentPositionMs(state)
}

export function getCurrentAudioUrl(ctx) {
  try {
    const audioUrl = ctx.stores?.player?.currentAudioUrl
    if (audioUrl) return audioUrl
  } catch { }
  const track = getCurrentTrack(ctx)
  return track?.audioUrl || ''
}
