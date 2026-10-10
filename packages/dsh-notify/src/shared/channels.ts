// 四条渠道的开关：宿主半与浏览器半共用一个默认值和一份取快照的写法。
// 之前默认值散在宿主 constants 与浏览器兜底字面量里，两边各自拼过，默认值一度相反。
import type { Channels } from './types.js'

export const DEFAULT_CHANNELS: Channels = { ack: true, browser: true, sound: true, title: true }

/** 从任何一份带这四个开关的配置里取出渠道快照（宿主配置 / hello 帧 / meta 都适用） */
export function channelsOf(source: Channels): Channels {
  return { ack: source.ack, browser: source.browser, sound: source.sound, title: source.title }
}
