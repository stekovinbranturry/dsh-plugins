// 核心能力层：只有四件事 —— 列已有 worktree、建一个 worktree（检出已有分支，或从
// 某个起点新建分支）、把某个 worktree 开成新会话、删掉一个 worktree（归档它的会话，
// 可选连本地/远端分支一起删）。浏览器半与模型工具都调这里，保证两端语义完全一致。
import { existsSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'

import type {
  BranchItem,
  WorktreeContextResult,
  WorktreeCreateResult,
  WorktreeItem,
  WorktreeOpenResult,
  WorktreeRemoveResult,
  WorktreeRemoteBranchResult,
} from '../shared/types.js'
import { ERR, FETCH_TIMEOUT_MS, NAME_MAX, REMOTE, TASK_SECTION_TEMPLATE } from './constants.js'
import * as git from './git.js'
import type { RepoInfo } from './git.js'
import {
  archiveSessionsAt,
  createSession,
  fillTemplate,
  registerProject,
  samePath,
  unregisterProject,
} from './sessions.js'
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
  /** 失败之前已经有副作用落下（只有删除功能会用到，见 WorktreeError.partial） */
  partial?: boolean,
): { ok: false; error: string; detail?: string; warnings?: string[]; partial?: boolean } {
  return {
    ok: false,
    error,
    ...(detail === undefined ? {} : { detail }),
    ...(warnings === undefined ? {} : { warnings }),
    ...(partial === true ? { partial: true } : {}),
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

/** 确认框用的只读查询：workspaceChanges 不提供远端引用查询，复用宿主 shell。 */
export async function remoteBranchOp(
  state: State,
  input: RepoTarget & { branch: string | null },
): Promise<WorktreeRemoteBranchResult> {
  if (!input.branch || !git.isValidBranchName(input.branch)) return fail(ERR.badBranch)
  const target = await repoTarget(state, input)
  if ('ok' in target) return target
  const ref = 'refs/heads/' + input.branch
  const probe = await git.runGit(
    state.ctx,
    ['ls-remote', '--heads', git.q(REMOTE), git.q(ref)],
    target.repo.root,
  )
  if (probe.code !== 0) return fail(ERR.remoteCheckFailed, probe.err.trim() || `git ls-remote 退出码 ${probe.code}`)
  return { ok: true, exists: probe.out.split('\n').some((line) => line.trim().split('\t')[1] === ref) }
}

/** 只更新 origin 的远端跟踪引用，不切分支、不合并、不删除引用。 */
export async function fetchBranchesOp(state: State, input: RepoTarget): Promise<WorktreeContextResult> {
  const target = await repoTarget(state, input)
  if ('ok' in target) return target
  const { repo, warnings } = target
  const policy = resolveCallPolicy(state.ctx, input.session)
  const refusal = sandboxRefusal(policy, [repo.root, repo.commonDir])
  if (refusal) return fail(refusal.error, refusal.detail, warnings)

  // 上游 workspaceChanges 只提供变更观察，没有远端拉取服务；复用现有宿主 shell 出口。
  // 显式 refspec 也覆盖 single-branch clone，避免 origin.fetch 只跟踪一个分支时仍找不到新分支。
  const fetched = await git.runGit(
    state.ctx,
    ['fetch', '--no-prune', '--no-tags', '--no-recurse-submodules', '--', git.q(REMOTE), git.q(`+refs/heads/*:refs/remotes/${REMOTE}/*`)],
    repo.root,
    FETCH_TIMEOUT_MS,
    policy,
  )
  if (fetched.code !== 0) {
    const raw = fetched.err.trim() || `git fetch 退出码 ${fetched.code}`
    return fail(looksLikeWriteDenied(raw) ? ERR.sandboxDenied : ERR.fetchFailed, raw, warnings)
  }
  return listWorktreesOp(state, { ...input, repoPath: repo.root })
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

/** 未提交改动整理成人话：前 5 个路径 + 总数。只在前置闸门/失败兜底里调，正常路径零开销 */
function dirtyDetail(changes: readonly string[]): string {
  const paths = changes
    .map((line) => line.replace(/^[A-Z?!]{1,2}\s+/, '').trim())
    .filter((line) => line !== '')
  const sample = paths.slice(0, 5).join('、')
  const rest = paths.length > 5 ? ` 等 ${paths.length} 个文件` : ''
  return (
    `${paths.length} 个文件有未提交的改动（${sample}${rest}）。` +
    '要连这些改动一起丢掉，就勾上「强制删除」再来一次；不想丢就先在那边提交或 stash。'
  )
}

export interface RemoveInput extends RepoTarget {
  /** worktree 名（.worktrees/<name> 的目录名，或外部 worktree 的目录 basename） */
  name?: string | null
  /** 连未提交的改动一起丢掉（`git worktree remove --force`）。默认关：不替用户决定 */
  force?: boolean
  /** 顺手删本地分支，走 `git branch -d`（没合并就留下并报出来，不替用户强删） */
  deleteBranch?: boolean
  /** 顺手删 origin 上的同名分支。默认关 —— 这是本插件唯一会改远端的操作 */
  deleteRemoteBranch?: boolean
}

/**
 * 删一个 worktree。每一步失败都停在那里，顺序是有讲究的：
 *
 * 1. 先过闸门：不在列表里 / 当前会话就住在这里 / 被 lock 住 / 有未提交改动 —— 全放在
 *    任何副作用之前，拒绝时保证什么都没动（git 的脏拒绝发生在 remove 那一步，等它拒
 *    就已经把会话归档掉了，所以自己先判一次）。
 * 2. 归档它下面的会话（用户选的语义：删目录、不删对话）。
 * 3. 注销它的工作区登记 —— 必须在删目录之前，反过来的话注销失败会留下一个指向已删
 *    目录的空项目。
 * 4. `git worktree remove`；目录本来就不在了（prunable）时改跑 `git worktree prune`。
 * 5. 勾了才删分支，先本地 `-d` 后远端：`-d` 的"没合并"闸门正是用来拦住未合并的活被
 *    删掉的，闸门一响就不动远端 —— 否则远端副本白丢。
 *
 * 第 4 步没有回滚，也不需要：git worktree remove 失败就什么都没删。
 */
export async function removeWorktreeOp(state: State, input: RemoveInput): Promise<WorktreeRemoveResult> {
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

  const path = found.entry.path
  const branch = found.item.branch

  // 主 worktree 已经被 linkedEntries 排除了，所以"自删"只剩一种：当前会话的 cwd 就是
  // 它。删掉等于把自己脚下的目录抽走 —— 之后所有文件/git 操作都落在不存在的路径上，
  // 而 workspace-write 下这个目录本身必然在可写根之外（可写根是它自己）。
  const cwd = typeof input.session?.header?.cwd === 'string' ? input.session.header.cwd : null
  if (cwd !== null && cwd !== '' && samePath(cwd, path)) {
    return fail(ERR.self, `当前会话就工作在这个 worktree 里（${path}）：换一个会话来删它`, warnings)
  }
  if (found.entry.locked) {
    return fail(ERR.locked, `这个 worktree 被 git lock 住了：先 git worktree unlock ${path}`, warnings)
  }

  const policy = resolveCallPolicy(state.ctx, input.session)
  const refusal = sandboxRefusal(policy, [repo.root, path])
  if (refusal) return fail(refusal.error, refusal.detail, warnings)

  // 目录已经不在了（git 自己标了 prunable）：没有东西可删，只清元数据。
  // 这时 git worktree remove 必然失败，所以先分流。
  const how: 'remove' | 'prune' = found.entry.prunable || !existsSync(path) ? 'prune' : 'remove'

  if (how === 'remove' && input.force !== true) {
    const changes = await git.worktreeChanges(state.ctx, path)
    if (changes.length > 0) return fail(ERR.dirty, dirtyDetail(changes), warnings)
  }

  // 1) 归档会话。失败即停：目录与登记都还在，已经归档掉的那几个如实报出来
  const archive = await archiveSessionsAt(state.ctx, path)
  warnings.push(...archive.warnings)
  const archived = archive.archived
  const alreadyArchived = archive.skipped
  if (archive.failed !== null) {
    if (archive.archived > 0) {
      warnings.push(`archive-partial: 已经归档了 ${archive.archived} 个会话（归档可逆，unarchive 就回来）`)
    }
    return fail(
      ERR.archiveFailed,
      `会话 ${archive.failed.sessionId} 归档失败：${archive.failed.detail}`,
      warnings,
      archive.archived > 0,
    )
  }

  // 2) 注销工作区登记（只摘登记，目录与会话日志都留着）
  const unregistered = await unregisterProject(state.ctx, path)
  if (unregistered.warning !== null) warnings.push(unregistered.warning)

  // 3) 删目录 / 清元数据
  if (how === 'prune') {
    const pruned = await git.worktreePrune(state.ctx, { repoRoot: repo.root, policy })
    if (pruned.code !== 0) {
      const raw = pruned.err.trim() || `git worktree prune 退出码 ${pruned.code}`
      return fail(looksLikeWriteDenied(raw) ? ERR.sandboxDenied : ERR.pruneFailed, raw, warnings, true)
    }
    // prune 是全局的，不只清这一条，如实说一句
    warnings.push('prune-is-global: 目录本来就不在了，这次只清了 git 的元数据（prune 会清掉所有失效记录）')
  } else {
    const removed = await git.worktreeRemove(state.ctx, {
      repoRoot: repo.root,
      path,
      force: input.force === true,
      policy,
    })
    if (removed.code !== 0) {
      const raw = removed.err.trim() || `git worktree remove 退出码 ${removed.code}`
      if (looksLikeWriteDenied(raw)) return fail(ERR.sandboxDenied, raw, warnings, true)
      // 前置闸门与 remove 之间有窗口（并发改动）：真撞上了就补一次只读 status 把文件数说清
      if (/contains modified or untracked files/i.test(raw)) {
        const changes = await git.worktreeChanges(state.ctx, path)
        return fail(ERR.dirty, dirtyDetail(changes), warnings, true)
      }
      if (/cannot remove a locked working tree/i.test(raw)) return fail(ERR.locked, raw, warnings, true)
      return fail(ERR.removeFailed, raw, warnings, true)
    }
  }

  // 4) 分支：先本地后远端
  let branchDeleted: string | null = null
  let remoteDeleted: string | null = null
  const wantLocal = input.deleteBranch === true
  const wantRemote = input.deleteRemoteBranch === true
  if (wantLocal || wantRemote) {
    if (branch === null) {
      warnings.push('branch-skipped: 这个 worktree 是 detached HEAD，没有分支可删')
    } else {
      let localGone = true
      if (wantLocal) {
        const deleted = await git.branchDelete(state.ctx, { repoRoot: repo.root, branch, policy })
        if (deleted.code === 0) {
          branchDeleted = branch
        } else {
          localGone = false
          const raw = deleted.err.trim() || `git branch -d 退出码 ${deleted.code}`
          if (/not fully merged/i.test(raw)) {
            warnings.push(
              `branch-not-merged: 本地分支 ${branch} 有没合并进上游/HEAD 的提交，没有删。` +
                `要强删请自己跑 git branch -D ${branch}；远端分支也没有动。`,
            )
          } else if (looksLikeWriteDenied(raw)) {
            warnings.push('branch-delete-denied: ' + raw)
          } else {
            warnings.push('branch-delete-failed: ' + raw)
          }
        }
      }
      if (!wantRemote) {
        // 没勾远端：什么都不做
      } else if (!localGone) {
        warnings.push('remote-branch-skipped: 本地分支没删成，远端分支也没有动')
      } else {
        const pushed = await git.branchDeleteRemote(state.ctx, {
          repoRoot: repo.root,
          remote: REMOTE,
          branch,
          policy,
        })
        if (pushed.code === 0) {
          remoteDeleted = branch
        } else {
          const raw = pushed.err.trim() || `git push --delete 退出码 ${pushed.code}`
          if (/remote ref does not exist/i.test(raw)) {
            warnings.push(`remote-branch-missing: ${REMOTE} 上本来就没有 ${branch}`)
          } else if (looksLikeWriteDenied(raw)) {
            warnings.push('remote-branch-delete-denied: ' + raw)
          } else {
            warnings.push('remote-branch-delete-failed: ' + raw)
          }
        }
      }
    }
  }

  // 5) 复核：git 元数据里应该已经没有它了
  const after = await git.listWorktrees(state.ctx, repo.root)
  if (after.some((entry) => resolve(entry.path) === resolve(path))) {
    warnings.push('worktree-still-listed: git 元数据里还留着这个 worktree')
  }

  return {
    ok: true,
    name: found.item.name,
    path,
    branch,
    how,
    archived,
    alreadyArchived,
    branchDeleted,
    remoteDeleted,
    warnings,
  }
}
