// 平台种子模块 @deepseek-ai/dsh-client-ui-primitives 的测试替身。
//
// 这个包不在 npm 上（它是 shell 运行时静态模块表里的一项），所以：
//  - dist/client.js 的 bundle 测试用 `SEEDS` 把它喂进 factory；
//  - test/.build 的 CJS 产物用 tsdown.test.config.ts 的 alias 指到这里。
// 两处共用这一份，替身只做"能被构造"，保证 tsc 与打包产出的 require 路径都是真的。
//
// 故意保留 data-tone：将来要断言"卡片用的是 primitives 的 Tag"时，从元素属性上看得见。
const React = require('react')

const passthrough = (tag) => (props) => {
  const { children, className, variant, size, tone, icon, ...rest } = props || {}
  return React.createElement(
    tag,
    {
      ...rest,
      ...(className === undefined ? {} : { className }),
      ...(variant === undefined ? {} : { 'data-variant': variant }),
      ...(size === undefined ? {} : { 'data-size': size }),
      ...(tone === undefined ? {} : { 'data-tone': tone }),
    },
    icon === undefined ? children : [icon, children],
  )
}

const icon = (name) => (props) => {
  const { size, className } = props || {}
  return React.createElement(name, {
    ...(className === undefined ? {} : { className }),
    ...(size === undefined ? {} : { width: size, height: size }),
  })
}

module.exports = {
  Button: passthrough('button'),
  Tag: passthrough('span'),
  IconCheckCircleOutlineRegular: icon('IconCheckCircleOutlineRegular'),
  IconShieldOutlineRegular: icon('IconShieldOutlineRegular'),
  IconQuestionOutlineRegular: icon('IconQuestionOutlineRegular'),
  IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
}
