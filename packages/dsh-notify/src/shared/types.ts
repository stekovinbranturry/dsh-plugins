// 宿主半与浏览器半共用的线格式。只放"能无损 JSON 化"的字段：宿主那边拿到的是 Cordis
// 活对象（Session / Agent / Service），一个都不能直接塞进来。

/** 三类会话通知：会话跑完、需要点同意、需要回答问题。 */
export type NotifyKind = 'turn-end' | 'approval' | 'question'

/** 完成类通知的严重度：正常结束 / 达到输出上限 / 出错。 */
export type TurnStatus = 'completed' | 'max-tokens' | 'error'

export interface TurnEndPayload {
  /** 第几个 turn（会话内递增）；读不到就不写，绝不拿 0 顶替 */
  turn?: number
  /** 本轮耗时（毫秒），拿不到就是 undefined */
  elapsedMs?: number
  status: TurnStatus
  /** error 时的失败信息，其余时候没有 */
  error?: string
  /** 本轮用户那句提示的开头 */
  prompt?: string
  /** 本轮最终回复的开头 */
  reply?: string
}

export interface ApprovalPayload {
  toolName: string
  reason?: string
  callId?: string
}

export interface QuestionPayload {
  /** 第一道题的标题（header），没有就用问题正文 */
  header?: string
  /** 问题正文开头 */
  question: string
  /** 题目数量；多于一道时通知里标出来 */
  count: number
}

/** 一条通知。`at` 由宿主盖章，客户端只用它做顺序与去重。 */
export interface NotifyWire {
  /** 进程内单调递增序号 */
  seq: number
  kind: NotifyKind
  /** 产生通知的时刻（epoch ms） */
  at: number
  /** 已经拼好的通知标题（浏览器系统通知 / 页内提示条的标题） */
  title: string
  sessionId: string
  /** 会话标题（拿不到就是空串） */
  sessionTitle: string
  /** 会话工作目录的目录名（拿不到就是空串） */
  workspace: string
  /** 模型给这次通知写的一句人话（可选，当前留空） */
  summary?: string
  /** 自检通知：页内照常显示，但不响铃、不发系统通知 */
  test?: boolean
  /** 自检通知的体检结论（只在浏览器半填，逐条一行） */
  report?: string[]
  turn?: TurnEndPayload
  approval?: ApprovalPayload
  question?: QuestionPayload
}

/** 浏览器系统通知的授权状态；unsupported 表示这个浏览器根本没有 Notification */
export type Permission = 'granted' | 'denied' | 'default' | 'unsupported'

/** 客户端渠道开关：宿主算好，随 hello / meta 一起交给页面 */
export interface Channels {
  /** 页内提示条 */
  ack: boolean
  /** 系统级通知（Web Notification），要用户授权 */
  browser: boolean
  sound: boolean
  title: boolean
}

/** SSE 的 `hello` 帧：客户端据此确认流已经活了 */
export interface NotifyHello {
  ok: true
  endpoint: string
  /** 配置里关掉的渠道，客户端据此不做无谓的尝试 */
  channels: Channels
}

/** 客户端拉取配置（POST /api/dsh-notify.state）时的返回 */
export interface NotifyState {
  ok: true
  config: {
    ack: boolean
    browser: boolean
    sound: boolean
    title: boolean
    showPreview: boolean
    notifyOnTurnEnd: boolean
    notifyOnApproval: boolean
    notifyOnQuestion: boolean
    includeSubagents: boolean
  }
  /** 当前挂着的浏览器连接数 */
  clients: number
  /** 已经推出去的通知条数（调试用） */
  delivered: number
}

/** POST /api/dsh-notify.test 的返回：立刻发一条假通知，用来验证链路 */
export interface NotifyTestResult {
  ok: true
  /** 宿主侧 webhook 自检结果 */
  webhook: { attempted: boolean; ok: boolean; detail?: string }
  /** 推给了几个浏览器 */
  clients: number
}
