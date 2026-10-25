// The test HTTP entry of the conformance suite: the SDK's createMcpHandler on node:http, over the fixtures. The handler
// answers -32020 for an Mcp-Method or Mcp-Name header that disagrees with the body, which the headers scenario needs.

import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server'

import { TASKS_EXTENSION, registerTaskMethods } from '../../server/protocol.ts'
import { fixtureSource, registerFixtureTools } from './fixtures.mjs'

const BODY_LIMIT = 1024 * 1024

async function toRequest(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    for (const one of Array.isArray(value) ? value : [value]) if (one !== undefined) headers.append(name, one)
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { method: req.method, headers, ...(hasBody ? { body: Buffer.concat(chunks) } : {}) })
}

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (response.body !== null) for await (const chunk of response.body) res.write(chunk)
  res.end()
}

/** Starts the entry on 127.0.0.1; port 0 takes a free one. `close` stops it and the handler. */
export async function startEntry({ port = 0, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const source = fixtureSource()
  // The handler builds a server for every request, so the tasks live in the source, which outlives them.
  const handler = createMcpHandler(
    () => {
      const mcp = new McpServer({ name: 'cc-orq-conformance', version: '0.0.0' }, { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } } })
      registerFixtureTools(mcp.server, source)
      registerTaskMethods(mcp, source)
      return mcp
    },
    { legacy: 'reject', onerror: (error) => log(`conformance entry: ${error.message}`) },
  )
  const http = createServer((req, res) => {
    toRequest(req)
      .then((request) => handler.fetch(request))
      .then((response) => send(res, response))
      .catch((error) => {
        log(`conformance entry: ${error instanceof Error ? error.message : String(error)}`)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error' } }))
      })
  })
  await new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, '127.0.0.1', resolve)
  })
  const { port: bound } = http.address()
  return {
    url: `http://127.0.0.1:${bound}/mcp`,
    async close() {
      await handler.close()
      http.closeAllConnections()
      await new Promise((resolve) => http.close(resolve))
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const entry = await startEntry({ port: Number(process.env.PORT ?? 0) })
  process.stdout.write(`conformance entry listening on ${entry.url}\n`)
  const stop = () => void entry.close().then(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
