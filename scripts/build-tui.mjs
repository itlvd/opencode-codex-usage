// Precompiles the TUI entrypoint.
//
// OpenCode's TUI loader only applies the OpenTUI Solid transform to files outside
// `node_modules`, so a published plugin must ship plain JavaScript. Otherwise the
// loader falls back to React-style JSX and the entrypoint fails with
// `Cannot find package 'react'`.
//
// This mirrors `transformSolidSource` from `@opentui/solid`: `babel-preset-solid`
// emits Solid's universal runtime imports from `@opentui/solid`, and
// `@babel/preset-typescript` strips type syntax. Presets run last-to-first, so the
// Solid preset is listed first and the TypeScript preset runs before it.
import { readFile, writeFile } from 'node:fs/promises'
import { transformAsync } from '@babel/core'
import ts from '@babel/preset-typescript'
import solid from 'babel-preset-solid'

const source = new URL('../tui.tsx', import.meta.url)
const target = new URL('../tui.js', import.meta.url)

const transformed = await transformAsync(await readFile(source, 'utf8'), {
  filename: 'tui.tsx',
  configFile: false,
  babelrc: false,
  presets: [
    [solid, { moduleName: '@opentui/solid', generate: 'universal' }],
    [ts],
  ],
})

const code = transformed?.code
if (!code) throw new Error('Solid transform produced no output for tui.tsx')
if (!code.includes('"@opentui/solid"') && !code.includes("'@opentui/solid'")) {
  throw new Error('Solid transform did not emit the @opentui/solid runtime')
}
if (/(^|[^\w$])React\b/.test(code) || /from\s+["']react["']/.test(code)) {
  throw new Error('Refusing to publish tui.js: the transform emitted React, not Solid')
}

await writeFile(target, code)
console.log('built tui.js from tui.tsx')
