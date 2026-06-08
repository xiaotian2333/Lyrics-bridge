export default async function (ctx) {
  const DEFAULT_SERVER_URL = 'ws://127.0.0.1:17195'
  const RETRY_DELAYS = [300, 800, 1500, 3000, 5000]
  const COVER_SIZE = 400
  const COVER_TIMEOUT_MS = 5000
  const MAX_COVER_BYTES = 4 * 1024 * 1024
  const MAX_COVER_CACHE_SIZE = 20

  let ws = null
  let pingTimer = null
  let reconnectTimer = null
  let connecting = false
  let seq = 0
  let statusEl = null
  let statusContainer = null
  let statusObserver = null
  let unsubNowPlaying = null
  let lyricRetryTimers = []
  let latestSnapshot = null
  let lastTrackKey = ''
  let lastSentMusicDataKey = ''
  let sendingMusicDataKey = ''
  let disposed = false

  const coverBase64Cache = new Map()

  const nextSeq = () => ++seq

  const unwrapValue = (value) => {
    if (value && typeof value === 'object' && 'value' in value) return value.value
    return value
  }

  const toText = (value) => String(value ?? '').trim()

  const isWsOpen = () => ws && ws.readyState === WebSocket.OPEN

  const getConfig = async () => {
    const storedServerUrl = await ctx.storage.get('serverUrl')
    const serverUrl = toText(storedServerUrl) || DEFAULT_SERVER_URL
    const autoReconnect = await ctx.storage.get('autoReconnect')
    return { serverUrl, autoReconnect: autoReconnect !== false }
  }

  const setStatus = (status) => {
    if (!statusEl) return
    statusEl.className = `winisland-status ${status}`
    const label = statusEl.querySelector('.label')
    if (!label) return
    const map = {
      connected: { text: 'EchoMusic-Lyrics-WinIsland 已连接' },
      disconnected: { text: 'EchoMusic-Lyrics-WinIsland 未连接' },
      connecting: { text: '连接中...' },
    }
    label.textContent = map[status]?.text || status
  }

  const send = (msg) => {
    if (!isWsOpen()) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  const clearLyricRetryTimers = () => {
    lyricRetryTimers.forEach(timer => clearTimeout(timer))
    lyricRetryTimers = []
  }

  const getCurrentTrack = () => {
    const currentTrack = ctx.stores?.player?.currentTrackSnapshot ?? ctx.player?.currentTrack
    return unwrapValue(currentTrack) || null
  }

  const getTrackKey = (snapshot) => {
    const playback = snapshot?.playback
    return toText(playback?.lyricHash || playback?.trackId)
  }

  const getCurrentTrackForSnapshot = (snapshot) => {
    const track = getCurrentTrack()
    if (!track) return null

    const trackKey = getTrackKey(snapshot)
    if (!trackKey) return track

    const currentTrackId = unwrapValue(ctx.stores?.player?.currentTrackId)
    const candidates = [track.hash, track.id, track.songId, currentTrackId]
      .map(toText)
      .filter(Boolean)

    return candidates.includes(trackKey) ? track : null
  }

  const splitArtists = (value) => toText(value)
    .split(/\s*(?:、|,|\/|&|；|;|\|)\s*/)
    .map(item => item.trim())
    .filter(Boolean)

  const normalizeArtistList = (artistList) => {
    if (!Array.isArray(artistList)) return []

    const artists = artistList
      .map(artist => artist?.name || artist?.title || artist?.nickname || artist)
      .map(toText)
      .filter(Boolean)

    return Array.from(new Set(artists))
  }

  const getTrackArtists = (track, playback) => {
    const artistList = normalizeArtistList(track?.artists)
    if (artistList.length > 0) return artistList

    const singerList = normalizeArtistList(track?.singers)
    if (singerList.length > 0) return singerList

    const artists = splitArtists(playback?.artist || track?.artist)
    return Array.from(new Set(artists))
  }

  const toMilliseconds = (time) => {
    const value = Number(time)
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.round(value * 1000))
  }

  const toSeekSeconds = (data, msgPayload) => {
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

  const normalizeCoverUrl = (url, size = COVER_SIZE) => {
    const rawUrl = toText(url)
    if (!rawUrl) return ''
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(rawUrl)) return rawUrl

    let cover = rawUrl.replace(/^http:\/\//i, 'https://')
    if (cover.includes('{size}')) {
      cover = cover.split('{size}').join(String(size))
    }
    return cover.replace('c1.kgimg.com', 'imge.kugou.com')
  }

  const stripDataUrlPrefix = (value) => {
    const text = toText(value)
    const match = text.match(/^data:[^,]+;base64,(.*)$/i)
    return match ? match[1].trim() : text
  }

  const rememberCoverBase64 = (url, base64) => {
    if (!url || !base64) return
    coverBase64Cache.set(url, base64)
    if (coverBase64Cache.size <= MAX_COVER_CACHE_SIZE) return

    const firstKey = coverBase64Cache.keys().next().value
    if (firstKey) coverBase64Cache.delete(firstKey)
  }

  const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize)
      binary += String.fromCharCode(...chunk)
    }

    return btoa(binary)
  }

  const fetchCoverBase64 = async (url) => {
    const normalizedUrl = normalizeCoverUrl(url)
    if (!normalizedUrl) return ''

    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(normalizedUrl)) {
      const base64 = stripDataUrlPrefix(normalizedUrl)
      rememberCoverBase64(normalizedUrl, base64)
      return base64
    }

    if (coverBase64Cache.has(normalizedUrl)) {
      return coverBase64Cache.get(normalizedUrl) || ''
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
      rememberCoverBase64(normalizedUrl, base64)
      return base64
    } catch {
      return ''
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  const getCoverBase64 = async (snapshot, track) => {
    const coverUrl = normalizeCoverUrl(snapshot?.playback?.coverUrl || track?.coverUrl || track?.cover)
    if (!coverUrl) return ''

    if (coverBase64Cache.has(coverUrl)) {
      return coverBase64Cache.get(coverUrl) || ''
    }

    return fetchCoverBase64(coverUrl)
  }

  const getLoadedLyricHash = () => toText(unwrapValue(ctx.stores?.lyric?.loadedHash))

  const hasRealLyrics = (snapshot, expectedTrackKey = '') => {
    if (!snapshot?.playback || !snapshot?.lyric) return false

    const trackKey = getTrackKey(snapshot)
    if (!trackKey) return false
    if (expectedTrackKey && trackKey !== expectedTrackKey) return false

    const lyricLines = snapshot.lyric.lines
    if (!Array.isArray(lyricLines) || lyricLines.length === 0) return false
    if (snapshot.lyric.isLoading === true) return false
    if (toText(snapshot.lyric.tips) === '歌词加载中...') return false

    const lyricTrackId = toText(snapshot.lyric.trackId)
    if (lyricTrackId && lyricTrackId !== trackKey) return false

    const loadedHash = getLoadedLyricHash()
    if (loadedHash && loadedHash !== trackKey) return false

    return true
  }

  const buildLyrics = (lyricLines) => lyricLines.map(line => ({
    time_ms: toMilliseconds(line?.time),
    text: String(line?.text ?? ''),
  }))

  const buildMusicDataPayload = async (snapshot) => {
    const track = getCurrentTrackForSnapshot(snapshot)
    const playback = snapshot.playback || {}
    const artists = getTrackArtists(track, playback)
    const artistText = artists.length > 0 ? artists.join('、') : toText(playback.artist || track?.artist)
    const coverBase64 = await getCoverBase64(snapshot, track)

    return {
      Metadata: {
        id: toText(track?.id ?? track?.songId ?? playback.trackId ?? track?.hash ?? playback.lyricHash),
        title: toText(playback.title || track?.title || track?.name),
        artist: artistText,
        artists,
        cover_base64: coverBase64,
      },
      lyrics: buildLyrics(snapshot.lyric.lines || []),
    }
  }

  const refreshLatestSnapshot = async () => {
    if (!ctx.nowPlaying?.getSnapshot) return latestSnapshot

    try {
      const snapshot = await ctx.nowPlaying.getSnapshot()
      latestSnapshot = snapshot
      const trackKey = getTrackKey(snapshot)
      if (trackKey && !lastTrackKey) lastTrackKey = trackKey
      return snapshot
    } catch {
      return latestSnapshot
    }
  }

  const getMusicDataKey = (snapshot) => {
    const trackKey = getTrackKey(snapshot)
    const revision = Number(snapshot?.lyric?.revision || 0)
    const lineCount = Array.isArray(snapshot?.lyric?.lines) ? snapshot.lyric.lines.length : 0
    return `${trackKey}:${revision}:${lineCount}`
  }

  const sendMusicData = async (options = {}) => {
    const force = options.force === true
    const expectedTrackKey = toText(options.expectedTrackKey)

    if (disposed || !isWsOpen()) return false

    let snapshot = latestSnapshot
    if (!hasRealLyrics(snapshot, expectedTrackKey)) {
      snapshot = await refreshLatestSnapshot()
    }
    if (!hasRealLyrics(snapshot, expectedTrackKey)) return false

    const trackKey = getTrackKey(snapshot)
    const expectedKey = expectedTrackKey || trackKey
    const musicDataKey = getMusicDataKey(snapshot)

    if (!force && lastSentMusicDataKey === musicDataKey) return true
    if (!force && sendingMusicDataKey === musicDataKey) return false

    sendingMusicDataKey = musicDataKey

    try {
      const payload = await buildMusicDataPayload(snapshot)
      const currentTrackKey = getTrackKey(latestSnapshot)
      if (disposed || !isWsOpen()) return false
      if (expectedKey && currentTrackKey && currentTrackKey !== expectedKey) return false
      if (!hasRealLyrics(latestSnapshot || snapshot, expectedKey)) return false

      const sent = send({ type: 'MusicData', seq: nextSeq(), payload })
      if (sent) lastSentMusicDataKey = musicDataKey
      return sent
    } finally {
      if (sendingMusicDataKey === musicDataKey) sendingMusicDataKey = ''
    }
  }

  const scheduleMusicDataRetry = (expectedTrackKey) => {
    clearLyricRetryTimers()
    const trackKey = toText(expectedTrackKey)
    if (disposed || !trackKey) return

    lyricRetryTimers = RETRY_DELAYS.map(delay => setTimeout(async () => {
      const sentRealLyrics = await sendMusicData({ expectedTrackKey: trackKey, reason: `retry-${delay}` })
      if (sentRealLyrics) clearLyricRetryTimers()
    }, delay))
  }

  const handleSnapshot = (snapshot) => {
    latestSnapshot = snapshot
    const trackKey = getTrackKey(snapshot)
    if (!trackKey) return

    if (trackKey !== lastTrackKey) {
      lastTrackKey = trackKey
      lastSentMusicDataKey = ''
      clearLyricRetryTimers()
      if (isWsOpen()) scheduleMusicDataRetry(trackKey)
      return
    }

    if (isWsOpen() && hasRealLyrics(snapshot, trackKey)) {
      const musicDataKey = getMusicDataKey(snapshot)
      if (lastSentMusicDataKey === musicDataKey) {
        clearLyricRetryTimers()
        return
      }

      void sendMusicData({ expectedTrackKey: trackKey, reason: 'snapshot' }).then((sent) => {
        if (sent) clearLyricRetryTimers()
      })
    }
  }

  const initNowPlayingSubscription = async () => {
    await refreshLatestSnapshot()

    if (!ctx.nowPlaying?.onSnapshot) return

    unsubNowPlaying = ctx.nowPlaying.onSnapshot((snapshot) => {
      if (disposed) return
      handleSnapshot(snapshot)
    })
  }

  const subscribe = () => {
    send({
      type: 'subscribe',
      seq: nextSeq(),
      payload: { events: ['control', 'state', 'media'] },
    })
  }

  const startPing = () => {
    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      send({ type: 'ping' })
    }, 10000)
  }

  const stopPing = () => {
    if (!pingTimer) return
    clearInterval(pingTimer)
    pingTimer = null
  }

  const showNotification = (data) => {
    const title = toText(data?.title)
    const message = toText(data?.message)
    const text = [title, message].filter(Boolean).join(': ')
    if (text) ctx.toast.info(text, 4000)
  }

  const handleMessage = (data) => {
    try {
      const msg = JSON.parse(data)
      if (msg.type === 'pong' || msg.type === 'ack') return

      if (msg.type === 'command') {
        const action = msg.payload?.action
        const actionData = msg.payload?.data

        switch (action) {
          case 'request_track_lyrics':
          case 'request_lyrics':
            void sendMusicData({ force: true, reason: 'request' })
            break
          case 'show_notification':
            showNotification(actionData)
            break
          case 'play':
            ctx.player.play()
            break
          case 'pause':
            ctx.player.pause()
            break
          case 'toggle_play':
            ctx.player.toggle()
            break
          case 'next':
            ctx.player.next()
            break
          case 'prev':
            ctx.player.prev()
            break
          case 'seek': {
            const seekSeconds = toSeekSeconds(actionData, msg.payload)
            if (seekSeconds != null) {
              ctx.player.seek(seekSeconds)
            }
            break
          }
        }
      }

      if (msg.type === 'state' && msg.payload?.media) {
        // 预留状态同步入口，当前协议暂不根据服务端 media 修改 EchoMusic 状态
      }
    } catch {
      // 忽略解析错误
    }
  }

  const scheduleReconnect = async () => {
    if (disposed) return

    const { autoReconnect } = await getConfig()
    if (disposed || !autoReconnect) return
    if (reconnectTimer) clearTimeout(reconnectTimer)

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, 5000)
  }

  const connect = async () => {
    if (disposed || connecting) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

    connecting = true
    setStatus('connecting')

    const { serverUrl } = await getConfig()
    if (disposed) {
      connecting = false
      return
    }

    try {
      ws = new WebSocket(serverUrl)

      ws.onopen = async () => {
        connecting = false
        setStatus('connected')
        ctx.toast.success('已连接到 EchoMusic-Lyrics-WinIsland')

        let sentMusicData = false
        try {
          await refreshLatestSnapshot()
          sentMusicData = await sendMusicData({ force: true, reason: 'connect' })
        } finally {
          if (!disposed && isWsOpen()) {
            subscribe()
            startPing()
            const trackKey = getTrackKey(latestSnapshot)
            if (!sentMusicData && trackKey) scheduleMusicDataRetry(trackKey)
          }
        }
      }

      ws.onmessage = (event) => handleMessage(event.data)

      ws.onclose = () => {
        connecting = false
        stopPing()
        ws = null
        setStatus('disconnected')
        void scheduleReconnect()
      }

      ws.onerror = () => {
        connecting = false
      }
    } catch {
      connecting = false
      setStatus('disconnected')
      void scheduleReconnect()
    }
  }

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    stopPing()
    if (ws) {
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
      ws = null
    }
    connecting = false
    setStatus('disconnected')
  }

  // 挂载状态指示器到侧边栏底部
  const mountStatusIndicator = () => {
    const container = document.createElement('div')
    container.style.padding = '8px 12px'
    container.innerHTML = `
      <div class="winisland-status disconnected">
        <span class="dot"></span>
        <span class="label">EchoMusic-Lyrics-WinIsland 未连接</span>
      </div>
    `
    statusContainer = container
    statusEl = container.querySelector('.winisland-status')
    if (!statusEl) return

    statusEl.addEventListener('click', () => {
      if (connecting) return
      if (isWsOpen()) {
        disconnect()
      } else {
        void connect()
      }
    })

    const mount = () => {
      if (disposed || !statusContainer) return
      const sidebar = document.querySelector('.sidebar-footer, .sidebar-bottom, [class*="sidebar"]')
      if (sidebar) {
        sidebar.appendChild(statusContainer)
        statusObserver?.disconnect()
        statusObserver = null
        return
      }
      if (!statusContainer.parentNode) {
        document.body.appendChild(statusContainer)
      }
    }

    statusObserver = new MutationObserver(mount)
    statusObserver.observe(document.body, { childList: true, subtree: true })
    mount()
  }

  // 设置面板
  const SettingsPanel = {
    name: 'WinIslandBridgeSettings',
    setup() {
      const { h, ref, onMounted } = ctx.vue
      const serverUrl = ref(DEFAULT_SERVER_URL)
      const autoReconnect = ref(true)
      const saving = ref(false)

      const reload = async () => {
        const config = await getConfig()
        serverUrl.value = config.serverUrl
        autoReconnect.value = config.autoReconnect
      }

      const saveAndReconnect = async () => {
        if (saving.value) return
        saving.value = true
        try {
          const nextServerUrl = toText(serverUrl.value) || DEFAULT_SERVER_URL
          serverUrl.value = nextServerUrl
          await ctx.storage.set('serverUrl', nextServerUrl)
          await ctx.storage.set('autoReconnect', Boolean(autoReconnect.value))
          disconnect()
          await connect()
          ctx.toast.success('EchoMusic-Lyrics-WinIsland 设置已保存')
        } catch {
          ctx.toast.warning('EchoMusic-Lyrics-WinIsland 设置保存失败')
        } finally {
          saving.value = false
        }
      }

      onMounted(() => {
        reload()
      })

      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '14px 0',
        borderBottom: '1px solid var(--color-border, rgba(128, 128, 128, 0.18))',
      }
      const labelStyle = {
        fontSize: '14px',
        fontWeight: '700',
        color: 'var(--color-text-main, inherit)',
      }
      const descriptionStyle = {
        marginTop: '4px',
        fontSize: '12px',
        color: 'var(--color-text-secondary, rgba(128, 128, 128, 0.8))',
      }
      const inputStyle = {
        width: '280px',
        maxWidth: '100%',
        height: '36px',
        padding: '0 12px',
        borderRadius: '10px',
        border: '1px solid var(--control-border, rgba(128, 128, 128, 0.28))',
        background: 'var(--control-muted-bg, rgba(128, 128, 128, 0.12))',
        color: 'var(--color-text-main, inherit)',
        outline: 'none',
      }

      return () => h('div', { style: { display: 'grid', gap: '4px' } }, [
        h('div', { style: rowStyle }, [
          h('div', null, [
            h('div', { style: labelStyle }, '服务端地址'),
            h('div', { style: descriptionStyle }, 'EchoMusic-Lyrics-WinIsland WebSocket 服务地址'),
          ]),
          h('input', {
            value: serverUrl.value,
            placeholder: DEFAULT_SERVER_URL,
            disabled: saving.value,
            style: inputStyle,
            onInput: (event) => {
              serverUrl.value = event.target.value
            },
            onKeydown: (event) => {
              if (event.key === 'Enter') saveAndReconnect()
            },
          }),
        ]),
        h('div', { style: rowStyle }, [
          h('div', null, [
            h('div', { style: labelStyle }, '自动重连'),
            h('div', { style: descriptionStyle }, '断开后自动重新连接'),
          ]),
          h('input', {
            type: 'checkbox',
            checked: autoReconnect.value,
            disabled: saving.value,
            style: { width: '20px', height: '20px', accentColor: 'var(--color-primary, #1a73e8)' },
            onChange: (event) => {
              autoReconnect.value = event.target.checked
            },
          }),
        ]),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', paddingTop: '14px' } }, [
          h('button', {
            type: 'button',
            disabled: saving.value,
            style: {
              height: '36px',
              padding: '0 16px',
              border: 0,
              borderRadius: '10px',
              background: 'var(--color-primary, #1a73e8)',
              color: '#fff',
              fontWeight: '700',
              cursor: saving.value ? 'not-allowed' : 'pointer',
              opacity: saving.value ? 0.65 : 1,
            },
            onClick: saveAndReconnect,
          }, saving.value ? '保存中...' : '保存并重连'),
        ]),
      ])
    },
  }

  ctx.ui.settings.define({
    id: 'Lyrics-bridge',
    title: '歌词桥接工具',
    description: '将 EchoMusic 的歌词和播放状态推送到外部歌词软件，并支持接收外部歌词软件的播放控制指令',
    component: SettingsPanel,
  })

  await initNowPlayingSubscription()

  // 挂载状态指示
  mountStatusIndicator()

  // 启动连接
  await connect()

  // 清理函数
  ctx.dispose(() => {
    disposed = true
    clearLyricRetryTimers()
    disconnect()
    if (unsubNowPlaying) {
      unsubNowPlaying()
      unsubNowPlaying = null
    }
    if (statusObserver) {
      statusObserver.disconnect()
      statusObserver = null
    }
    if (statusContainer) {
      statusContainer.remove()
      statusContainer = null
    }
    statusEl = null
    latestSnapshot = null
    coverBase64Cache.clear()
  })
}
