/** 宿主半的常量与默认值。模型可见/用户可见的文案都放这里，方便改。 */

/** 浏览器半长连的 SSE 路径。
 *
 * 长连不走 /api 承运通道（那边是请求/响应），所以这条自留在 webServer 上；围栏用
 * ctx.connection.requestRejection 拿承运层的 Host/Origin 与浏览器认证裁定，不自己判
 */
export const STREAM_PATH = '/dsh-notify/stream'

/** 客户端在 index.html 里读这条 meta 拿流地址 */
export const META_NAME = 'dsh-notify'

/** 一次最多给客户端推多少字节的正文预览 */
export const PREVIEW_LIMIT = 120

/** 各类通知在会话标题缺失时的兜底文案 */
export const FALLBACK_SESSION_TITLE = '未命名会话'

/** 各类通知的默认标题（会话标题拿不到时） */
export const KIND_LABEL: Record<'turn-end' | 'approval' | 'question', string> = {
  'turn-end': '会话完成',
  approval: '需要 Approve',
  question: '需要回答',
}

/** 完成类通知按状态分档 */
export const TURN_STATUS_LABEL = {
  completed: '完成',
  'max-tokens': '达到输出上限',
  error: '出错',
} as const

/** SSE 心跳间隔：CDN / 代理空闲断连比这早得多 */
export const HEARTBEAT_MS = 20_000

/** webhook 超时 */
export const WEBHOOK_TIMEOUT_MS = 5_000

/** /api/dsh-notify.{...} 的合法方法名 */
export const METHODS = ['state', 'test'] as const
export type MethodName = (typeof METHODS)[number]
