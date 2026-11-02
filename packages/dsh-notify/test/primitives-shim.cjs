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

// 开关：照真实实现的结构 —— <button type="button" role="switch" aria-checked aria-label>，
// label 只当 aria-label（不渲染文字），onChange 收到的是下一个值。
const Switch = (props) => {
  const { checked, onChange, label, disabled, title, className } = props || {}
  return React.createElement(
    'button',
    {
      type: 'button',
      role: 'switch',
      'aria-checked': checked,
      'aria-label': label,
      ...(title === undefined ? {} : { title }),
      ...(disabled === undefined ? {} : { disabled }),
      ...(className === undefined ? {} : { className }),
      onClick: () => onChange(!checked),
    },
    React.createElement('span', null),
  )
}

// 输入框：照真实实现的结构 —— 外面一层 span（className 落在 span 上），里面是原生 input，
// 其余 props 全部透传。测试靠"展开后是 input"断言用的是 primitives 的 Input。
const Input = (props) => {
  const { icon: leading, className, ...rest } = props || {}
  return React.createElement(
    'span',
    { ...(className === undefined ? {} : { className }) },
    leading === undefined ? null : React.createElement('span', null, leading),
    React.createElement('input', rest),
  )
}

module.exports = {
  Button: passthrough('button'),
  Tag: passthrough('span'),
  Switch,
  Input,
  IconCheckCircleOutlineRegular: icon('IconCheckCircleOutlineRegular'),
  IconShieldOutlineRegular: icon('IconShieldOutlineRegular'),
  IconQuestionOutlineRegular: icon('IconQuestionOutlineRegular'),
  IconCloseOutlineRegular: icon('IconCloseOutlineRegular'),
}
