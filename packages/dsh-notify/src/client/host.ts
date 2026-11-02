/** 宿主调用与流订阅：客户端唯一的两个网络出口。 */
import { apiPath } from '../shared/api.js'
import type { BootMeta } from './constants.js'
import { channelsOf } from '../shared/channels.js'
import type { Channels, NotifyTestResult, NotifyWire } from './types.js'

/** 从 index.html 的 meta 里读宿主注入的流地址与渠道开关 */
export function readBootMeta(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): BootMeta | null {
  if (!doc) return null
  const node = doc.querySelector('meta[name="dsh-notify"]')
  const raw = node?.getAttribute('content')
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as { endpoint?: unknown; channels?: unknown }
    const endpoint = typeof record.endpoint === 'string' && record.endpoint.startsWith('/')
      ? record.endpoint
      : '/dsh-notify/stream'
    const channels = record.channels as Partial<BootMeta['channels']> | undefined
    return {
      endpoint,
      channels: {
        ack: channels?.ack !== false,
        browser: channels?.browser === true,
        sound: channels?.sound !== false,
        title: channels?.title !== false,
      },
    }
  } catch {
    return null
  }
}

/** 通知条是否要显示：宿主关掉 ack 时整条不显示（但系统通知照样发） */
export function ackEnabled(meta: BootMeta | null): boolean {
  if (!meta) return true
  return meta.channels.ack
}

/** 让宿主立刻发一条自检，并把宿主侧各渠道的结果带回来 */
export async function requestTest(): Promise<NotifyTestResult | null> {
  try {
    // /api 承运通道上的端点：同源普通 fetch，Host/Origin 围栏与浏览器认证由承运层做完
    const res = await fetch(apiPath('test'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    if (!res.ok) return null
    const body = (await res.json()) as { ok?: boolean }
    return body.ok === true ? (body as NotifyTestResult) : null
  } catch {
    return null
  }
}

export interface StreamHandle {
  close(): void
}

/**
 * 订阅宿主推送。EventSource 自带重连，这里只管解析与分发；解析失败的单帧丢掉，
 * 不能因为一条坏数据把整条流搞死。
 */
export function openStream(
  endpoint: string,
  onNotify: (wire: NotifyWire) => void,
  onStatus?: (state: 'open' | 'error') => void,
  onChannels?: (channels: Channels) => void,
): StreamHandle {
  if (typeof EventSource === 'undefined') {
    return { close: () => {} }
  }
  const source = new EventSource(endpoint)
  let closed = false
  const onMessage = (event: MessageEvent): void => {
    if (closed) return
    try {
      const wire = JSON.parse(String(event.data)) as NotifyWire
      // sessionId 允许为空串：自检通知就是这样，提示条照样要显示
      if (wire && typeof wire.kind === 'string' && typeof wire.title === 'string') onNotify(wire)
    } catch {
      // 单帧坏了不影响后续
    }
  }
  const onConfig = (event: MessageEvent): void => {
    if (closed) return
    try {
      const frame: unknown = JSON.parse(String(event.data))
      if (frame === null || typeof frame !== 'object') return
      const value = (frame as { channels?: unknown }).channels
      if (value === null || typeof value !== 'object') return
      const channels = value as Partial<Channels>
      // 一帧必须是完整的四布尔快照；坏帧不能部分改写当前配置。
      if (typeof channels.ack !== 'boolean' || typeof channels.browser !== 'boolean'
        || typeof channels.sound !== 'boolean' || typeof channels.title !== 'boolean') return
      onChannels?.(channelsOf(channels as Channels))
    } catch {
      // 与 notify 一样，单帧错误不影响后续更新。
    }
  }
  const onOpen = (): void => { if (!closed) onStatus?.('open') }
  const onError = (): void => { if (!closed) onStatus?.('error') }
  source.addEventListener('notify', onMessage as EventListener)
  source.addEventListener('hello', onConfig as EventListener)
  source.addEventListener('config', onConfig as EventListener)
  source.addEventListener('open', onOpen)
  source.addEventListener('error', onError)
  return {
    close: () => {
      if (closed) return
      closed = true
      source.removeEventListener('notify', onMessage as EventListener)
      source.removeEventListener('hello', onConfig as EventListener)
      source.removeEventListener('config', onConfig as EventListener)
      source.removeEventListener('open', onOpen)
      source.removeEventListener('error', onError)
      source.close()
    },
  }
}
