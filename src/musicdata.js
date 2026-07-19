import { getCoverBase64 } from './cover.js'
import { buildLyrics } from './lyrics.js'
import { refreshLatestSnapshot } from './snapshot.js'
import { nextSeq } from './state.js'
import {
  getCurrentTrackForSnapshot,
  getFavoriteStateForSnapshot,
  getTrackArtists,
  getTrackKey,
  getTrackProtocolId,
  isFavoriteTrack,
} from './track.js'
import { getCurrentPlayMode } from './playmode.js'
import { toText } from './utils.js'
import { isWsOpen, send } from './websocket.js'

export async function buildMusicDataPayload(state, ctx, snapshot) {
  const track = getCurrentTrackForSnapshot(ctx, snapshot)
  const playback = snapshot.playback || {}
  const artists = getTrackArtists(track, playback)
  const artistText = artists.length > 0 ? artists.join('、') : toText(playback.artist || track?.artist)
  const coverBase64 = await getCoverBase64(state, ctx, snapshot, track)

  return {
    Metadata: {
      id: getTrackProtocolId(track, playback),
      title: toText(playback.title || track?.title || track?.name),
      artist: artistText,
      artists,
      cover_base64: coverBase64,
      is_favorite: isFavoriteTrack(ctx, track),
      play_mode: getCurrentPlayMode(ctx),
    },
    lyrics: buildLyrics(snapshot.lyric.lines || []),
  }
}

export function getMusicDataKey(ctx, snapshot) {
  const trackKey = getTrackKey(snapshot)
  const revision = Number(snapshot?.lyric?.revision || 0)
  const lineCount = Array.isArray(snapshot?.lyric?.lines) ? snapshot.lyric.lines.length : 0
  const playMode = getCurrentPlayMode(ctx)
  return `${trackKey}:${revision}:${lineCount}:${getFavoriteStateForSnapshot(ctx, snapshot) ? 'fav' : 'normal'}:${playMode}`
}

export async function sendMusicData(state, ctx, options = {}) {
  const force = options.force === true

  if (state.disposed || !isWsOpen(state)) return false

  let snapshot = state.latestSnapshot
  if (!snapshot) {
    snapshot = await refreshLatestSnapshot(state, ctx)
  }
  if (!snapshot) return false

  const musicDataKey = getMusicDataKey(ctx, snapshot)
  if (!force && state.lastSentMusicDataKey === musicDataKey) return true

  try {
    const payload = await buildMusicDataPayload(state, ctx, snapshot)
    if (state.disposed || !isWsOpen(state)) return false

    const currentTrackKey = getTrackKey(state.latestSnapshot)
    const expectedKey = options.expectedTrackKey || getTrackKey(snapshot)
    if (expectedKey && currentTrackKey && currentTrackKey !== expectedKey) return false

    const sent = send(state, { type: 'MusicData', seq: nextSeq(state), payload })
    if (sent) state.lastSentMusicDataKey = musicDataKey
    return sent
  } catch {
    return false
  }
}
