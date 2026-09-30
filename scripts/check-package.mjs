import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  assert.equal(pkg.exports['./tui'], './tui.tsx')
  for (const file of ['index.ts', 'tui.tsx', 'core.ts', 'rpc.ts']) {
    assert.ok(readFileSync(join(installed, file)).length, `Missing source: ${file}`)
  }
  // Node refuses native TS stripping inside node_modules. Transpile only this
  // installed package for the server smoke test; OpenCode owns its runtime loader.
  const prefix = pathToFileURL(installed + '/').href
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
    const { default: plugin } = await import(pathToFileURL(join(installed, pkg.exports['.'])).href)
    assert.equal(plugin.id, 'codex-usage.server')
    assert.equal(typeof plugin.setup, 'function')
  } finally {
    hooks.deregister()
  }
  console.log('Installed package server import passed; TUI runtime must be tested in OpenCode.')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
