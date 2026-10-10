// 3 个模型工具。参数由 defineTool 按 schema 校验；真正的能力都在 core.ts，
// 与浏览器半走的是同一批函数，避免两端语义漂移。
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { WorktreeItem } from '../shared/types.js'
import * as core from './core.js'
import type { SessionLike } from './services.js'

export interface ToolDeps {
  getState: () => core.State
}

interface CallerContext {
  sessionId: string | null
  session: SessionLike | undefined
}

function callerOf(exec: { agent?: { session?: { id: string; header: { cwd?: string; id: string } } } }): CallerContext {
  const session = exec.agent?.session
  if (!session) return { sessionId: null, session: undefined }
  return { sessionId: session.id, session: session as unknown as SessionLike }
}

function renderError(result: { error: string; detail?: string; warnings?: string[] }): string {
  const lines = ['ok: false', 'error: ' + result.error]
  if (result.detail) lines.push('detail: ' + result.detail)
  if (result.warnings && result.warnings.length > 0) lines.push('warnings: ' + result.warnings.join(' | '))
  lines.push('nothing was changed.')
  return lines.join('\n')
}

function renderWarnings(warnings: string[]): string[] {
  return warnings.length === 0 ? [] : ['warnings:', ...warnings.map((warning) => '  - ' + warning)]
}

function itemLine(item: WorktreeItem): string {
  const parts = ['- ' + item.name, item.branch ?? '(detached)']
  if (item.detached) parts.push('detached')
  parts.push(item.path)
  return parts.join('  ')
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(
    defineTool({
      name: 'worktree_list',
      description:
        'List every git worktree of the repository the current session works in, plus the branches that can be ' +
        'used to create a new one (local branches first, then origin/*). Use it before worktree_open or ' +
        'worktree_create to see the exact names. Read-only.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute(_args, exec) {
        const result = await core.listWorktreesOp(deps.getState(), callerOf(exec))
        if (!result.ok) return renderError(result)
        const lines = ['ok: true', 'repo: ' + result.repoRoot, 'worktree root: ' + result.worktreeRoot]
        lines.push('worktrees (' + result.items.length + '):')
        lines.push(...(result.items.length === 0 ? ['  (none)'] : result.items.map(itemLine)))
        lines.push('branches that can be used to create a worktree (' + result.branches.length + '):')
        lines.push(
          ...(result.branches.length === 0
            ? ['  (none)']
            : result.branches.map(
                (branch) =>
                  '  - ' + branch.name + '  ' + (branch.kind === 'remote' ? 'remote' : 'local') +
                  (branch.inWorktree === null ? '' : '  (already checked out at ' + branch.inWorktree + ')'),
              )),
        )
        lines.push(...renderWarnings(result.warnings))
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'worktree_create',
      description:
        'Create a git worktree for the repository the current session works in, under the repo-local worktree ' +
        'root (default .worktrees/<name>). Give EITHER branch (check out an existing one) OR newBranch (create ' +
        'one, optionally from base). An existing local branch is checked out as-is; an existing origin/* branch ' +
        'becomes a new local branch of the same name tracking it; a newBranch is created from base (default ' +
        'HEAD), and an origin/* base sets up tracking exactly like git itself does. Fails closed when the branch ' +
        'is already checked out in another worktree, a newBranch already exists locally, the base does not ' +
        'resolve, or the directory already exists. Set enter=true to also open a NEW ' +
        'session in that worktree (recommended); this session is not switched or moved.',
      parameters: {
        branch: {
          type: 'string',
          description:
            'Existing branch to check out: a local name like feature/foo, or a remote one like origin/feature/foo. ' +
            'Mutually exclusive with newBranch.',
        },
        newBranch: {
          type: 'string',
          description:
            'Name of a NEW local branch to create (e.g. feature/foo). Must not exist locally. ' +
            'Mutually exclusive with branch.',
        },
        base: {
          type: 'string',
          description:
            'Start point for newBranch: a local branch, an origin/* branch, or HEAD (default). Ignored when ' +
            'branch is used.',
        },
        name: {
          type: 'string',
          description:
            'Directory name under the worktree root: lowercase letters, digits and hyphens, 1-64 chars. ' +
            'Omit to derive it from the branch name (feature/foo -> feature-foo).',
        },
        enter: {
          type: 'boolean',
          description: 'Also open a NEW session in the worktree. Defaults to false.',
        },
        task: {
          type: 'string',
          description: 'What will be done in this worktree; injected into the new session as handoff.',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await core.createWorktreeOp(deps.getState(), {
          ...callerOf(exec),
          branch: typeof args.branch === 'string' ? args.branch : null,
          newBranch: typeof args.newBranch === 'string' ? args.newBranch : null,
          base: typeof args.base === 'string' ? args.base : null,
          name: typeof args.name === 'string' ? args.name : null,
          enter: args.enter === true,
          task: typeof args.task === 'string' ? args.task : null,
        })
        if (!result.ok) return renderError(result)
        const lines = ['ok: true', 'created: ' + itemLine(result.item)]
        if (result.sessionId !== undefined) {
          lines.push('new session: ' + result.sessionId + ' (already opened in the UI; this session is unchanged)')
        }
        lines.push(...renderWarnings(result.warnings))
        return lines.join('\n')
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'worktree_open',
      description:
        'Open an EXISTING git worktree of the current repository as a NEW session whose working directory is ' +
        'that worktree. Use worktree_list first to get the exact name. The task description is handed to the new ' +
        'session. This session is not switched or moved.',
      parameters: {
        name: {
          type: 'string',
          required: true,
          description: 'Worktree name as reported by worktree_list.',
        },
        task: {
          type: 'string',
          description: 'What will be done in that worktree; injected into the new session as handoff.',
        },
      },
      output: TEXT_OUTPUT,
      async execute(args, exec) {
        const result = await core.openWorktreeOp(deps.getState(), {
          ...callerOf(exec),
          name: args.name,
          task: typeof args.task === 'string' ? args.task : null,
        })
        if (!result.ok) return renderError(result)
        const lines = [
          'ok: true',
          'worktree: ' + args.name + '  ' + (result.branch ?? '(detached)'),
          'path: ' + result.path,
          'new session: ' + result.sessionId + '  title: ' + result.title,
          'the new session is already opened in the UI; this session is unchanged.',
        ]
        lines.push(...renderWarnings(result.warnings))
        return lines.join('\n')
      },
    }),
  )
}
