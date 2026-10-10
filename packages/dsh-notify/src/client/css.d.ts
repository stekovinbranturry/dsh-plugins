/** 样式在构建时被 tsdown 插件改写成"字符串默认导出"，类型侧补一份同名声明 */
declare module '*.css' {
  const css: string
  export default css
}
