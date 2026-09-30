import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const archive = process.argv[2]
assert.ok(archive, 'Usage: npm run test:package -- <package.tgz>')
const directory = mkdtempSync(join(tmpdir(), 'codex-usage-package-'))
try {
  execFileSync('npm', ['install', '--prefix', directory, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', resolve(archive)], { stdio: 'inherit' })
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const installed = join(directory, 'node_modules', manifest.name)
  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(pkg.version, manifest.version)
  assert.equal(pkg.exports['.'], './index.ts')
  // The TUI entrypoint must be precompiled JavaScript: OpenCode's loader only applies
  // the OpenTUI Solid transform outside node_modules, so shipping tui.tsx regresses to
  // React-style JSX (`Cannot find package 'react'`).
  assert.equal(pkg.exports['./tui'], './tui.js')
  for (const file of ['index.ts', 'tui.js', 'core.ts', 'rpc.ts']) {
    assert.ok(readFileSync(join(installed, file)).length, `Missing source: ${file}`)
  }
  const tui = readFileSync(join(installed, 'tui.js'), 'utf8')
  assert.ok(tui.includes('@opentui/solid'), 'Packaged tui.js does not import the Solid runtime')
  assert.ok(!/(^|[^\w$])React\b/.test(tui) && !/from\s+["']react["']/.test(tui), 'Packaged tui.js still references React')
  assert.ok(!pkg.files.includes('tui.tsx'), 'Raw tui.tsx must not be published')
  // Node refuses native TS stripping inside node_modules. Transpile only this
  // installed package for the runtime smoke tests; OpenCode owns its runtime loader.
  // Resolve symlinks (e.g. /var -> /private/var on macOS) so the hook matches the
  // URLs Node's loader actually uses.
  const prefix = pathToFileURL(realpathSync(installed) + '/').href
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith(prefix) || !url.endsWith('.ts')) return nextLoad(url, context)
      const { outputText } = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 },
      })
      return { format: 'module', source: outputText, shortCircuit: true }
    },
  })
  try {
    const { default: server } = await import(pathToFileURL(join(installed, pkg.exports['.'])).href)
    assert.equal(server.id, 'codex-usage.server')
    assert.equal(typeof server.setup, 'function')
    // Load the packaged TUI entrypoint the way OpenCode does. A ReactJSX regression
    // fails here with a resolution error before any assertion runs.
    const { default: tuiPlugin } = await import(pathToFileURL(join(installed, pkg.exports['./tui'])).href)
    assert.equal(tuiPlugin.id, 'codex-usage.tui')
    assert.equal(typeof tuiPlugin.setup, 'function')
  } finally {
    hooks.deregister()
  }
  console.log('Installed package server and TUI entrypoints import passed.')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
