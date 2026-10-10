// tsdown 把 .css 当字符串默认导出；类型侧在这里补上
declare module '*.css' {
  const css: string
  export default css
}
