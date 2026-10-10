import { PREVIEW_LIMIT } from './constants.js'

/**
 * 把消息 content / 任意嵌套值压成一行纯文本预览。
 *
 * 传进来的是 Cordis 活对象里的一小块（日志事件 payload），形状由会话包定义且可能带
 * 未知分支，所以这里只做"浅层递归 + 只认文本"，认不出来的返回空串而不是抛。
 */
export function plainText(value: unknown, limit: number = PREVIEW_LIMIT): string {
  const out = collect(value, 0)
  const flat = out.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat
}

function collect(value: unknown, depth: number): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) {
    let out = ''
    for (const item of value) {
      const piece = collect(item, depth + 1)
      if (piece !== '') out = out === '' ? piece : out + ' ' + piece
    }
    return out
  }
  if (typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const type = typeof record.type === 'string' ? record.type : ''
  // 文本块是唯一稳定认得出来的形状；其他块（图片、工具结果…）不猜
  if (typeof record.text === 'string' && (type === '' || type === 'text')) return record.text
  if (Array.isArray(record.content)) return collect(record.content, depth + 1)
  if (typeof record.content === 'string') return record.content
  if (typeof record.message === 'string') return record.message
  return ''
}
