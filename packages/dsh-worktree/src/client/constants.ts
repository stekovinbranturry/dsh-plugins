/** 客户端常量：slot 标识、标题节点 id、弹窗分区定义。 */
export const SLOT = 'sidebar.footer.action'
export const SLOT_ID = 'dsh-worktree:sidebar-entry'
/** 弹窗标题节点 id：aria-labelledby 用它。写死而不是 useId()，省一个 hook */
export const TITLE_ID = 'dsh-worktree:title'

/** 弹窗的两个分区，顺序即导航栏顺序 */
export const SECTIONS = [
  { id: 'create', label: '新建 Worktree' },
  { id: 'list', label: '已有 Worktree' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']
