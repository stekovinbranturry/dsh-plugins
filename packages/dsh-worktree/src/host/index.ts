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
import type { Connection, SettingsForms } from './services.js'
import { service } from './services.js'
import { registerTools } from './tools.js'
import { live } from './volatile.js'
import { installClientWatch } from './watch.js'
import { apiPath } from '../shared/api.js'

export const name = 'dsh-worktree'

/** 插件入口 id：必须与 package.json 的 name、客户端 bundle 的 __ModuleLoader__ id 一致 */
export const ENTRY_ID = '@zhanghanxuan/dsh-worktree'

// 两类依赖都是软的：工具要 tools 服务、面板要 /api 承运通道，缺了只关掉对应能力。
// 静态 inject 留空，headless / SDK 组合照样能装（拿到 git 能力层与三个模型工具）。
export const inject: string[] = []

// 每个字段都标 volatile —— 这是 DSH 设置面板的硬门槛：dsh-settings 的 describe() 只把
// "有 volatile 字段"的 profile 条目投影成表单（`const form = volatileForm(schema);
// if (form === void 0) return []`），一个 volatile 都没有就等于本插件在设置里没有页
// （ctx.configForms.get(ns) 永远 unavailable）。设置命名空间 = profile patch 条目的 id，
// 也就是 cordis.patch.yml 里的 `dsh-worktree`，不是包名。
//
// 代价是 schema 的输出类型被改写（schemastery 的 SchemaOutput：`'volatile-defined' → Volatile<T>`），
// volatile 字段解析出来是引用盒子而不是裸值 —— 所以不能再写 `z<Config>` 注解。
// 运行时形状见下面的 WorktreeConfigRuntime，Config 的注解就是照它写的：漏标 .volatile() 的字段
// 会是裸 boolean，跟 LiveValue<boolean> 不兼容，当场报错。

/** 只暴露必要的旋钮；所有默认值都与 constants.ts 里的文档一致 */
export const Config: Schemastery<Config, WorktreeConfigRuntime, 'plain'> = z.object({
  /** worktree 根目录，相对仓库根 */
  worktreeRoot: z.string().default(DEFAULT_WORKTREE_ROOT).volatile(),
  /** 工作区（项目）名模板：{compact} {spaced} {name} {repo} */
  titleTemplate: z.string().default(DEFAULT_TITLE_TEMPLATE).volatile(),
  /** 会话名模板：默认 {spaced}（连字符换空格） */
  sessionTitleTemplate: z.string().default(DEFAULT_SESSION_TITLE_TEMPLATE).volatile(),
  /** 交接消息模板：{name} {branch} {path} {repo} {task}；默认空 = 新会话一条消息都不发 */
  handoffTemplate: z.string().default(DEFAULT_HANDOFF_TEMPLATE).volatile(),
  /** 是否把 worktree 目录注册成独立项目（左侧栏按项目分组） */
  registerProject: z.boolean().default(true).volatile(),
  /** 是否把 worktree 根目录写进共享 .git/info/exclude */
  writeExclude: z.boolean().default(true).volatile(),
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

/**
 * volatile 字段的运行时引用盒子。结构等价于 cosmokit 的 `Volatile<T>`，这里自己写一遍：
 * @deepseek-ai/cosmokit 没有 `dsh` manifest（不是本仓该依赖的公共包），而 schemastery 的
 * 输出类型里带着它 —— 直接导出推断出来的 Config 类型会让 .d.ts 引用一个不可移植的包名（TS2742）。
 */
export interface LiveValue<T> {
  get(): T
}

/**
 * apply 收到的运行时配置：volatile 字段是引用盒子（见 volatile.ts），比 Config 多一层解包，
 * 读值一律过 live()。
 */
export interface WorktreeConfigRuntime {
  worktreeRoot: LiveValue<string>
  titleTemplate: LiveValue<string>
  sessionTitleTemplate: LiveValue<string>
  handoffTemplate: LiveValue<string>
  registerProject: LiveValue<boolean>
  writeExclude: LiveValue<boolean>
}

/**
 * 逐字段解包 volatile 引用盒子，产出一份普通对象 —— 业务侧（core / tools / api）只见裸值。
 *
 * 解包不是洁癖：面板把值写进盒子后，老写法会静默出错或直接抛 ——
 *   - `source.registerProject !== false` 对盒子恒为 true（盒子是对象）→ 开关关不掉；
 *   - `(source.worktreeRoot ?? '').trim()` 盒子没有 trim → TypeError。
 * 裸值（headless / SDK 组合、测试夹具传普通值）走同一条路：live() 原样返回。
 */
export function resolveConfig(config: Partial<WorktreeConfigRuntime> | undefined): ResolvedConfig {
  const source = config ?? {}
  const worktreeRoot = live(source.worktreeRoot ?? '').trim()
  return {
    worktreeRoot: worktreeRoot === '' ? DEFAULT_WORKTREE_ROOT : worktreeRoot,
    titleTemplate: live(source.titleTemplate) ?? DEFAULT_TITLE_TEMPLATE,
    sessionTitleTemplate: live(source.sessionTitleTemplate) ?? DEFAULT_SESSION_TITLE_TEMPLATE,
    handoffTemplate: live(source.handoffTemplate) ?? DEFAULT_HANDOFF_TEMPLATE,
    registerProject: live(source.registerProject) !== false,
    writeExclude: live(source.writeExclude) !== false,
  }
}

const CLIENT_BUNDLE = fileURLToPath(new URL('../client.js', import.meta.url))

export function apply(ctx: Context, config?: Partial<WorktreeConfigRuntime>): void {
  const state: State = { ctx, config: resolveConfig(config) }

  // 设置面板改的是 volatile 字段：Loader 不重挂插件、也不重跑 apply，只把新值原地写进
  // Config 的引用盒子，再给 owner fiber 广播这个事件（见 volatile.ts）。不在这里重新解析
  // 一遍，业务侧就还拿着 apply 那一刻的快照 —— 表现是"设置改完要重启才生效"。
  // state 已被 registerTools 与 /api 路由按引用捕获（getState: () => state），所以只换
  // state.config 就够，不必重建对象、也不必重挂插件。
  ctx.on('loader/volatile-update' as never, (() => {
    state.config = resolveConfig(config)
  }) as never)

  // 设置页策略：本插件自带页面，关掉自动页（官方约定，见 services.ts 的 SettingsForms）。
  // 与 connection 同理用 ctx.inject 而不是静态 inject：settings 缺席（headless / SDK）时
  // 插件照装，它晚到或被替换时这个 child 重跑、策略跟着走。
  ctx.inject(['settings'], (scope) => {
    const settings = service<SettingsForms>(scope, 'settings')
    if (!settings) return
    scope.effect(() => settings.configure({ auto: false }, scope.fiber), 'dsh-worktree: settings policy')
  })

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
