// git 能力层：所有命令都走宿主的 shell 服务，参数统一用 q() 单引号转义，
// 不做任何字符串拼接式调用。
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

import { ADD_TIMEOUT_MS, BRANCH_RE, GIT_TIMEOUT_MS, NAME_MAX, NAME_RE } from './constants.js'
import type { Context, SandboxPolicyLike, ShellResult } from './services.js'
import { shellOf } from './services.js'

export interface GitProbe {
  code: number
  out: string
  err: string
}

export function q(text: string): string {
  return "'" + text.replace(/'/g, `'\\''`) + "'"
}

export function errorText(error: unknown): string {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return String((error as { message?: unknown }).message || error)
}

export interface RepoInfo {
  /** 主仓库根（worktree 内调用时仍是 main worktree 的路径） */
  root: string
  /** cwd 所在的那个工作树的根；在 linked worktree 里就不是 root 了 */
  toplevel: string
  /** 与所有 worktree 共享的 .git 目录（写 info/exclude 的位置） */
  commonDir: string
  /** cwd 是否落在某个 linked worktree 里 */
  isWorktree: boolean
}

export interface WorktreeEntry {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  prunable: boolean
}

export async function runGit(
  ctx: Context,
  args: string[],
  cwd: string,
  timeoutMs = GIT_TIMEOUT_MS,
  policy?: SandboxPolicyLike,
): Promise<GitProbe> {
  const shell = shellOf(ctx)
  if (!shell) throw new Error('shell-unavailable')
  let result: ShellResult
  try {
    const spec = shell.resolve({
      command: 'git ' + args.join(' '),
      workdir: cwd,
      timeoutMs,
      stdoutMaxBytes: 400_000,
      // 只读命令不带策略（读不受沙箱限制）；写命令必须带上调用方会话的策略，
      // 否则会落到部署默认根（宿主启动目录）而被拒写
      ...(policy === undefined ? {} : { sandboxPolicy: policy }),
    })
    result = await (await shell.execute(spec)).result()
  } catch (error) {
    // 工作目录已经不存在、或沙箱 spawn 不起来时宿主会直接抛。降级成一次普通的
    // "git 失败"，别让异常原文冒到界面上
    return { code: 1, out: '', err: errorText(error) }
  }
  return {
    code: typeof result.exitCode === 'number' ? result.exitCode : 1,
    out: typeof result.stdout?.text === 'string' ? result.stdout.text : '',
    err: typeof result.stderr?.text === 'string' ? result.stderr.text : '',
  }
}

/** 从 path 往上找第一个真实存在的目录；整条路径都在就原样返回 */
export function nearestExisting(path: string): string {
  let current = resolve(path)
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

/**
 * 仓库解析：只支持 cwd 本身就在仓库里（含 linked worktree），不做子目录扫描。
 *
 * 关键：在 linked worktree 里 `--show-toplevel` 给的是这个 worktree 自己，所以要用
 * `--git-common-dir` 反推主仓库根——否则会把 worktree 当成仓库（真机验证抓到的）。
 */
export async function resolveRepo(ctx: Context, cwd: string): Promise<RepoInfo | null> {
  // cwd 可能已经不存在了：先往上找到最近一个存在的目录再解析
  const probe = nearestExisting(cwd)
  const top = await runGit(ctx, ['rev-parse', '--show-toplevel'], probe)
  if (top.code !== 0) return null
  const toplevel = top.out.trim().split('\n')[0]?.trim() ?? ''
  if (toplevel === '') return null
  const common = await runGit(ctx, ['rev-parse', '--git-common-dir'], toplevel)
  const rawCommon = common.code === 0 ? common.out.trim().split('\n')[0]?.trim() ?? '' : ''
  const commonDir = rawCommon === '' ? resolve(toplevel, '.git') : resolve(toplevel, rawCommon)
  // 主 worktree 的 common dir 就是 <main>/.git；linked worktree 指向同一个 .git
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : toplevel
  return {
    root: mainRoot,
    toplevel,
    commonDir,
    isWorktree: resolve(toplevel) !== resolve(mainRoot),
  }
}

export function parseWorktreeList(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim() || null
      continue
    }
    if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim()
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
      continue
    }
    if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true
    else if (line === 'prunable' || line.startsWith('prunable ')) current.prunable = true
  }
  if (current) entries.push(current)
  return entries
}

export async function listWorktrees(ctx: Context, repoRoot: string): Promise<WorktreeEntry[]> {
  const probe = await runGit(ctx, ['worktree', 'list', '--porcelain'], repoRoot)
  if (probe.code !== 0) {
    throw new Error('git worktree list failed: ' + (probe.err.trim() || String(probe.code)))
  }
  return parseWorktreeList(probe.out)
}

async function refExists(ctx: Context, repoRoot: string, ref: string): Promise<boolean> {
  const probe = await runGit(ctx, ['show-ref', '--verify', '--quiet', q(ref)], repoRoot)
  return probe.code === 0
}

export function branchExistsLocal(ctx: Context, repoRoot: string, name: string): Promise<boolean> {
  return BRANCH_RE.test(name) ? refExists(ctx, repoRoot, `refs/heads/${name}`) : Promise.resolve(false)
}

export function branchExistsRemote(
  ctx: Context,
  repoRoot: string,
  remote: string,
  name: string,
): Promise<boolean> {
  return BRANCH_RE.test(name) ? refExists(ctx, repoRoot, `refs/remotes/${remote}/${name}`) : Promise.resolve(false)
}

/** 分支清单：本地 + <remote>/*，排除符号引用 HEAD */
export async function listBranches(
  ctx: Context,
  repoRoot: string,
  remote: string,
): Promise<{ local: string[]; remote: string[] }> {
  // %(refname) 而不是 %(refname:short)：short 会把 refs/remotes/origin/HEAD 压成 "origin"，
  // 于是"排除符号引用"就无从判断了。注意 %(...) 必须整体引号化——POSIX sh 会把裸括号当操作符。
  const format = q('--format=%(refname)')
  const localProbe = await runGit(ctx, ['for-each-ref', format, q('refs/heads')], repoRoot)
  const remoteProbe = await runGit(ctx, ['for-each-ref', format, q(`refs/remotes/${remote}`)], repoRoot)
  const strip = (text: string, prefix: string, skip: string | null): string[] =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix) && line !== skip)
      .map((line) => line.slice(prefix.length))
  return {
    local: strip(localProbe.out, 'refs/heads/', null),
    // 远端保留 remote/ 前缀（origin/feature/x），与 git 里的写法一致
    remote: strip(remoteProbe.out, 'refs/remotes/', `refs/remotes/${remote}/HEAD`),
  }
}

/** 在一个新 worktree 里检出一个已存在的本地分支 */
export function worktreeAddBranch(
  ctx: Context,
  options: { repoRoot: string; path: string; branch: string; policy?: SandboxPolicyLike },
): Promise<GitProbe> {
  return runGit(
    ctx,
    ['worktree', 'add', '--', q(options.path), q(options.branch)],
    options.repoRoot,
    ADD_TIMEOUT_MS,
    options.policy,
  )
}

/** 从一个起点（分支名 / 远端名 / HEAD）新建 <branch> 并检出到新 worktree */
export function worktreeAddNewBranch(
  ctx: Context,
  options: { repoRoot: string; path: string; branch: string; startPoint: string; policy?: SandboxPolicyLike },
): Promise<GitProbe> {
  return runGit(
    ctx,
    ['worktree', 'add', '-b', q(options.branch), '--', q(options.path), q(options.startPoint)],
    options.repoRoot,
    ADD_TIMEOUT_MS,
    options.policy,
  )
}

/** ref 能不能解析成一个 commit（用来校验新分支的起点） */
export async function revisionExists(ctx: Context, repoRoot: string, ref: string): Promise<boolean> {
  const probe = await runGit(ctx, ['rev-parse', '--verify', '--quiet', q(ref + '^{commit}')], repoRoot)
  return probe.code === 0
}

/** 从远端跟踪分支建一个同名本地分支并检出到新 worktree */
export function worktreeAddTracking(
  ctx: Context,
  options: { repoRoot: string; path: string; localBranch: string; remoteRef: string; policy?: SandboxPolicyLike },
): Promise<GitProbe> {
  return runGit(
    ctx,
    ['worktree', 'add', '-b', q(options.localBranch), '--track', '--', q(options.path), q(options.remoteRef)],
    options.repoRoot,
    ADD_TIMEOUT_MS,
    options.policy,
  )
}

/**
 * 把 worktree 根目录写进共享 .git/info/exclude（不碰仓库的 .gitignore，
 * 保证仓库不脏、不产生 diff）。已存在则不动。
 */
export function ensureExclude(commonDir: string, entry: string): { changed: boolean; warning: string | null } {
  try {
    const file = resolve(commonDir, 'info', 'exclude')
    mkdirSync(dirname(file), { recursive: true })
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines = existing.split('\n').map((line) => line.trim())
    if (lines.includes(entry)) return { changed: false, warning: null }
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n'
    appendFileSync(file, `${prefix}# dsh-worktree\n${entry}\n`, 'utf8')
    return { changed: true, warning: null }
  } catch (error) {
    return { changed: false, warning: 'exclude-write-failed: ' + errorText(error) }
  }
}

/** 分支名 → worktree 目录名：feature/foo → feature-foo */
export function nameFromBranch(branch: string): string {
  const short = branch.includes('/') && branch.startsWith('origin/')
    ? branch.slice('origin/'.length)
    : branch
  const slug = short
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX)
    .replace(/-+$/g, '')
  return NAME_RE.test(slug) ? slug : ''
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name)
}

export function isValidBranchName(branch: string): boolean {
  return BRANCH_RE.test(branch) && !branch.startsWith('-') && !branch.includes('..')
}
