// The orq MCP server: the tools of server/tools.ts over stdio, on the job core. server/main.mjs checks the Node
// version and loads this file. stdout carries JSON-RPC frames and nothing else, so every log line goes to stderr,
// which is where the engine shim writes `ui.log`.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { newCatalogCache } from '../hooks/tools.ts'
import { isRecord } from '../hooks/types.ts'
import { nodeEngine } from './node-engine.ts'
import { registerTaskMethods, TASKS_EXTENSION } from './protocol.ts'
import { registerTools } from './tools.ts'
import { McpServer, serveStdio } from './vendor/mcp-sdk.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSTRUCTIONS = readFileSync(join(HERE, 'instructions.md'), 'utf8')

function pluginVersion(): string {
  const manifest: unknown = JSON.parse(readFileSync(join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8'))
  return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

const engine = nodeEngine({ pluginRoot: process.env.CLAUDE_PLUGIN_ROOT })
const catalog = newCatalogCache()
const version = pluginVersion()

function buildServer(): McpServer {
  const mcp = new McpServer(
    { name: 'cc-orq', version },
    { capabilities: { tools: {}, extensions: { [TASKS_EXTENSION]: {} } }, instructions: INSTRUCTIONS },
  )
  registerTools(mcp, engine, catalog)
  registerTaskMethods(mcp)
  return mcp
}

const connection = serveStdio(buildServer, { onerror: (error) => void engine.ui.log(`orq: server error: ${error.message}`) })

// The workers run detached, so closing the connection and exiting leaves them alone.
let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  try {
    await connection.close()
  } finally {
    process.exit(0)
  }
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
process.stdin.once('end', () => void stop())
