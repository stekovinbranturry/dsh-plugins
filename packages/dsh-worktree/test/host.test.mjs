// 宿主半的验证。两条腿：
//  1) 纯函数（porcelain 解析、引号转义、命名、模板）
//  2) 真 git：临时目录里建真仓库 + 真裸远端，通过真实注册出来的路由 handler 驱动
//     context / create / open，所有 git 事实都回到磁盘上用 git 自己再验一遍。
// shell 桩不是"按命令回放"的假货，而是真的执行命令（cwd 用 spec.workdir），
// 所以这一层同时覆盖了命令拼接与引号转义。
import { execFileSync, exec } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { apply, name, inject } from '../dist/host/index.js'
import { METHODS } from '../dist/host/api.js'
import {
  parseWorktreeList,
  q,
  isValidName,
  isValidBranchName,
  nameFromBranch,
} from '../dist/host/git.js'
import { fillTemplate } from '../dist/host/sessions.js'
import { buildHandoff, compactName, spacedName } from '../dist/host/core.js'
import { isInsideRoot, sandboxRefusal, writableRoots } from '../dist/host/sandbox.js'
import {
  DEFAULT_HANDOFF_TEMPLATE,
  DEFAULT_SESSION_TITLE_TEMPLATE,
  DEFAULT_TITLE_TEMPLATE,
} from '../dist/host/constants.js'

const { basename, join } = path

let failures = 0
function ok(cond, label, extra) {
  if (cond) console.log('  ok   ' + label)
  else {
    failures++
    console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + extra : ''))
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}
function includes(haystack, needle, label) {
  ok(
    typeof haystack === 'string' && haystack.indexOf(needle) >= 0,
    label,
    'missing ' + JSON.stringify(needle) + ' in ' + JSON.stringify(haystack),
  )
}

const GIT_FLAGS = [
  '-c',
  'user.email=test@example.com',
  '-c',
  'user.name=dsh-worktree-test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
]

/** 夹具里直接同步调 git（测试代码，不经过被测的插件路径） */
function git(args, cwd) {
  return execFileSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * 真 shell 桩：真的执行命令，工作目录用 spec.workdir。
 * 形状就是 0.1.7 的 ShellExecutor：resolve(spec) → execute(spec) → result()。
 * withExecute=false 用来钉住「服务在、但前台入口缺」时的降级。
 */
function realShell(state, withExecute, options) {
  const o = options || {}
  // shellDenyWrite：模拟被沙箱拒写（macOS EPERM 在 git 里的原文），用来钉住错误码映射
  const denyWrite = (spec) => {
    state.shellCalls.push({ command: spec.command, workdir: spec.workdir, sandboxPolicy: spec.sandboxPolicy })
    return Promise.resolve({
      exitCode: 1,
      stdout: { text: '' },
      stderr: {
        text:
          "fatal: cannot lock ref 'refs/heads/feature/denied': Unable to create " +
          "'/tmp/repo/.git/refs/heads/feature/denied.lock': Operation not permitted",
      },
    })
  }
  const spawn = (spec) =>
    o.shellDenyWrite === true && spec.command.indexOf('worktree add') >= 0
      ? denyWrite(spec)
      : new Promise((resolve) => {
          state.shellCalls.push({ command: spec.command, workdir: spec.workdir, sandboxPolicy: spec.sandboxPolicy })
          exec(
            spec.command,
            { cwd: spec.workdir, timeout: spec.timeoutMs ?? 10000, maxBuffer: 1 << 22 },
            (error, stdout, stderr) => {
              const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0
              resolve({
                exitCode: code,
                stdout: { text: String(stdout ?? '') },
                stderr: { text: String(stderr ?? '') },
              })
            },
          )
        })
  const shell = { resolve: (spec) => spec }
  if (withExecute) shell.execute = async (spec) => ({ result: () => spawn(spec) })
  return shell
}

// 承运层给的是真 Request，handler 回真 Response（与 /api 通道同一个形状）
function makeReq(method, url, body, headers, raw) {
  const text = raw !== undefined ? raw : body === undefined ? '' : JSON.stringify(body)
  return new Request('http://dsh.internal' + url, {
    method,
    headers: Object.assign({ host: 'dsh.internal', 'content-type': 'application/json' }, headers || {}),
    body: method === 'GET' || method === 'HEAD' ? undefined : text,
  })
}

/**
 * 一个夹具 = 临时仓库（含真裸远端、若干本地/远端分支）+ 假 Cordis ctx + 注册出来的 handler。
 * 分支布局：本地 main、feature/local-only；远端 origin/main、origin/feature/remote-only。
 */
function makeFixture(options) {
  const o = options || {}
  // macOS 的 /var 是 /private/var 的符号链接，git 报的是 realpath，夹具也统一成 realpath
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-worktree-')))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  mkdirSync(repo)
  git(['init', '-q', '--bare', remote], root)
  git(['init', '-q'], repo)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo)
  writeFileSync(join(repo, 'README.md'), '# fixture\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'init'], repo)
  git(['remote', 'add', 'origin', remote], repo)
  git(['push', '-q', '-u', 'origin', 'main'], repo)
  git(['remote', 'set-head', 'origin', '-a'], repo)
  git(['branch', 'feature/local-only'], repo)
  // 只存在于远端的跟踪分支：本地建好推上去再把本地分支删掉
  git(['branch', 'feature/remote-only'], repo)
  git(['push', '-q', 'origin', 'feature/remote-only'], repo)
  git(['branch', '-D', 'feature/remote-only'], repo)

  const state = {
    routes: [],
    routesByPath: new Map(),
    disposers: [],
    prompts: [],
    renames: [],
    workspaces: [],
    sessions: new Map(),
    shellCalls: [],
    tools: [],
    createRequests: [],
  }
  const callerCwd = o.cwd ?? repo
  state.sessions.set('sess-1', { id: 'sess-1', header: { id: 'sess-1', cwd: callerCwd } })

  // 真 Cordis 会把 inject 到的服务挂成 ctx 属性；这里同样在回调期间挂上 tools
  const tools = { register: (definition) => (state.tools.push(definition), () => {}) }

  const ctx = {
    effect(fn) {
      state.disposers.push(fn())
      return () => {}
    },
    inject(names, callback) {
      // 真 Cordis 等所有 named 服务就位才跑回调；夹具照做，否则"缺 connection 时不注册"
      // 这条断言测不到
      ctx.tools = tools
      if ((names || []).every((name) => ctx.get(name) !== undefined)) callback(ctx)
      ctx.tools = undefined
    },
    get(key) {
      if (key === 'tools') return tools
      if (key === 'connection') {
        if (o.noConnection) return undefined
        return {
          fetch: {
            register(route) {
              state.routes.push(route)
              state.routesByPath.set(route.path, route)
              return () => {}
            },
          },
        }
      }
      if (key === 'shell') return realShell(state, o.shellNoExecute !== true, o)
      // 真宿主的 sandboxPolicy 服务：按会话解析出 mode + 可写根（会话 cwd）。
      // o.sandbox === false 模拟没挂沙箱服务的旧宿主；o.sandboxRoot 模拟"部署默认根"
      // （真值 = 宿主进程启动目录，通常是仓库外的某个地方）
      if (key === 'sandboxPolicy') {
        if (o.sandbox === false) return undefined
        return {
          resolve(request) {
            const session = request && request.session
            const fromSession = session && session.header && session.header.cwd
            return {
              mode: o.sandboxMode ?? 'workspace-write',
              workspaceRoot: o.sandboxRoot ?? fromSession ?? repo,
            }
          },
        }
      }
      if (key === 'sessions') return { get: (id) => state.sessions.get(id) }
      if (key === 'sessionController') {
        return {
          async create(request) {
            state.createRequests.push({ ...request })
            const id = 'sess-' + String(state.sessions.size + 1)
            // 真宿主会按 workspaceId 取项目的 path；夹具照做，否则"会话挂在 worktree 上"
            // 这条断言就测不到真行为
            let cwd = request.cwd
            if (cwd === undefined && typeof request.workspaceId === 'string') {
              const found = state.workspaces.filter((entry) => entry.id === request.workspaceId)[0]
              cwd = found === undefined ? undefined : found.path
            }
            state.sessions.set(id, { id, header: { id, cwd: cwd ?? repo } })
            return { sessionId: id }
          },
          async rename(request) {
            state.renames.push(request)
            return { title: request.title, seq: 1 }
          },
          async prompt(request) {
            state.prompts.push(request)
            return { accepted: true }
          },
        }
      }
      if (key === 'workspaceRegistry') {
        return {
          async create(workspacePath, title) {
            const id = 'ws-' + String(state.workspaces.length + 1)
            state.workspaces.push({ id, path: workspacePath, title })
            return { id, path: workspacePath, title }
          },
        }
      }
      return undefined
    },
  }

  apply(ctx, o.config)
  return { root, repo, remote, ctx, state }
}

// 与承运层同款的匹配：按 (path, method) 精确找路由；找不到就是 404（承运层不会把
// 未注册的方法交给 handler），进了 handler 之后的业务错误都是 200 + ok:false
async function call(fixture, method, route, body, headers, raw) {
  const registered = fixture.state.routesByPath.get('/api/dsh-worktree.' + route)
  if (!registered) return { status: 404, json: { ok: false, error: 'not-found' } }
  if (!registered.methods.includes(method)) return { status: 404, json: { ok: false, error: 'not-found' } }
  const res = await registered.fetch(makeReq(method, registered.path, body, headers, raw))
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

function headOf(cwd, ref) {
  return git(['rev-parse', ref], cwd).trim()
}

function cleanup(fixture) {
  try {
    rmSync(fixture.root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响断言
  }
}

console.log('\n== module surface ==')
eq(name, 'dsh-worktree', 'name')
eq(JSON.stringify(inject), '[]', '静态 inject 为空：工具与面板接口都按需取服务')
  // 承运层缺位时插件照样装得上（面板接口少一条，git 能力层与模型工具不受影响）
  const noConn = makeFixture({ noConnection: true })
  eq(noConn.state.routes.length, 0, '没有 connection 服务时不注册任何 /api 路由')
  eq(noConn.state.tools.length, 3, '工具照常注册')
  cleanup(noConn)

console.log('\n== pure helpers ==')
ok(isValidName('alpha-1'), 'isValidName accepts lowercase/digit/hyphen')
ok(!isValidName('Alpha'), 'isValidName is case-sensitive')
ok(!isValidName('alpha/../etc'), 'isValidName rejects slashes and dots')
ok(!isValidName('-alpha'), 'isValidName requires an alphanumeric first char')
ok(!isValidName(''), 'isValidName rejects the empty name')
ok(isValidBranchName('feature/foo'), 'isValidBranchName accepts a slashed branch')
ok(!isValidBranchName('feature/foo bar'), 'isValidBranchName rejects whitespace')
ok(!isValidBranchName('feature/foo..bar'), 'isValidBranchName rejects ..')
ok(!isValidBranchName('feature/foo~1'), 'isValidBranchName rejects ~')
ok(!isValidBranchName('-feature'), 'isValidBranchName rejects a leading dash')
ok(!isValidBranchName('feature/foo^'), 'isValidBranchName rejects ^')
eq(nameFromBranch('feature/foo'), 'feature-foo', 'nameFromBranch folds the slash')
eq(nameFromBranch('origin/feature/Bar'), 'feature-bar', 'nameFromBranch drops origin/ and lowercases')
eq(nameFromBranch('release-2024.06'), 'release-2024-06', 'nameFromBranch folds punctuation')
eq(nameFromBranch('  '), '', 'nameFromBranch rejects a blank input')
eq(q("it's"), "'it'\\''s'", 'q escapes single quotes for the shell')
eq(
  fillTemplate('wt: {name} @ {repo} ({missing})', { name: 'alpha', repo: 'repo' }),
  'wt: alpha @ repo ({missing})',
  'fillTemplate leaves unknown keys alone',
)

console.log('\n== parseWorktreeList (porcelain) ==')
const parsed = parseWorktreeList(
  [
    'worktree /repo',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/alpha',
    'HEAD def456',
    'branch refs/heads/feature/alpha',
    '',
    'worktree /repo/.worktrees/gone',
    'HEAD aaa111',
    'detached',
    'prunable gitdir file points to non-existent location',
    'locked',
  ].join('\n'),
)
eq(parsed.length, 3, 'three worktrees parsed')
eq(parsed[0].branch, 'main', 'first entry branch')
eq(parsed[1].path, '/repo/.worktrees/alpha', 'second entry path')
eq(parsed[1].branch, 'feature/alpha', 'branch keeps its slash')
eq(parsed[2].detached, true, 'detached parsed')
eq(parsed[2].prunable, true, 'prunable parsed')
eq(parsed[2].locked, true, 'locked parsed')

// ── 真 git 集成 ────────────────────────────────────────────────────────────
const A = makeFixture()

console.log('\n== model tools ==')
const T = makeFixture()
const toolNames = T.state.tools.map((tool) => tool.name)
eq(toolNames.join(','), 'worktree_list,worktree_create,worktree_open', 'exactly three tools registered')
ok(toolNames.indexOf('worktree_remove') < 0, 'remove is gone')
ok(toolNames.indexOf('worktree_prune') < 0, 'prune is gone')
const toolByName = (wanted) => T.state.tools.filter((tool) => tool.name === wanted)[0]
const listTool = toolByName('worktree_list')
const createTool = toolByName('worktree_create')
const openTool = toolByName('worktree_open')
ok(!!createTool.parameters && !!createTool.parameters.properties, 'create exposes JSON Schema parameters')
eq(createTool.parameters.required, undefined, 'create requires neither branch nor newBranch (they are exclusive)')
ok(!!createTool.parameters.properties.branch && !!createTool.parameters.properties.newBranch, 'create offers branch and newBranch')
ok(!!createTool.parameters.properties.base, 'create offers base for the new branch')
eq(openTool.parameters.required.join(','), 'name', 'open requires the name')
eq(listTool.parameters.required, undefined, 'list requires nothing')
includes(createTool.description, 'EITHER branch', 'create description spells out the two modes')
includes(createTool.description, 'newBranch', 'create description mentions inventing a branch')
eq(createTool.output.schema.type, 'string', 'tools return a canonical string')
eq(
  JSON.stringify(listTool.output.render({}, 'text')),
  '[{"type":"text","text":"text"}]',
  'render wraps the canonical string into one text block',
)

const toolExec = () => ({
  agent: { session: { id: 'sess-1', header: { id: 'sess-1', cwd: T.repo } } },
  signal: {},
})
let toolText = await createTool.execute({ branch: 'feature/local-only', enter: true }, toolExec())
includes(toolText, 'ok: true', 'create tool succeeds from a local branch')
includes(toolText, 'feature/local-only', 'create tool reports the branch')
includes(toolText, 'new session', 'create tool reports the opened session')
toolText = await listTool.execute({}, toolExec())
includes(toolText, 'feature-local-only', 'list tool reports the worktree')
includes(toolText, 'branches that can be used', 'list tool reports the branch inventory')
toolText = await openTool.execute({ name: 'feature-local-only', task: '从工具打开' }, toolExec())
includes(toolText, 'ok: true', 'open tool succeeds')
toolText = await openTool.execute({ name: 'ghost' }, toolExec())
includes(toolText, 'ok: false', 'open tool reports a refusal as a normal result')
includes(toolText, 'worktree-not-found', 'refusal carries the error code')
includes(toolText, 'nothing was changed', 'refusal states that nothing changed')
toolText = await createTool.execute({ branch: 'nope/x' }, toolExec())
includes(toolText, 'branch-not-found', 'create tool surfaces the missing branch')
toolText = await createTool.execute({ branch: 'feature/local-only' }, toolExec())
includes(toolText, 'branch-already-checked-out', 'create tool refuses a branch already checked out')
toolText = await createTool.execute({ newBranch: 'feature/from-tool', base: 'main' }, toolExec())
includes(toolText, 'ok: true', 'create tool invents a branch from a base')
includes(toolText, 'feature/from-tool', 'create tool reports the new branch')
eq(headOf(join(T.repo, '.worktrees', 'feature-from-tool'), 'HEAD'), headOf(T.repo, 'refs/heads/main'), 'the tool built it on the given base')
toolText = await createTool.execute({ newBranch: 'feature/from-tool', base: 'main' }, toolExec())
includes(toolText, 'branch-already-exists', 'create tool refuses a name that already exists locally')
toolText = await createTool.execute({ newBranch: 'feature/base-less', base: 'ghost' }, toolExec())
includes(toolText, 'base-not-found', 'create tool surfaces a missing base')
toolText = await createTool.execute({}, toolExec())
includes(toolText, 'missing-branch-target', 'create tool refuses to guess between branch and newBranch')
cleanup(T)

console.log('\n== route registration: 走 DSH 的 /api 承运通道 ==')
{
  const paths = A.state.routes.map((entry) => entry.path)
  eq(paths.length, METHODS.length, 'one exact route per api method')
  eq(paths[0], '/api/dsh-worktree.' + METHODS[0], '第一个方法的端点地址')
  ok(paths.every((entry) => entry.indexOf('/api/dsh-worktree.') === 0), '全部挂在 /api 命名空间下')
  ok(A.state.routes.every((entry) => JSON.stringify(entry.methods) === '["POST"]'), '只收 POST')
  ok(A.state.routes.every((entry) => entry.requestBody === 'buffered'), '缓冲体（JSON 请求）')
  ok(A.state.routes.every((entry) => typeof entry.fetch === 'function'), 'handler 是 fetch 形态')
  ok(A.state.disposers.length > 0, '每条路由都进 effect（卸载时整体摘掉）')
  // 围栏不再由插件实现：宿主半不该出现 Host / Origin / sec-fetch-site 的任何判断
  const source = readFileSync(new URL('../dist/host/index.js', import.meta.url), 'utf8')
  ok(source.indexOf('sec-fetch-site') < 0, '宿主半不碰 sec-fetch-site')
  ok(source.indexOf('webRuntime') < 0, '宿主半不再读 webRuntime.trustedHosts')
}

console.log('\n== method / path routing ==')
let r = await call(A, 'GET', 'context', { sessionId: 'sess-1' })
eq(r.status, 404, 'GET 不进 handler（只注册了 POST，承运层直接 404）')
r = await call(A, 'POST', 'nope', {})
eq(r.status, 404, 'unknown method -> 404（承运层没有这条路由）')
r = await call(A, 'POST', 'context/nested', {})
eq(r.status, 404, 'nested path -> 404')
r = await call(A, 'POST', 'remove', { sessionId: 'sess-1' })
eq(r.status, 404, 'the removed route is gone')
r = await call(A, 'POST', 'prune', { sessionId: 'sess-1' })
eq(r.status, 404, 'the prune route is gone')
r = await call(A, 'POST', 'context', undefined, undefined, '{not json')
eq(r.status, 400, 'malformed body -> 400')

console.log('\n== context on a fresh repo ==')
r = await call(A, 'POST', 'context', { sessionId: 'sess-1' })
ok(r.json && r.json.ok === true, 'ok true', JSON.stringify(r.json))
eq(r.json.repoRoot, A.repo, 'repoRoot')
eq(r.json.items.length, 0, 'no worktrees yet (the main worktree is not listed)')
eq(r.json.worktreeRoot, join(A.repo, '.worktrees'), 'worktree root is repo-local')
const branchNames = r.json.branches.map((item) => item.name)
eq(branchNames.join(','), 'feature/local-only,main,origin/feature/remote-only', 'local branches first, then remote-only ones')
ok(branchNames.indexOf('origin') < 0, 'the origin/HEAD symref is not offered as a branch')
const mainBranch = r.json.branches.filter((item) => item.name === 'main')[0]
eq(mainBranch.kind, 'local', 'main is local')
eq(mainBranch.inWorktree, A.repo, 'main is checked out in the main worktree')
eq(mainBranch.localName, 'main', 'localName of a local branch')
const remoteBranch = r.json.branches.filter((item) => item.name === 'origin/feature/remote-only')[0]
eq(remoteBranch.kind, 'remote', 'origin/feature/remote-only is remote')
eq(remoteBranch.localName, 'feature/remote-only', 'the local name is offered without the prefix')
eq(remoteBranch.inWorktree, null, 'nothing has it checked out')

console.log('\n== create from a local branch ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only', task: '在 local-only 上干活' })
ok(r.json && r.json.ok === true, 'create ok', JSON.stringify(r.json))
const localPath = join(A.repo, '.worktrees', 'feature-local-only')
eq(r.json.item.name, 'feature-local-only', 'the directory name is derived from the branch')
eq(r.json.item.branch, 'feature/local-only', 'the branch keeps its slash')
eq(r.json.item.path, localPath, 'item path')
ok(existsSync(localPath), 'the worktree directory exists on disk')
eq(headOf(localPath, 'HEAD'), headOf(A.repo, 'refs/heads/feature/local-only'), 'HEAD is the local branch tip')
includes(readFileSync(join(A.repo, '.git', 'info', 'exclude'), 'utf8'), '.worktrees/', 'worktree root appended to .git/info/exclude')
includes(git(['worktree', 'list', '--porcelain'], A.repo), localPath, 'git worktree list knows it')
ok(!existsSync(join(A.repo, '.gitignore')), 'no .gitignore was created (exclude, not ignore)')
r = await call(A, 'POST', 'context', { sessionId: 'sess-1' })
eq(r.json.items.length, 1, 'now one worktree')
eq(r.json.items[0].detached, false, 'not detached')
eq(r.json.branches.filter((item) => item.name === 'feature/local-only')[0].inWorktree, localPath, 'the branch now reports where it is checked out')

console.log('\n== create from a remote-only branch (tracking) ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'origin/feature/remote-only', enter: true })
ok(r.json && r.json.ok === true, 'create ok', JSON.stringify(r.json))
const remotePath = join(A.repo, '.worktrees', 'feature-remote-only')
eq(r.json.item.name, 'feature-remote-only', 'the name is derived from the branch without the remote prefix')
eq(r.json.item.branch, 'feature/remote-only', 'a local branch of the same name was created')
eq(r.json.item.path, remotePath, 'item path (no double checkout)')
eq(headOf(remotePath, 'HEAD'), headOf(A.repo, 'refs/remotes/origin/feature/remote-only'), 'HEAD is the remote tip')
eq(git(['config', 'branch.feature/remote-only.remote'], A.repo).trim(), 'origin', 'upstream remote set')
eq(git(['config', 'branch.feature/remote-only.merge'], A.repo).trim(), 'refs/heads/feature/remote-only', 'upstream merge set')
ok(typeof r.json.sessionId === 'string' && r.json.sessionId !== '', 'enter opened a session')

console.log('\n== create refusals ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only', name: 'again' })
eq(r.json.ok, false, 'a branch already checked out is refused')
eq(r.json.error, 'branch-already-checked-out', 'refusal code names the checkout')
includes(r.json.detail, localPath, 'refusal names the worktree holding the branch')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'ghost/branch' })
eq(r.json.ok, false, 'an unknown branch is refused')
eq(r.json.error, 'branch-not-found', 'refusal code')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/foo bar' })
eq(r.json.error, 'bad-branch', 'a branch name with whitespace is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only', name: 'feature-local-only' })
eq(r.json.error, 'branch-already-checked-out', 'the checkout gate fires before the path gate')
git(['branch', 'feature/name-check'], A.repo)
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/name-check', name: 'Alpha!' })
eq(r.json.error, 'bad-worktree-name', 'a bad directory name is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/name-check', name: 'feature-local-only' })
eq(r.json.error, 'worktree-exists', 'an existing directory is refused')

console.log('\n== create a NEW branch (no explicit base: HEAD) ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/fresh', name: 'fresh-head' })
ok(r.json && r.json.ok === true, 'create-new ok', JSON.stringify(r.json))
const freshPath = join(A.repo, '.worktrees', 'fresh-head')
eq(r.json.item.name, 'fresh-head', 'the explicit directory name is honoured')
eq(r.json.item.branch, 'feature/fresh', 'the item reports the invented branch')
eq(r.json.item.path, freshPath, 'item path')
ok(existsSync(freshPath), 'the worktree directory exists on disk')
eq(headOf(A.repo, 'refs/heads/feature/fresh'), headOf(A.repo, 'HEAD'), 'the new branch starts at the repo HEAD')
eq(headOf(freshPath, 'HEAD'), headOf(A.repo, 'refs/heads/feature/fresh'), 'the worktree sits on the new branch')
let upstream = ''
try {
  upstream = git(['config', 'branch.feature/fresh.remote'], A.repo).trim()
} catch {
  upstream = ''
}
eq(upstream, '', 'a brand-new branch gets no upstream')

console.log('\n== create a NEW branch from a remote tip ==')
r = await call(A, 'POST', 'create', {
  sessionId: 'sess-1',
  newBranch: 'feature/from-remote',
  base: 'origin/feature/remote-only',
})
ok(r.json && r.json.ok === true, 'create-new from origin ok', JSON.stringify(r.json))
const fromRemotePath = join(A.repo, '.worktrees', 'feature-from-remote')
eq(r.json.item.name, 'feature-from-remote', 'the directory name is derived from the new branch')
eq(
  headOf(fromRemotePath, 'HEAD'),
  headOf(A.repo, 'refs/remotes/origin/feature/remote-only'),
  'HEAD is the chosen base tip',
)
eq(git(['rev-parse', '--abbrev-ref', 'feature/from-remote@{upstream}'], A.repo).trim(), 'origin/feature/remote-only', 'git picked the remote as upstream')

console.log('\n== create a NEW branch from a local branch ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/from-local', base: 'feature/name-check' })
ok(r.json && r.json.ok === true, 'create-new from a local branch ok', JSON.stringify(r.json))
eq(
  headOf(join(A.repo, '.worktrees', 'feature-from-local'), 'HEAD'),
  headOf(A.repo, 'refs/heads/feature/name-check'),
  'HEAD follows the local base',
)

console.log('\n== create (new branch) refusals ==')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/fresh' })
eq(r.json.error, 'branch-already-exists', 'an existing local branch name is refused')
includes(r.json.detail, 'feature/fresh', 'the refusal names the branch')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/local-only' })
eq(r.json.error, 'branch-already-exists', 'a name taken by another worktree is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'origin/feature/x' })
eq(r.json.error, 'bad-branch', 'a new branch may not carry the origin/ prefix')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/foo bar' })
eq(r.json.error, 'bad-branch', 'a new branch name with whitespace is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/base-missing', base: 'ghost/branch' })
eq(r.json.error, 'base-not-found', 'a nonexistent base is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/bad-base', base: 'feature/foo bar' })
eq(r.json.error, 'bad-branch', 'a malformed base is refused')
r = await call(A, 'POST', 'create', { sessionId: 'sess-1' })
eq(r.json.error, 'missing-branch-target', 'neither branch nor newBranch is refused')
r = await call(A, 'POST', 'context', { sessionId: 'sess-1' })
const freshEntry = r.json.branches.filter((item) => item.name === 'feature/fresh')[0]
eq(freshEntry.inWorktree, freshPath, 'the invented branch now shows up as checked out')

console.log('\n== session vs workspace naming ==')
eq(compactName('feature-local-only'), 'featurelocalonly', 'the compact form drops every dash')
eq(compactName('alpha'), 'alpha', 'a dash-free name is untouched')
eq(compactName('FN-1234-hotfix'), 'FN1234hotfix', 'dashes go even when the name is mixed case')
eq(
  fillTemplate(DEFAULT_TITLE_TEMPLATE, { name: 'feature-local-only', repo: 'repo' }),
  'wt: feature-local-only',
  'the workspace template keeps the worktree name as-is, without the repo suffix (tree mode nests by path)',
)
eq(spacedName('feature-local-only'), 'feature local only', 'the session name turns dashes into spaces')
eq(spacedName('alpha'), 'alpha', 'a dash-free name is untouched')
eq(
  fillTemplate(DEFAULT_SESSION_TITLE_TEMPLATE, { spaced: spacedName('feature-local-only') }),
  'feature local only',
  'the shipped session template is the readable name',
)
ok(
  DEFAULT_SESSION_TITLE_TEMPLATE !== DEFAULT_TITLE_TEMPLATE,
  'session and workspace names are separate templates',
)
// {name} 就是目录名（交接消息里要说清真实路径），工作区标题也保留它
eq(
  buildHandoff('- worktree: {name}', { name: 'feature-local-only', task: '' }),
  '- worktree: feature-local-only',
  'the handoff keeps the real directory name',
)

console.log('\n== handoff rendering ==')
// 默认交接消息是空的：开出来的对话里一条消息都不该有（cwd 已经冻在会话头里）
eq(DEFAULT_HANDOFF_TEMPLATE, '', 'the shipped default sends nothing')
eq(
  buildHandoff(DEFAULT_HANDOFF_TEMPLATE, { name: 'alpha', path: '/p/alpha', branch: 'b', repo: 'r', task: '' }),
  '',
  'the shipped default renders to nothing',
)
eq(
  buildHandoff('', { name: 'alpha', task: '' }),
  '',
  'an empty template with no task is empty',
)
eq(
  buildHandoff('', { name: 'alpha', task: '  修 bug  ' }),
  '任务：\n修 bug',
  'an empty template still carries a tool-supplied task, with no stray blank line',
)
eq(
  buildHandoff('在 {name} 里干活', { name: 'alpha', task: '' }),
  '在 {name} 里干活'.replace('{name}', 'alpha'),
  'no task: the template renders as-is',
)
eq(
  buildHandoff('先别动。', { name: 'alpha', task: '  修 bug  ' }),
  '先别动。\n\n任务：\n修 bug',
  'a tool-supplied task is appended after the template',
)
eq(
  buildHandoff('先别动。', { name: 'alpha', task: '' }),
  '先别动。',
  'a blank task adds nothing',
)
eq(
  buildHandoff('任务：{task}', { name: 'alpha', task: '修 bug' }),
  '任务：修 bug',
  'a template that places {task} itself is not appended twice',
)
eq(
  buildHandoff('先别动。\n', { name: 'alpha', task: '修 bug' }),
  '先别动。\n\n任务：\n修 bug',
  'trailing whitespace in the template does not double the blank line',
)

console.log('\n== open (new session in an existing worktree) ==')
// 前面 create+enter 已经写过一轮 rename/prompt/workspace，这里只关心本次 open 的增量
A.state.renames.length = 0
A.state.prompts.length = 0
A.state.createRequests.length = 0
A.state.workspaces.length = 0
r = await call(A, 'POST', 'open', { sessionId: 'sess-1', name: 'feature-local-only', task: '把 local-only 做完' })
ok(r.json && r.json.ok === true, 'open ok', JSON.stringify(r.json))
const openedSession = r.json.sessionId
ok(typeof openedSession === 'string' && openedSession !== '', 'open returned a session id')
eq(r.json.title, 'feature local only', 'session name: dashes become spaces')
eq(r.json.path, localPath, 'the session opens in the worktree')
eq(r.json.branch, 'feature/local-only', 'the branch comes back')
eq(A.state.renames.length, 1, 'one rename call')
eq(A.state.renames[0].title, 'feature local only', 'the session is renamed to the session template')
eq(A.state.workspaces.length, 1, 'worktree registered as a project')
eq(A.state.createRequests[0].workspaceId, 'ws-1', 'the session is created against the registered project')
eq('cwd' in A.state.createRequests[0], false, 'no cwd alongside workspaceId (the host takes them as XOR)')
eq(A.state.workspaces[0].path, localPath, 'registered project path is the worktree')
eq(A.state.workspaces[0].title, 'wt: feature-local-only', 'the workspace title keeps the worktree name as-is')
eq(A.state.prompts.length, 1, 'the tool-supplied task is delivered')
eq(
  A.state.prompts[0].content[0].text,
  '任务：\n把 local-only 做完',
  'the task is the whole message — no fake handoff note in front of it',
)
eq(A.state.prompts[0].sessionId, openedSession, 'the task went to the new session')
eq(A.state.prompts[0].mode, 'queue', 'the task uses queue mode')

console.log('\n== open refusals / config ==')
r = await call(A, 'POST', 'open', { sessionId: 'sess-1', name: 'ghost' })
eq(r.json.error, 'worktree-not-found', 'an unknown worktree is refused')
r = await call(A, 'POST', 'open', { sessionId: 'sess-1', name: basename(A.repo) })
eq(r.json.error, 'worktree-not-found', 'the main worktree is not openable through the plugin')
const C = makeFixture({
  config: { worktreeRoot: 'wt', titleTemplate: 'WB {name} @ {repo}', sessionTitleTemplate: '会话 {spaced}' },
})
r = await call(C, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only', enter: true })
ok(r.json && r.json.ok === true, 'create with a custom root ok', JSON.stringify(r.json))
eq(r.json.item.path, join(C.repo, 'wt', 'feature-local-only'), 'custom worktree root honoured')
includes(readFileSync(join(C.repo, '.git', 'info', 'exclude'), 'utf8'), 'wt/', 'custom root appended to exclude')
ok(
  C.state.workspaces.map((entry) => entry.title).indexOf('WB feature-local-only @ repo') >= 0,
  'custom workspace template honoured',
)
ok(C.state.renames.map((entry) => entry.title).indexOf('会话 feature local only') >= 0, 'custom session template honoured')
cleanup(C)

console.log('\n== no session at all (the sidebar entry path) ==')
const N = makeFixture()
r = await call(N, 'POST', 'context', { repoPath: N.repo })
ok(r.json && r.json.ok === true, 'context works from an explicit repoPath without any session', JSON.stringify(r.json))
eq(r.json.repoRoot, N.repo, 'repoRoot resolved from repoPath')
r = await call(N, 'POST', 'create', { repoPath: N.repo, branch: 'feature/local-only', name: 'nosession', enter: true })
ok(r.json && r.json.ok === true, 'create+enter works without any session', JSON.stringify(r.json))
eq(r.json.item.path, join(N.repo, '.worktrees', 'nosession'), 'created under the repo')
ok(typeof r.json.sessionId === 'string' && r.json.sessionId !== '', 'a session was opened')
eq(N.state.createRequests[0].workspaceId, 'ws-1', 'the new session is attached to the registered project')
// 面板走的就是 create+enter 与 open，两条都不带任务 —— 新对话里不该有任何消息
eq(N.state.prompts.length, 0, 'create+enter without a task sends no message at all')
r = await call(N, 'POST', 'open', { repoPath: N.repo, name: 'nosession' })
ok(r.json && r.json.ok === true, 'open works without any session', JSON.stringify(r.json))
eq(N.state.prompts.length, 0, 'open without a task sends no message at all')
r = await call(N, 'POST', 'context', {})
eq(r.json.ok, false, 'no session and no repoPath is refused')
eq(r.json.error, 'no-workspace', 'refusal code for a missing workspace')
cleanup(N)

console.log('\n== repo gates ==')
const notRepo = makeFixture({ cwd: tmpdir() })
r = await call(notRepo, 'POST', 'context', { sessionId: 'sess-1' })
eq(r.json.error, 'not-a-git-repo', 'a non-repo cwd is refused')
r = await call(notRepo, 'POST', 'context', { repoPath: tmpdir() })
eq(r.json.error, 'not-a-git-repo', 'a non-repo repoPath is refused')
r = await call(notRepo, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only' })
eq(r.json.error, 'not-a-git-repo', 'create is refused outside a repo')
cleanup(notRepo)

console.log('\n== a session that lives inside a worktree ==')
const G = makeFixture()
r = await call(G, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only' })
const insidePath = r.json.item.path
// 把"调用方会话"挪进这个 worktree，模拟用户在 worktree 会话里点入口
G.state.sessions.get('sess-1').header.cwd = insidePath
r = await call(G, 'POST', 'context', { sessionId: 'sess-1' })
eq(r.json.repoRoot, G.repo, 'repoRoot is the main repo, not the worktree itself')
eq(r.json.worktreeRoot, join(G.repo, '.worktrees'), 'the worktree root stays under the main repo')
eq(r.json.items.map((item) => item.name).join(','), 'feature-local-only', 'only the linked worktree is listed')
mkdirSync(join(insidePath, 'src'), { recursive: true })
G.state.sessions.get('sess-1').header.cwd = join(insidePath, 'src')
r = await call(G, 'POST', 'context', { sessionId: 'sess-1' })
eq(r.json.items.map((item) => item.name).join(','), 'feature-local-only', 'a subdirectory cwd resolves the same repo')
git(['branch', 'feature/sibling'], G.repo)
// 会话 cwd 就是沙箱的可写根，而它在这个 worktree 的 src 里 —— 真实部署里写主仓库的 .git
// 会被内核拒（可写根不含主仓库，见上面那组纯函数断言）；夹具仓库落在宿主临时目录里，
// 临时区域本来就允许写，所以这里照样能建
r = await call(G, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/sibling' })
ok(r.json.ok === true, 'create works from inside a worktree', JSON.stringify(r.json))
eq(r.json.item.path, join(G.repo, '.worktrees', 'feature-sibling'), 'the new worktree is a sibling, never nested')
cleanup(G)

console.log('\n== registerProject=false falls back to create({cwd}) ==')
const I = makeFixture({ config: { registerProject: false } })
r = await call(I, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only', enter: true })
ok(r.json && r.json.ok === true, 'create+enter ok without project registration', JSON.stringify(r.json))
eq(I.state.workspaces.length, 0, 'nothing was registered as a project')
eq(I.state.createRequests[0].cwd, join(I.repo, '.worktrees', 'feature-local-only'), 'the session is created against the worktree cwd')
eq('workspaceId' in I.state.createRequests[0], false, 'no workspaceId when the project is not registered')
cleanup(I)

console.log('\n== cwd gone (the worktree the session lived in was deleted) ==')
const H = makeFixture()
r = await call(H, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only' })
const doomedPath = r.json.item.path
H.state.sessions.get('sess-1').header.cwd = doomedPath
rmSync(doomedPath, { recursive: true, force: true })
r = await call(H, 'POST', 'context', { sessionId: 'sess-1' })
ok(r.json.ok === true, 'context survives a vanished cwd', JSON.stringify(r.json))
eq(r.json.repoRoot, H.repo, 'repo resolution climbs to the main repo')
includes(r.json.warnings.join(' | '), 'cwd-missing', 'the missing cwd is reported as a warning')
ok(r.json.items.some((item) => item.name === 'feature-local-only'), 'the vanished worktree is still listed by git metadata')
cleanup(H)

console.log('\n== no-leak checks ==')
const F = makeFixture()
r = await call(F, 'POST', 'create', { sessionId: 'sess-1', branch: 'feature/local-only' })
const item = r.json.item
const text = JSON.stringify(r.json)
ok(text.indexOf('undefined') < 0, 'no undefined leaked into the response')
ok(text.indexOf('NaN') < 0, 'no NaN leaked into the response')
eq(basename(item.path), 'feature-local-only', 'path basename matches the name')
r = await call(F, 'POST', 'context', { sessionId: 'sess-1' })
ok(JSON.stringify(r.json).indexOf('undefined') < 0, 'no undefined leaked into the context response')
cleanup(F)

cleanup(A)

console.log('\n== 沙箱范围判定（纯函数） ==')
// 真宿主的 workspace-write 只放行会话工作区 + 宿主临时区域（本地 provider 拿上游
// writableRoots() 生成 Seatbelt/Landlock 规则）。目标落在范围外时 git 只会回一句
// "Operation not permitted"，看不出是权限范围问题 —— 所以插件先判一次
const WS = '/Users/example/ws'
eq(sandboxRefusal(undefined, ['/Users/example/repo']), null, 'no policy at all: nothing is judged')
eq(sandboxRefusal({ mode: 'danger-full-access' }, ['/Users/example/repo']), null, 'danger-full-access is not judged')
eq(sandboxRefusal({ mode: 'future-mode' }, ['/Users/example/repo']), null, 'an unknown mode is not judged')
eq(sandboxRefusal({ mode: 'workspace-write', workspaceRoot: WS }, [WS + '/repo']), null, 'inside the session workspace')
eq(
  sandboxRefusal({ mode: 'workspace-write', workspaceRoot: WS }, [join(tmpdir(), 'scratch-repo')]),
  null,
  'the host temp areas stay writable',
)
const outsideRefusal = sandboxRefusal({ mode: 'workspace-write', workspaceRoot: WS }, ['/Users/example/other/repo'])
eq(outsideRefusal.error, 'workspace-outside-sandbox', 'outside every writable root is refused')
includes(outsideRefusal.detail, '/Users/example/other/repo', 'the refusal names the target')
includes(outsideRefusal.detail, WS, 'the refusal names the writable roots')
eq(
  sandboxRefusal({ mode: 'workspace-write', workspaceRoot: WS }, [WS + '-sibling/repo']).error,
  'workspace-outside-sandbox',
  'a sibling path sharing the prefix is not "inside"',
)
// 用户真实遇到的那一对：部署默认根 = 宿主进程启动目录，目标是仓库
eq(
  sandboxRefusal({ mode: 'workspace-write', workspaceRoot: '/opt/dsh-host-cwd' }, ['/Users/example/repo']).error,
  'workspace-outside-sandbox',
  'the deployment fallback root is refused too',
)
eq(
  sandboxRefusal({ mode: 'read-only', workspaceRoot: WS }, [WS + '/repo']).error,
  'sandbox-read-only',
  'read-only refuses even inside the root',
)
ok(isInsideRoot(WS, WS + '/repo') && !isInsideRoot(WS, WS + '-other'), 'isInsideRoot matches whole path segments')
ok(writableRoots({ mode: 'workspace-write', workspaceRoot: WS }).indexOf(WS) >= 0, 'the workspace root is writable')
eq(writableRoots({ mode: 'read-only', workspaceRoot: WS }).length, 0, 'read-only has no writable root')

console.log('\n== 沙箱策略（写命令必须带上会话策略） ==')
// 仓库落在宿主临时目录里：即使在会话工作区外也不该被误拒（临时区域本来就允许写）
const outsideCwd = join(tmpdir(), 'dsh-worktree-outside-' + process.pid)
const W = makeFixture({ cwd: outsideCwd })
r = await call(W, 'POST', 'create', { repoPath: W.repo, sessionId: 'sess-1', newBranch: 'feature/temp-repo' })
ok(r.json.ok === true, 'a repo inside the host temp area is not falsely refused', JSON.stringify(r.json))
const tempAdd = W.state.shellCalls.filter((entry) => entry.command.indexOf('worktree add') >= 0)[0]
eq(tempAdd.sandboxPolicy.workspaceRoot, outsideCwd, 'the policy root is the session cwd, not the repo')
cleanup(W)

// read-only：写什么都不可能成，别让 git 去撞
const R = makeFixture({ sandboxMode: 'read-only' })
r = await call(R, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/readonly' })
eq(r.json.ok, false, 'a read-only session is refused')
eq(r.json.error, 'sandbox-read-only', 'the refusal names read-only')
cleanup(R)

// 正常路径：写命令必须带上会话策略，读命令不带（读不受沙箱限制）
const P = makeFixture()
r = await call(P, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/with-policy' })
ok(r.json.ok === true, 'create still works with a policy in play', JSON.stringify(r.json))
const addCall = P.state.shellCalls.filter((entry) => entry.command.indexOf('worktree add') >= 0)[0]
ok(!!addCall && !!addCall.sandboxPolicy, 'git worktree add carries a sandbox policy', JSON.stringify(addCall))
eq(addCall.sandboxPolicy.mode, 'workspace-write', 'the policy carries the session mode')
eq(addCall.sandboxPolicy.workspaceRoot, P.repo, 'the writable root is the session workspace')
const listCall = P.state.shellCalls.filter((entry) => entry.command.indexOf('worktree list') >= 0)[0]
eq(listCall.sandboxPolicy, undefined, 'read-only git commands carry no policy')
cleanup(P)

// 没挂沙箱服务的宿主（旧版/裁剪部署）：不判也不拒，照旧能建，且不凭空造策略
const N2 = makeFixture({ sandbox: false })
r = await call(N2, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/no-sandbox' })
ok(r.json.ok === true, 'a host without a sandbox service still creates', JSON.stringify(r.json))
eq(
  N2.state.shellCalls.filter((entry) => entry.command.indexOf('worktree add') >= 0)[0].sandboxPolicy,
  undefined,
  'no policy is invented',
)
cleanup(N2)

// 前置判定兜不住时（git 真回了 EPERM）：翻译成沙箱拒绝，而不是笼统的 add 失败
const Y = makeFixture({ shellDenyWrite: true })
r = await call(Y, 'POST', 'create', { sessionId: 'sess-1', newBranch: 'feature/denied' })
eq(r.json.ok, false, 'a denied write is a refusal')
eq(r.json.error, 'sandbox-write-denied', 'the EPERM text maps to the sandbox code')
includes(r.json.detail, 'Operation not permitted', 'the raw git text is kept for the user')
cleanup(Y)

console.log('\n== shell seam (0.1.7 execute) ==')
// 真宿主的 ctx.shell 就是 ShellExecutor：resolve(spec) → execute(spec) → result()
const S = makeFixture()
r = await call(S, 'POST', 'context', { sessionId: 'sess-1' })
ok(r.json && r.json.ok === true, 'context ok through the real shell seam', JSON.stringify(r.json))
ok(
  (r.json.branches ?? []).map((b) => b.name).indexOf('feature/local-only') >= 0,
  'local branches listed',
  JSON.stringify(r.json.branches),
)
ok(S.state.shellCalls.length > 0, 'commands actually ran')
cleanup(S)

// 没有前台入口：明确报 shell-unavailable，而不是静默给个空仓库
const X = makeFixture({ shellNoExecute: true })
r = await call(X, 'POST', 'context', { sessionId: 'sess-1' })
eq(r.json.ok, false, 'a shell without execute() is refused')
eq(r.json.error, 'shell-unavailable', 'refusal names the missing shell seam')
cleanup(X)

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
process.exit(failures === 0 ? 0 : 1)
