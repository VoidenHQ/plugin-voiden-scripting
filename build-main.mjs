#!/usr/bin/env node
import { build } from 'esbuild'
import { readFileSync } from 'fs'
import { existsSync } from 'fs'

const manifest = JSON.parse(readFileSync('./manifest.json', 'utf8'))
const pluginId = manifest.id
const entry = './src/main-process.ts'

if (!existsSync(entry)) {
  console.log('No main-process.ts found — skipping main build')
  process.exit(0)
}

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: `dist/${pluginId}-main.js`,
  external: [
    'electron',
    'node:*',
    'child_process', 'fs', 'path', 'os', 'http', 'https', 'net', 'crypto',
    'worker_threads', 'stream', 'events', 'util', 'url', 'buffer',
    '@voiden/sdk',
    'selfsigned',
  ],
  minify: true,
})

console.log(`Built dist/${pluginId}-main.js`)
