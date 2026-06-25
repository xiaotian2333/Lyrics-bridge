import { initFavoriteWatch } from './src/favorite.js'
import { initNowPlayingSubscription } from './src/snapshot.js'
import { createState } from './src/state.js'
import { defineSettings } from './src/settings.js'
import { initVolumeWatch } from './src/volume.js'
import { connect, disconnect, isWsOpen, send } from './src/websocket.js'

async function launchHelper(state, ctx) {
  if (state.disposed) return

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
    state.helperPids.push(result.pid)
  } else if (!result.canceled) {
    ctx.toast.warning(result.error || '启动辅助进程失败')
  }
}

function disposeBridge(state, ctx) {
  state.disposed = true
  if (state.serverSeekClearTimer) {
    clearTimeout(state.serverSeekClearTimer)
    state.serverSeekClearTimer = null
  }

  // 通知服务端插件被禁用
  if (isWsOpen(state)) {
    send(state, {
      type: 'command',
      source: 'plugin',
      payload: { action: 'disabled', data: {} },
    })
  }

  // 终止外部辅助进程
  state.helperPids.forEach(pid => {
    try { ctx.process.terminate(pid) } catch { }
  })
  state.helperPids = []

  disconnect(state)
  if (state.unsubNowPlaying) {
    state.unsubNowPlaying()
    state.unsubNowPlaying = null
  }
  if (state.unsubFavoriteWatch) {
    state.unsubFavoriteWatch()
    state.unsubFavoriteWatch = null
  }
  if (state.unsubVolumeWatch) {
    state.unsubVolumeWatch()
    state.unsubVolumeWatch = null
  }
  state.latestSnapshot = null
  state.lastTrackKey = ''
  state.lastSentMusicDataKey = ''
  state.lastSentFavoriteStateKey = ''
  state.lastSentVolumeKey = ''
  state.coverBase64Cache.clear()
}

export default async function (ctx) {
  const state = createState()

  defineSettings(ctx, state)

  await initNowPlayingSubscription(state, ctx)
  initFavoriteWatch(state, ctx)
  initVolumeWatch(state, ctx)
  await connect(state, ctx)
  void launchHelper(state, ctx)

  ctx.dispose(() => {
    disposeBridge(state, ctx)
  })
}
