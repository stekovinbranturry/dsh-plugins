// 宿主半的入口：一个方法一条 /api 承运路由给浏览器半调用 + 3 个模型工具。
//
// 路由注册在 @deepseek-ai/dsh-client-connection 的 /api 通道上（ctx.connection.fetch.register），
// 与 DSH 自己的 present.open 同一形状：信任围栏（Host / Origin）与浏览器认证（401/403）由承运层
// 在把请求交给 handler 之前做完，这里不再自建前缀路由、也不再抄一份围栏。
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

import { handlerFor, METHODS } from './api.js'
import {
  DEFAULT_HANDOFF_TEMPLATE,
  DEFAULT_SESSION_TITLE_TEMPLATE,
  DEFAULT_TITLE_TEMPLATE,
  DEFAULT_WORKTREE_ROOT,
} from './constants.js'
import type { ResolvedConfig, State } from './core.js'
import { errText, jsonResponse, readJsonRequest } from './http.js'
import type { Connection } from './services.js'
import { registerTools } from './tools.js'
import { installClientWatch } from './watch.js'
import { apiPath } from '../shared/api.js'

export const name = 'dsh-worktree'

/** 插件入口 id：必须与 package.json 的 name、客户端 bundle 的 __ModuleLoader__ id 一致 */
export const ENTRY_ID = '@stekovinbranturry/dsh-worktree'

// 两类依赖都是软的：工具要 tools 服务、面板要 /api 承运通道，缺了只关掉对应能力。
// 静态 inject 留空，headless / SDK 组合照样能装（拿到 git 能力层与三个模型工具）。
export const inject: string[] = []

/** 只暴露必要的旋钮；所有默认值都与 constants.ts 里的文档一致 */
export const Config = z.object({
  /** worktree 根目录，相对仓库根 */
  worktreeRoot: z.string().default(DEFAULT_WORKTREE_ROOT),
  /** 工作区（项目）名模板：{compact} {spaced} {name} {repo} */
  titleTemplate: z.string().default(DEFAULT_TITLE_TEMPLATE),
  /** 会话名模板：默认 {spaced}（连字符换空格） */
  sessionTitleTemplate: z.string().default(DEFAULT_SESSION_TITLE_TEMPLATE),
  /** 交接消息模板：{name} {branch} {path} {repo} {task}；默认空 = 新会话一条消息都不发 */
  handoffTemplate: z.string().default(DEFAULT_HANDOFF_TEMPLATE),
  /** 是否把 worktree 目录注册成独立项目（左侧栏按项目分组） */
  registerProject: z.boolean().default(true),
  /** 是否把 worktree 根目录写进共享 .git/info/exclude */
  writeExclude: z.boolean().default(true),
})

/** 与上面 schema 一一对应；手写而不是从 schema 推导，避免依赖 schemastery 的类型工具 */
export interface Config {
  worktreeRoot: string
  titleTemplate: string
  sessionTitleTemplate: string
  handoffTemplate: string
  registerProject: boolean
  writeExclude: boolean
}

function resolveConfig(config: Partial<Config> | undefined): ResolvedConfig {
  const source = config ?? {}
  const worktreeRoot = (source.worktreeRoot ?? '').trim()
  return {
    worktreeRoot: worktreeRoot === '' ? DEFAULT_WORKTREE_ROOT : worktreeRoot,
    titleTemplate: source.titleTemplate ?? DEFAULT_TITLE_TEMPLATE,
    sessionTitleTemplate: source.sessionTitleTemplate ?? DEFAULT_SESSION_TITLE_TEMPLATE,
    handoffTemplate: source.handoffTemplate ?? DEFAULT_HANDOFF_TEMPLATE,
    registerProject: source.registerProject !== false,
    writeExclude: source.writeExclude !== false,
  }
}

const CLIENT_BUNDLE = fileURLToPath(new URL('../client.js', import.meta.url))

export function apply(ctx: Context, config?: Partial<Config>): void {
  const state: State = { ctx, config: resolveConfig(config) }

  // 模型工具是软依赖：没有 tools 服务的部署仍然能用 HTTP + git 能力层
  ctx.inject(['tools'], (scope) => {
    registerTools(scope, { getState: () => state })
  })

  // 一个方法一条精确路由：路径匹配、方法匹配（只收 POST）、403/401 围栏都归承运层，
  // 这里只把请求体读出来交给业务处理函数
  const route = (call: (ctx: Context, deps: { getState: () => State }, args: Record<string, unknown>) => Promise<unknown>) =>
    async (request: Request): Promise<Response> => {
      let body
      try {
        body = await readJsonRequest(request)
      } catch (error) {
        return jsonResponse(400, { ok: false, error: 'bad-json: ' + errText(error) })
      }
      // 处理函数自己的失败以 200 + ok:false 回，客户端只判断 ok，不必区分传输层
      try {
        return jsonResponse(200, await call(ctx, { getState: () => state }, body))
      } catch (error) {
        return jsonResponse(200, { ok: false, error: errText(error) })
      }
    }

  // 承运通道是软依赖：模型工具与 git 能力层不靠浏览器也能用，没有 /api 通道的部署
  // （headless / SDK）少掉面板接口而已
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection') as Connection
    for (const method of METHODS) {
      const call = handlerFor(method)
      if (call === null) continue
      scope.effect(
        () => connection.fetch.register({
          path: apiPath(method),
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: route(call),
        }),
        'dsh-worktree: ' + apiPath(method),
      )
    }
    console.log('[dsh-worktree] browser api on ' + METHODS.map(apiPath).join(' '))
  })

  const watching = installClientWatch(ctx, ENTRY_ID, CLIENT_BUNDLE)
  console.log(
    '[dsh-worktree] host loaded; worktreeRoot=' + state.config.worktreeRoot
      + (watching ? '; watching client bundle for HMR' : ''),
  )
}
