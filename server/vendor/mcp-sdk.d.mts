// The types of mcp-sdk.mjs, taken from the SDK packages in devDependencies, which are the ones the bundle is built from.
// `z` is the part of zod that the bundle re-exports; ENTRY in scripts/build-vendor.mjs lists it.
import type { object, string } from 'zod/v4'

export { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server'
export type { CallToolResult, ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
export { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
export declare const z: { object: typeof object; string: typeof string }
