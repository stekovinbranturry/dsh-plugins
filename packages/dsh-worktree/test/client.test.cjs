// 客户端 bundle 的渲染验证。
//
// 没有真的 react / react-dom，也不需要：bundle 只用 React.createElement / hooks。
// 这里按浏览器的真实方式加载产物（顶层 window.__ModuleLoader__.load，非 ESM），
// 垫一个最小 React 与假 document，然后展开元素树断言。
// useState 的返回值按调用序号预置，于是"弹层打开 + 已有数据"的分支也被覆盖。
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const CLIENT = path.join(__dirname, '..', 'dist', 'client.js')
const SLOT = 'sidebar.footer.action'

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

console.log('\n== bundle envelope ==')
const source = fs.readFileSync(CLIENT, 'utf8')
const loaded = []
const styleNodes = []
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
  document: {
    head: {
      appendChild(node) {
        node.parentNode = this
        styleNodes.push(node)
      },
      removeChild(node) {
        node.parentNode = null
      },
    },
    createElement() {
      return {
        parentNode: null,
        attributes: {},
        setAttribute(name, value) {
          this.attributes[name] = value
        },
        set textContent(value) {
          this.text = value
        },
        get textContent() {
          return this.text
        },
      }
    },
  },
  window: { __ModuleLoader__: { load: (config) => loaded.push(config) } },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: CLIENT })

eq(loaded.length, 1, 'exactly one __ModuleLoader__.load call')
const config = loaded[0]
eq(config.id, 'dsh-worktree', 'bundle id')
eq(typeof config.factory, 'function', 'factory is a function')
const requires = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
const SEEDS = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']
ok(
  requires.length > 0 && requires.every((id) => SEEDS.indexOf(id) >= 0),
  'only platform seeds are required',
  requires.join(' '),
)
ok(requires.indexOf('react/jsx-runtime') >= 0, 'JSX compiles to the automatic runtime')
ok(!/^[ \t]*(import|export)[ \t]/m.test(source), 'no ESM statements: the bundle is a classic script')
ok(source.indexOf('__STYLES__') < 0, 'no stylesheet placeholder left')
ok(source.indexOf('.wt-panel') > 0, 'styles.css was inlined')
ok(source.indexOf('sidebar.footer.action') > 0, 'the sidebar footer slot name is in the bundle')
ok(source.indexOf('conversation.session.header') < 0, 'the session header slot is gone')
ok(source.indexOf('dsh-worktree:sidebar-entry') > 0, 'the slot registration id is in the bundle')
ok(source.indexOf('/api/dsh-worktree.') > 0, 'the host API namespace is in the bundle')
ok(source.indexOf('/remove') < 0, 'the client never calls the removed route')
ok(source.indexOf('worktree_prune') < 0, 'the client never calls prune')
ok(source.indexOf('eval(') < 0, 'no eval in the bundle')

// ── minimal React + element-tree expander ─────────────────────────────────
let stateIndex = 0
let presets = []
/** 记录 useState 的 setter 调用：状态变化没有真实重渲染，只能这样断言 handler 的意图 */
let stateSets = []
const ReactShim = {
  createElement: (type, props, ...children) => ({
    __el: true,
    type,
    props: Object.assign({}, props, { children: children.length > 1 ? children : children[0] }),
  }),
  useState(initial) {
    const index = stateIndex++
    const value = index < presets.length && presets[index] !== undefined ? presets[index] : initial
    return [
      value,
      (next) => {
        stateSets.push({ index, value: typeof next === 'function' ? next(value) : next })
      },
    ]
  },
  useEffect() {},
  useRef() {
    return { current: null }
  },
  useMemo(fn) {
    return fn()
  },
  useCallback(fn) {
    return fn
  },
  useSyncExternalStore(_subscribe, snapshot) {
    return snapshot()
  },
}
function jsxNode(type, props, key) {
  const merged = Object.assign({}, props)
  if (key !== undefined) merged.key = key
  return { __el: true, type, props: merged }
}
const JsxRuntimeShim = {
  jsx: jsxNode,
  jsxs: jsxNode,
  Fragment: function Fragment(props) {
    return jsxNode('fragment', props)
  },
}
/**
 * 平台 primitives 的替身。只垫本插件用到的两个导出：Menu、Tooltip。
 * 真 Menu 会把 anchor 原样渲染在原地、再在 body 里挂浮层；这里把 anchor 放进 children，
 * 好让元素树走查照旧能找到触发器，行本身按 props.items 断言。
 * Tooltip 同理：真件在 hover 时才挂浮层，这里只留一个可断言的 tooltip 节点（label 是 props，
 * 不落成文本，否则会污染 allText 的窄轨断言）。
 */
const PrimitivesShim = {
  Menu(props) {
    return jsxNode('Menu', Object.assign({}, props, { children: props.anchor }))
  },
  Tooltip(props) {
    return jsxNode('tooltip', {
      label: props.label,
      disabled: props.disabled,
      children: props.children,
    })
  },
}
const moduleExports = config.factory((id) => {
  if (id === 'react') return ReactShim
  if (id === 'react/jsx-runtime') return JsxRuntimeShim
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return PrimitivesShim
  throw new Error('unexpected require: ' + id)
})

console.log('\n== exports ==')
eq(moduleExports.name, undefined, 'no plugin name on the client half (the bundle id carries it)')
eq(typeof moduleExports.apply, 'function', 'exports.apply')
eq(moduleExports[Symbol.toStringTag], 'Module', 'Symbol.toStringTag is Module')
// uiWorkspace 用 ctx.get 取，所以不进 inject（get 不要求门控），拿不到只降级成一句提示
eq(JSON.stringify(moduleExports.inject), '["slots"]', 'the module injects slots only (uiWorkspace goes through get)')

// ── fake client ctx ───────────────────────────────────────────────────────
const registrations = []
const injected = []
const disposers = []
/** 0.1.7 的切主视图动作：uiWorkspace.openSession(id)（sessions.open 已删） */
const opened = []
const uiWorkspace = { openSession: (id) => opened.push(id) }
const ctx = {
  effect(fn) {
    disposers.push(fn())
    return () => {}
  },
  get: (name) => (name === 'uiWorkspace' ? uiWorkspace : undefined),
  slots: {
    inject(slotName, callback) {
      injected.push(slotName)
      return callback()
    },
    register(registration, component) {
      registrations.push({ registration, component })
      return () => {}
    },
  },
}

console.log('\n== slot registration ==')
moduleExports.apply(ctx)
eq(styleNodes.length, 1, 'styles were inserted once')
eq(styleNodes[0].attributes['data-dsh-worktree'], '', 'style node is tagged for cleanup')
ok(styleNodes[0].textContent.indexOf('.wt-panel') > 0, 'the inserted style node carries the panel css')
eq(injected.length, 1, 'exactly one slot inject')
eq(injected[0], SLOT, 'injects the root-level sidebar footer slot')
eq(registrations.length, 1, 'one slot registration')
const registration = registrations[0].registration
eq(registration.name, SLOT, 'registration targets the same slot')
eq(registration.id, 'dsh-worktree:sidebar-entry', 'registration id is plugin-namespaced')
eq(registration.registrant, 'dsh-worktree', 'registration declares its registrant')
ok(typeof registration.order === 'number', 'registration declares an order')
eq(disposers.length, 1, 'one effect (the stylesheet)')
eq(typeof registrations[0].component, 'function', 'the occupant is the component itself, so it receives the standard props')

// ── pure helpers exported from the bundle ─────────────────────────────────
console.log('\n== pickWorkspace (the no-session fallback rule) ==')
const pick = moduleExports.pickWorkspace
const W1 = {
  items: [
    { workspaceId: 'w1', path: '/one', title: 'one', sessionIds: ['s1'], createdAt: '2024-01-01T00:00:00.000Z' },
    { workspaceId: 'w2', path: '/two', title: 'two', sessionIds: ['s2'], createdAt: '2024-01-02T00:00:00.000Z' },
  ],
}
eq(
  pick(W1.items, { current: 's1', byId: { s1: { id: 's1', updatedAt: 1 }, s2: { id: 's2', updatedAt: 99 } } }).workspaceId,
  'w1',
  'the current session wins over the recency rule',
)
eq(
  pick(W1.items, { current: undefined, byId: { s1: { id: 's1', updatedAt: 1 }, s2: { id: 's2', updatedAt: 99 } } }).workspaceId,
  'w2',
  'with no session the most recently used workspace wins (recentWorkspace)',
)
eq(
  pick(W1.items, { current: undefined, byId: {} }).workspaceId,
  'w2',
  'with no session data at all it falls back to the newest workspace',
)
eq(pick([], { current: undefined, byId: {} }), undefined, 'no workspace -> undefined')
eq(moduleExports.deriveName('feature/foo'), 'feature-foo', 'deriveName folds the slash')
eq(moduleExports.deriveName('origin/Feature/Bar'), 'feature-bar', 'deriveName drops origin/ and lowercases')
// worktree 目录从目标仓库里排除
eq(moduleExports.isWorktreePath('/repo/.worktrees/foo'), true, 'a worktree directory is identified')
eq(moduleExports.isWorktreePath('/Users/x/.worktrees/feature-bar'), true, 'worktrees under any repo root are identified')
eq(moduleExports.isWorktreePath('/Users/x/my-worktrees'), false, 'a folder merely named worktrees-* is not a git worktree')
eq(moduleExports.isWorktreePath('/repo'), false, 'a plain repo root is kept')

// ── expand the element tree ───────────────────────────────────────────────
function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (node.__el !== true) return node
  if (typeof node.type === 'function') {
    const props = Object.assign({}, node.props, { children: expand(node.props.children) })
    return expand(node.type(props))
  }
  return { __el: true, type: node.type, props: Object.assign({}, node.props, { children: expand(node.props.children) }) }
}

function collect(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') {
    visit({ kind: 'text', value: String(node) })
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) collect(child, visit)
    return
  }
  if (node.__el === true) {
    visit({ kind: 'element', type: node.type, props: node.props, children: node.props.children })
    collect(node.props.children, visit)
  }
}
function flatten(tree) {
  const out = []
  collect(tree, (entry) => out.push(entry))
  return out
}
function allText(tree) {
  return flatten(tree)
    .filter((entry) => entry.kind === 'text')
    .map((entry) => entry.value)
    .join(' | ')
}
function buttons(tree) {
  return flatten(tree)
    .filter((entry) => entry.kind === 'element' && entry.type === 'button')
    .map((entry) => ({ label: allText(entry.children), className: entry.props.className, disabled: entry.props.disabled }))
}
function divsWithClass(tree, wanted) {
  return flatten(tree).filter(
    (entry) =>
      entry.kind === 'element' &&
      typeof entry.props.className === 'string' &&
      entry.props.className.split(' ').indexOf(wanted) >= 0,
  )
}

/** 平台注入的标准 props：这里给出真实的 workspace / session 快照 */
function standardProps(workspaces, sessions, wide = true) {
  return {
    useWorkspaces: (selector) => selector(workspaces),
    useSessions: (selector) => selector(sessions),
    wide,
  }
}
/**
 * 状态顺序（与组件里的 useState 顺序一一对应）。
 * 主组件：open, section, workspaceId, data, busy, message, mode, branch, name, nameTouched,
 *         newBranch, base
 * 之后是工作区选择（单选下拉）自己的两个状态：open, active
 * 再之后是分支/起点下拉的三个状态：query, listOpen, active
 */
const S_OPEN = 0
const S_SECTION = 1
const S_WORKSPACE = 2
const S_DATA = 3
const S_BUSY = 4
const S_MESSAGE = 5
const S_MODE = 6
const S_BRANCH = 7
const S_NAME = 8
const S_NEW_BRANCH = 10
const S_BASE = 11
const S_WS_OPEN = 12
const S_QUERY = 13
const S_LIST_OPEN = 14
const S_ACTIVE = 15
/** 工作区选择只有一个状态：菜单开没开（行交给平台的 Menu，我们不再自持光标） */
const WS_COMBO = [false]
/**
 * 预置状态数组：open, section, workspaceId(=null 即跟随默认), 主组件 9 个, 工作区选择 2 个,
 * 最后是分支/起点下拉 3 个。rest 里前 9 个是主组件（短数组省略的 newBranch/base 补回初始值），
 * 剩下的是分支下拉状态。
 */
const preset = (open, section, rest) => [open, section, null, ...mainStates(rest), ...WS_COMBO, ...rest.slice(9)]
const presetWs = (workspaceId, open, section, rest) => [
  open,
  section,
  workspaceId,
  ...mainStates(rest),
  ...WS_COMBO,
  ...rest.slice(9),
]
/** 主组件的 9 个状态：data, busy, message, mode, branch, name, nameTouched, newBranch, base */
function mainStates(rest) {
  const main = rest.slice(0, 9)
  while (main.length < 8) main.push('')
  if (main.length < 9) main.push('HEAD')
  return main
}
const REPO_WORKSPACES = {
  items: [
    {
      workspaceId: 'w1',
      path: '/repo',
      title: 'repo',
      sessionIds: ['s1'],
      createdAt: '2024-01-01T00:00:00.000Z',
    },
  ],
}
const REPO_SESSIONS = { current: 's1', byId: { s1: { id: 's1', cwd: '/repo', updatedAt: 5 } } }

console.log('\n== collapsed entry ==')
stateIndex = 0
presets = []
const collapsed = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
ok(allText(collapsed).indexOf('Worktree') >= 0, 'the entry is labelled Worktree (title case)')
eq(divsWithClass(collapsed, 'wt-panel').length, 0, 'no panel while collapsed')
const entry = flatten(collapsed).filter((e) => e.kind === 'element' && e.type === 'button')[0]
ok(!!entry && entry.props.className.indexOf('wt-entry') >= 0, 'the sidebar control is our own button')
ok(entry.props.className.indexOf('wt-entry-active') < 0, 'not marked active while collapsed')
ok(entry.props.className.indexOf('wt-entry-rail') < 0, 'wide column: the full label row, like the settings trigger')
eq(entry.props['aria-expanded'], false, 'the entry is a disclosure control')
// 悬停气泡换成平台 Tooltip（官方 settings 触发器同款），原生 title 必须清掉 —— 否则两层提示
const entryTip = flatten(collapsed).filter((e) => e.kind === 'element' && e.type === 'tooltip')[0]
ok(!!entryTip, 'the entry is wrapped in the platform Tooltip')
eq(entryTip.props.label, 'Worktree', 'hover bubble is the short label, same scale as the settings trigger')
eq(entryTip.props.disabled, false, 'bubble is live while the panel is closed')
eq(entry.props.title, undefined, 'no native title alongside the platform tooltip')
// 官方 settings 触发器在收起时只留图标（36×36，圆角仍是 radius-md —— rail 不覆盖 border-radius）
stateIndex = 0
presets = []
const rail = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS, false)))
const railEntry = flatten(rail).filter((e) => e.kind === 'element' && e.type === 'button')[0]
ok(railEntry.props.className.indexOf('wt-entry-rail') >= 0, 'narrow rail: the entry collapses to an icon button')
eq(allText(rail).indexOf('worktree'), -1, 'narrow rail: no label text')
const railTip = flatten(rail).filter((e) => e.kind === 'element' && e.type === 'tooltip')[0]
ok(!!railTip, 'narrow rail keeps the tooltip (it is the only place the label survives)')
eq(railTip.props.label, 'Worktree', 'narrow rail: the bubble carries the label')
eq(railEntry.props.title, undefined, 'narrow rail: no native title either')

console.log('\n== open panel with data ==')
const DATA = {
  ok: true,
  repoRoot: '/repo',
  worktreeRoot: '/repo/.worktrees',
  warnings: ['cwd-missing: /gone'],
  items: [
    { name: 'alpha', path: '/repo/.worktrees/alpha', branch: 'feature/alpha', detached: false },
    { name: 'external', path: '/elsewhere/external', branch: null, detached: true },
  ],
  branches: [
    { name: 'main', kind: 'local', localName: 'main', inWorktree: '/repo' },
    { name: 'feature/local-only', kind: 'local', localName: 'feature/local-only', inWorktree: null },
    { name: 'origin/feature/remote-only', kind: 'remote', localName: 'feature/remote-only', inWorktree: null },
  ],
}
// useState 的顺序：open, section, data, busy, message, mode, branch, name, nameTouched
stateIndex = 0
presets = preset(true, 'create', [DATA, false, 'cwd-missing: /gone', 'existing', 'feature/local-only', 'feature-local-only', true])
const panel = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
eq(divsWithClass(panel, 'wt-panel').length, 1, 'the panel renders when open')
// 弹窗外壳必须与设置弹窗一致：遮罩 + 居中面板 + 左侧导航栏
eq(divsWithClass(panel, 'wt-overlay').length, 1, 'the modal overlay is rendered')
eq(divsWithClass(panel, 'wt-mask').length, 1, 'the modal mask dims the page behind it')
eq(divsWithClass(panel, 'wt-nav').length, 1, 'the settings-style nav rail is rendered')
eq(divsWithClass(panel, 'wt-options').length, 1, 'the scrollable options column is rendered')
const dialog = flatten(panel).filter((e) => e.kind === 'element' && e.props.role === 'dialog')[0]
ok(!!dialog, 'the panel is a dialog')
eq(dialog.props['aria-modal'], 'true', 'the dialog is modal')
ok(typeof dialog.props['aria-labelledby'] === 'string', 'the dialog is labelled by its title node')
let texts = allText(panel)
eq(texts.indexOf('/repo'), -1, 'the repo path is shown by the workspace picker title, not a text node')
// 工作区是单选触发器（button），不是可输入搜索框
const wsTrigger = flatten(panel).filter(
  (e) => e.kind === 'element' && e.type === 'button' && e.props['aria-label'] === '选择工作区',
)[0]
ok(!!wsTrigger, 'the workspace picker is a single-select trigger, not a native select')
const wsTLabel = flatten(panel).filter(
  (e) => e.kind === 'element' && String(e.props.className || '').indexOf('wt-ws-trigger-label') >= 0,
)[0]
eq(wsTLabel && allText(wsTLabel.children), 'repo', 'the trigger shows the workspace title (as in the sidebar), not the path')
ok(texts.indexOf('新建 Worktree') >= 0, 'the create section is present')
ok(texts.indexOf('已有 Worktree') >= 0, 'the nav offers the existing-worktree section')
ok(texts.indexOf('cwd-missing: /gone') >= 0, 'a host warning reaches the notice')
// 导航栏两个分区，跟设置弹窗一样由它切换右侧内容
const navCells = flatten(panel).filter(
  (e) => e.kind === 'element' && e.type === 'button' && String(e.props.className).indexOf('wt-nav-cell') >= 0,
)
eq(navCells.length, 2, 'two nav sections')
eq(navCells.map((e) => allText(e.children)).join(','), '新建 Worktree,已有 Worktree', 'the nav sections are labelled')
eq(navCells[0].props['aria-current'], 'true', 'the create section is active by default')
ok(navCells[1].props.className.indexOf('wt-nav-cell-active') < 0, 'the list section is not highlighted')
const labels = buttons(panel).map((b) => b.label)
ok(labels.indexOf('创建并进入新会话') >= 0, 'primary create button')
ok(labels.indexOf('只创建') >= 0, 'plain create button')
ok(labels.indexOf('已有分支') >= 0, 'the mode switch offers existing branches')
ok(labels.indexOf('新建分支') >= 0, 'the mode switch offers a new branch')
ok(labels.indexOf('删除') < 0, 'there is no delete button any more')
ok(labels.indexOf('清理 stale 记录') < 0, 'there is no prune button any more')
// 分区切换：同一时刻只渲染当前分区（设置弹窗就是这么做的），导航在前、内容在后
const sections = flatten(panel)
  .filter((e) => e.kind === 'element' && typeof e.props.className === 'string' && e.props.className.indexOf('wt-section') >= 0)
  .map((e) => allText(e.children))
eq(sections.length, 1, 'only the active section is rendered')
ok(sections[0].indexOf('新建 Worktree') >= 0, 'the create section is the active one', sections.join(' / '))

console.log('\n== existing worktree section ==')
stateIndex = 0
presets = preset(true, 'list', [DATA, false, null, 'existing', 'feature/local-only', 'feature-local-only', true])
const listPanel = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
ok(allText(listPanel).indexOf('已有 Worktree（2）') >= 0, 'the list section titles the count')
ok(allText(listPanel).indexOf('alpha') >= 0, 'worktree name listed')
ok(allText(listPanel).indexOf('feature/alpha') >= 0, 'branch listed')
ok(allText(listPanel).indexOf('(detached)') >= 0, 'a detached worktree is labelled')
ok(allText(listPanel).indexOf('/repo/.worktrees/alpha') >= 0, 'the worktree path is shown')
eq(divsWithClass(listPanel, 'wt-row-card').length, 2, 'each worktree is a settings-style row card')
ok(allText(listPanel).indexOf('打开新会话') >= 0, 'each worktree offers opening a new session')
ok(allText(listPanel).indexOf('已有分支') < 0, 'the create form is not rendered in the list section')
eq(divsWithClass(listPanel, 'wt-footer').length, 0, 'the create footer belongs to the create section')

console.log('\n== workspace switching ==')
const TWO_WORKSPACES = {
  items: [
    { workspaceId: 'w1', path: '/repo', title: 'repo', sessionIds: ['s1'], createdAt: '2024-01-01T00:00:00.000Z' },
    { workspaceId: 'w2', path: '/other', title: 'other', sessionIds: [], createdAt: '2024-01-02T00:00:00.000Z' },
    // worktree 目录不算目标仓库：不该出现在工作区下拉里
    { workspaceId: 'wt1', path: '/repo/.worktrees/other', title: 'wt: other@repo', sessionIds: [], createdAt: '2024-01-03T00:00:00.000Z' },
  ],
}
const wsTriggerOf = (tree) =>
  flatten(tree).filter((e) => e.kind === 'element' && e.type === 'button' && e.props['aria-label'] === '选择工作区')[0]
const wsLabelOf = (tree) =>
  flatten(tree).filter(
    (e) => e.kind === 'element' && String(e.props.className || '').indexOf('wt-ws-trigger-label') >= 0,
  )[0]
const wsOptionsOf = (tree) =>
  flatten(tree).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option')
const wsMenuOf = (tree) => flatten(tree).filter((e) => e.kind === 'element' && e.type === 'Menu')[0]
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', 'feature/local-only', 'feature-local-only', true])
const twoWs = expand(registrations[0].component(standardProps(TWO_WORKSPACES, REPO_SESSIONS)))
ok(!!wsTriggerOf(twoWs), 'the modal offers a workspace picker')
// 工作区选择在顶栏上、没有 label：先确认它落在 .wt-header-workspace 这个 div 里，且不渲染 .wt-label
const wsHeader = flatten(twoWs).filter(
  (e) => e.kind === 'element' && String(e.props.className || '').indexOf('wt-header-workspace') >= 0,
)[0]
ok(!!wsHeader && wsHeader.type === 'div', 'the workspace picker sits in a header div (not a labelled field)')
const headerLabels = flatten(twoWs).filter(
  (e) => e.kind === 'element' && String(e.props.className || '').indexOf('wt-label') >= 0 && allText(e.children) === '工作区',
)
eq(headerLabels.length, 0, 'no “工作区” label above the workspace picker')
// 单选：触发器不是可输入搜索框，拉平后没有 combobox 输入框
ok(
  flatten(twoWs).every(
    (e) => !(e.kind === 'element' && e.type === 'input' && e.props['aria-label'] === '工作区'),
  ),
  'the workspace picker is single-select: no search input',
)
eq(wsLabelOf(twoWs) && allText(wsLabelOf(twoWs).children), 'repo', 'the trigger shows the auto-picked workspace title')
// 展开下拉看全部候选
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', 'feature/local-only', 'feature-local-only', true])
presets[S_WS_OPEN] = true
const twoWsOpen = expand(registrations[0].component(standardProps(TWO_WORKSPACES, REPO_SESSIONS)))
const wsOptions = wsOptionsOf(twoWsOpen)
const wsMenu = wsMenuOf(twoWsOpen)
eq(wsOptionsOf(twoWsOpen).length, 0, 'the list is no longer hand-rolled: no role=option rows of our own')
ok(!!wsMenu, 'the picker renders the platform Menu')
eq(wsMenu.props.portal, true, 'the list portals to body so the modal cannot clip it')
eq(wsMenu.props.align, 'end', 'the list is right-aligned to the trigger')
eq(wsMenu.props.selectedId, 'w1', 'the auto-picked workspace is the selected row')
ok(!!wsTriggerOf(twoWsOpen), 'the trigger is the menu anchor (rendered in place)')
const wsItems = wsMenu.props.items
eq(wsItems.length, 2, 'every non-worktree workspace is offered')
ok(
  wsItems.every((item) => String(item.label).indexOf('wt: other@repo') < 0),
  'a worktree directory is filtered out of the workspace picker',
)
eq(
  wsItems.map((item) => item.label).join(','),
  'repo,other',
  'the candidates are the workspace titles (matching the sidebar)',
)
eq(
  wsItems.map((item) => item.id).join(','),
  'w1,w2',
  'rows carry the workspace id the host needs',
)
ok(wsItems.every((item) => !!item.icon), 'every row carries the folder icon')
// 点一行：Menu 只回 id，收尾动作还是我们的
stateSets = []
wsMenu.props.onSelect('w2')
eq(stateSets.filter((set) => set.index === S_WS_OPEN)[0].value, false, 'the menu closes after picking')
eq(stateSets.filter((set) => set.index === S_WORKSPACE)[0].value, 'w2', 'picking a workspace re-targets the modal')
eq(stateSets.filter((set) => set.index === S_DATA)[0].value, null, 'the previous repo data is dropped while the new one loads')
// 手动选过之后就以选中的为准（默认值 null 只代表"跟随当前会话"）
stateIndex = 0
presets = presetWs('w2', true, 'create', [DATA, false, null, 'existing', 'feature/local-only', 'feature-local-only', true])
const switched = expand(registrations[0].component(standardProps(TWO_WORKSPACES, REPO_SESSIONS)))
eq(wsLabelOf(switched) && allText(wsLabelOf(switched).children), 'other', 'the manually picked workspace sticks (its title shows)')

console.log('\n== footer actions ==')
eq(divsWithClass(panel, 'wt-footer').length, 1, 'the create actions live in a footer')
const footerButtons = flatten(panel)
  .filter((e) => e.kind === 'element' && e.type === 'button')
  .filter((e) => typeof e.props.className === 'string' && e.props.className.indexOf('wt-btn') >= 0 && e.props.className.indexOf('wt-btn-sm') < 0)
eq(footerButtons.map((e) => allText(e.children)).join(','), '只创建,创建并进入新会话', 'the footer holds the two create actions')

// 分段控件：两种创建方式的切换
const tabs = flatten(panel).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'tab')
eq(tabs.length, 2, 'two create modes')
eq(tabs.map((e) => allText(e.children)).join(','), '已有分支,新建分支', 'the modes are labelled')
eq(tabs[0].props['aria-selected'], true, 'existing-branch mode is selected by default')
eq(tabs[1].props['aria-selected'], false, 'new-branch mode is off by default')
ok(tabs[0].props.className.indexOf('wt-seg-btn-active') >= 0, 'the selected mode is highlighted')

// 表单控件：分支搜索框 + 目录名（工作区是单选触发器，不是输入框）
const controls = flatten(panel).filter(
  (e) => e.kind === 'element' && (e.type === 'input' || e.type === 'textarea' || e.type === 'select'),
)
eq(controls.length, 2, 'branch box + directory name (workspace is a single-select trigger, not an input)')
eq(controls.filter((e) => e.type === 'select').length, 0, 'no native select anywhere in the modal')
eq(controls.filter((e) => e.type === 'textarea').length, 0, 'the task textarea is gone')
const acrossPanel = allText(panel)
ok(acrossPanel.indexOf('任务') < 0, 'no task field label left')
ok(acrossPanel.indexOf('交接说明') < 0, 'no handoff placeholder left')
const branchBox = controls.filter((e) => e.type === 'input' && e.props['aria-label'] === '分支')[0]
ok(!!branchBox, 'the branch control is a combobox input')
eq(branchBox.props.value, 'feature/local-only', 'closed combo shows the chosen branch')
eq(branchBox.props['aria-expanded'], false, 'closed combo reports collapsed')
eq(branchBox.props.placeholder, '搜索分支…', 'the combo invites typing to filter')
const nameBox = controls.filter((e) => e.type === 'input' && e.props.role !== 'combobox')[0]
eq(nameBox.props.value, 'feature-local-only', 'the directory name input shows the derived name')

// 按钮样式：primary / secondary 两个类名分开，方便对齐 DSH 自己的按钮
const createPrimary = buttons(panel).filter((b) => b.label === '创建并进入新会话')[0]
const createSecondary = buttons(panel).filter((b) => b.label === '只创建')[0]
ok(createPrimary.className.indexOf('wt-btn-primary') >= 0, 'the first action is the primary button')
ok(createSecondary.className.indexOf('wt-btn-secondary') >= 0, 'the second action is the secondary button')
const openRow = buttons(listPanel).filter((b) => b.label === '打开新会话')[0]
ok(openRow.className.indexOf('wt-btn-secondary') >= 0 && openRow.className.indexOf('wt-btn-sm') >= 0, 'the row action is a small secondary button')

console.log('\n== header icons ==')
// 弹窗图标全部用 16px 的 SVG 而不是文字字形：字形在 28px 按钮里看着明显偏小
const svgs = flatten(panel).filter((e) => e.kind === 'element' && e.type === 'svg')
eq(svgs.length, 7, 'refresh + close + two nav cells + trigger folder + trigger chevron + entry worktree draw svg icons')
eq(svgs.filter((e) => e.props.width === '16' && e.props.height === '16').length, 5, 'the 16px icons are 16x16 like the rest of the app')
eq(svgs.filter((e) => e.props.viewBox === '0 0 16 16').length, 4, 'the 16-box icons use the 16-box viewBox (branch uses the 24-box lucide glyph)')
const iconPaths = flatten(panel).filter((e) => e.kind === 'element' && e.type === 'path')
ok(iconPaths.length >= 5, 'the icons are drawn with paths', String(iconPaths.length))
ok(
  iconPaths.every((e) => e.props.stroke === 'currentColor' || e.props.fill === 'currentColor'),
  'every icon path inherits the button colour (stroke or fill)',
)
ok(allText(panel).indexOf('⟳') < 0 && allText(panel).indexOf('✕') < 0, 'the old text glyphs are gone')

console.log('\n== searchable branch combo ==')
const filter = moduleExports.filterBranches
eq(filter(DATA.branches, '').length, 3, 'an empty query keeps every branch')
eq(filter(DATA.branches, 'FEATURE').length, 2, 'matching ignores case and is a substring match')
eq(filter(DATA.branches, '  remote  ').length, 1, 'the query is trimmed')
eq(filter(DATA.branches, 'zzz').length, 0, 'a query that matches nothing yields no options')
// 键盘光标必须跳过"已被检出"的行，否则回车停在灰行上什么都不做
eq(moduleExports.firstUsable(DATA.branches), 1, 'firstUsable skips the checked-out branch')
const ORDERED = [
  { name: 'a', kind: 'local', localName: 'a', inWorktree: null },
  { name: 'b', kind: 'local', localName: 'b', inWorktree: '/repo' },
  { name: 'c', kind: 'local', localName: 'c', inWorktree: null },
  { name: 'd', kind: 'local', localName: 'd', inWorktree: '/repo' },
]
eq(moduleExports.stepUsable(ORDERED, 0, 1), 2, 'ArrowDown jumps over the checked-out row')
eq(moduleExports.stepUsable(ORDERED, 2, -1), 0, 'ArrowUp jumps back the same way')
eq(moduleExports.stepUsable(ORDERED, 2, 1), 2, 'at the end it stops instead of landing on a grey row')
eq(moduleExports.stepUsable(ORDERED, 0, -1), 0, 'at the top it stops too')
eq(moduleExports.stepUsable([], 0, 1), 0, 'no branches: index stays 0')
eq(moduleExports.firstUsable([ORDERED[1]]), 0, 'only a checked-out branch: fall back to 0')
// 起点的可选性不同：已检出的分支照样能当起点
const acceptAll = () => true
eq(moduleExports.firstUsable(DATA.branches, acceptAll), 0, 'a base list can pick the checked-out first row')
eq(moduleExports.stepUsable(ORDERED, 0, 1, acceptAll), 1, 'a base list does not skip the checked-out row')

// 组件用的就是这个纯函数：把 query 预置成 "feature" 后，下拉里只剩那两个分支
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', '', '', false, '', 'HEAD', 'feature', true, 1])
const filtering = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const comboOptions = flatten(filtering).filter(
  (e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option',
)
eq(comboOptions.length, 2, 'typing filters the rendered options')
ok(allText(comboOptions[0].children).indexOf('feature/local-only') >= 0, 'the local feature branch is offered')
ok(allText(comboOptions[1].children).indexOf('origin/feature/remote-only') >= 0, 'a remote branch is offered with its origin/ name')
ok(allText(comboOptions[1].children).indexOf('远端') >= 0, 'a remote branch is tagged as remote')
eq(comboOptions[0].props['aria-selected'], false, 'aria-selected tracks the chosen branch')
ok(comboOptions[0].props.className.indexOf('wt-combo-item-active') < 0, 'no highlight on a non-active row')
ok(comboOptions[1].props.className.indexOf('wt-combo-item-active') >= 0, 'the active row is highlighted (keyboard cursor)')
eq(comboOptions.filter((e) => e.props.disabled === true).length, 0, 'both matches are usable')
// 已选中的分支在选项行右侧打勾（和工作区菜单一致）
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', 'feature/local-only', '', false, '', 'HEAD', '', true, 0])
const withChosen = flatten(
  expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS))),
).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option')
const checkedOptions = withChosen.filter(
  (e) => flatten(e.children).some((x) => x.kind === 'element' && String(x.props.className || '').indexOf('wt-combo-check') >= 0),
)
eq(checkedOptions.length, 1, 'exactly one option shows a check (the chosen branch)')
eq(checkedOptions[0].props['aria-selected'], true, 'the checked option is the chosen branch')
// 已被检出的分支照样列出来（说明为什么不能选），但标灰
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', '', '', false, '', 'HEAD', 'main', true, 0])
const withCheckedOut = flatten(expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))).filter(
  (e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option',
)
eq(withCheckedOut.length, 1, 'the checked-out branch still shows up so the user knows why it is unavailable')
eq(withCheckedOut[0].props.disabled, true, 'the branch already checked out is greyed out')
ok(allText(withCheckedOut[0].children).indexOf('已被检出') >= 0, 'and it says why')

console.log('\n== picking a branch ==')
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', '', '', false, '', 'HEAD', '', true, 0])
const picking = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const pickOptions = flatten(picking).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option')
const remoteOption = pickOptions.filter((e) => allText(e.children).indexOf('origin/feature/remote-only') >= 0)[0]
stateSets = []
let defaultPrevented = false
remoteOption.props.onMouseDown({ preventDefault: () => { defaultPrevented = true } })
ok(defaultPrevented, 'mousedown is default-prevented so the input keeps focus and blur cannot close the list early')
eq(stateSets.filter((set) => set.index === S_BRANCH)[0].value, 'origin/feature/remote-only', 'the picked branch becomes the selection')
eq(stateSets.filter((set) => set.index === S_LIST_OPEN)[0].value, false, 'the dropdown closes after picking')
eq(stateSets.filter((set) => set.index === S_NAME)[0].value, 'feature-remote-only', 'the directory name is derived from the picked branch')
// 用户手改过目录名之后就不再覆盖
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', '', 'my-dir', true, '', 'HEAD', '', true, 0])
const picking2 = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const option2 = flatten(picking2).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option')[1]
stateSets = []
option2.props.onMouseDown({ preventDefault: () => {} })
eq(stateSets.filter((set) => set.index === S_NAME).length, 0, 'a hand-edited directory name is never overwritten')
// 已检出的分支 refused 掉（handler 里也挡一层）
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'existing', '', '', false, '', 'HEAD', 'main', true, 0])
const picking3 = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const disabledOption = flatten(picking3).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option')[0]
stateSets = []
disabledOption.props.onMouseDown({ preventDefault: () => {} })
eq(stateSets.length, 0, 'a checked-out branch cannot be picked')

console.log('\n== creating a NEW branch ==')
// 起点清单 = HEAD + 全部分支，已检出的分支照样能当起点
const bases = moduleExports.baseItems(DATA.branches)
eq(bases.length, 4, 'HEAD is offered alongside every branch')
eq(bases[0].name, 'HEAD', 'HEAD is the first base')
eq(bases[0].inWorktree, null, 'HEAD is never marked as checked out')
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'new', 'feature/local-only', 'feature-thing', false, 'feature/thing', 'origin/feature/remote-only'])
const newPanel = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const newTabs = flatten(newPanel).filter((e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'tab')
eq(newTabs[0].props['aria-selected'], false, 'existing-branch mode is off in new mode')
eq(newTabs[1].props['aria-selected'], true, 'new-branch mode is selected')
const newControls = flatten(newPanel).filter((e) => e.kind === 'element' && e.type === 'input')
eq(newControls.length, 3, 'new-branch name + base combo + directory name (workspace is a single-select trigger)')
const newBranchBox = newControls.filter((e) => e.props['aria-label'] === '新分支')[0]
eq(newBranchBox.props.value, 'feature/thing', 'the new branch name is bound to its input')
eq(newBranchBox.props.placeholder, '例如 feature/my-change', 'the input shows an example name')
const baseBox = newControls.filter((e) => e.props['aria-label'] === '起点')[0]
eq(baseBox.props['aria-label'], '起点', 'the base control is labelled 起点')
eq(baseBox.props.value, 'origin/feature/remote-only', 'the chosen base is shown when the combo is closed')
eq(baseBox.props.placeholder, '搜索起点分支…', 'the base combo invites typing')
// 新分支模式不显示"没有可用分支"这类只对目标分支成立的提示
ok(allText(newPanel).indexOf('没有可用的分支') < 0, 'the no-usable-branch hint does not apply to a new branch')
// 起点下拉里已检出的行也可以选
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'new', '', '', false, 'feature/thing', 'HEAD', '', true, 0])
const baseOpen = flatten(expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))).filter(
  (e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option',
)
eq(baseOpen.length, 4, 'every base is offered')
eq(baseOpen.filter((e) => e.props.disabled === true).length, 0, 'no base is greyed out, including the checked-out ones')
ok(allText(baseOpen[0].children).indexOf('HEAD') >= 0, 'HEAD is the first option')
// 点一个起点：只改起点，不动目录名（目录名跟新分支名走）
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'new', '', 'feature-thing', false, 'feature/thing', 'HEAD', '', true, 0])
const basePicking = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const mainBase = flatten(basePicking).filter(
  (e) => e.kind === 'element' && e.type === 'button' && e.props.role === 'option' && allText(e.children).indexOf('main') >= 0,
)[0]
stateSets = []
mainBase.props.onMouseDown({ preventDefault: () => {} })
eq(stateSets.filter((set) => set.index === S_BASE)[0].value, 'main', 'the picked base becomes the start point')
eq(stateSets.filter((set) => set.index === S_NAME).length, 0, 'picking a base never touches the directory name')
// 新分支名为空时不能提交
stateIndex = 0
presets = preset(true, 'create', [DATA, false, null, 'new', '', '', false, '   ', 'HEAD'])
const blankNew = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
const blankCreate = buttons(blankNew).filter((b) => b.label === '创建并进入新会话')[0]
eq(blankCreate.disabled, true, 'a blank new branch name disables create')
ok(allText(blankNew).indexOf('这个仓库没有可用的分支') < 0, 'no branch-inventory hint in new-branch mode')

console.log('\n== empty, error and no-workspace states ==')
stateIndex = 0
presets = preset(true, 'create', [{ ...DATA, items: [], branches: [], warnings: [] }, false, null, 'existing', '', '', false])
const empty = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
ok(allText(empty).indexOf('这个仓库没有可用的分支') >= 0, 'empty branch state message')
ok(
  buttons(empty).filter((b) => b.label === '创建并进入新会话')[0].disabled === true,
  'create is disabled without a branch',
)
stateIndex = 0
presets = preset(true, 'list', [{ ...DATA, items: [], branches: [], warnings: [] }, false, null, 'existing', '', '', false])
const emptyList = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
ok(allText(emptyList).indexOf('这个仓库还没有 worktree') >= 0, 'empty list state message')
eq(divsWithClass(emptyList, 'wt-empty-box').length, 1, 'the empty list is a settings-style dashed box')
stateIndex = 0
presets = preset(true, 'create', [null, false, '本地已经有同名分支了（feature/fresh）', 'new', '', '', false, 'feature/fresh', 'HEAD'])
const failed = expand(registrations[0].component(standardProps(REPO_WORKSPACES, REPO_SESSIONS)))
ok(allText(failed).indexOf('本地已经有同名分支了（feature/fresh）') >= 0, 'the duplicate-branch refusal is rendered')
stateIndex = 0
presets = preset(true, 'create', [null, false, null, 'existing', '', '', false])
const noRepo = expand(registrations[0].component(standardProps({ items: [] }, { byId: {} })))
eq(divsWithClass(noRepo, 'wt-header-workspace').length, 0, 'no workspace picker when there is nothing to pick')
ok(allText(noRepo).indexOf('先在左侧添加或选择一个工作区') >= 0, 'no workspace guidance shown')

console.log('\n== clicking open calls uiWorkspace.openSession ==')
// 组件是函数式的，这里直接驱动它返回的那棵树里的 handler
const openButton = flatten(listPanel).filter(
  (e) => e.kind === 'element' && e.type === 'button' && allText(e.children) === '打开新会话',
)[0]
ok(!!openButton, 'found the open button')
const fetchCalls = []
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
sandbox.fetch = async (url, options) => {
  const body = JSON.parse(options.body)
  fetchCalls.push({ url, body })
  if (url.indexOf('/create') >= 0) {
    return { ok: true, json: async () => ({ ok: true, item: { name: body.name, path: '/p', branch: 'b' }, warnings: [] }) }
  }
  if (url.indexOf('/context') >= 0) {
    return { ok: true, json: async () => ({ ok: true, repoRoot: '/repo', worktreeRoot: '/repo/.worktrees', items: [], branches: [], warnings: [] }) }
  }
  return {
    ok: true,
    json: async () => ({ ok: true, sessionId: 's-new', title: 't', path: '/p', branch: 'b', warnings: [] }),
  }
}
const callOf = (route) => fetchCalls.filter((call) => call.url.indexOf('/api/dsh-worktree.' + route) >= 0)[0]

async function clickChecks() {
  // onClick 是 () => void onOpenExisting(...)：真正的异步工作要等微任务跑完
  openButton.props.onClick()
  await tick()
  eq(opened.length, 1, 'uiWorkspace.openSession was called once')
  eq(opened[0], 's-new', 'it opened the session the host returned')
  eq(fetchCalls[0].url, '/api/dsh-worktree.open', 'the open route was called')
  eq(fetchCalls[0].body.repoPath, '/repo', 'the selected workspace path was sent explicitly')
  eq(fetchCalls[0].body.name, 'alpha', 'the chosen worktree was sent')
  eq('task' in fetchCalls[0].body, false, 'the open call no longer carries a task')
  eq(fetchCalls[0].body.sessionId, 's1', 'the caller session is passed along as a fallback')

  // 已有分支模式：提交的是 branch
  const createButton = (tree) =>
    flatten(tree).filter((e) => e.kind === 'element' && e.type === 'button' && allText(e.children) === '只创建')[0]
  const existingCreate = createButton(panel)
  existingCreate.props.onClick()
  await tick()
  const existingBody = callOf('create').body
  eq(existingBody.branch, 'feature/local-only', 'existing mode submits the chosen branch')
  eq('newBranch' in existingBody, false, 'existing mode does not invent a branch')

  // 新分支模式：提交的是 newBranch + base
  fetchCalls.length = 0
  const newCreate = createButton(newPanel)
  newCreate.props.onClick()
  await tick()
  const newBody = callOf('create').body
  eq(newBody.newBranch, 'feature/thing', 'new mode submits the new branch name')
  eq(newBody.base, 'origin/feature/remote-only', 'new mode submits the chosen base')
  eq('branch' in newBody, false, 'new mode does not send a target branch')
  eq(newBody.name, 'feature-thing', 'the directory name is sent')
  eq(newBody.enter, false, '只创建 does not ask for a session')
  eq(newBody.repoPath, '/repo', 'the workspace path is sent')
  eq(newBody.sessionId, 's1', 'the caller session is passed along')

  // 宿主刚建出来的会话，客户端目录不一定已经收到 api-session/added：openSession 会先抛
  // `sessions.retain: unknown session <id>`，这时必须重试，而不是把「创建并进入」变成看运气
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const realOpen = uiWorkspace.openSession
  let attempts = 0
  uiWorkspace.openSession = (id) => {
    attempts++
    if (attempts === 1) throw new Error('sessions.retain: unknown session ' + id)
    opened.push(id)
  }
  opened.length = 0
  fetchCalls.length = 0
  openButton.props.onClick()
  await settle(220)
  eq(attempts, 2, 'the first failure is retried (the catalog event lands a beat later)')
  eq(opened[0], 's-new', 'the retry still opens the session the host returned')
  uiWorkspace.openSession = realOpen

  // 界面里没有 uiWorkspace（别的组合）：不崩、留在弹层里说清楚
  const realGet = ctx.get
  ctx.get = () => undefined
  stateSets = []
  fetchCalls.length = 0
  openButton.props.onClick()
  await tick()
  const messages = stateSets.filter((set) => set.index === S_MESSAGE)
  ok(
    messages.length > 0 && String(messages[messages.length - 1].value).indexOf('uiWorkspace') >= 0,
    'a missing uiWorkspace is reported, not swallowed',
  )
  ok(
    stateSets.filter((set) => set.index === S_OPEN).length === 0,
    'the panel stays open when it could not switch',
  )
  ctx.get = realGet
}

clickChecks().then(() => {
  console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'))
  process.exit(failures === 0 ? 0 : 1)
})
