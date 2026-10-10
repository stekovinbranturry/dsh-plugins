// 核心能力层：只有三件事 —— 列已有 worktree、建一个 worktree（检出已有分支，或从
// 某个起点新建分支）、把某个 worktree 开成新会话。浏览器半与模型工具都调这里，
// 保证两端语义完全一致。
import { existsSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type {
  BranchItem,
  WorktreeContextResult,
  WorktreeCreateResult,
  WorktreeItem,
  WorktreeOpenResult,
} from '../shared/types.js'
import { ERR, NAME_MAX, REMOTE, TASK_SECTION_TEMPLATE } from './constants.js'
import * as git from './git.js'
import type { RepoInfo } from './git.js'
import { createSession, fillTemplate, registerProject } from './sessions.js'
import { looksLikeWriteDenied, sandboxRefusal } from './sandbox.js'
import type { Context, SandboxPolicyLike, SessionLike } from './services.js'
import { resolveCallPolicy } from './services.js'

/** 工作区名里用的短名：worktree 名去掉所有连字符（feature-local-only → featurelocalonly） */
export function compactName(name: string): string {
  return name.replace(/-/g, '')
}

/** 会话名里用的可读名：连字符换成空格（feature-local-only → feature local only） */
export function spacedName(name: string): string {
  return name.replace(/-/g, ' ').trim()
}

/** 模板变量：工作区名与会话名共用一套 */
function titleValues(name: string, repoRoot: string, branch: string | null, path: string): Record<string, string> {
  return {
    name,
    compact: compactName(name),
    spaced: spacedName(name),
    repo: basename(repoRoot),
    branch: branch ?? '',
    path,
  }
}

/**
 * 渲染交接消息。空模板 + 没任务 = 空串，调用方据此**一条消息都不发**（干净的新对话）。
 *
 * 面板不问任务，所以模板默认就是空的；只有工具调用方显式给了任务时才有一段。
 * 模板里自己写了 {task} 就按模板的位置走，不重复追加。
 */
export function buildHandoff(template: string, values: Record<string, string>): string {
  const rendered = fillTemplate(template, values).trim()
  const task = (values.task ?? '').trim()
  if (task === '' || template.includes('{task}')) return rendered
  // 模板为空时不要凭空多出一个空行：有模板才拿空行分隔，没有就直接是任务那一段
  return (rendered === '' ? '' : rendered + '\n\n') + fillTemplate(TASK_SECTION_TEMPLATE, { task })
}

export interface ResolvedConfig {
  /** worktree 根目录，相对仓库根 */
  worktreeRoot: string
  /** 工作区（项目）名模板 */
  titleTemplate: string
  /** 会话名模板 */
  sessionTitleTemplate: string
  handoffTemplate: string
  /** 是否把 worktree 目录注册成独立项目（左侧栏按项目分组） */
  registerProject: boolean
  /** 是否把 worktree 根目录写进共享 .git/info/exclude */
  writeExclude: boolean
}

export interface State {
  ctx: Context
  config: ResolvedConfig
}

export interface SessionRef {
  sessionId: string | null
  session?: SessionLike
}

/** 前端/工具传入的仓库定位：优先显式 repoPath（无会话时靠它），否则退到会话 cwd */
export interface RepoTarget extends SessionRef {
  repoPath?: string | null
}

function fail(
  error: string,
  detail?: string,
  warnings?: string[],
): { ok: false; error: string; detail?: string; warnings?: string[] } {
  return {
    ok: false,
    error,
    ...(detail === undefined ? {} : { detail }),
    ...(warnings === undefined ? {} : { warnings }),
  }
}

export function worktreeRootOf(config: ResolvedConfig, repoRoot: string): string {
  return resolve(repoRoot, config.worktreeRoot)
}

/** exclude 用的相对路径：git 的 exclude 模式以仓库根为基准，统一成正斜杠 */
function excludeEntry(config: ResolvedConfig): string {
  const root = config.worktreeRoot.replace(/^\.\//, '').replace(/\/+$/, '').split(sep).join('/')
  return root + '/'
}

/** 把仓库路径解析成 RepoInfo：显式 repoPath 优先，其次会话 cwd */
async function repoTarget(
  state: State,
  input: RepoTarget,
): Promise<
  { repo: RepoInfo; warnings: string[] } | { ok: false; error: string; detail?: string; warnings?: string[] }
> {
  const cwd = typeof input.session?.header?.cwd === 'string' ? input.session.header.cwd : null
  const explicit = typeof input.repoPath === 'string' ? input.repoPath.trim() : ''
  const candidate = explicit !== '' ? explicit : cwd
  if (candidate === null || candidate === '') {
    return fail(ERR.noRepo, '当前没有选中的工作区')
  }
  const repo = await git.resolveRepo(state.ctx, candidate)
  if (!repo) return fail(ERR.notRepo, `不是 git 仓库：${candidate}`)
  const warnings: string[] = []
  // 会话 cwd 可能已经不存在（比如它就在被删掉的 worktree 里）：解析会退回存在的父目录
  if (explicit === '' && !existsSync(candidate)) warnings.push('cwd-missing: ' + candidate)
  return { repo, warnings }
}

/**
 * 只列/只认"额外的" worktree：主 worktree 本身就是仓库，开新会话走 DSH 原生的
 * 新建对话就行，混在列表里只会干扰选择。
 */
function linkedEntries(entries: readonly git.WorktreeEntry[], repoRoot: string): git.WorktreeEntry[] {
  return entries.filter(
    (entry) => entry.bare !== true && resolve(entry.path) !== resolve(repoRoot),
  )
}

function nameFromPath(config: ResolvedConfig, repoRoot: string, path: string): string {
  const root = worktreeRootOf(config, repoRoot)
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/') ? rel.split(sep).join('/') : basename(path)
}

function toItem(config: ResolvedConfig, repoRoot: string, entry: git.WorktreeEntry): WorktreeItem {
  return {
    name: nameFromPath(config, repoRoot, entry.path),
    path: entry.path,
    branch: entry.detached ? null : entry.branch,
    detached: entry.detached,
  }
}

/**
 * 分支清单：本地分支 + origin/*。同名的本地分支优先（远端那条不再重复列出），
 * 已被某个 worktree 检出的分支带上 inWorktree，UI 标灰。
 */
export async function branchItems(
  ctx: Context,
  repoRoot: string,
  entries: readonly git.WorktreeEntry[],
): Promise<BranchItem[]> {
  const listed = await git.listBranches(ctx, repoRoot, REMOTE)
  const checkedOutAt = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.detached && entry.branch !== null) checkedOutAt.set(entry.branch, entry.path)
  }
  const items: BranchItem[] = []
  const localNames = new Set(listed.local)
  for (const name of listed.local) {
    items.push({ name, kind: 'local', localName: name, inWorktree: checkedOutAt.get(name) ?? null })
  }
  for (const full of listed.remote) {
    const short = full.startsWith(REMOTE + '/') ? full.slice(REMOTE.length + 1) : full
    // 同名本地分支已列过：远端那条是冗余的
    if (short === '' || localNames.has(short)) continue
    items.push({ name: full, kind: 'remote', localName: short, inWorktree: checkedOutAt.get(short) ?? null })
  }
  return items
}

/** 列：仓库里所有已有 worktree + 可用来建新 worktree 的分支 */
export async function listWorktreesOp(state: State, input: RepoTarget): Promise<WorktreeContextResult> {
  const target = await repoTarget(state, input)
  if ('ok' in target) return target
  const { repo } = target
  const warnings = [...target.warnings]
  const entries = await git.listWorktrees(state.ctx, repo.root)
  const items = linkedEntries(entries, repo.root)
    .map((entry) => toItem(state.config, repo.root, entry))
    .sort((left, right) => left.name.localeCompare(right.name))
  const branches = await branchItems(state.ctx, repo.root, entries)
  return {
    ok: true,
    repoRoot: repo.root,
    worktreeRoot: worktreeRootOf(state.config, repo.root),
    items,
    branches,
    warnings,
  }
}

export interface CreateInput extends RepoTarget {
  /** 已有分支：本地名 `feature/x` 或远端名 `origin/feature/x` */
  branch?: string | null
  /** 新分支名；给了它就建新分支（与 branch 二选一） */
  newBranch?: string | null
  /** 新分支的起点：本地名 / `origin/x` / HEAD；空则 HEAD（主 worktree 当前提交） */
  base?: string | null
  /** 目录名；空则从分支名派生 */
  name?: string | null
  /** 建完就把这个 worktree 开成新会话 */
  enter?: boolean
  /** 交接消息里的任务描述 */
  task?: string | null
  agentPreset?: string | null
}

/**
 * 决定这次要检出哪个本地分支、以及怎么检出。
 *
 * - 已有分支：本地分支直接检出；远端跟踪分支建同名本地分支并设好 upstream。
 *   分支已经被别的 worktree 检出时直接拒（git 也会拒，但错误信息不如自己给的可读）。
 * - 新分支：本地不能已有同名分支，起点必须真实存在（默认 HEAD）。
 */
async function resolveTarget(
  state: State,
  repo: RepoInfo,
  entries: readonly git.WorktreeEntry[],
  input: CreateInput,
): Promise<
  | { branch: string; add: (path: string, policy: SandboxPolicyLike | undefined) => Promise<git.GitProbe> }
  | { ok: false; error: string; detail?: string; warnings?: string[] }
> {
  const repoRoot = repo.root
  const newBranch = (input.newBranch ?? '').trim()

  if (newBranch !== '') {
    // 新分支名不接受 origin/ 前缀：那是个远端跟踪名，不是要创建的本地名字
    if (!git.isValidBranchName(newBranch) || newBranch.startsWith(REMOTE + '/')) {
      return fail(ERR.badBranch, `新分支名不可用：${newBranch}`)
    }
    if (await git.branchExistsLocal(state.ctx, repoRoot, newBranch)) {
      return fail(ERR.branchExists, `本地已经有分支 ${newBranch} 了：改个名字，或选"已有分支"`)
    }
    const base = (input.base ?? '').trim() || 'HEAD'
    if (base !== 'HEAD') {
      if (!git.isValidBranchName(base)) return fail(ERR.badBranch, `起点不可用：${base}`)
      if (!(await git.revisionExists(state.ctx, repoRoot, base))) {
        return fail(ERR.baseNotFound, `起点不存在：${base}（本地和 ${REMOTE} 都没有）`)
      }
    }
    return {
      branch: newBranch,
      add: (path: string, policy: SandboxPolicyLike | undefined) =>
        git.worktreeAddNewBranch(state.ctx, { repoRoot, path, branch: newBranch, startPoint: base, policy }),
    }
  }

  const branchInput = (input.branch ?? '').trim()
  if (branchInput === '') return fail(ERR.missingTarget, '要给出已有分支，或给出新分支名')
  if (!git.isValidBranchName(branchInput)) {
    return fail(ERR.badBranch, `分支名不可用：${branchInput}`)
  }
  const short = branchInput.startsWith(REMOTE + '/') ? branchInput.slice(REMOTE.length + 1) : branchInput
  if (short === '' || !git.isValidBranchName(short)) {
    return fail(ERR.badBranch, `分支名不可用：${branchInput}`)
  }

  const checkedOut = entries.find((entry) => !entry.detached && entry.branch === short)
  if (checkedOut) {
    return fail(ERR.branchInUse, `分支 ${short} 已经在 ${checkedOut.path} 里检出了`)
  }

  const localExists = await git.branchExistsLocal(state.ctx, repoRoot, short)
  const remoteExists = localExists ? false : await git.branchExistsRemote(state.ctx, repoRoot, REMOTE, short)
  if (!localExists && !remoteExists) {
    return fail(ERR.branchNotFound, `分支不存在：${branchInput}（本地和 ${REMOTE} 都没有）`)
  }

  return {
    branch: short,
    add: (path: string, policy: SandboxPolicyLike | undefined) =>
      localExists
        ? git.worktreeAddBranch(state.ctx, { repoRoot, path, branch: short, policy })
        : git.worktreeAddTracking(state.ctx, {
            repoRoot,
            path,
            localBranch: short,
            remoteRef: `${REMOTE}/${short}`,
            policy,
          }),
  }
}

/** 建一个 worktree：从已有分支检出，或从某个起点新建分支。 */
export async function createWorktreeOp(state: State, input: CreateInput): Promise<WorktreeCreateResult> {
  const target = await repoTarget(state, input)
  if ('ok' in target) return target
  const { repo } = target
  const warnings = [...target.warnings]

  const entries = await git.listWorktrees(state.ctx, repo.root)
  const resolved = await resolveTarget(state, repo, entries, input)
  if ('ok' in resolved) return resolved
  const short = resolved.branch

  const explicitName = (input.name ?? '').trim()
  const name = explicitName !== '' ? explicitName : git.nameFromBranch(short)
  if (name === '' || name.length > NAME_MAX || !git.isValidName(name)) {
    return fail(
      ERR.badName,
      `目录名只允许小写字母、数字、连字符（1-${NAME_MAX} 位，以字母或数字开头）：${name || '(空)'}`,
    )
  }

  const path = join(worktreeRootOf(state.config, repo.root), name)
  if (existsSync(path) || entries.some((entry) => resolve(entry.path) === resolve(path))) {
    return fail(ERR.exists, `已经存在：${path}`)
  }

  // 写之前先判沙箱可写范围：目标仓库与 worktree 目录都要落在某个可写根内（会话工作区
  // 或宿主临时区域）。落在外面时 git 只会回一句 "Operation not permitted"，用户根本
  // 看不出是权限范围问题
  const policy = resolveCallPolicy(state.ctx, input.session)
  const refusal = sandboxRefusal(policy, [repo.root, path])
  if (refusal) return fail(refusal.error, refusal.detail, warnings)

  if (state.config.writeExclude) {
    const excluded = git.ensureExclude(repo.commonDir, excludeEntry(state.config))
    if (excluded.warning !== null) warnings.push(excluded.warning)
  }

  const added = await resolved.add(path, policy)
  if (added.code !== 0) {
    const raw = added.err.trim() || `git worktree add 退出码 ${added.code}`
    // 前置判定漏掉的情况（例如 .git 在可写根内、但 worktree 目录被别的挂载点挡住）
    if (looksLikeWriteDenied(raw)) return fail(ERR.sandboxDenied, raw, warnings)
    return fail(ERR.addFailed, raw, warnings)
  }

  const after = await git.listWorktrees(state.ctx, repo.root)
  const created = after.find((entry) => resolve(entry.path) === resolve(path))
  const item: WorktreeItem = created
    ? toItem(state.config, repo.root, created)
    : { name, path, branch: short, detached: false }

  if (input.enter === true) {
    const opened = await openWorktreeOp(state, {
      sessionId: input.sessionId,
      session: input.session,
      repoPath: repo.root,
      name,
      task: input.task ?? undefined,
      agentPreset: input.agentPreset ?? undefined,
    })
    if (opened.ok) {
      return { ok: true, item, warnings, sessionId: opened.sessionId }
    }
    warnings.push('open-failed: ' + opened.error + (opened.detail ? ' ' + opened.detail : ''))
  }
  return { ok: true, item, warnings }
}

export interface OpenInput extends RepoTarget {
  /** worktree 名（.worktrees/<name> 的目录名，或外部 worktree 的目录 basename） */
  name?: string | null
  /** 交接消息里的任务描述 */
  task?: string | null
  agentPreset?: string | null
}

/** 选：把一个已有 worktree 开成一个新会话（原会话不动） */
export async function openWorktreeOp(state: State, input: OpenInput): Promise<WorktreeOpenResult> {
  const target = await repoTarget(state, input)
  if ('ok' in target) return target
  const { repo } = target
  const warnings = [...target.warnings]

  const name = (input.name ?? '').trim()
  if (name === '') return fail(ERR.notFound, '缺少 worktree 名')
  const entries = await git.listWorktrees(state.ctx, repo.root)
  const found = linkedEntries(entries, repo.root)
    .map((entry) => ({ entry, item: toItem(state.config, repo.root, entry) }))
    .find((candidate) => candidate.item.name === name)
  if (!found) return fail(ERR.notFound, `这个仓库里没有 worktree：${name}`)

  const values = titleValues(found.item.name, repo.root, found.item.branch, found.entry.path)
  // 两个名字：工作区（左侧栏那个项目）用短的，会话名给人读
  const workspaceTitle = fillTemplate(state.config.titleTemplate, values)
  const sessionTitle = fillTemplate(state.config.sessionTitleTemplate, values)
  const handoff = buildHandoff(state.config.handoffTemplate, {
    name: found.item.name,
    repo: basename(repo.root),
    branch: found.item.branch ?? '(detached)',
    path: found.entry.path,
    task: (input.task ?? '').trim(),
  })

  let workspaceId: string | null = null
  if (state.config.registerProject) {
    workspaceId = await registerProject(state.ctx, found.entry.path, workspaceTitle)
    if (workspaceId === null) warnings.push('project-register-failed')
  }

  let created: { sessionId: string; warnings: string[] }
  try {
    created = await createSession(state.ctx, {
      path: found.entry.path,
      title: sessionTitle,
      handoff,
      workspaceId,
      ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}),
    })
  } catch (error) {
    return fail(ERR.openFailed, git.errorText(error), warnings)
  }
  warnings.push(...created.warnings)
  return {
    ok: true,
    sessionId: created.sessionId,
    // title 是**会话**名（工作区名是另一套，见 workspaceTitle）
    title: sessionTitle,
    path: found.entry.path,
    branch: found.item.branch,
    warnings,
  }
}
