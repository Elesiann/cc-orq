// Entry of the orq MCP server (mcpServers.orq in .claude-plugin/plugin.json). The version check runs here, before
// main.ts is loaded, because a Node older than 22.18 cannot load a .ts file and a check inside main.ts would never run.
import { nodeVersionRefusal } from './node-version.mjs'

const refusal = nodeVersionRefusal(process.versions.node)
if (refusal === null) {
  await import('./main.ts')
} else {
  process.stderr.write(`${refusal}\n`)
  process.exitCode = 1
}
