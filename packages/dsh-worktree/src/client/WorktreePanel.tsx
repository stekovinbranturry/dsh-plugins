/** 弹窗主体：左侧导航 + 顶栏（工作区选择）+ 两个分区（新建 / 已有）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import {
  Button,
  Checkbox,
  IconTrashOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Modal,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'

import type { BranchItem, WorktreeItem, WorktreeRemoteBranchResult } from '../shared/types.js'
import { BranchCombo } from './BranchCombo.js'
import { WorkspaceCombo } from './WorkspaceCombo.js'
import { alwaysPickable, baseItems, deriveName, isWorktreePath, pickWorkspace } from './branches.js'
import { SECTIONS, TITLE_ID } from './constants.js'
import type { SectionId } from './constants.js'
import { callHost, errLabel } from './host.js'
import {
  IconBranch,
  IconClose,
  IconFolderOption,
  IconGitPull,
  IconList,
  IconRefresh,
  IconWorktree,
} from './icons.js'
import type {
  ClientContext,
  ContextResult,
  CreateResult,
  ErrorResult,
  OpenResult,
  RemoveResult,
  SessionListState,
  SlotStandardProps,
  UiWorkspaceService,
  WorkspaceSnapshot,
} from './types.js'

type PanelProps = Partial<SlotStandardProps>

interface PanelOwnProps {
  ctx: ClientContext
}

/** 创建区的两种模式：检出已有分支 / 新建分支 */
type CreateMode = 'existing' | 'new'

/** 切视图的重试节奏：宿主建完会话到客户端目录收到 api-session/added 只差一个事件 */
const OPEN_RETRY_MS = 100
const OPEN_TIMEOUT_MS = 5000

/** 切不过去时的两种原因，用来把提示说准 */
type OpenFailure = 'unavailable' | 'timed-out'

const OPEN_FAILURE_TEXT: Record<OpenFailure, string> = {
  unavailable: '当前界面没有 uiWorkspace 导航服务',
  'timed-out': '界面还没认出这个会话',
}

/**
 * 把主视图切到某个会话，成功返回 null，失败返回原因。
 *
 * 0.1.7 把 `ctx.sessions.open(id)` 删了：客户端 ClientSessions 只剩 retain / scope /
 * search，切主视图的动作搬到 `uiWorkspace` 服务上 —— 官方侧边栏的会话行就是
 * `uiWorkspace.openSession(sessionId)`（它内部 replaceMain → sessions.retain）。
 *
 * 刚由**宿主**建出来的会话要多等一拍：`sessions.retain` 会先经 SessionManager.resolveTarget
 * 查本地目录，目录里还没有这个 id 时直接抛 `sessions.retain: unknown session <id>`，
 * 而目录是靠 `api-session/added` 事件补上的，跟我们的 HTTP 响应不在同一条路上。所以这里
 * 有界重试，别让「创建并进入」变成看运气。
 *
 * 用 ctx.get 而不是属性访问：拿不到就退回一句提示，而不是整个插件起不来（get 不要求 inject）。
 */
async function openSession(ctx: ClientContext, sessionId: string): Promise<OpenFailure | null> {
  const ui = ctx.get('uiWorkspace') as UiWorkspaceService | undefined
  if (ui === undefined || typeof ui.openSession !== 'function') return 'unavailable'
  const deadline = Date.now() + OPEN_TIMEOUT_MS
  for (;;) {
    try {
      ui.openSession(sessionId)
      return null
    } catch {
      if (Date.now() >= deadline) return 'timed-out'
      await new Promise((done) => setTimeout(done, OPEN_RETRY_MS))
    }
  }
}

/** 平台一定会传 standard props；万一没传（更老的 DSH），给个空快照也别崩 */
function emptyWorkspaces<S>(selector: (state: WorkspaceSnapshot) => S): S {
  return selector({ items: [] })
}

function emptySessions<S>(selector: (state: SessionListState) => S): S {
  return selector({ byId: {} })
}

export function WorktreePanel({
  ctx,
  wide = true,
  useWorkspaces = emptyWorkspaces,
  useSessions = emptySessions,
}: PanelProps & PanelOwnProps): ReactElement {
  const workspaces = useWorkspaces((state: WorkspaceSnapshot) => state.items)
  /** 目标仓库只从非 worktree 的工作区里选：不去 worktree 里再建 worktree */
  const repos = useMemo(() => workspaces.filter((item) => !isWorktreePath(item.path)), [workspaces])
  const currentSession = useSessions((state: SessionListState) => state.current)
  const sessionsById = useSessions((state: SessionListState) => state.byId)
  const selected = useMemo(
    () => pickWorkspace(repos, { current: currentSession, byId: sessionsById }),
    [repos, currentSession, sessionsById],
  )

  const [open, setOpen] = useState(false)
  /** 当前分区，跟设置弹窗一样由左侧导航栏切换 */
  const [section, setSection] = useState<SectionId>('create')
  /**
   * 手动选中的工作区。null = 跟随默认（当前会话所属 / recentWorkspace），
   * 这样默认行为不变，但用户可以在这个弹窗里换一个仓库操作。
   */
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [data, setData] = useState<ContextResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [mode, setMode] = useState<CreateMode>('existing')
  /** 已有分支模式下要检出的分支 */
  const [branch, setBranch] = useState('')
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  /** 新建分支模式下要创建的分支名 */
  const [newBranch, setNewBranch] = useState('')
  /** 新分支的起点（HEAD 或某个分支名） */
  const [base, setBase] = useState('HEAD')
  /**
   * 删除是本插件唯一不可逆的动作，所以确认框不是「确定/取消」两态：
   * 失败原因留在框里（有未提交改动 → 才露出「强制删除」勾选；被 lock → 让人去 unlock），
   * 删除进行中按钮 disabled。三个勾选状态默认全关 —— 不替用户决定。
   */
  const [deleteTarget, setDeleteTarget] = useState<WorktreeItem | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<ErrorResult | null>(null)
  /** 丢掉未提交的改动（宿主侧 = git worktree remove --force） */
  const [deleteForce, setDeleteForce] = useState(false)
  /** 连本地分支一起删（宿主侧 = git branch -d，没合并进上游会被拒绝） */
  const [deleteBranch, setDeleteBranch] = useState(false)
  /** 连 origin 上的同名分支一起删；比本地再多一道勾选，因为远端删了别人也会受影响 */
  const [deleteRemoteBranch, setDeleteRemoteBranch] = useState(false)
  const [deleteRemoteCheck, setDeleteRemoteCheck] = useState<{
    repoPath: string
    path: string
    status: 'present' | 'absent' | 'failed'
  } | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)

  const chosen = useMemo(
    () => (workspaceId === null ? selected : (repos.find((item) => item.workspaceId === workspaceId) ?? selected)),
    [workspaceId, repos, selected],
  )
  const repoPath = chosen?.path ?? null

  const refreshRequest = useRef(0)

  const refresh = useCallback(async (fetchRemote = false) => {
    const request = ++refreshRequest.current
    if (repoPath === null) {
      setData(null)
      setBusy(false)
      return
    }
    setBusy(true)
    if (fetchRemote) setMessage('正在拉取 origin 的远端分支…')
    try {
      const result = await callHost<ContextResult | ErrorResult>(fetchRemote ? 'fetch' : 'context', {
        repoPath,
        ...(fetchRemote ? { sessionId: currentSession } : {}),
      })
      // fetch 可能较慢；切换仓库后旧请求不能覆盖新仓库的列表。
      if (request !== refreshRequest.current) return
      if (result.ok) {
        setData(result)
        setMessage(result.warnings.length > 0 ? result.warnings.join('；') : fetchRemote ? '已拉取 origin 的远端分支' : null)
        setBranch((previous) => {
          if (previous !== '' && result.branches.some((item) => item.name === previous)) return previous
          const usable = result.branches.find((item) => item.inWorktree === null)
          return usable === undefined ? '' : usable.name
        })
        setBase((previous) =>
          previous === 'HEAD' || result.branches.some((item) => item.name === previous) ? previous : 'HEAD',
        )
      } else {
        if (!fetchRemote) setData(null)
        setMessage(errLabel(result))
      }
    } catch (error) {
      if (request !== refreshRequest.current) return
      if (!fetchRemote) setData(null)
      setMessage((fetchRemote ? '拉取失败：' : '读取失败：') + String(error))
    } finally {
      if (request === refreshRequest.current) setBusy(false)
    }
  }, [repoPath, currentSession])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // Esc 关窗：跟设置弹窗一样挂在 document 上，且只在打开时存在（生命周期就是弹窗的）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 打开即聚焦关闭按钮：无障碍的初始焦点，跟设置弹窗一致
  useEffect(() => {
    if (open && closeRef.current !== null) closeRef.current.focus()
  }, [open])

  // 分支/新分支名换了就跟着改默认目录名（用户手动改过就不再覆盖）
  useEffect(() => {
    if (nameTouched) return
    const source = mode === 'new' ? newBranch.trim() : branch
    setName(source === '' ? '' : deriveName(source))
  }, [mode, branch, newBranch, nameTouched])

  const branches = data?.branches ?? []
  const remoteStatus = deleteRemoteCheck?.repoPath === repoPath && deleteRemoteCheck?.path === deleteTarget?.path
    ? deleteRemoteCheck?.status
    : undefined
  const deleteHasRemote = remoteStatus === 'present'

  useEffect(() => {
    if (repoPath === null || deleteTarget?.branch == null) return
    let active = true
    setDeleteRemoteCheck(null)
    void (async () => {
      let status: 'present' | 'absent' | 'failed' = 'failed'
      try {
        const result = await callHost<WorktreeRemoteBranchResult>('remoteBranch', { repoPath, branch: deleteTarget.branch })
        if (result.ok) status = result.exists ? 'present' : 'absent'
      } catch {
        // 断网、旧宿主没有此端点等情况都不能当成「远端不存在」。
      }
      if (active) setDeleteRemoteCheck({ repoPath, path: deleteTarget.path, status })
    })()
    return () => { active = false }
  }, [repoPath, deleteTarget])
  const bases = useMemo(() => baseItems(branches), [branches])
  const usableBranches = branches.filter((item) => item.inWorktree === null)
  const ready = mode === 'new' ? newBranch.trim() !== '' : branch !== ''

  /** 选中一个分支（当目标或当起点），并按需派生目录名 */
  const pickBranch = useCallback(
    (item: BranchItem) => {
      if (item.inWorktree !== null) return
      setBranch(item.name)
      if (!nameTouched) setName(deriveName(item.name))
    },
    [nameTouched],
  )

  /** 换模式：把目录名重新按当前模式的输入派生一次，并清掉上一条提示 */
  const switchMode = useCallback((next: CreateMode) => {
    setMode(next)
    setNameTouched(false)
    setMessage(null)
  }, [])

  const onOpenExisting = useCallback(
    async (item: WorktreeItem) => {
      if (repoPath === null) return
      setBusy(true)
      setMessage(null)
      try {
        // 不带任务：宿主的交接模板默认是空的，新会话里一条消息都不发
        const result = await callHost<OpenResult | ErrorResult>('open', {
          repoPath,
          name: item.name,
          sessionId: currentSession,
        })
        if (!result.ok) {
          setMessage(errLabel(result))
          return
        }
        const failure = await openSession(ctx, result.sessionId)
        if (failure !== null) {
          setMessage('会话已就绪，但没能自动切过去（' + OPEN_FAILURE_TEXT[failure] + '）：请在左侧会话列表里点开它')
          return
        }
        setOpen(false)
      } catch (error) {
        setMessage('打开失败：' + String(error))
      } finally {
        setBusy(false)
      }
    },
    [ctx, repoPath, currentSession],
  )

  /** 点行内「删除」：只开确认框，什么都还没删 */
  const openDelete = useCallback((item: WorktreeItem) => {
    setDeleteTarget(item)
    setDeleteRemoteCheck(null)
    setDeleteFailure(null)
    setDeleteForce(false)
    setDeleteBranch(false)
    setDeleteRemoteBranch(false)
  }, [])

  const closeDelete = useCallback(() => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteFailure(null)
  }, [deleting])

  /**
   * 确认删除。宿主按「归档会话 → 注销工作区登记 → git worktree remove →（勾了才）删分支」
   * 的顺序做，任一步失败就停在那里并如实报告做到哪一步（ErrorResult.partial）。
   * 成功或失败都要重读列表：归档会话、删掉分支都会改变列表内容。
   */
  const onDeleteConfirm = useCallback(async () => {
    if (repoPath === null || deleteTarget === null) return
    setDeleting(true)
    setDeleteFailure(null)
    try {
      const result = await callHost<RemoveResult | ErrorResult>('remove', {
        repoPath,
        name: deleteTarget.name,
        force: deleteForce,
        deleteBranch,
        deleteRemoteBranch: deleteBranch && deleteHasRemote && deleteRemoteBranch,
        sessionId: currentSession,
      })
      if (!result.ok) {
        setDeleteFailure(result)
        return
      }
      setDeleteTarget(null)
      await refresh()
      setMessage(
        [
          '已删除 worktree ' + result.name,
          ...(result.archived > 0 ? ['已归档 ' + result.archived + ' 个会话'] : []),
          ...(result.branchDeleted === null ? [] : ['已删除本地分支 ' + result.branchDeleted]),
          ...(result.remoteDeleted === null ? [] : ['已删除远端分支 origin/' + result.remoteDeleted]),
          ...result.warnings,
        ].join('\n'),
      )
    } catch (error) {
      setDeleteFailure({ ok: false, error: '删除失败', detail: String(error) })
    } finally {
      setDeleting(false)
    }
  }, [repoPath, deleteTarget, deleteForce, deleteBranch, deleteHasRemote, deleteRemoteBranch, currentSession, refresh])

  const onCreate = useCallback(
    async (enter: boolean) => {
      if (repoPath === null || !ready) return
      setBusy(true)
      setMessage(null)
      try {
        const result = await callHost<CreateResult | ErrorResult>('create', {
          repoPath,
          // 两种模式二选一：目标分支，或"新分支 + 起点"
          ...(mode === 'new' ? { newBranch: newBranch.trim(), base } : { branch }),
          name: name.trim() === '' ? undefined : name.trim(),
          enter,
          sessionId: currentSession,
        })
        if (!result.ok) {
          setMessage(errLabel(result))
          return
        }
        if (result.sessionId !== undefined) {
          const failure = await openSession(ctx, result.sessionId)
          if (failure === null) {
            setOpen(false)
            return
          }
          setMessage(
            '已创建 ' +
              result.item.name +
              '（' +
              result.item.path +
              '）：没能自动切过去（' +
              OPEN_FAILURE_TEXT[failure] +
              '），请在左侧会话列表里点开它',
          )
        } else {
          setMessage('已创建 ' + result.item.name + '（' + result.item.path + '）')
        }
        await refresh()
      } catch (error) {
        setMessage('创建失败：' + String(error))
      } finally {
        setBusy(false)
      }
    },
    [ctx, repoPath, mode, branch, newBranch, base, name, ready, currentSession, refresh],
  )

  // 悬停提示走平台 Tooltip（官方 settings 触发器同款）。原生 title 会跟它弹出两层系统提示，
  // 而且那层是浏览器样式，跟侧栏其他控件不是一套；弹窗打开时禁用，跟设置一致。
  // 文案用短标签，跟「设置」一个量级（详细说明留在 aria-label 之外的交互本身里）
  const trigger = (
    <Tooltip label="Worktree" disabled={open}>
      <button
        type="button"
        className={'wt-entry' + (wide ? '' : ' wt-entry-rail') + (open ? ' wt-entry-active' : '')}
        aria-label="Worktree"
        aria-expanded={open}
        onClick={() => {
          setOpen((previous) => !previous)
          setMessage(null)
        }}
      >
        <span className="wt-entry-icon" aria-hidden="true">
          {/* 与官方 settings 触发器同一把尺（宽轨 16、窄轨 18）：图标是自己画的，只有尺寸对齐它 */}
          <IconWorktree size={wide ? 16 : 18} />
        </span>
        {wide ? <span className="wt-entry-label">Worktree</span> : null}
      </button>
    </Tooltip>
  )

  // 临时反馈由平台 Toast 自行浮层、淡出，不挤占表单；新文案重新计时。
  const toast = message === null ? null : (
    <Toast
      key={message}
      text={message}
      icon={message.includes('\n') ? <span className="wt-toast-lines" /> : undefined}
      onDone={() => setMessage((current) => current === message ? null : current)}
    />
  )

  if (!open) return <>{trigger}{toast}</>

  return (
    <div className={'wt-anchor' + (wide ? '' : ' wt-anchor-rail')}>
      {trigger}
      {toast}
      <div className="wt-overlay" role="presentation">
        <div className="wt-mask" aria-hidden="true" onClick={() => setOpen(false)} />
        <div className="wt-panel" role="dialog" aria-modal="true" aria-labelledby={TITLE_ID}>
          <nav className="wt-nav">
            <div className="wt-nav-title" id={TITLE_ID}>
              Worktree
            </div>
            <div className="wt-nav-list">
              {SECTIONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={'wt-nav-cell' + (section === entry.id ? ' wt-nav-cell-active' : '')}
                  aria-current={section === entry.id ? 'true' : undefined}
                  onClick={() => setSection(entry.id)}
                >
                  {entry.id === 'create' ? <IconBranch /> : <IconList />}
                  <span className="wt-nav-label">{entry.label}</span>
                </button>
              ))}
            </div>
          </nav>

          <div className="wt-content">
            <div className="wt-header">
              {/* 工作区选择在标题右边的顶栏上，不带 label；只列非 worktree 的目标仓库 */}
              {repos.length === 0 ? null : (
                <div className="wt-header-workspace">
                  <WorkspaceCombo
                    items={repos}
                    value={chosen?.workspaceId ?? null}
                    display={chosen?.title ?? ''}
                    onPick={(id) => {
                      ++refreshRequest.current
                      setWorkspaceId(id)
                      setData(null)
                    }}
                  />
                </div>
              )}
              <div className="wt-header-actions">
                <Tooltip label="拉取远端分支（origin），不合并当前分支" side="bottom">
                  <Button
                    type="button"
                    variant="toolbar"
                    size="sm"
                    className="wt-icon-btn"
                    aria-label="拉取远端分支"
                    disabled={busy || repoPath === null}
                    onClick={() => void refresh(true)}
                  >
                    <IconGitPull />
                  </Button>
                </Tooltip>
                <button
                  type="button"
                  className="wt-icon-btn"
                  title="刷新"
                  aria-label="刷新"
                  disabled={busy}
                  onClick={() => void refresh()}
                >
                  <IconRefresh />
                </button>
              </div>
              <button
                ref={closeRef}
                type="button"
                className="wt-close"
                title="关闭"
                aria-label="关闭"
                onClick={() => setOpen(false)}
              >
                <IconClose />
                <span className="wt-visually-hidden">关闭</span>
              </button>
            </div>

            <div className="wt-options">
              {section === 'create' ? (
                <div className="wt-section">
                  <h2 className="wt-title">新建 Worktree</h2>
                  {repoPath === null ? (
                    <p className="wt-empty">先在左侧添加或选择一个工作区，再回来点这里。</p>
                  ) : (
                    <>
                      <div className="wt-seg" role="tablist" aria-label="创建方式">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'existing'}
                          className={'wt-seg-btn' + (mode === 'existing' ? ' wt-seg-btn-active' : '')}
                          onClick={() => switchMode('existing')}
                        >
                          已有分支
                        </button>
                        <button
                          type="button"
                          role="tab"
                          aria-selected={mode === 'new'}
                          className={'wt-seg-btn' + (mode === 'new' ? ' wt-seg-btn-active' : '')}
                          onClick={() => switchMode('new')}
                        >
                          新建分支
                        </button>
                      </div>

                      <div className="wt-form">
                        {mode === 'existing' ? (
                          <div className="wt-field">
                            <span className="wt-label">分支</span>
                            <BranchCombo
                              items={branches}
                              value={branch}
                              placeholder="搜索分支…"
                              ariaLabel="分支"
                              onPick={pickBranch}
                            />
                          </div>
                        ) : (
                          <>
                            <label className="wt-field">
                              <span className="wt-label">新分支</span>
                              <input
                                className="wt-input"
                                value={newBranch}
                                placeholder="例如 feature/my-change"
                                autoComplete="off"
                                spellCheck={false}
                                aria-label="新分支"
                                onChange={(event) => setNewBranch(event.target.value)}
                              />
                            </label>
                            <div className="wt-field">
                              <span className="wt-label">起点</span>
                              <BranchCombo
                                items={bases}
                                value={base}
                                placeholder="搜索起点分支…"
                                ariaLabel="起点"
                                pickable={alwaysPickable}
                                onPick={(item) => setBase(item.name)}
                              />
                            </div>
                          </>
                        )}
                        <label className="wt-field">
                          <span className="wt-label">目录名</span>
                          <input
                            className="wt-input"
                            value={name}
                            placeholder="默认按分支名派生"
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) => {
                              setNameTouched(true)
                              setName(event.target.value)
                            }}
                          />
                        </label>
                      </div>

                      {mode === 'new' ? null : branches.length === 0 ? (
                        <p className="wt-hint">这个仓库没有可用的分支</p>
                      ) : usableBranches.length === 0 ? (
                        <p className="wt-hint">所有分支都已经被 worktree 检出，没有可用的分支</p>
                      ) : null}
                    </>
                  )}
                </div>
              ) : (
                <div className="wt-section">
                  <h2 className="wt-title">{'已有 Worktree（' + (data?.items.length ?? 0) + '）'}</h2>
                  {repoPath === null ? (
                    <p className="wt-empty">先在左侧添加或选择一个工作区，再回来点这里。</p>
                  ) : data === null ? (
                    <p className="wt-empty">{busy ? '读取中…' : '还没有读到数据'}</p>
                  ) : data.items.length === 0 ? (
                    <p className="wt-empty-box">这个仓库还没有 worktree</p>
                  ) : (
                    <div className="wt-list">
                      {data.items.map((item) => (
                        <div key={item.path} className="wt-row-card">
                          <div className="wt-row-head">
                            <span className="wt-row-icon">
                              <IconWorktree />
                            </span>
                            <span className="wt-row-name">{item.name}</span>
                            <span className="wt-row-actions">
                              <button
                                type="button"
                                className="wt-btn wt-btn-secondary wt-btn-sm"
                                disabled={busy}
                                onClick={() => void onOpenExisting(item)}
                              >
                                打开新会话
                              </button>
                              <button
                                type="button"
                                className="wt-btn wt-btn-danger wt-btn-sm"
                                disabled={busy}
                                title={'删除 worktree ' + item.name}
                                onClick={() => openDelete(item)}
                              >
                                <IconTrashOutlineRegular size={14} />
                                删除
                              </button>
                            </span>
                          </div>
                          <div className="wt-row-branch" title={item.branch ?? '(detached)'}>
                            <span className="wt-row-icon">
                              <IconBranch />
                            </span>
                            <span className="wt-row-text">{item.branch ?? '(detached)'}</span>
                          </div>
                          <div className="wt-row-path" title={item.path}>
                            <span className="wt-row-icon">
                              <IconFolderOption />
                            </span>
                            <span className="wt-row-text">{item.path}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 动作按钮固定在 footer：面板高度固定，按钮永远贴在底部，不随内容滚动 */}
            {section === 'create' && repoPath !== null ? (
              <div className="wt-footer">
                <button
                  type="button"
                  className="wt-btn wt-btn-secondary"
                  disabled={busy || !ready}
                  onClick={() => void onCreate(false)}
                >
                  只创建
                </button>
                <button
                  type="button"
                  className="wt-btn wt-btn-primary"
                  disabled={busy || !ready}
                  onClick={() => void onCreate(true)}
                >
                  创建并进入新会话
                </button>
              </div>
            ) : null}

            {/*
              删除确认框。用平台 Modal（官方「删除工作区」用的也是它）而不是自绘浮层：它是
              portal，天然盖在自写弹窗之上，焦点陷阱与 Esc 交给平台管。没用 RiskConfirmation
              是因为它没有 children 槽位，装不下下面这几个勾选。
              版式分三层：① 一定会执行的三步（编号）② 可选项（勾选，细线隔开）
              ③ 失败原因 + 补救勾选，紧贴底部的动作按钮。
            */}
            {deleteTarget === null ? null : (
              // 不收句号：弹窗里其他每一行（步骤说明、警告、勾选项）都不收，只它带会很扎眼
              <Modal
                open
                onClose={closeDelete}
                closeLabel="关闭"
                className="wt-modal"
                contentClassName="wt-modal-content"
                title="删除 worktree"
                description={'「' + deleteTarget.name + '」的目录将被删除，无法恢复'}
                footer={
                  <>
                    <Button variant="outline" disabled={deleting} onClick={closeDelete}>
                      取消
                    </Button>
                    <Button
                      variant="outline"
                      className="wt-modal-danger"
                      disabled={deleting}
                      onClick={() => void onDeleteConfirm()}
                    >
                      删除
                    </Button>
                  </>
                }
              >
                {/* 三步的顺序就是宿主真正执行的顺序，一条不多一条不少 */}
                <ol className="wt-steps">
                  <li className="wt-step">
                    <span className="wt-step-no">1</span>
                    <span className="wt-step-text">
                      <span className="wt-step-title">归档该目录下的会话</span>
                      <span className="wt-step-note">对话记录保留，可在「未分组」里取消归档</span>
                    </span>
                  </li>
                  <li className="wt-step">
                    <span className="wt-step-no">2</span>
                    <span className="wt-step-text">
                      <span className="wt-step-title">从工作区列表中移除</span>
                    </span>
                  </li>
                  <li className="wt-step">
                    <span className="wt-step-no">3</span>
                    <span className="wt-step-text">
                      <span className="wt-step-title">删除目录</span>
                      <code className="wt-step-path">{deleteTarget.path}</code>
                    </span>
                  </li>
                </ol>

                {data !== null && !deleteTarget.path.startsWith(data.worktreeRoot + '/') ? (
                  <div className="wt-alert wt-alert-warn">
                    <IconWarningTriangleOutlineRegular size={16} />
                    <span>{'不在 ' + data.worktreeRoot + '/ 下，是仓库外部的目录'}</span>
                  </div>
                ) : null}

                {/* 可选项：跟「一定会做」的三步用一条细线分开，默认全不勾 */}
                <div className="wt-extras">
                  <p className="wt-extras-title">同时删除分支</p>
                  {deleteTarget.branch === null ? (
                    <p className="wt-extras-note">它是 detached HEAD，没有分支可删</p>
                  ) : (
                    <div className="wt-checks">
                      <Checkbox
                        checked={deleteBranch}
                        onChange={setDeleteBranch}
                        disabled={deleting}
                        label={'本地分支 ' + deleteTarget.branch}
                      />
                      {/* 服务器确认存在且勾了本地时，才提供远端删除选项。 */}
                      {deleteBranch && deleteHasRemote ? (
                        <Checkbox
                          checked={deleteRemoteBranch}
                          onChange={setDeleteRemoteBranch}
                          disabled={deleting}
                          label={'远端分支 origin/' + deleteTarget.branch}
                        />
                      ) : null}
                    </div>
                  )}
                  {deleteTarget.branch !== null && (remoteStatus === undefined || remoteStatus === 'failed') ? (
                    <p className="wt-extras-note" role="status">
                      {remoteStatus === 'failed' ? '无法确认远端分支，暂不提供远端删除' : '正在确认远端分支…'}
                    </p>
                  ) : null}
                </div>

                {deleteFailure === null ? null : (
                  <div className="wt-alert wt-alert-error" role="alert">
                    {errLabel(deleteFailure)}
                  </div>
                )}
                {/* 「强制删除」只在真被未提交改动拦住之后才露出来：先让人知道代价，再给这个选项 */}
                {deleteForce || deleteFailure?.error === 'worktree-dirty' ? (
                  <div className="wt-checks">
                    <Checkbox
                      checked={deleteForce}
                      onChange={setDeleteForce}
                      disabled={deleting}
                      label="丢弃未提交的改动，强制删除"
                    />
                  </div>
                ) : null}
                {deleting ? (
                  <p className="wt-status" role="status">
                    正在归档会话并删除目录…
                  </p>
                ) : null}
              </Modal>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
