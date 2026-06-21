import { DEFAULT_SERVER_URL } from './constants.js'
import { getConfig } from './config.js'
import { toText } from './utils.js'
import { connect, disconnect } from './websocket.js'

export function defineSettings(ctx, state) {
  const SettingsPanel = {
    name: 'WinIslandBridgeSettings',
    setup() {
      const { h, ref, onMounted } = ctx.vue
      const serverUrl = ref(DEFAULT_SERVER_URL)
      const autoReconnect = ref(true)
      const autoLaunch = ref(true)
      const saving = ref(false)

      const reload = async () => {
        const config = await getConfig(ctx)
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
          disconnect(state)
          await connect(state, ctx)
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
    title: '灵动岛歌词',
    description: '将 EchoMusic 的歌词和播放状态推送到外部歌词软件，并支持接收外部歌词软件的播放控制指令',
    component: SettingsPanel,
  })
}
