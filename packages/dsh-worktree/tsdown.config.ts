// tsdown 只负责客户端那一半：宿主半由 tsc 逐文件产出（保持 ESM 目录结构，Cordis 直接
// import）。客户端 bundle 的形状是 DSH 模块系统规定的——宿主按普通 script 加载它，
// 执行时只注册工厂，require 只解析平台种子模块——所以用 CJS 格式让 rolldown 把外部
// 依赖发成 require("react")，再用 banner/footer 补齐 __ModuleLoader__ 信封。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'

const ENTRY_ID = '@zhanghanxuan/dsh-worktree'
const CSS_VIRTUAL_PREFIX = '\0dsh-worktree-css:'
// 虚拟 id 必须以非 css 扩展名结尾：tsdown 的 css-guard filter 只看结尾
const CSS_VIRTUAL_SUFFIX = '.js'

// 样式要的是"字符串默认导出"，而 css-guard 会把任何 .css 模块直接判死（它只认
// @tsdown/css 那套样式资产管线）。所以在 resolve 阶段就把 .css 改写成虚拟 JS 模块
function cssAsString(): Plugin {
  return {
    name: 'dsh-worktree:css-as-string',
    resolveId(source, importer) {
      if (!source.endsWith('.css') || !importer) return null
      return CSS_VIRTUAL_PREFIX + path.resolve(path.dirname(importer), source) + CSS_VIRTUAL_SUFFIX
    },
    load(id) {
      if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const file = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      return 'export default ' + JSON.stringify(readFileSync(file, 'utf8'))
    },
  }
}

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  // react 与平台 UI 组件库都由浏览器运行时的平台模块表提供：primitives 自己也 require
  // react，打进来会得到第二份。
  deps: { neverBundle: [/^react(\/|$)/, /^@deepseek-ai\/dsh-client-ui-primitives$/] },
  sourcemap: true,
  // tsc 已经把 dist/host 写好了，这里不能清 dist
  clean: false,
  hash: false,
  dts: false,
  // 包是 "type": "module"，不强制的话 CJS 会输出成 .cjs，而 exports["./client"] 要 .js
  outExtensions: () => ({ js: '.js' }),
  plugins: [cssAsString()],
  banner: [
    'window.__ModuleLoader__.load({',
    '  id: ' + JSON.stringify(ENTRY_ID) + ',',
    '  factory: (require) => {',
    '    var module = { exports: {} }',
    '    var exports = module.exports',
    "    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })",
  ].join('\n'),
  footer: ['', '    return module.exports', '  },', '})', ''].join('\n'),
})
