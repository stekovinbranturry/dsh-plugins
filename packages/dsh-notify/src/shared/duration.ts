// 耗时的展示格式。宿主半（webhook 正文）与浏览器半（提示条正文）都要用，
// 放在 shared 里只留一份实现。
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return hours + 'h' + minutes + 'm'
  if (minutes > 0) return minutes + 'm' + seconds + 's'
  return seconds + 's'
}
