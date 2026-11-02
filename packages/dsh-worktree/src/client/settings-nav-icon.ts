// 把设置导航里 worktree 那一行的通用齿轮换成插件自己的图标（icons.tsx 的 IconWorktree）。
//
// 为什么只能这么做：设置 shell（dsh-client-ui-settings-general 的 SettingsRoot）从
// `settings.section` 的注册项里只投影三个字段 ——
//     rows = ctx.slots.entries("settings.section").map((e) => ({ id, order, label }))
// 图标是 shell 自己按 section id 从一个闭集里挑的（account / models / agent-presets /
// plugins / archived-sessions），其余一律回落到 IconSettingsOutlineMedium（齿轮）。
// 本版 DSH 的 settings.section 契约没有 icon 字段，所以插件无法在注册项里声明图标；
// 同一个 DSH 版本里 dsh-better-sidebar 用的也是这套「挂载后认领自己那一行 + CSS 换图」的办法。
//
// 认领方式按可见文案精确匹配，并且只在**唯一命中**时打标记：万一别的插件用了同一个标题，
// 宁可自己退回齿轮，也不去改别人的行。标记本身不占结构，disposer 里会摘干净（HMR 安全）。
const SETTINGS_NAV_MARKER = 'data-dsh-worktree-settings-nav'

/** 标记属性名，测试与 styles.css 共用 */
export const SETTINGS_NAV_ATTRIBUTE = SETTINGS_NAV_MARKER

/**
 * 持续把标记保持在「文案等于本插件当前设置页标题」的那一个导航按钮上。
 *
 * @param label 与 settings.section 注册项同一个文案解析器（locale 变了这里也跟得上）
 * @returns 停止观察并摘掉自己打过的标记
 */
export function registerSettingsNavIcon(label: () => string): () => void {
  // 非浏览器环境（单测、SSR）直接空转：这里碰的全是 document / MutationObserver。
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return function () {}

  let disposed = false
  const marked = () => Array.from(document.querySelectorAll('[' + SETTINGS_NAV_MARKER + ']'))

  const sync = (): void => {
    if (disposed) return
    const wanted = label().trim()
    const candidates =
      wanted.length === 0
        ? []
        : Array.from(document.querySelectorAll('[role="dialog"] nav button')).filter(
            (button) => (button.textContent ?? '').trim() === wanted,
          )
    const owner = candidates.length === 1 ? candidates[0] : undefined
    for (const button of marked()) {
      if (button !== owner) button.removeAttribute(SETTINGS_NAV_MARKER)
    }
    if (owner !== undefined && !owner.hasAttribute(SETTINGS_NAV_MARKER)) {
      owner.setAttribute(SETTINGS_NAV_MARKER, '')
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return function () {
    disposed = true
    observer.disconnect()
    for (const button of marked()) button.removeAttribute(SETTINGS_NAV_MARKER)
  }
}
