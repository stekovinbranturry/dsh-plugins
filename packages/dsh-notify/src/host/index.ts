// 宿主半入口：把三类会话事件接到通知中枢上，并把浏览器半的两类入口挂出去
// （JSON 方法挂 /api 承运通道，SSE 长连自留 webServer）。
//
// 依赖策略：webServer 与承运通道到位后才装浏览器面；无浏览器时仍能发 webhook。
// sessions / sessionTitle / clientModules 一律按需 ctx.get，缺了只关掉对应能力，不阻塞激活。
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'

import { METHODS, STREAM_PATH } from './constants.js'
import { Config, resolveConfig } from './config.js'
import type { NotifyConfig } from './config.js'
import { wireNotifyEvents } from './events.js'
import { Notifier } from './notifier.js'
import { installWebSurface } from './web.js'

export const name = 'dsh-notify'

// webServer 不写进 inject：headless / SDK 这样的无浏览器组合仍能发 webhook，
// 只是没有浏览器那半。缺了它 apply 里按需降级。
export const inject: string[] = []

/** 插件入口 id：必须与 package.json 的 name、客户端 bundle 的 __ModuleLoader__ id 一致 */
export const ENTRY_ID = '@stekovinbranturry/dsh-notify'

const CLIENT_BUNDLE = fileURLToPath(new URL('../client.js', import.meta.url))

export { Config, resolveConfig }
export type { NotifyConfig }

export function apply(ctx: Context, config?: Partial<NotifyConfig>): void {
  const notifier = new Notifier(ctx, resolveConfig(config))

  // 事件接线（三类来源）：不依赖 webServer，先接上
  wireNotifyEvents(ctx, notifier)
  ctx.effect(() => () => notifier.dispose(), 'dsh-notify: clients')

  // 浏览器面：SSE 推送 + 两个 JSON 方法 + index 里的 meta + 开发期 bundle 盯盘。
  //
  // 这里用 ctx.inject 而不是 static inject：webServer 由 boot 顺序更靠后的插件（web-app）
  // 提供，静态 inject 会让本插件一直等到它出现——但 headless / SDK 组合里它永远不出现，
  // 静态依赖就把"无浏览器也要能发 webhook"这条路堵死了。ctx.inject 的作用域回调在服务
  // 到位时跑一次，缺席就一直不跑：两条路都通。
  //
  // connection 必须一起等：它的 apply 是 async 的（`await BrowserAuth.create(...)` 先要
  // 拿到 credentials），所以在 webServer 到位那一瞬间它经常还没 provide 出来。只等 webServer
  // 会输给这个竞态 —— 表现就是启动日志里一句 "connection service absent; browser surface
  // disabled"，之后 /dsh-notify/stream 永远 404：页内提示条、浏览器系统通知、提示音、标题
  // 角标整条浏览器面全灭（0.2.0-rc.1 上就是这么坏的）。
  // 两个都到位再装，才既保住 headless 降级，又不赌激活顺序。
  ctx.inject(['webServer', 'connection'], (scope) => {
    const disposeWeb = installWebSurface(scope, notifier, {
      entryId: ENTRY_ID,
      bundlePath: CLIENT_BUNDLE,
    })
    if (!disposeWeb) return
    scope.effect(() => disposeWeb, 'dsh-notify: web surface')
    console.log(
      '[dsh-notify] browser surface on; stream=' + STREAM_PATH
        + '; api=/api/dsh-notify.{' + METHODS.join(',') + '}',
    )
  })

  const c = notifier.getConfig()
  console.log(
    '[dsh-notify] host loaded'
      + '; turn-end=' + c.notifyOnTurnEnd + ' approval=' + c.notifyOnApproval + ' question=' + c.notifyOnQuestion
      + '; ack=' + c.ack + ' sound=' + c.sound + ' browser=' + c.browser
      + (c.webhookUrl !== '' ? '; webhook=on' : ''),
  )
}
