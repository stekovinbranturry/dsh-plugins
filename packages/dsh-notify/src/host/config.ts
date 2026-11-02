// 插件配置：只暴露真正需要调的旋钮。默认值以"装了就有用"为准 —— 四条渠道全默认开。
// 浏览器系统通知虽然要用户点一次授权，但通道本身默认开：页面会在第一次交互时申请，
// 拿到授权就能用。授权这一步没法替用户点，所以页面上另外给了显式入口。
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CHANNELS } from '../shared/channels.js'
import { live } from './volatile.js'

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

// 每个字段都标 volatile —— 这是 DSH 设置面板的硬门槛：dsh-settings 的 describe() 只把
// "有 volatile 字段"的 profile 条目投影成表单（`const form = volatileForm(schema);
// if (form === void 0) return []`），一个 volatile 都没有就等于本插件在设置里没有页。
//
// 代价是 schema 的输出类型被改写（schemastery 的 SchemaOutput：`'volatile-defined' → Volatile<T>`），
// volatile 字段解析出来是引用盒子而不是裸值 —— 所以不能再写 `z<NotifyConfig>` 注解。
// 运行时形状见下面的 NotifyConfigRuntime，Config 的注解就是照它写的：漏标 .volatile() 的字段
// 会是裸 boolean，跟 LiveValue<boolean> 不兼容，当场报错。

/**
 * volatile 字段的运行时引用盒子。结构等价于 cosmokit 的 `Volatile<T>`，这里自己写一遍：
 * @deepseek-ai/cosmokit 没有 `dsh` manifest（不是本仓该依赖的公共包），而 schemastery 的
 * 输出类型里带着它 —— 直接导出推断出来的 Config 类型会让 .d.ts 引用一个不可移植的包名（TS2742）。
 */
export interface LiveValue<T> {
  get(): T
}

/**
 * apply 收到的运行时配置：volatile 字段是引用盒子（见 volatile.ts），比 NotifyConfig 多一层解包，
 * 读值一律过 live()。
 */
export interface NotifyConfigRuntime {
  notifyOnTurnEnd: LiveValue<boolean>
  notifyOnApproval: LiveValue<boolean>
  notifyOnQuestion: LiveValue<boolean>
  includeSubagents: LiveValue<boolean>
  browser: LiveValue<boolean>
  ack: LiveValue<boolean>
  sound: LiveValue<boolean>
  title: LiveValue<boolean>
  showPreview: LiveValue<boolean>
  webhookUrl: LiveValue<string>
  webhookHeaders: LiveValue<Record<string, string>>
}

export const Config: Schemastery<NotifyConfig, NotifyConfigRuntime, 'plain'> = z.object({
  notifyOnTurnEnd: z.boolean().default(true).volatile(),
  notifyOnApproval: z.boolean().default(true).volatile(),
  notifyOnQuestion: z.boolean().default(true).volatile(),
  includeSubagents: z.boolean().default(false).volatile(),
  browser: z.boolean().default(DEFAULT_CHANNELS.browser).volatile(),
  ack: z.boolean().default(DEFAULT_CHANNELS.ack).volatile(),
  sound: z.boolean().default(DEFAULT_CHANNELS.sound).volatile(),
  title: z.boolean().default(DEFAULT_CHANNELS.title).volatile(),
  showPreview: z.boolean().default(true).volatile(),
  webhookUrl: z.string().default('').volatile(),
  webhookHeaders: z.dict(z.string()).default({}).volatile(),
})

export function resolveConfig(config: Partial<NotifyConfigRuntime> | undefined): NotifyConfig {
  const source = config ?? {}
  return {
    notifyOnTurnEnd: live(source.notifyOnTurnEnd) !== false,
    notifyOnApproval: live(source.notifyOnApproval) !== false,
    notifyOnQuestion: live(source.notifyOnQuestion) !== false,
    includeSubagents: live(source.includeSubagents) === true,
    browser: live(source.browser) !== false,
    ack: live(source.ack) !== false,
    sound: live(source.sound) !== false,
    title: live(source.title) !== false,
    showPreview: live(source.showPreview) !== false,
    webhookUrl: live(source.webhookUrl ?? '').trim(),
    webhookHeaders: live(source.webhookHeaders) ?? {},
  }
}
