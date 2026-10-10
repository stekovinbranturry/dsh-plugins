/** 客户端常量：meta 名、文案表、图标。 */
import type { Channels, NotifyKind } from './types.js'

export const META_NAME = 'dsh-notify'

/** 来自宿主的 meta（index 注入） */
export interface BootMeta {
  endpoint: string
  channels: Channels
}

export const KIND_TITLE: Record<NotifyKind, string> = {
  'turn-end': '会话完成',
  approval: '需要 Approve',
  question: '需要回答',
}

/**
 * 卡片图标的语义色。走 DSH 的 state token，不再写死十六进制 ——
 * 硬编码的橙/蓝不跟主题走，深色下偏亮。turn-end 也从 brand 改成 success：
 * "跑完了"是状态，不是品牌色。
 */
export const KIND_ACCENT: Record<NotifyKind, string> = {
  'turn-end': 'var(--dsw-alias-state-success-primary)',
  approval: 'var(--dsw-alias-state-warn-primary)',
  question: 'var(--dsw-alias-state-business-primary)',
}

/** 通知类型标签的色调（primitives Tag 的 tone），与 KIND_ACCENT 同一套语义 */
export const KIND_TONE: Record<NotifyKind, 'success' | 'warning' | 'info'> = {
  'turn-end': 'success',
  approval: 'warning',
  question: 'info',
}

/** 提示条停留时长；approval / question 在等用户动作，留久一点 */
export const TOAST_TTL: Record<NotifyKind, number> = {
  'turn-end': 7_000,
  approval: 20_000,
  question: 20_000,
}

export const MAX_TOASTS = 4
export const TITLE_PREFIX = '● '
