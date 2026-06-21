export function createState() {
  return {
    ws: null,
    pingTimer: null,
    reconnectTimer: null,
    connecting: false,
    seq: 0,
    unsubNowPlaying: null,
    unsubFavoriteWatch: null,
    latestSnapshot: null,
    lastTrackKey: '',
    lastSentMusicDataKey: '',
    lastSentFavoriteStateKey: '',
    lastIsPlaying: false,
    lastPositionMs: 0,
    lastPositionTimestamp: 0,
    lastServerSeekTriggered: false,
    serverSeekClearTimer: null,
    helperPids: [],
    disposed: false,
    coverBase64Cache: new Map(),
  }
}

export function nextSeq(state) {
  state.seq += 1
  return state.seq
}
