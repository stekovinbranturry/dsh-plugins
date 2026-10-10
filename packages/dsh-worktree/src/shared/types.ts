// 宿主与浏览器半共用的契约：两侧都按 ESM 各自解析，不跨边界 import 运行时值
// （类型用 import type，编译后消失）。
//
// 这个插件只做两件事：列出仓库里已有的 worktree（挑一个开新会话），
// 以及建一个新 worktree（检出已有分支，或从某个起点新建分支）。

/** 列表里的一项：直接用 git 的事实，不额外记元数据 */
export interface WorktreeItem {
  /** worktree 名（= .worktrees/<name> 的目录名；外部 worktree 取目录 basename） */
  name: string
  /** worktree 绝对路径 */
  path: string
  /** 检出的分支全名；detached 时为 null */
  branch: string | null
  detached: boolean
}

/** 可用来建 worktree 的分支 */
export interface BranchItem {
  /** 展示名：本地分支 `feature/x`，远端分支 `origin/feature/x` */
  name: string
  kind: 'local' | 'remote'
  /** 建 worktree 时实际会检出的本地分支名 */
  localName: string
  /** 该分支已经被某个 worktree 检出：值为那个路径（选中会失败，UI 标灰） */
  inWorktree: string | null
}

/** 一次失败的结构化原因，两个前端都靠它显示 */
export interface WorktreeError {
  ok: false
  error: string
  detail?: string
  warnings?: string[]
}

export interface WorktreeContextOk {
  ok: true
  repoRoot: string
  /** 该仓库 worktree 的根目录（绝对路径） */
  worktreeRoot: string
  items: WorktreeItem[]
  branches: BranchItem[]
  warnings: string[]
}

export type WorktreeContextResult = WorktreeContextOk | WorktreeError

export interface WorktreeCreateOk {
  ok: true
  item: WorktreeItem
  warnings: string[]
  /** enter=true 时带回来的新会话 id */
  sessionId?: string
}

export type WorktreeCreateResult = WorktreeCreateOk | WorktreeError

export interface WorktreeOpenOk {
  ok: true
  sessionId: string
  title: string
  path: string
  branch: string | null
  warnings: string[]
}

export type WorktreeOpenResult = WorktreeOpenOk | WorktreeError
