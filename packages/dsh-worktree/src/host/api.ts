// 浏览器半调用的 HTTP 路由表。Cordis 的 webServer register 传进来的 req 是结构镜像，
// 所以这里只依赖最小字段面（method/headers/迭代读体）。
import type { Context } from '@deepseek-ai/cordis'

import * as core from './core.js'
import type { State } from './core.js'
import type { ApiArgs } from './http.js'
import { service, sessionOf } from './services.js'

export interface ApiDeps {
  getState: () => State
}

function str(args: ApiArgs, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function bool(args: ApiArgs, key: string): boolean {
  return args[key] === true
}

/** 仓库定位：显式 repoPath（无会话时唯一来源）+ 可选 sessionId（拿 cwd 兜底） */
function targetFrom(args: ApiArgs, ctx: Context): core.RepoTarget {
  const sessionId = str(args, 'sessionId')
  return { sessionId, session: sessionOf(ctx, sessionId), repoPath: str(args, 'repoPath') }
}

export type ApiHandler = (ctx: Context, deps: ApiDeps, args: ApiArgs) => Promise<unknown>

const API: Record<string, ApiHandler> = {
  /** 弹层先拉这个：仓库信息 + 全部已有 worktree + 可用来建 worktree 的分支 */
  async context(ctx, deps, args) {
    return core.listWorktreesOp(deps.getState(), targetFrom(args, ctx))
  },

  /** 只读查询 origin 实际分支，不使用可能残留的远端跟踪引用。 */
  async remoteBranch(ctx, deps, args) {
    return core.remoteBranchOp(deps.getState(), { ...targetFrom(args, ctx), branch: str(args, 'branch') })
  },

  /** 用户主动拉取远端分支；普通 context 仍然只读 */
  async fetch(ctx, deps, args) {
    return core.fetchBranchesOp(deps.getState(), targetFrom(args, ctx))
  },

  /** 建一个 worktree：检出已有分支，或从某起点新建分支；enter=true 时顺手开成新会话 */
  async create(ctx, deps, args) {
    return core.createWorktreeOp(deps.getState(), {
      ...targetFrom(args, ctx),
      branch: str(args, 'branch'),
      newBranch: str(args, 'newBranch'),
      base: str(args, 'base'),
      name: str(args, 'name'),
      enter: bool(args, 'enter'),
      task: str(args, 'task'),
      agentPreset: str(args, 'agentPreset'),
    })
  },

  /** 把一个已有 worktree 开成新会话 */
  async open(ctx, deps, args) {
    return core.openWorktreeOp(deps.getState(), {
      ...targetFrom(args, ctx),
      name: str(args, 'name'),
      task: str(args, 'task'),
      agentPreset: str(args, 'agentPreset'),
    })
  },

  /** 删一个已有 worktree：归档它的会话 → 注销工作区登记 → 删目录；勾了才连分支一起删 */
  async remove(ctx, deps, args) {
    return core.removeWorktreeOp(deps.getState(), {
      ...targetFrom(args, ctx),
      name: str(args, 'name'),
      force: bool(args, 'force'),
      deleteBranch: bool(args, 'deleteBranch'),
      deleteRemoteBranch: bool(args, 'deleteRemoteBranch'),
    })
  },
}

/** 返回 null 表示未知方法 */
export function handlerFor(method: string): ApiHandler | null {
  return Object.prototype.hasOwnProperty.call(API, method) ? (API[method] ?? null) : null
}

export const METHODS = Object.keys(API)

export { service }
