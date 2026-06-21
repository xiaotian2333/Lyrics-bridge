import { DEFAULT_SERVER_URL } from './constants.js'
import { toText } from './utils.js'

export async function getConfig(ctx) {
  const storedServerUrl = await ctx.storage.get('serverUrl')
  const serverUrl = toText(storedServerUrl) || DEFAULT_SERVER_URL
  const autoReconnect = await ctx.storage.get('autoReconnect')
  return { serverUrl, autoReconnect: autoReconnect !== false }
}
