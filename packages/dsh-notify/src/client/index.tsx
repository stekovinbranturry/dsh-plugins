// 浏览器半入口：订阅宿主的 SSE 流，把通知变成三样东西 —— 页内提示条、系统通知、提示音，
// 并在页面不可见时把未读数写到标签页标题上。
//
// 提示条挂在 body 上的一个自建容器里（portal 都不需要）：插件只加自己的节点，不去抢
// DSH 自己的布局插槽。这样即使 composer 的插槽改名，通知也照样显示。
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import STYLES from './styles.css'
import { KIND_TITLE, META_NAME, TOAST_TTL } from './constants.js'
import type { BootMeta } from './constants.js'
import type { ClientContext, SessionsService, UiWorkspaceService } from './context.js'
import {
  browserBody,
  notificationPermission,
  playChime,
  requestPermission,
  resetTitleMarker,
  showBrowserNotification,
  titleMarker,
} from './effects.js'
import { ackEnabled, openStream, readBootMeta, requestTest } from './host.js'
import { pageHidden, probeBrowserNotification } from './effects.js'
import { createStore } from './store.js'
import type { Store } from './store.js'
import { ToastStack } from './Toasts.js'
import { DEFAULT_CHANNELS } from '../shared/channels.js'
import type { Channels, NotifyTestResult, NotifyWire, Permission } from './types.js'

export const name = 'dsh-notify'

// 不硬依赖任何客户端服务：提示条、系统通知、提示音、标题角标都不需要服务就能跑，
// 只有"跳回那个对话"要 uiWorkspace —— 它是用 ctx.get 取的（get 不要求 inject），
// 拿不到就少一个跳转入口，不该拖累整个插件不装
export const inject: string[] = []

/**
 * 跳回某个会话。0.1.7 把 `sessions.open(id)` 删了（客户端 ClientSessions 只剩
 * retain / scope / search），"选中会话、把它显示成对话"搬到 uiWorkspace 服务上 ——
 * 官方侧边栏的会话行就是 `uiWorkspace.openSession(sessionId)`。
 *
 * 用 ctx.get 而不是属性访问：拿不到就只是没有跳转入口（返回 false），不影响通知本身。
 */
function openViaUi(ctx: ClientContext, sessionId: string): boolean {
  try {
    const ui = ctx.get('uiWorkspace') as UiWorkspaceService | undefined
    if (ui === undefined || typeof ui.openSession !== 'function') return false
    ui.openSession(sessionId)
    return true
  } catch {
    // 导航服务在切换工作区时可能短暂不可用：跳不过去就算了，别让通知链路上报错
    return false
  }
}

/**
 * 判断"这个会话正显示在主视图里" —— 人已经盯着这个对话，回复 / 审批卡 / 提问卡本来就在
 * 屏幕上，再弹一条提示条是纯噪音。
 *
 * 判据是会话控制器列表快照里的 `retainedBy.mainView`：官方 dsh-client-ui-session 自己的
 * `isMain()` 就是 `byId[id].retainedBy.mainView > 0`，但那个方法是私有的，所以这里读
 * 同一份公开快照（ISessions.list）。同样走 ctx.get：拿不到 sessions 服务时一律返回 false，
 * 退回旧行为（照常通知），不能让一个可选服务把通知本身搞挂。
 */
function currentSessionProbe(ctx: ClientContext): (sessionId: string) => boolean {
  return (sessionId: string): boolean => {
    if (sessionId === '') return false
    const sessions = ctx.get('sessions') as SessionsService | undefined
    const row = sessions?.list?.getSnapshot?.().byId?.[sessionId]
    return (row?.retainedBy?.mainView ?? 0) > 0
  }
}

function insertStyles(css: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const node = document.createElement('style')
  node.setAttribute('data-dsh-notify', '')
  node.textContent = css
  document.head.appendChild(node)
  return () => {
    if (node.parentNode) node.parentNode.removeChild(node)
  }
}

/** 把页内提示条、浏览器系统通知与 webhook 的体检结论拼成几行，贴在自检卡片上 */
function reportLines(input: {
  permission: Permission
  probe: { probeOk: boolean; detail?: string }
  webhook: { attempted: boolean; ok: boolean; detail?: string } | null
  clients: number
}): string[] {
  const lines: string[] = []
  lines.push('页内提示条：正常')
  if (input.permission === 'granted' && input.probe.probeOk) {
    lines.push('系统通知：通知创建成功，请确认是否看到测试弹窗（未看到请检查系统通知设置 / 勿扰模式）')
  } else if (input.permission === 'granted') {
    lines.push('系统通知：创建失败' + (input.probe.detail ? '（' + input.probe.detail + '）' : '') + '，请检查浏览器或系统通知设置')
  } else if (input.permission === 'default') {
    lines.push('系统通知：还没授权，点上面「开启系统通知」')
  } else if (input.permission === 'denied') {
    lines.push('系统通知：浏览器里被拒了，去地址栏左侧的站点设置里改')
  } else {
    lines.push('系统通知：这个浏览器不支持')
  }
  if (input.webhook !== null && input.webhook.attempted) {
    const why = input.webhook.detail ? '（' + input.webhook.detail + '）' : ''
    lines.push('webhook：' + (input.webhook.ok ? '已推' : '失败' + why))
  }
  lines.push('页面连接数：' + input.clients)
  return lines
}

export interface NotifyController {
  store: Store
  meta: BootMeta | null
  /** 生效的渠道开关（meta 缺失时用与宿主同一份默认值） */
  channels: Channels
  notify(wire: NotifyWire): void
  /** 自检：返回页内提示条、浏览器系统通知与 webhook 的体检结论 */
  test(): Promise<string[]>
  /** 申请系统通知授权：只能在用户手势里调 */
  askBrowserPermission(): Promise<void>
  /** 重新读一次浏览器授权状态（切回页面 / 跑自检时用，避免结论停在旧快照） */
  refreshPermission(): void
  dispose(): void
}

/**
 * 通知的客户端控制面：一个 store + 一条流 + 一堆定时器。行为单测直接建它，
 * 不需要真的渲染 React。
 */
export function createController(options: {
  meta: BootMeta | null
  openSession?: (sessionId: string) => void
  /** 这个会话是不是正显示在主视图里；缺省或抛错时按"不是"处理（照常通知） */
  isCurrentSession?: (sessionId: string) => boolean
}): NotifyController {
  const store = createStore()
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const meta = options.meta
  const channels = meta?.channels ?? DEFAULT_CHANNELS

  store.setPermission(notificationPermission())

  const schedule = (seq: number, kind: NotifyWire['kind']): void => {
    const existing = timers.get(seq)
    if (existing) clearTimeout(existing)
    const ttl = TOAST_TTL[kind] ?? 7_000
    const timer = setTimeout(() => {
      timers.delete(seq)
      store.dismiss(seq)
    }, ttl)
    // Node 侧（行为单测）不该被提示条定时器拖住
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
      timer.unref()
    }
    timers.set(seq, timer)
  }

  /**
   * 探针是可选的降级路径：能判定就用它压制，取不到、探针抛错都当成"不是当前对话"。
   * notify 跑在 SSE 回调里，一个可选服务不该有机会把整条通知链带崩，
   * 所以异常策略收在这一处，不散到各个探针实现里。
   */
  const isCurrent = (sessionId: string): boolean => {
    if (options.isCurrentSession === undefined) return false
    try {
      return options.isCurrentSession(sessionId) === true
    } catch {
      return false
    }
  }

  const notify = (wire: NotifyWire): void => {
    const visible = !pageHidden()
    // 人正看着这个对话时，回复 / 审批卡 / 提问卡本来就在屏幕上，再弹一条是纯噪音。
    // 只在页面可见时压制：切到别的软件或标签页之后，还得照常叫你 ——
    // 那时候"在对话里"这个前提已经不成立了。
    if (visible && isCurrent(wire.sessionId)) return
    if (ackEnabled(meta)) {
      store.append(wire)
      schedule(wire.seq, wire.kind)
    } else {
      // 宿主关了页内提示：仍要记未读，标题上还能看到
      store.setConnected(true)
    }
    if (wire.test === true) return
    if (channels.sound) playChime()
    if (channels.title && !visible) titleMarker(true)
    if (channels.browser && !visible) {
      showBrowserNotification({
        title: wire.title || KIND_TITLE[wire.kind],
        body: browserBody(wire),
        tag: 'dsh-notify-' + wire.seq,
        onClick: () => {
          // 系统通知的点击发生在别的窗口栈里：先把 DSH 的标签页拉到前面，再跳会话
          if (typeof window !== 'undefined') window.focus()
          if (options.openSession && wire.sessionId !== '') options.openSession(wire.sessionId)
          if (ackEnabled(meta)) store.dismiss(wire.seq)
        },
      })
    }
  }

  return {
    store,
    meta,
    channels,
    notify,
    async test() {
      // 自检：既问一遍宿主（验证"宿主 → 页面"这条链路），也本地补三条假的，让控制台里
      // 一次就能看全三种卡片长什么样。宿主那条已经带了 test 标记，不会再响铃。
      // 最后把页内提示条、浏览器系统通知与 webhook 的体检结论写回卡片上 —— "为什么切走没通知"就看这一行。
      const now = Date.now()
      const seqs = SELF_TEST.map((wire, index) => {
        const seq = now + index
        notify({ ...wire, seq, at: now, test: true })
        return seq
      })

      let host: NotifyTestResult | null = null
      try {
        host = await requestTest()
      } catch {
        host = null
      }

      // 现读一次授权状态：用户可能刚在浏览器里点过允许（或刚拒绝），
      // 只认创建时那一次的快照会让体检结论一直停在"还没授权"
      const permission = notificationPermission()
      store.setPermission(permission)
      const probe = await probeBrowserNotification()
      const report = reportLines({
        permission,
        probe,
        webhook: host?.webhook ?? null,
        clients: host?.clients ?? 0,
      })
      // 结论挂在新收到的那张自检卡（宿主回的那条「DSH 通知自检」）上；宿主那条因为
      // SSE 与 HTTP 响应是两条路，可能还没到，那就退回最后一条本地假卡片
      const target = store.getState().items.find((item) => item.test === true)?.seq
        ?? seqs[seqs.length - 1]
      if (target !== undefined) store.setReport(target, report)
      return report
    },
    async askBrowserPermission() {
      const permission = await requestPermission()
      store.setPermission(permission)
    },
    refreshPermission() {
      store.setPermission(notificationPermission())
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

/**
 * 控制台自检用的三条假通知：把这三种卡片的真实样子一次摆出来。
 * 带 `test` 标记 → 不响铃、不发系统通知；但照常显示、照常可点。
 */
const SELF_TEST: NotifyWire[] = [
  {
    seq: 0,
    kind: 'turn-end',
    at: 0,
    title: '会话完成',
    sessionId: 'self-test',
    sessionTitle: '修登录超时',
    workspace: 'example-project',
    turn: {
      turn: 7,
      status: 'completed',
      elapsedMs: 96_000,
      reply: '已经把超时从 5s 调到 30s，并补了三条用例。',
    },
    test: true,
  },
  {
    seq: 0,
    kind: 'approval',
    at: 0,
    title: '需要 Approve',
    sessionId: 'self-test',
    sessionTitle: '修登录超时',
    workspace: 'example-project',
    approval: { toolName: 'bash', reason: 'pnpm vitest run packages/web --reporter=dot' },
    test: true,
  },
  {
    seq: 0,
    kind: 'question',
    at: 0,
    title: '需要回答',
    sessionId: 'self-test',
    sessionTitle: '修登录超时',
    workspace: 'example-project',
    question: { header: '先跑哪个', question: '先跑单测还是先打标签？', count: 2 },
    test: true,
  },
]

export function apply(ctx: ClientContext): void {
  const meta = readBootMeta()
  ctx.effect(() => insertStyles(STYLES), 'dsh-notify: styles')

  const container = typeof document === 'undefined' ? null : document.createElement('div')
  if (container) {
    container.setAttribute('data-dsh-notify-root', '')
    document.body.appendChild(container)
  }
  const root: Root | null = container ? createRoot(container) : null

  const openSession = (sessionId: string): void => {
    openViaUi(ctx, sessionId)
  }

  const controller = createController({
    meta,
    openSession,
    isCurrentSession: currentSessionProbe(ctx),
  })
  const unread = (): number => controller.store.getState().unread

  // 页面回到前台：未读清零 + 标题还原
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      // 从浏览器设置页切回来时要重新读一次授权：用户可能刚把通知打开
      controller.refreshPermission()
      controller.store.markRead()
      titleMarker(false)
    }
  }

  const stream = openStream(
    meta?.endpoint ?? '/dsh-notify/stream',
    (wire) => controller.notify(wire),
    (status) => controller.store.setConnected(status === 'open'),
  )

  // 用户第一次点页面时顺手申请系统通知授权。
  // 这是"切到别的软件 / 别的 tab 之后还能收到"的关键：页内提示条只在页面可见时有用，
  // 页面一被遮住，只有系统级通知能穿透出去。授权这一步必须发生在用户手势里。
  const onFirstGesture = (): void => {
    if (!controller.channels.browser) return
    if (controller.store.getState().permission !== 'default') return
    void controller.askBrowserPermission()
  }

  const rerender = (): void => {
    root?.render(
      React.createElement(ToastStack, {
        store: controller.store,
        onOpenSession: openSession,
        onAskBrowser: () => void controller.askBrowserPermission(),
      }),
    )
  }
  const unsubscribe = controller.store.subscribe(rerender)
  rerender()

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pointerdown', onFirstGesture, { once: true })

  // 自检口子：控制台里 `__dshNotifyTest()` 能立刻验证整条链路，
  // `__dshNotifyOpen('<sessionId>')` 单独验证"跳回对话"这一步是否通。
  const hooks = window as unknown as {
    __dshNotifyTest?: () => Promise<string[]>
    __dshNotifyOpen?: (sessionId: string) => boolean
    __dshNotifyAsk?: () => void
  }
  hooks.__dshNotifyTest = () => controller.test()
  hooks.__dshNotifyAsk = () => void controller.askBrowserPermission()
  hooks.__dshNotifyOpen = (sessionId: string) =>
    typeof sessionId === 'string' && sessionId !== '' && openViaUi(ctx, sessionId)

  ctx.effect(() => () => {
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointerdown', onFirstGesture)
    stream.close()
    controller.dispose()
    resetTitleMarker()
    root?.unmount()
    if (container?.parentNode) container.parentNode.removeChild(container)
    delete hooks.__dshNotifyTest
    delete hooks.__dshNotifyOpen
    delete hooks.__dshNotifyAsk
  }, 'dsh-notify: client lifetime')

  console.log(
    '[dsh-notify] client loaded; meta=' + (meta ? 'yes' : 'no')
      + ' endpoint=' + (meta?.endpoint ?? '/dsh-notify/stream')
      + ' unread=' + String(unread())
      + ' browser-permission=' + controller.store.getState().permission,
  )
}

export { META_NAME }
