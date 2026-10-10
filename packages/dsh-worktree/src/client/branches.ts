/**
 * 纯逻辑：工作区/分支的选择、筛选与派生。不依赖 React，单独拿出来也方便直接断言。
 */
import type { BranchItem } from '../shared/types.js'
import type { SessionListState, WorkspaceView } from './types.js'

/**
 * 当前选中的工作区：当前会话所属的那个；没有会话时按 DSH 自己 startSession 用的
 * recentWorkspace 规则（取最近有会话活动的工作区，并列时按注册顺序）。
 */
export function pickWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState,
): WorkspaceView | undefined {
  const current = sessions.current
  if (current !== undefined) {
    const owner = workspaces.find((workspace) => workspace.sessionIds.includes(current))
    if (owner !== undefined) return owner
  }
  let selected: WorkspaceView | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions.byId[sessionId]
      if (session !== undefined && typeof session.updatedAt === 'number') {
        latest = Math.max(latest, session.updatedAt)
      }
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (Number.isNaN(latest)) latest = Number.NEGATIVE_INFINITY
    if (selected === undefined || latest > selectedTime) {
      selected = workspace
      selectedTime = latest
    }
  }
  return selected
}

/** 分支下拉的筛选：忽略大小写的子串匹配，空串给全量（顺序保持 git 的顺序） */
export function filterBranches(branches: readonly BranchItem[], query: string): BranchItem[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return branches.slice()
  return branches.filter((branch) => branch.name.toLowerCase().includes(needle))
}

/**
 * 工作区路径里是不是一个 worktree：worktree 目录都在主仓库的 `.worktrees/` 下，
 * 用路径段判断，避免把 `/repo/.worktrees` 这类当普通仓库。目标仓库只从非 worktree
 * 的工作区里选（不在 worktree 里再建 worktree）。
 */
export function isWorktreePath(path: string): boolean {
  return path.split('/').includes('.worktrees')
}

/** 默认的可选性：已经被检出的分支不能当目标（当起点倒是可以） */
export function isPickable(branch: BranchItem): boolean {
  return branch.inWorktree === null
}

/** 能选的第一项 */
export function firstUsable(
  branches: readonly BranchItem[],
  pickable: (branch: BranchItem) => boolean = isPickable,
): number {
  const index = branches.findIndex(pickable)
  return index < 0 ? 0 : index
}

/**
 * 键盘上下移动：跳过不能选的项（停在边界就不动了）。
 * 不跳的话，光标会停在灰行上、回车又什么都不做，看起来像坏了。
 */
export function stepUsable(
  branches: readonly BranchItem[],
  from: number,
  delta: number,
  pickable: (branch: BranchItem) => boolean = isPickable,
): number {
  const last = branches.length - 1
  if (last < 0) return from
  for (let index = from + delta; index >= 0 && index <= last; index += delta) {
    const branch = branches[index]
    if (branch !== undefined && pickable(branch)) return index
  }
  return from
}

/**
 * 新分支的起点候选：HEAD（主 worktree 当前提交）排在最前，然后是全部本地 / origin/*
 * 分支。起点不受"已被检出"限制——从任何提交开新分支都是合法的。
 */
export function baseItems(branches: readonly BranchItem[]): BranchItem[] {
  return [{ name: 'HEAD', kind: 'local', localName: 'HEAD', inWorktree: null }, ...branches]
}

/** 起点永远可选：已检出的分支照样能当起点 */
export function alwaysPickable(): boolean {
  return true
}
/** feature/foo → feature-foo；origin/foo → foo */
export function deriveName(branch: string): string {
  const short = branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch
  return short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
}
