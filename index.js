export default async function (ctx) {
  const DEFAULT_SERVER_URL = 'ws://127.0.0.1:17195'
  const COVER_SIZE = 400
  const COVER_TIMEOUT_MS = 5000
  const MAX_COVER_BYTES = 4 * 1024 * 1024
  const MAX_COVER_CACHE_SIZE = 20
  const SEEK_THRESHOLD_MS = 2000

  let ws = null
  let pingTimer = null
  let reconnectTimer = null
  let connecting = false
  let seq = 0
  let statusEl = null
  let statusContainer = null
  let statusObserver = null
  let unsubNowPlaying = null
  let latestSnapshot = null
  let lastTrackKey = ''
  let lastSentMusicDataKey = ''
  let lastIsPlaying = false
  let lastPositionMs = 0
  let lastPositionTimestamp = 0
  let lastServerSeekTriggered = false
  let serverSeekClearTimer = null
  let helperPids = []
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

  const sendPluginCommand = (action, data = {}) => {
    return send({
      type: 'command',
      source: 'plugin',
      payload: { action, data },
    })
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

    for (let index = 0; index < bytes.byteLength; index += chunkSize) {
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

    if (disposed || !isWsOpen()) return false

    let snapshot = latestSnapshot
    if (!snapshot) {
      snapshot = await refreshLatestSnapshot()
    }
    if (!snapshot) return false

    const musicDataKey = getMusicDataKey(snapshot)
    if (!force && lastSentMusicDataKey === musicDataKey) return true

    try {
      const payload = await buildMusicDataPayload(snapshot)
      if (disposed || !isWsOpen()) return false

      const currentTrackKey = getTrackKey(latestSnapshot)
      const expectedKey = options.expectedTrackKey || getTrackKey(snapshot)
      if (expectedKey && currentTrackKey && currentTrackKey !== expectedKey) return false

      const sent = send({ type: 'MusicData', seq: nextSeq(), payload })
      if (sent) lastSentMusicDataKey = musicDataKey
      return sent
    } catch {
      return false
    }
  }

  const detectTrackDirection = (newTrackId) => {
    try {
      const queue = ctx.playlist?.getActiveQueue?.() || []
      if (!queue.length || !lastTrackKey) return 'next'

      const matchesId = (item, id) => {
        const itemId = toText(item?.id || item?.songId || item?.hash)
        return itemId === id
      }

      const oldIndex = queue.findIndex(item => matchesId(item, lastTrackKey))
      const newIndex = queue.findIndex(item => matchesId(item, newTrackId))

      if (oldIndex >= 0 && newIndex >= 0) {
        return newIndex > oldIndex ? 'next' : 'prev'
      }
    } catch {}

    return 'next'
  }

  const getCurrentPositionMs = () => {
    const playback = latestSnapshot?.playback || {}
    return toMilliseconds(playback.currentTime || playback.position || 0)
  }

  const getCurrentAudioUrl = () => {
    try {
      const audioUrl = ctx.stores?.player?.currentAudioUrl
      if (audioUrl) return audioUrl
    } catch {}
    const track = getCurrentTrack()
    return track?.audioUrl || ''
  }

  const handleSnapshot = (snapshot) => {
    if (disposed) return

    const oldSnapshot = latestSnapshot
    latestSnapshot = snapshot

    const playback = snapshot.playback || {}
    const newTrackKey = getTrackKey(snapshot)
    const newIsPlaying = playback.isPlaying === true
    const newPositionMs = toMilliseconds(playback.currentTime || playback.position || 0)
    const now = Date.now()

    if (!newTrackKey) return

    // 曲目切换
    if (newTrackKey !== lastTrackKey) {
      const prevTrackKey = lastTrackKey
      lastTrackKey = newTrackKey
      lastSentMusicDataKey = ''
      lastPositionMs = newPositionMs
      lastPositionTimestamp = now
      lastIsPlaying = newIsPlaying

      if (isWsOpen()) {
        const direction = prevTrackKey ? detectTrackDirection(newTrackKey) : 'next'
        sendPluginCommand(direction, { position_ms: newPositionMs })
        sendMusicData({ force: true, expectedTrackKey: newTrackKey })
      }
      return
    }

    // 播放/暂停状态变化
    if (newIsPlaying !== lastIsPlaying) {
      lastIsPlaying = newIsPlaying
      lastPositionMs = newPositionMs
      lastPositionTimestamp = now
      if (isWsOpen()) {
        sendPluginCommand(newIsPlaying ? 'play' : 'pause', { position_ms: newPositionMs })
      }
      return
    }

    // 非自然 seek 检测（仅播放中）
    if (newIsPlaying && lastPositionTimestamp > 0) {
      const elapsed = now - lastPositionTimestamp
      const expectedPosition = lastPositionMs + elapsed
      const diff = Math.abs(newPositionMs - expectedPosition)

      if (diff > SEEK_THRESHOLD_MS && !lastServerSeekTriggered) {
        if (isWsOpen()) {
          sendPluginCommand('seek', { position_ms: newPositionMs, cause: 'user' })
        }
      }
      lastPositionMs = newPositionMs
      lastPositionTimestamp = now
    } else if (newIsPlaying) {
      lastPositionMs = newPositionMs
      lastPositionTimestamp = now
    } else {
      lastPositionMs = newPositionMs
      lastPositionTimestamp = now
    }

    // 歌词数据变更（同曲目）
    if (isWsOpen() && newTrackKey) {
      const musicDataKey = getMusicDataKey(snapshot)
      if (lastSentMusicDataKey && lastSentMusicDataKey !== musicDataKey) {
        const lyricLines = snapshot.lyric?.lines || []
        if (lyricLines.length > 0 || lastSentMusicDataKey) {
          sendMusicData({ force: true, expectedTrackKey: newTrackKey })
        }
      }
    }
  }

  const initNowPlayingSubscription = async () => {
    await refreshLatestSnapshot()

    // 初始化状态值
    if (latestSnapshot) {
      const playback = latestSnapshot.playback || {}
      lastIsPlaying = playback.isPlaying === true
      lastPositionMs = toMilliseconds(playback.currentTime || playback.position || 0)
      lastPositionTimestamp = Date.now()
    }

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

  const handleUploadMusicFile = async (data) => {
    const uploadUrl = data?.upload_url
    if (!uploadUrl) return

    const audioUrl = getCurrentAudioUrl()
    if (!audioUrl) return

    const track = getCurrentTrack()
    const normalizedUploadUrl = uploadUrl.replace(/\/+$/, '') + '/Music-file-upload'

    try {
      const fetcher = ctx.net?.fetch || fetch
      const audioResponse = await fetcher(audioUrl)
      if (!audioResponse?.ok) return

      const blob = await audioResponse.blob()

      const headers = {
        'Content-Type': blob.type || 'audio/mpeg',
      }

      if (track) {
        const trackId = toText(track?.id || track?.songId || track?.hash)
        if (trackId) headers['X-Music-Id'] = trackId
        const title = toText(track?.title || track?.name)
        if (title) headers['X-Music-Title'] = encodeURIComponent(title)
        const artist = toText(track?.artist)
        if (artist) headers['X-Music-Artist'] = encodeURIComponent(artist)
      }

      const uploadResponse = await fetcher(normalizedUploadUrl, {
        method: 'POST',
        headers,
        body: blob,
      })

      if (uploadResponse.status !== 200) {
        // 静默忽略非 200 响应
      }
    } catch {
      // 静默忽略上传失败
    }
  }

  const handleMessage = (data) => {
    try {
      const msg = JSON.parse(data)
      if (msg.type === 'pong' || msg.type === 'ack') return

      if (msg.type === 'command') {
        const source = msg.source || 'server'
        const action = msg.payload?.action
        const actionData = msg.payload?.data

        if (source === 'server') {
          switch (action) {
            case 'request_MusicData':
              void sendMusicData({ force: true, reason: 'request' })
              break
            case 'show_notification':
              showNotification(actionData)
              break
            case 'get_playback_state': {
              const positionMs = getCurrentPositionMs()
              const snapshot = latestSnapshot
              const playback = snapshot?.playback || {}
              const durationMs = toMilliseconds(playback.duration || 0)
              const isPlaying = playback.isPlaying === true
              sendPluginCommand('position', {
                position_ms: positionMs,
                duration_ms: durationMs,
                is_playing: isPlaying,
              })
              break
            }
            case 'get_software_info': {
              sendPluginCommand('software_info', {
                name: ctx.manifest?.name || 'EchoMusic',
                version: ctx.manifest?.version || '',
                author: ctx.manifest?.author || '',
              })
              break
            }
            case 'upload_music_file':
              void handleUploadMusicFile(actionData)
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
                // 标记为由服务端触发的 seek，防闭环
                lastServerSeekTriggered = true
                if (serverSeekClearTimer) clearTimeout(serverSeekClearTimer)
                serverSeekClearTimer = setTimeout(() => {
                  lastServerSeekTriggered = false
                  serverSeekClearTimer = null
                }, 1500)
                ctx.player.seek(seekSeconds)
              }
              break
            }
          }
        }
      }

      if (msg.type === 'state' && msg.payload?.media) {
        // 预留状态同步入口
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

        await refreshLatestSnapshot()
        if (!disposed && isWsOpen()) {
          // 连接成功后发送 MusicData（可能有歌词也可能没有）
          await sendMusicData({ force: true, reason: 'connect' })
          subscribe()
          startPing()
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
      const autoLaunch = ref(true)
      const saving = ref(false)

      const reload = async () => {
        const config = await getConfig()
        serverUrl.value = config.serverUrl
        autoReconnect.value = config.autoReconnect
        const savedAutoLaunch = await ctx.storage.get('autoLaunch')
        autoLaunch.value = savedAutoLaunch !== false
      }

      const saveAndReconnect = async () => {
        if (saving.value) return
        saving.value = true
        try {
          const nextServerUrl = toText(serverUrl.value) || DEFAULT_SERVER_URL
          serverUrl.value = nextServerUrl
          await ctx.storage.set('serverUrl', nextServerUrl)
          await ctx.storage.set('autoReconnect', Boolean(autoReconnect.value))
          await ctx.storage.set('autoLaunch', Boolean(autoLaunch.value))
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
        h('div', { style: rowStyle }, [
          h('div', null, [
            h('div', { style: labelStyle }, '自动启动辅助进程'),
            h('div', { style: descriptionStyle }, 'EchoMusic 启动时自动运行 bridge 服务端'),
          ]),
          h('input', {
            type: 'checkbox',
            checked: autoLaunch.value,
            disabled: saving.value,
            style: { width: '20px', height: '20px', accentColor: 'var(--color-primary, #1a73e8)' },
            onChange: (event) => {
              autoLaunch.value = event.target.checked
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

  // 启动外部辅助进程
  const launchHelper = async () => {
    if (disposed) return

    const platform = ctx.electron?.platform
    if (platform !== 'win32') return

    const isEnabled = await ctx.storage.get('autoLaunch')
    if (isEnabled === false) return

    const result = await ctx.process.launch({
      executable: 'bin/EchoMusic-Lyrics-WinIsland.exe',
      args: [],
      cwd: 'bin',
    })

    if (result.ok) {
      helperPids.push(result.pid)
    } else if (!result.canceled) {
      ctx.toast.warning(result.error || '启动辅助进程失败')
    }
  }

  void launchHelper()

  // 清理函数
  ctx.dispose(() => {
    disposed = true
    if (serverSeekClearTimer) {
      clearTimeout(serverSeekClearTimer)
      serverSeekClearTimer = null
    }

    // 终止外部辅助进程
    helperPids.forEach(pid => {
      try { ctx.process.terminate(pid) } catch {}
    })
    helperPids = []

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
    lastTrackKey = ''
    lastSentMusicDataKey = ''
    coverBase64Cache.clear()
  })
}
