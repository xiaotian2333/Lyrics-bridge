export default async function (ctx) {
  let ws = null
  let pingTimer = null
  let reconnectTimer = null
  let connecting = false
  let seq = 0
  let statusEl = null
  let unsubTrackChange = null
  let lyricRetryTimers = []

  const nextSeq = () => ++seq

  const getConfig = async () => {
    const serverUrl = await ctx.storage.get('serverUrl') || 'ws://127.0.0.1:17195'
    const autoReconnect = await ctx.storage.get('autoReconnect')
    return { serverUrl, autoReconnect: autoReconnect !== false }
  }

  const setStatus = (status) => {
    if (!statusEl) return
    statusEl.className = `winisland-status ${status}`
    const dot = statusEl.querySelector('.dot')
    const label = statusEl.querySelector('.label')
    if (!dot || !label) return
    const map = {
      connected: { text: 'EchoMusic-Lyrics-WinIsland 已连接' },
      disconnected: { text: 'EchoMusic-Lyrics-WinIsland 未连接' },
      connecting: { text: '连接中...' },
    }
    label.textContent = map[status]?.text || status
  }

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }

  const clearLyricRetryTimers = () => {
    lyricRetryTimers.forEach(timer => clearTimeout(timer))
    lyricRetryTimers = []
  }

  const getCurrentTrack = () => {
    const currentTrack = ctx.player.currentTrack
    return currentTrack?.value || currentTrack || ctx.stores?.player?.currentTrackSnapshot || null
  }

  const getTrackArtists = (track) => {
    const artistList = track?.artists || track?.singers || []
    if (Array.isArray(artistList) && artistList.length > 0) {
      return artistList
        .map(artist => artist?.name || artist)
        .filter(Boolean)
        .map(String)
    }
    return String(track?.artist || '').split(/\s*[、,/&]\s*/).filter(Boolean)
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

  const sendTrackLyrics = () => {
    const track = getCurrentTrack()
    const lyricLines = ctx.lyric.lines || []
    const isLoading = ctx.lyric.isLoading
    const tips = ctx.lyric.tips

    // 歌词未加载完成或没有真实歌词时不推送 track_lyrics 事件
    if (isLoading || tips === '歌词加载中...' || lyricLines.length === 0) return false

    const artists = getTrackArtists(track)
    const payload = {
      track: {
        id: track?.id || track?.songId || track?.hash || '',
        title: track?.title || track?.name || '',
        artist: artists.join('、'),
        artists,
      },
      lyrics: lyricLines.map(line => ({
        time_ms: toMilliseconds(line.time),
        text: line.text,
      })),
    }

    send({ type: 'track_lyrics', seq: nextSeq(), payload })
    return true
  }

  const scheduleLyricsSync = () => {
    clearLyricRetryTimers()

    const retryDelays = [300, 800, 1500, 3000, 5000]
    lyricRetryTimers = retryDelays.map(delay => setTimeout(() => {
      const sentRealLyrics = sendTrackLyrics()
      if (sentRealLyrics) clearLyricRetryTimers()
    }, delay))
  }

  const subscribe = () => {
    send({
      type: 'subscribe',
      seq: nextSeq(),
      payload: { events: ['control', 'state', 'media'] },
    })
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
            sendTrackLyrics()
            break
          case 'show_notification':
            if (actionData) {
              ctx.toast.show(`${actionData.title}: ${actionData.message}`, { duration: 4000 })
            }
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
        // 可选的：根据 EchoMusic-Lyrics-WinIsland 端 media 信息做同步
      }
    } catch (e) {
      // 忽略解析错误
    }
  }

  const connect = async () => {
    if (connecting) return
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    connecting = true
    setStatus('connecting')

    const { serverUrl } = await getConfig()

    try {
      ws = new WebSocket(serverUrl)

      ws.onopen = () => {
        connecting = false
        setStatus('connected')
        ctx.toast.success('已连接到 WinIsland')

        sendTrackLyrics()
        subscribe()

        pingTimer = setInterval(() => {
          send({ type: 'ping' })
        }, 10000)
      }

      ws.onmessage = (e) => handleMessage(e.data)

      ws.onclose = () => {
        connecting = false
        setStatus('disconnected')
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = null
        }
        ws = null
        scheduleReconnect()
      }

      ws.onerror = () => {
        connecting = false
      }
    } catch (e) {
      connecting = false
      setStatus('disconnected')
      scheduleReconnect()
    }
  }

  const scheduleReconnect = async () => {
    const { autoReconnect } = await getConfig()
    if (!autoReconnect) return
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => connect(), 5000)
  }

  const disconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (ws) {
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
      <div class="EchoMusic-Lyrics-WinIsland-status disconnected">
        <span class="dot"></span>
        <span class="label">EchoMusic-Lyrics-WinIsland 未连接</span>
      </div>
    `
    statusEl = container.querySelector('.winisland-status')

    statusEl.addEventListener('click', () => {
      if (connecting) return
      if (ws && ws.readyState === WebSocket.OPEN) {
        disconnect()
      } else {
        connect()
      }
    })

    // 尝试挂载到侧边栏底部
    const observer = new MutationObserver(() => {
      const sidebar = document.querySelector('.sidebar-footer, .sidebar-bottom, [class*="sidebar"]')
      if (sidebar) {
        sidebar.appendChild(container)
        observer.disconnect()
        return
      }
      // 兜底：挂到 body
      if (!container.parentNode) {
        document.body.appendChild(container)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })

    // 5 秒后如果还没挂上就强制挂到 body
    setTimeout(() => {
      if (!container.parentNode) {
        document.body.appendChild(container)
      }
    }, 5000)
  }

  // 设置面板
  const SettingsPanel = {
    name: 'WinIslandBridgeSettings',
    setup() {
      const { h, ref, onMounted } = ctx.vue
      const serverUrl = ref('ws://127.0.0.1:17195')
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
          const nextServerUrl = String(serverUrl.value || '').trim() || 'ws://127.0.0.1:17195'
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
            placeholder: 'ws://127.0.0.1:17195',
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

  // 监听曲目切换，等待真实歌词加载完成后再推送 track_lyrics 事件
  unsubTrackChange = ctx.events.onTrackChange(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      scheduleLyricsSync()
    }
  })

  // 挂载状态指示
  mountStatusIndicator()

  // 启动连接
  await connect()

  // 清理函数
  ctx.dispose(() => {
    clearLyricRetryTimers()
    disconnect()
    if (unsubTrackChange) unsubTrackChange()
    if (statusEl) {
      statusEl.remove()
      statusEl = null
    }
  })
}
