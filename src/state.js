export function createState() {
  return {
    ws: null,
    seekWs: null,
    pingTimer: null,
    seekTimer: null,
    reconnectTimer: null,
    connecting: false,
    seekConnecting: false,
    seekInterval: 0,
    seekSyncToken: 0,
    seq: 0,
    unsubNowPlaying: null,
    unsubFavoriteWatch: null,
    unsubVolumeWatch: null,
    unsubPlayModeWatch: null,
    latestSnapshot: null,
    lastTrackKey: '',
    lastSentMusicDataKey: '',
    lastSentFavoriteStateKey: '',
    lastSentVolumeKey: '',
    lastSentPlayModeKey: '',
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
