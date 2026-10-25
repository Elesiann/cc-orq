#!/usr/bin/env node
// Bundles the MCP SDK that the stdio server runs on into server/vendor/mcp-sdk.mjs, so a user of the plugin
// needs no `npm install`. The bundle is committed and deterministic: it holds no timestamp and no absolute path.
//
//   node scripts/build-vendor.mjs           write the bundle (npm run build:vendor)
//   node scripts/build-vendor.mjs --check   build in memory; exit 1 when the committed bundle differs from it,
//                                           or when NOTICE misses a package the bundle contains
//
// The SDK's own build inlines packages of its own (ajv, fast-uri, ...), and they never appear in esbuild's
// metafile, which sees only the SDK's dist files. The bundled-package list therefore also reads the source
// maps that the dist files ship, through esbuild's merged output map, and the `//#region` markers in the dist.
import { build } from 'esbuild'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = 'server/vendor/mcp-sdk.mjs'
const NOTICE = 'NOTICE'

// What server/*.ts imports from the SDK. `z` carries only the zod functions the server calls: re-exporting the
// whole namespace would keep all of zod in the bundle, which is more than half a megabyte.
const ENTRY = [
  "export { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'",
  "export { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'",
  "import { object, string } from 'zod/v4'",
  'export const z = { object, string }',
  '',
].join('\n')

// Packages the SDK inlines into its dist files are not installed, so their licenses are named here. A package
// that is not in this table stops the build: read its license, add it here, and put its text in NOTICE.
const INLINED_LICENSES = {
  'ajv@8.18.0': 'MIT',
  'ajv-formats@3.0.1': 'MIT',
  'content-type@1.0.5': 'MIT',
  'fast-deep-equal@3.1.3': 'MIT',
  'fast-uri@3.1.8': 'BSD-3-Clause',
  'json-schema-traverse@1.0.0': 'MIT',
}

// Workspace packages of the SDK repository that its dist inlines; they ship under the SDK's own license.
const PART_OF_SDK = new Set(['@modelcontextprotocol/core-internal'])
const SDK = '@modelcontextprotocol/server'

// One phrase of each license text, to prove that NOTICE carries the text and not only the name.
const LICENSE_MARKERS = {
  'Apache-2.0': 'Apache License\n                           Version 2.0, January 2004',
  MIT: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'BSD-3-Clause': 'Redistributions in binary form must reproduce the above copyright',
}

const squash = (text) => text.replace(/\s+/g, ' ').trim()

function readPackage(name) {
  const file = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(file)) return null
  return { dir: dirname(file), json: JSON.parse(readFileSync(file, 'utf8')) }
}

/** The `{ name, version, license }` of one place a bundled byte can come from, or null when it is none of ours. */
function describeSource(path) {
  const tail = path.split('node_modules/').at(-1)
  if (tail === path) return null
  const name = /^(@[^/]+\/[^/]+|[^/]+)\//.exec(tail)?.[1]
  if (name === undefined) return null
  const pnpm = /\.pnpm\/([^/]+)\//.exec(path)?.[1]
  if (pnpm !== undefined) {
    const version = /^@?[^@]+@(\d[^_]*)/.exec(pnpm)?.[1]
    return version === undefined ? { name, version: '?', license: null } : { name, version, license: INLINED_LICENSES[`${name}@${version}`] ?? null }
  }
  if (PART_OF_SDK.has(name)) return describeSource(`node_modules/${SDK}/`)
  const installed = readPackage(name)
  if (installed === null) return { name, version: '?', license: null }
  return { name, version: installed.json.version, license: typeof installed.json.license === 'string' ? installed.json.license : null }
}

function bundledPackages(sources, regionText) {
  const found = new Map()
  const add = (described) => {
    if (described !== null) found.set(`${described.name}@${described.version}`, described)
  }
  for (const source of sources) add(describeSource(source))
  for (const match of regionText.matchAll(/^\/\/#region .*?node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//gm)) {
    add(describeSource(`node_modules/.pnpm/${match[1]}/node_modules/${match[2]}/x`))
  }
  const unknown = [...found.values()].filter((p) => p.license === null || p.version === '?')
  if (unknown.length > 0) {
    const names = unknown.map((p) => `${p.name}@${p.version}`).join(', ')
    throw new Error(`cannot name the license of ${names}: add it to INLINED_LICENSES in scripts/build-vendor.mjs and its text to NOTICE`)
  }
  return [...found.values()].sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1))
}

/** A dist file that points at a source map that is not there hides what the SDK inlined, so the build stops. */
function assertMapsAreReadable(inputs) {
  for (const input of inputs) {
    if (!input.includes('node_modules/') || !/\.(?:m?js)$/.test(input)) continue
    const text = readFileSync(join(ROOT, input), 'utf8')
    const map = /^\/\/# sourceMappingURL=(\S+)\s*$/m.exec(text)?.[1]
    if (map !== undefined && !map.startsWith('data:') && !existsSync(join(ROOT, dirname(input), map))) {
      throw new Error(`${input} names the source map ${map}, which is missing, so the packages it inlines cannot be listed`)
    }
  }
}

async function bundle() {
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'vendor-entry.mjs' },
    bundle: true,
    // A node_modules that is a symlink, as in a copy of the tree, must not change the paths esbuild writes into the bundle.
    preserveSymlinks: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile: OUT,
    sourcemap: 'external',
    metafile: true,
    write: false,
    legalComments: 'none',
    logLevel: 'warning',
  })
  const js = result.outputFiles.find((file) => file.path.endsWith('.mjs'))
  const map = result.outputFiles.find((file) => file.path.endsWith('.map'))
  const output = Object.entries(result.metafile.outputs).find(([path]) => path.endsWith('.mjs'))
  if (js === undefined || map === undefined || output === undefined) throw new Error('esbuild produced no bundle or no source map')
  const used = Object.entries(output[1].inputs).filter(([, input]) => input.bytesInOutput > 0).map(([path]) => path)
  assertMapsAreReadable(used)
  const dist = used.filter((path) => path.includes('node_modules/')).map((path) => readFileSync(join(ROOT, path), 'utf8')).join('\n')
  const packages = bundledPackages(JSON.parse(map.text).sources, dist)
  const list = packages.map((p) => `${p.name} ${p.version}`).join(', ')
  const banner =
    '// The MCP SDK that server/main.ts runs on, bundled by scripts/build-vendor.mjs (npm run build:vendor). Do not edit by hand.\n' +
    `// Bundled packages: ${list}.\n` +
    '// Their licenses are in NOTICE, at the repository root.\n'
  const text = banner + js.text
  if (text.includes(ROOT)) throw new Error('the bundle holds the absolute path of this checkout, so it would differ from machine to machine')
  return { text, packages }
}

/** What NOTICE lacks for the bundled packages; empty when it names them all and carries every license text. */
function noticeGaps(packages, notice) {
  const gaps = []
  const lines = notice.split('\n').filter((line) => line.startsWith('- '))
  for (const p of packages) {
    if (!lines.some((line) => line.includes(`${p.name} ${p.version}`) && line.includes(p.license))) {
      gaps.push(`NOTICE has no "- ${p.name} ${p.version} (${p.license}...)" line`)
    }
    const installed = readPackage(p.name)
    if (installed === null) continue
    for (const file of readdirSync(installed.dir).filter((name) => /^(?:LICENSE|LICENCE|NOTICE)(?:\.|$)/i.test(name))) {
      if (!squash(notice).includes(squash(readFileSync(join(installed.dir, file), 'utf8')))) {
        gaps.push(`NOTICE does not carry node_modules/${p.name}/${file}`)
      }
    }
  }
  for (const license of new Set(packages.map((p) => p.license))) {
    const marker = LICENSE_MARKERS[license]
    if (marker === undefined) gaps.push(`scripts/build-vendor.mjs has no marker phrase for the license ${license}`)
    else if (!squash(notice).includes(squash(marker))) gaps.push(`NOTICE does not carry the ${license} text`)
  }
  return gaps
}

async function main() {
  const check = process.argv.includes('--check')
  const { text, packages } = await bundle()
  const outPath = join(ROOT, OUT)
  if (!check) {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, text)
    console.log(`wrote ${OUT}: ${Buffer.byteLength(text)} bytes, ${packages.length} packages`)
  }
  const problems = []
  if (check) {
    if (!existsSync(outPath)) problems.push(`${OUT} is missing`)
    else if (!readFileSync(outPath).equals(Buffer.from(text))) problems.push(`${OUT} differs from a fresh build; run npm run build:vendor and commit the result`)
  }
  problems.push(...noticeGaps(packages, readFileSync(join(ROOT, NOTICE), 'utf8')))
  for (const problem of problems) console.error(`build-vendor: ${problem}`)
  if (check && problems.length === 0) {
    console.log(`${OUT} is current: ${Buffer.byteLength(text)} bytes, NOTICE names ${packages.map((p) => `${p.name} ${p.version}`).join(', ')}`)
  }
  if (problems.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`build-vendor: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
})
