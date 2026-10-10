// 浏览器半的两类入口：
//   1. `POST /api/dsh-notify.{state|test}` —— 拉配置、发一条测试通知（一次性请求/响应），
//      注册在 DSH 的 /api 承运通道上：Host / Origin 围栏（DNS-rebinding / 跨站防御）与浏览器
//      认证由承运层在进 handler 之前做完，这里不再自己判、也不再自己回 403/401
//   2. `GET  /dsh-notify/stream`         —— SSE 长连，宿主把通知推给所有挂着的页面
//
// 长连不走 /api 承运通道（那边是请求/响应，拿不住一条长期持有的响应），所以它自留在
// webServer 上；围栏问承运层要裁定：ctx.connection.requestRejection({ headers })。长连尤其
// 需要这道裁定 —— 它一直挂着，一旦放开就是一个稳定的跨站通知注入点
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  META_NAME,
  METHODS,
  STREAM_PATH,
  WEBHOOK_TIMEOUT_MS,
} from './constants.js'
import type { MethodName } from './constants.js'
import { errText, jsonResponse, writeJson } from './http.js'
import type { Notifier } from './notifier.js'
import type { Connection, Context, IndexInjectionRow, WebServer } from './services.js'
import { service } from './services.js'
import { installWatch } from './watch.js'
import { channelsOf } from '../shared/channels.js'
import { apiPath } from '../shared/api.js'
import type { NotifyState, NotifyTestResult } from '../shared/types.js'

export interface WebDeps {
  /** 客户端 bundle 的入口 id（= npm 包名），HMR 重建时用 */
  entryId: string
  bundlePath: string
}

/**
 * 注册两类入口 + 一条 index 注入；返回的 disposer 会一次性摘掉它们。
 * 没有 webServer（headless / SDK 组合）时返回 null：webhook 完全不受影响，
 * 只是没有浏览器那半。有 webServer 但没有承运通道同样返回 null —— 长连的围栏与认证都在
 * 承运层里，拿不到裁定就不该开这条口子（fail closed）。
 */
export function installWebSurface(ctx: Context, notifier: Notifier, deps: WebDeps): (() => void) | null {
  const webServer = service<WebServer>(ctx, 'webServer')
  if (!webServer) {
    notifier.log('webServer service absent; browser surface disabled')
    return null
  }
  const connection = service<Connection>(ctx, 'connection')
  if (
    !connection
    || typeof connection.requestRejection !== 'function'
    || typeof connection.fetch?.register !== 'function'
  ) {
    notifier.log('connection service absent; browser surface disabled')
    return null
  }

  const disposers: Array<() => void> = []

  // SSE 长连：自留 webServer，围栏取承运层的 401/403 裁定
  disposers.push(webServer.register({
    kind: 'exact',
    path: STREAM_PATH,
    handler: (req, res) => {
      const rejection = connection.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        writeJson(res, rejection, { ok: false, error: rejection === 403 ? 'forbidden' : 'unauthorized' })
        return
      }
      if (req.method !== 'GET') {
        writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      notifier.handleStream(req, res)
    },
  }))

  // JSON 方法：一个方法一条精确路由，路径 / 方法 / 围栏 / 认证都归承运层
  for (const method of METHODS) {
    disposers.push(connection.fetch.register({
      path: apiPath(method),
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (): Promise<Response> => {
        try {
          return jsonResponse(200, await runMethod(notifier, method))
        } catch (error) {
          return jsonResponse(200, { ok: false, error: errText(error) })
        }
      },
    }))
  }

  // index 注入：客户端在 boot 时读这条 meta 拿流地址与渠道开关
  const tap = tapIndex(ctx, notifier)
  if (tap) disposers.push(tap)

  const watching = installWatch(ctx, deps.entryId, deps.bundlePath)
  if (watching) notifier.log('watching client bundle for HMR')

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 卸载期的失败不值得抛
      }
    }
  }
}

/**
 * `webserver/index-inject` 是 emit 型事件：每次渲染 index 都会重新问一遍，所以这里
 * 读实时配置。服务/事件缺失时返回 null（只损失"页面侧渠道开关"，不影响通知本体）。
 */
function tapIndex(ctx: Context, notifier: Notifier): (() => void) | null {
  const events = ctx.events
  if (!events || typeof events.on !== 'function') return null
  return events.on('webserver/index-inject', (rows: IndexInjectionRow[]) => {
    const channels = channelsOf(notifier.getConfig())
    const value = JSON.stringify({ endpoint: STREAM_PATH, channels })
    rows.push({
      kind: 'html',
      placement: 'head',
      // 单引号属性 + 转义单引号：JSON 里的双引号就不用动了
      html: '<meta name="' + META_NAME + '" content=\'' + value.replace(/'/g, '&#39;') + '\'>',
    })
  })
}

/**
 * webhook 自检：真发一次请求，把真实结果带回去。
 * 之前这里只判断"URL 非空"就当成功，页面上会打印一句假的「webhook：已推」。
 */
async function probeWebhook(
  notifier: Notifier,
): Promise<{ attempted: boolean; ok: boolean; detail?: string }> {
  const config = notifier.getConfig()
  if (config.webhookUrl === '') return { attempted: false, ok: false }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS)
  try {
    const response = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...config.webhookHeaders },
      body: JSON.stringify({
        kind: 'turn-end',
        title: 'DSH 通知自检',
        test: true,
        at: Date.now(),
        text: '看到这条说明 webhook 链路是通的',
      }),
      signal: controller.signal,
    })
    return response.ok
      ? { attempted: true, ok: true }
      : { attempted: true, ok: false, detail: 'HTTP ' + response.status }
  } catch (error) {
    return { attempted: true, ok: false, detail: errText(error) }
  } finally {
    clearTimeout(timer)
  }
}

async function runMethod(notifier: Notifier, method: MethodName): Promise<NotifyState | NotifyTestResult> {
  if (method === 'state') {
    return {
      ok: true,
      config: notifier.snapshot(),
      clients: notifier.clientCount,
      delivered: notifier.deliveredCount,
    }
  }

  // test：立刻发一条假通知，用来验证"宿主 → 页面 → 系统弹窗"整条链路
  const clients = notifier.clientCount
  notifier.publishFull({
    kind: 'turn-end',
    title: 'DSH 通知自检',
    sessionId: '',
    sessionTitle: '测试通知',
    workspace: '',
    test: true,
    turn: { turn: 1, status: 'completed', elapsedMs: 1_000, reply: '看到这条说明通知链路是通的' },
  })

  const webhook = await probeWebhook(notifier)
  return {
    ok: true,
    webhook,
    clients,
  }
}
