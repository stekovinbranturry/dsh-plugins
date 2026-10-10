// 三个 suite 共用的小工具：断言、计数收尾、以及 session/event 信封与两种消息载荷的构造。
// 这些以前在每个 suite 里各抄一份，改一处要改三遍。
export let failed = 0
export let passed = 0

export function check(cond, label, detail) {
  if (cond) {
    passed++
    console.log('  ok   ' + label)
  } else {
    failed++
    console.error('  FAIL ' + label + (detail === undefined ? '' : '  -> ' + detail))
  }
}

export function eq(actual, expected, label) {
  check(actual === expected, label, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected))
}

/** 收尾：打印计数并按结果退出 */
export function report(name) {
  console.log(
    '\n' + (failed === 0 ? name + ': ALL PASS (' + passed + ')' : name + ': ' + failed + ' failed, ' + passed + ' passed'),
  )
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * `session/event` 的真信封是 `{ type, seq, time, data }` —— 载荷在 `data` 里，不在事件顶层。
 * 测试必须照真形状发，否则"轮次永远是 0""预览永远空"这类错误在单测里根本暴露不出来。
 */
export const sessionEvent = (type, data = {}) => ({ type, seq: 1, time: Date.now(), data })

/** user/message 的 data 就是 UserMessage 本身（没有 message 包装层） */
export const userMessage = (text) => ({ role: 'user', content: [{ type: 'text', text }] })

/** assistant/message 的 data 是 { turn, step, message } */
export const assistantMessage = (text, turn = 1) => ({
  turn,
  step: 1,
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})
