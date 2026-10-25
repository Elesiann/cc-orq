#!/usr/bin/env node
// Checks the relative links and anchors of Markdown files. A link to a file or a directory must
// name one that exists inside the repository. A #anchor must match a heading or an id of the file
// it points into, with headings slugged the way GitHub slugs them. External links are not fetched.
//
// Usage, from the repository root: node scripts/check-links.mjs [FILE...]
// With no FILE, every Markdown file that git tracks is checked. Exit 0 when every link resolves,
// 1 when one does not.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

// The heading text as GitHub slugs it: link syntax keeps its text, letters, digits, marks,
// hyphens and underscores stay, and each space becomes a hyphen.
function slugify(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-')
}

// The lines with fenced code blocks blanked, so a line inside a block is neither a heading nor a link.
function proseLines(text) {
  let open = null
  return text.split('\n').map((line) => {
    if (open === null) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
      if (m) {
        open = m[1]
        return ''
      }
      return line
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
    if (close && close[1][0] === open[0] && close[1].length >= open.length) open = null
    return ''
  })
}

function anchorsOf(lines) {
  const anchors = new Set()
  const seen = new Map()
  for (const line of lines) {
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      const base = slugify(heading[1])
      const n = seen.get(base) ?? 0
      seen.set(base, n + 1)
      if (base !== '') anchors.add(n === 0 ? base : `${base}-${n}`)
    }
    for (const m of line.matchAll(/\s(?:id|name)="([^"]+)"/g)) anchors.add(m[1])
  }
  return anchors
}

// Inline and image links, and src or href attributes. Code spans are blanked first.
function linksOf(lines) {
  const links = []
  lines.forEach((raw, i) => {
    const line = raw.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length))
    for (const m of line.matchAll(/\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/g)) {
      links.push({ line: i + 1, target: m[1] })
    }
    for (const m of line.matchAll(/\s(?:src|href)="([^"]*)"/g)) {
      links.push({ line: i + 1, target: m[1] })
    }
  })
  return links
}

function anchorsFor(file, cache) {
  if (!cache.has(file)) {
    cache.set(file, anchorsOf(proseLines(readFileSync(file, 'utf8'))))
  }
  return cache.get(file)
}

// Returns the reason a link is broken, or null when it resolves.
function brokenReason(file, root, target, cache) {
  if (target === '') return 'empty target'
  if (SCHEME.test(target) || target.startsWith('//')) return null

  const hash = target.indexOf('#')
  const pathPart = (hash === -1 ? target : target.slice(0, hash)).split('?')[0]
  const fragment = hash === -1 ? '' : target.slice(hash + 1)

  let path
  let decodedFragment
  try {
    path = decodeURIComponent(pathPart)
    decodedFragment = decodeURIComponent(fragment)
  } catch {
    return 'the path or the anchor is not valid percent-encoding'
  }

  let abs
  if (path === '') abs = file
  else if (path.startsWith('/')) abs = resolve(root, `.${path}`)
  else abs = resolve(dirname(file), path)

  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return 'the target lies outside the repository'
  }
  if (!existsSync(abs)) return 'no such file or directory'
  if (decodedFragment === '' || statSync(abs).isDirectory() || !abs.endsWith('.md')) return null

  if (!anchorsFor(abs, cache).has(decodedFragment)) {
    return `no heading or id "#${decodedFragment}" in ${relative(root, abs)}`
  }
  return null
}

function markdownFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path !== '')
      .map((path) => resolve(root, path))
  } catch {
    console.log('not a git repository: pass the Markdown files as arguments')
    process.exit(2)
  }
}

function main(args) {
  const root = process.cwd()
  const files = args.length > 0 ? args.map((path) => resolve(root, path)) : markdownFiles(root)
  const cache = new Map()
  const broken = []
  let links = 0

  for (const file of files) {
    const lines = proseLines(readFileSync(file, 'utf8'))
    for (const { line, target } of linksOf(lines)) {
      links += 1
      const reason = brokenReason(file, root, target, cache)
      if (reason !== null) {
        broken.push(`${relative(root, file)}:${line}: broken link "${target}": ${reason}`)
      }
    }
  }

  for (const message of broken) console.log(message)
  console.log(`checked ${links} links in ${files.length} Markdown files: ${broken.length} broken`)
  return broken.length === 0 ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
