#!/usr/bin/env node
// 对着构建产物跑验证：宿主模块语法 + 客户端 bundle 形状 + 两个行为 harness。
// 业务断言写在 harness 里，verify 只负责串起来和汇总。
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = path.join(ROOT, 'dist')
const BUNDLE = path.join(DIST, 'client.js')
const ENTRY_ID = '@stekovinbranturry/dsh-notify'
const SUITES = [
  ['host logic', path.join(ROOT, 'test', 'host.test.mjs')],
  ['client logic', path.join(ROOT, 'test', 'client.test.mjs')],
  ['http end-to-end', path.join(ROOT, 'test', 'http.test.mjs')],
  ['install order', path.join(ROOT, 'test', 'install-order.test.mjs')],
]

let failed = 0

function check(cond, label, detail) {
  if (cond) console.log('  ok   ' + label)
  else {
    failed++
    console.error('  FAIL ' + label + (detail === undefined ? '' : '  -> ' + detail))
  }
}

function run(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: 'inherit' })
    child.on('close', (code) => resolve(code))
  })
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

function parses(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'ignore' })
    child.on('close', (code) => resolve(code === 0))
  })
}

async function hostChecks() {
  const dir = path.join(DIST, 'host')
  for (const name of ['native.js', 'native.d.ts', 'native.js.map']) {
    check(!(await exists(path.join(dir, name))), 'removed native artifact is absent: ' + name)
  }
  const modules = (await readdir(dir)).filter((name) => name.endsWith('.js'))
  check(modules.length >= 9, 'host half is emitted per module', modules.length + ' module(s)')

  let parsed = 0
  for (const name of modules) if (await parses(path.join(dir, name))) parsed++
  check(parsed === modules.length, 'every host module parses as ESM', parsed + '/' + modules.length)

  for (const name of ['index.js', 'index.d.ts', 'index.js.map']) {
    check(await exists(path.join(dir, name)), 'dist/host/' + name + ' exists')
  }

  // 宿主与浏览器半共用的模块走 dist/shared，两侧必须都能按 ESM 解析
  const sharedDir = path.join(DIST, 'shared')
  const shared = (await readdir(sharedDir)).filter((name) => name.endsWith('.js'))
  check(shared.length >= 1, 'the shared half is emitted', shared.length + ' module(s)')
  let sharedParsed = 0
  for (const name of shared) if (await parses(path.join(sharedDir, name))) sharedParsed++
  check(sharedParsed === shared.length, 'every shared module parses as ESM', sharedParsed + '/' + shared.length)

  // 挂载点和 bundle id 必须与包名一致，否则宿主找不到客户端半
  const patch = await readFile(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  check(patch.includes("name: '" + ENTRY_ID + "'"), 'cordis.patch.yml mounts ' + ENTRY_ID)
}

async function bundleChecks() {
  const bundle = await readFile(BUNDLE, 'utf8')
  const required = [...bundle.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])

  check(bundle.startsWith('window.__ModuleLoader__.load({'), 'envelope opens the module loader')
  check(bundle.includes('id: "' + ENTRY_ID + '"'), 'bundle declares the plugin id')
  check(bundle.includes('factory: (require) => {'), 'factory receives require')
  check(bundle.includes('return module.exports'), 'factory returns its exports')
  // 末尾还有一行 sourceMappingURL 注释，先摘掉再看信封是否闭合
  const withoutMapComment = bundle.replace(/\/\/# sourceMappingURL=\S+\s*$/, '')
  check(withoutMapComment.trimEnd().endsWith('})'), 'envelope is closed')
  // 只有平台种子可以从 require 里出来，其余依赖必须打进 bundle。
  // react/jsx-dev-runtime 故意不在名单里：那是 dev JSX 运行时，平台不提供
  const SEEDS = [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    // primitives 是 shell 静态模块表里的一项（npm 上没有这个包），与 react 同一条
    // require 通道 —— 卡片用的 Button / Tag / Icon* 都从这里来，不能被 bundle 进去
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  check(
    required.length > 0 && required.every((id) => SEEDS.indexOf(id) >= 0),
    'only platform seed modules are required',
    required.join(', '),
  )
  check(required.indexOf('react/jsx-runtime') >= 0, 'JSX compiles to the automatic runtime')
  check(!/^[ \t]*(import|export)[ \t]/m.test(bundle), 'no ESM syntax in the classic-script bundle')
  check(bundle.includes('.nt-card'), 'styles.css was inlined')
  check(!bundle.includes('__STYLES__'), 'no stylesheet placeholder left')
  check(bundle.includes('//# sourceMappingURL=client.js.map'), 'bundle points at its source map')

  const mapFile = BUNDLE + '.map'
  if (await exists(mapFile)) {
    const map = JSON.parse(await readFile(mapFile, 'utf8'))
    const sources = Array.isArray(map.sources) ? map.sources : []
    check(sources.some((source) => source.includes('src/client/index.tsx')), 'source map points back at src/')
  } else {
    check(false, 'dist/client.js.map exists')
  }
}

console.log('\n== host artifacts ==')
await hostChecks()

console.log('\n== client bundle ==')
await bundleChecks()

// 客户端测试直接吃 tsdown.test.config.ts 的产物；主构建不产出它，所以这里按需补一次
const logicBundle = path.join(ROOT, 'test', '.build', 'client-logic.cjs')
if (!(await exists(logicBundle))) {
  console.log('\n== building the client test harness ==')
  const code = await new Promise((resolve) => {
    const child = spawn('npx', ['tsdown', '--config', 'tsdown.test.config.ts'], {
      cwd: ROOT,
      stdio: 'inherit',
    })
    child.on('close', resolve)
  })
  if (code !== 0) failed++
}

for (const [label, file] of SUITES) {
  console.log('\n== ' + label + ' ==')
  if ((await run(file)) !== 0) failed++
}

console.log('\n' + (failed === 0 ? 'verify: ALL PASS' : 'verify: ' + failed + ' check(s) failed'))
process.exit(failed === 0 ? 0 : 1)
