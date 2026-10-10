// 三个页面侧的小效果：系统通知（Web Notification）、提示音、标签页标题标记。
// 全部都是"尽力而为"：浏览器不给（没授权 / 没用户手势 / 老浏览器）就安静降级。
import { TITLE_PREFIX } from './constants.js'
import type { NotifyWire, Permission } from './types.js'

export function notificationSupported(): boolean {
  return typeof Notification !== 'undefined'
}

export function notificationPermission(): Permission {
  if (!notificationSupported()) return 'unsupported'
  return Notification.permission as Permission
}

/** 申请授权：只能在用户手势里调用，否则 Chrome 会直接拒 */
export async function requestPermission(): Promise<Permission> {
  if (!notificationSupported()) return 'unsupported'
  try {
    const result = await Notification.requestPermission()
    return result as Permission
  } catch {
    return notificationPermission()
  }
}

export interface BrowserNotify {
  title: string
  body: string
  tag?: string
  onClick?: () => void
}

/** 页面可见时不发系统通知：人就在看着屏幕，页内提示条已经够了 */
export function pageHidden(): boolean {
  return typeof document === 'undefined' ? false : document.visibilityState !== 'visible'
}

/** 发一条系统通知；返回是否真的发出去了 */
export function showBrowserNotification(input: BrowserNotify): boolean {
  if (!pageHidden()) return false
  if (!notificationSupported() || Notification.permission !== 'granted') return false
  try {
    const notification = new Notification(input.title, {
      body: input.body,
      tag: input.tag,
      silent: true,
    })
    if (input.onClick) notification.onclick = input.onClick
    return true
  } catch {
    return false
  }
}

// ── 提示音 ────────────────────────────────────────────────────────────────
// 一次短促的双音；AudioContext 懒创建并复用。浏览器要求用户手势之后才能出声，
// 所以失败（NotAllowedError）就当静音，不再重试刷屏。

let audioContext: AudioContext | null = null

function ensureAudioContext(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  if (audioContext) return audioContext
  try {
    audioContext = new AudioContext()
    return audioContext
  } catch {
    return null
  }
}

export function playChime(): void {
  const context = ensureAudioContext()
  if (!context) return
  const play = (): void => {
    const now = context.currentTime
    for (const [index, frequency] of [880, 1320].entries()) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(0.0001, now + index * 0.12)
      gain.gain.exponentialRampToValueAtTime(0.09, now + index * 0.12 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.12 + 0.22)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(now + index * 0.12)
      oscillator.stop(now + index * 0.12 + 0.24)
    }
  }
  if (context.state === 'suspended') {
    void context.resume().then(play).catch(() => {})
    return
  }
  play()
}

// ── 标签页标题标记 ────────────────────────────────────────────────────────

let baseTitle: string | null = null

export function titleMarker(active: boolean): void {
  if (typeof document === 'undefined') return
  if (baseTitle === null) baseTitle = document.title
  const next = active ? TITLE_PREFIX + baseTitle : baseTitle
  if (document.title !== next) document.title = next
}

export function resetTitleMarker(): void {
  if (typeof document === 'undefined') return
  if (baseTitle !== null) document.title = baseTitle
  baseTitle = null
}

/** 系统通知的体检结论：权限 + 真正 new Notification() 会不会失败 */
export interface BrowserProbe {
  permission: Permission
  /** 尝试创建一条静音测试通知是否成功，不代表系统实际展示了横幅 */
  probeOk: boolean
  detail?: string
}

export async function probeBrowserNotification(): Promise<BrowserProbe> {
  const permission = notificationPermission()
  if (permission !== 'granted') return { permission, probeOk: false, detail: 'permission:' + permission }
  try {
    const probe = new Notification('dsh-notify 自检', { body: '看到这条说明浏览器系统通知已送达', silent: true, tag: 'dsh-notify-probe' })
    // 1.2 秒后尝试收起；静音或 close() 都不能保证系统不展示横幅。
    setTimeout(() => {
      try {
        probe.close()
      } catch {
        /* 关不掉就算了 */
      }
    }, 1_200)
    return { permission, probeOk: true }
  } catch (error) {
    return { permission, probeOk: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 通知正文：系统通知只显示两行，长文本先压平 */
export function browserBody(wire: NotifyWire): string {
  const parts: string[] = []
  if (wire.kind === 'turn-end' && wire.turn) {
    // 拿不到轮次就不写"第 N 轮"，宁可少一句也不写个假数字
    if (typeof wire.turn.turn === 'number') parts.push('第 ' + wire.turn.turn + ' 轮完成')
    else parts.push('本轮完成')
    const preview = wire.turn.reply || wire.turn.prompt || ''
    if (preview !== '') parts.push(preview)
  } else if (wire.kind === 'approval' && wire.approval) {
    parts.push('工具 ' + wire.approval.toolName + ' 等待授权')
  } else if (wire.kind === 'question' && wire.question) {
    parts.push(wire.question.question)
  }
  const where = wire.sessionTitle !== '' ? wire.sessionTitle : wire.workspace
  if (where !== '') parts.push(where)
  return parts.join(' · ')
}
