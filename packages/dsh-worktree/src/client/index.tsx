// 浏览器半：侧边栏底部一个 worktree 入口 + 一个设置弹窗形态的居中弹窗。
//
// 入口挂在官方 slot sidebar.footer.action（root 级）而不是会话头，因为需求是
// "开新对话、还没有任何 session 时也要能用"——会话头的 slot 在无 session 时根本
// 不渲染（官方代码是 sessionId === void 0 ? null : renderSlot(...)）。
//
// 弹窗整体照抄 DSH 的设置弹窗（ui-settings-general 的 SettingsRoot）：遮罩 + 居中面板，
// 左侧 188px 导航栏（标题 + 分区列表），右侧 header（动作 + 关闭）+ 可滚动的 options。
// 分区两块：新建 worktree、已有 worktree。组件样式同样对齐设置弹窗里的实现
// （ui-settings-models 的输入框 / 按钮 / 行卡片 / 空态）。
//
// 插件只做两件事：
//   1. 列出仓库里已有的 worktree，挑一个开成新会话
//   2. 建一个新 worktree —— 检出已有分支（本地 + origin/*），或从某个起点新建一个分支
//      （可顺手开成新会话）
// 仓库来源沿用"当前选中的工作区"：当前会话所属的 workspace，没有会话时按 DSH
// 自己的 recentWorkspace 规则（最近有会话活动的那个）回退。
//
// tsdown（rolldown + oxc）用 automatic runtime 编 JSX，产物 require("react") 与
// require("react/jsx-runtime") —— 都是平台种子模块。整份 bundle 套在
// window.__ModuleLoader__.load({ id, factory }) 信封里，平台按普通 script 加载。
import STYLES from './styles.css'
import type { ClientContext, SlotStandardProps } from './types.js'
import { SLOT, SLOT_ID } from './constants.js'
import { WorktreePanel } from './WorktreePanel.js'

// 行为单测直接吃这些纯函数，所以从入口再导出一次。
export {
  baseItems,
  deriveName,
  filterBranches,
  firstUsable,
  isPickable,
  isWorktreePath,
  pickWorkspace,
  stepUsable,
} from './branches.js'

function insertStyles(css: string): () => void {
  if (typeof document === 'undefined') return function () {}
  const node = document.createElement('style')
  node.setAttribute('data-dsh-worktree', '')
  node.textContent = css
  document.head.appendChild(node)
  return function () {
    if (node.parentNode) node.parentNode.removeChild(node)
  }
}

// uiWorkspace 刻意不进门控：它是「切到刚建好的会话」用的，拿不到时插件照装不误，
// 只在真的要点开对话时给一句提示（见 WorktreePanel 的 openSession）
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => insertStyles(STYLES), 'dsh-worktree: styles')
  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      { name: SLOT, id: SLOT_ID, order: 30, registrant: 'dsh-worktree' },
      (props: SlotStandardProps) => <WorktreePanel {...props} ctx={ctx} />,
    ),
  )
}
