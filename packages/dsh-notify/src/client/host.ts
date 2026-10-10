/** 宿主调用与流订阅：客户端唯一的两个网络出口。 */
import { apiPath } from '../shared/api.js'
import type { BootMeta } from './constants.js'
import type { NotifyTestResult, NotifyWire } from './types.js'

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
): StreamHandle {
  if (typeof EventSource === 'undefined') {
    return { close: () => {} }
  }
  const source = new EventSource(endpoint)
  const onMessage = (event: MessageEvent): void => {
    try {
      const wire = JSON.parse(String(event.data)) as NotifyWire
      // sessionId 允许为空串：自检通知就是这样，提示条照样要显示
      if (wire && typeof wire.kind === 'string' && typeof wire.title === 'string') onNotify(wire)
    } catch {
      // 单帧坏了不影响后续
    }
  }
  source.addEventListener('notify', onMessage as EventListener)
  source.addEventListener('open', () => onStatus?.('open'))
  source.addEventListener('error', () => onStatus?.('error'))
  return {
    close: () => {
      source.removeEventListener('notify', onMessage as EventListener)
      source.close()
    },
  }
}
