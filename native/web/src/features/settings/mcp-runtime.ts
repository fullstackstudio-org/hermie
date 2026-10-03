/**
 * What the Settings › MCP page is given by the page: the MCP model's actions
 * (`core/mcp/model.ts`). Its state is read from `state/mcp.ts`, like every other
 * store.
 *
 * A context, like `PasskeyRuntimeContext`, and optional for the same reason: a
 * screen rendered with none (a test of the shell) draws what the store holds and
 * acts on nothing.
 */
import { createContext, useContext } from 'react'

import type { McpModel } from '../../core/mcp/model'

/** The model methods a screen calls. */
export type McpActions = Pick<McpModel, 'watch' | 'refresh' | 'revoke' | 'host'>

export const McpRuntimeContext = createContext<McpActions | null>(null)

export const useMcpRuntime = (): McpActions | null => useContext(McpRuntimeContext)
