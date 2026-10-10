// 只给测试用：把 src/client 的纯逻辑与胶水层编成一份 CJS，供 test/client.test.mjs 直接
// require。主构建（tsdown.config.ts）不碰它，dist 里也不会留这份产物。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsdown'
import type { Plugin } from 'rolldown'

const CSS_VIRTUAL_PREFIX = '\0dsh-notify-test-css:'
const CSS_VIRTUAL_SUFFIX = '.js'
// 平台种子模块在 npm 上不存在，测试构建把它 alias 到替身（见 test/primitives-shim.cjs）
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'
const PRIMITIVES_SHIM = path.resolve('test/primitives-shim.cjs')

function cssAsString(): Plugin {
  return {
    name: 'dsh-notify-test:css-as-string',
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
  entry: { 'client-logic': 'test/client-entry.ts' },
  outDir: 'test/.build',
  format: 'cjs',
  platform: 'node',
  deps: { neverBundle: [/^react(\/|$)/, /^react-dom(\/|$)/] },
  alias: { [PRIMITIVES]: PRIMITIVES_SHIM },
  sourcemap: false,
  clean: true,
  hash: false,
  dts: false,
  outExtensions: () => ({ js: '.cjs' }),
  plugins: [cssAsString()],
})
