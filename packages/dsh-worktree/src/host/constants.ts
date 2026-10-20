// 常量与默认值。取值范围都很窄，所以这里是一张平表，不引入配置层级。

/** worktree 根目录，相对仓库根 */
export const DEFAULT_WORKTREE_ROOT = '.worktrees'

/** 远端名：分支列表里的远端分支只认它 */
export const REMOTE = 'origin'

/**
 * worktree 名（= 目录名）的安全字符集：小写字母/数字/连字符，必须以字母或数字开头。
 * 这个名字会拼进 git 命令行与文件路径，所以必须严格收窄
 */
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 目录名派生时的长度上限 */
export const NAME_MAX = 64

/** 分支名会拼进 shell 命令行，只挡掉 git ref 明确禁止的字符 */
export const BRANCH_RE = /^[^\s~^:?*[\\]{1,200}$/

/**
 * 默认**工作区**（项目）名模板；{compact} {spaced} {name} {branch} {path} {repo} 会被替换。
 *
 * 工作区名保留 worktree 目录名原样（连字符不丢）。不再带 `@{repo}`：DSH 0.1.7 起侧边栏
 * 的「按工作区树」按**路径包含关系**把 worktree 工作区嵌在仓库工作区底下，仓库名已经
 * 在父行上了，子行再写一遍只是挤宽度。worktree 目录落在 `<repo>/.worktrees/` 内是默认
 * 布局，所以父行必然存在。例：worktree `sample-worktree-dir` → `wt: sample-worktree-dir`。
 * 仍然用「按工作区」/「单列表」模式、需要仓库线索的，配成 `wt: {name}@{repo}` 即可
 * ——模板变量一个没少。
 */
export const DEFAULT_TITLE_TEMPLATE = 'wt: {name}'

/**
 * 默认**会话**名模板。
 *
 * 会话名给人读，所以默认就把连字符换成空格：`feature-local-only` → `feature local only`。
 * 想跟工作区名保持一致就把它设成 `{spaced}` 之外的写法，例如 `{compact}` 或完整标题。
 */
export const DEFAULT_SESSION_TITLE_TEMPLATE = '{spaced}'

/**
 * 默认交接消息模板；{name} {branch} {path} {repo} {task} 会被替换。
 *
 * 默认**空**：开出来的就是干净的新对话，一条消息都不发。新会话的 cwd 在创建时就冻在
 * 会话头里（就是 worktree 目录），模型本来就知道自己在哪；再补一句"你在 worktree 里、
 * 先别动"只会在对话里留一条假的用户消息，还白跑一轮回复。
 *
 * 想要开场白（或那段"别切回主仓库"的提醒）就把它配成非空模板；工具调用方显式给了
 * 任务时，渲染结果后面自动追加"任务：…"那段 —— 那条是调用方真发的指令，不是假的。
 */
export const DEFAULT_HANDOFF_TEMPLATE = ''

/** 调用方额外给了任务时，追加在模板渲染结果后面的段落 */
export const TASK_SECTION_TEMPLATE = '任务：\n{task}'

/** 普通 git 命令超时 */
export const GIT_TIMEOUT_MS = 20_000

/** fetch 需要访问远端，单独放宽 */
export const FETCH_TIMEOUT_MS = 60_000

/** git worktree add 要落盘整个工作区，单独放宽 */
export const ADD_TIMEOUT_MS = 60_000

/** git worktree remove 要落盘删除整个工作区，与 add 同量级 */
export const REMOVE_TIMEOUT_MS = 60_000

/** 删远端分支要访问远端（可能要认证），与 fetch 同量级 */
export const REMOTE_TIMEOUT_MS = 60_000

/** 插件内部错误码：前端按码显示中文，不要靠解析文案 */
export const ERR = {
  noRepo: 'no-workspace',
  notRepo: 'not-a-git-repo',
  badName: 'bad-worktree-name',
  badBranch: 'bad-branch',
  branchNotFound: 'branch-not-found',
  branchInUse: 'branch-already-checked-out',
  /** 要新建的分支本地已经存在（那就该走"已有分支"） */
  branchExists: 'branch-already-exists',
  /** 新分支的起点不存在 */
  baseNotFound: 'base-not-found',
  /** 既没给 branch 也没给 newBranch */
  missingTarget: 'missing-branch-target',
  exists: 'worktree-exists',
  notFound: 'worktree-not-found',
  addFailed: 'worktree-add-failed',
  fetchFailed: 'git-fetch-failed',
  openFailed: 'open-session-failed',
  /** 会话文件权限是只读，写不了任何东西 */
  sandboxReadOnly: 'sandbox-read-only',
  /** 目标仓库/worktree 目录不在会话沙箱的可写根内（workspace-write 只放行会话工作区） */
  sandboxOutside: 'workspace-outside-sandbox',
  /** git 真的撞上了写拒绝（EPERM/EACCES），前置判定没能提前拦下 */
  sandboxDenied: 'sandbox-write-denied',
  /** 目标 worktree 里有未提交的改动，git 拒绝删除（要强删得显式 force） */
  dirty: 'worktree-dirty',
  /** 目标 worktree 被 `git worktree lock` 锁住了 */
  locked: 'worktree-locked',
  /** 要删的就是当前会话自己所在的 worktree：删掉它等于把自己的 cwd 抽掉 */
  self: 'worktree-in-use-by-this-session',
  removeFailed: 'worktree-remove-failed',
  pruneFailed: 'worktree-prune-failed',
  /** 归档该 worktree 下的会话失败。归档是删除的第一步，失败即停，目录不动 */
  archiveFailed: 'session-archive-failed',
  /** 本地分支没合并进上游/HEAD，`git branch -d` 拒绝（强删要用户自己决定） */
  branchUnmerged: 'branch-not-merged',
  branchDeleteFailed: 'branch-delete-failed',
  /** 远端上本来就没有这个分支（`push --delete` 回了 remote ref does not exist） */
  remoteBranchMissing: 'remote-branch-not-found',
  remoteDeleteFailed: 'remote-branch-delete-failed',
  remoteCheckFailed: 'remote-branch-check-failed',
} as const
