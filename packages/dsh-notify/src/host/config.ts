// 插件配置：只暴露真正需要调的旋钮。默认值以"装了就有用"为准 —— 四条渠道全默认开。
// 浏览器系统通知虽然要用户点一次授权，但通道本身默认开：页面会在第一次交互时申请，
// 拿到授权就能用。授权这一步没法替用户点，所以页面上另外给了显式入口。
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CHANNELS } from '../shared/channels.js'

export interface NotifyConfig {
  /** 会话跑完时通知 */
  notifyOnTurnEnd: boolean
  /** 需要 Approve 时通知 */
  notifyOnApproval: boolean
  /** 需要用户回答问题时通知 */
  notifyOnQuestion: boolean
  /** 子代理（subagent）会话也通知；默认不打扰 */
  includeSubagents: boolean
  /** 浏览器系统通知（Web Notification，需要用户授权） */
  browser: boolean
  /** 页内提示条 */
  ack: boolean
  /** 提示音 */
  sound: boolean
  /** 把未读条数写到标签页标题 */
  title: boolean
  /** 通知正文里带会话/回复预览 */
  showPreview: boolean
  /** 外部 webhook：POST 通知 JSON，用于手机/机器人转发 */
  webhookUrl: string
  /** webhook 的附加请求头 */
  webhookHeaders: Record<string, string>
}

export const Config: z<NotifyConfig> = z.object({
  notifyOnTurnEnd: z.boolean().default(true),
  notifyOnApproval: z.boolean().default(true),
  notifyOnQuestion: z.boolean().default(true),
  includeSubagents: z.boolean().default(false),
  browser: z.boolean().default(DEFAULT_CHANNELS.browser),
  ack: z.boolean().default(DEFAULT_CHANNELS.ack),
  sound: z.boolean().default(DEFAULT_CHANNELS.sound),
  title: z.boolean().default(DEFAULT_CHANNELS.title),
  showPreview: z.boolean().default(true),
  webhookUrl: z.string().default(''),
  webhookHeaders: z.dict(z.string()).default({}),
})

export function resolveConfig(config: Partial<NotifyConfig> | undefined): NotifyConfig {
  const source = config ?? {}
  return {
    notifyOnTurnEnd: source.notifyOnTurnEnd !== false,
    notifyOnApproval: source.notifyOnApproval !== false,
    notifyOnQuestion: source.notifyOnQuestion !== false,
    includeSubagents: source.includeSubagents === true,
    browser: source.browser !== false,
    ack: source.ack !== false,
    sound: source.sound !== false,
    title: source.title !== false,
    showPreview: source.showPreview !== false,
    webhookUrl: (source.webhookUrl ?? '').trim(),
    webhookHeaders: source.webhookHeaders ?? {},
  }
}
