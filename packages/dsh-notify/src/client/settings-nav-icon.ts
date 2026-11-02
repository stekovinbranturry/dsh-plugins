// settings.section 只公开 id/order/label，不能传图标（与 worktree 的设置导航相同）。
// 两插件可独立安装，故在各自包内保留这段最小适配；只认领唯一的本插件导航项。
export const SETTINGS_NAV_ATTRIBUTE = 'data-dsh-notify-settings-nav'

export function registerSettingsNavIcon(label: () => string): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}

  let disposed = false
  const marked = () => Array.from(document.querySelectorAll('[' + SETTINGS_NAV_ATTRIBUTE + ']'))
  const sync = (): void => {
    if (disposed) return
    const wanted = label().trim()
    const candidates = wanted === '' ? [] : Array.from(
      document.querySelectorAll('[role="dialog"] nav button'),
    ).filter((button) => (button.textContent ?? '').trim() === wanted)
    const owner = candidates.length === 1 ? candidates[0] : undefined
    for (const button of marked()) {
      if (button !== owner) button.removeAttribute(SETTINGS_NAV_ATTRIBUTE)
    }
    if (owner !== undefined && !owner.hasAttribute(SETTINGS_NAV_ATTRIBUTE)) {
      owner.setAttribute(SETTINGS_NAV_ATTRIBUTE, '')
    }
  }

  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => {
    disposed = true
    observer.disconnect()
    for (const button of marked()) button.removeAttribute(SETTINGS_NAV_ATTRIBUTE)
  }
}
