/**
 * What a tool call says about itself, as plain text.
 *
 * A tool row is one collapsed line and, opened, a few lines of text: the
 * arguments, what came back, what went wrong. Nothing here is Markdown, and
 * nothing is run or fetched: the arguments and the result are what the agent and
 * a tool's output made them, so they are only ever shown as characters.
 */
import type { ToolItem } from '@hermie/transcript'

import { clipLine } from '../chat-format'

/** Tools whose whole interface is somewhere else (the todo list, a reaction): no row while they succeed. */
const SILENT_TOOLS = new Set(['react_to_message', 'todo', 'todo_list'])

export const isSilentTool = (name: string): boolean => SILENT_TOOLS.has(name)

/** Past this many characters a value is folded behind "Show more". */
export const LONG_VALUE_CHARS = 600

/** The longest line the collapsed row carries. */
const SUMMARY_CHARS = 120

const MCP_PREFIX = 'mcp__'
const MCP_SEPARATOR = '__'
const TOOL_NAME_MAX = 18

/**
 * A tool's name short enough to stand in a line of the header. A gateway spells
 * an MCP tool `mcp__server__verb`; the server is the thing a reader recognises.
 */
export function shortToolName(raw: string): string {
  const name = raw.trim()

  if (!name) {
    return ''
  }

  const namespaced = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : null
  const server = namespaced === null ? name : (namespaced.split(MCP_SEPARATOR)[0] ?? namespaced)
  const chosen = server === '' ? name : server

  return chosen.length > TOOL_NAME_MAX ? `${chosen.slice(0, TOOL_NAME_MAX - 1)}…` : chosen
}

const stringify = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

/** The fields a tool's own result most often keeps its text under, in the order they are tried. */
const RESULT_TEXT_KEYS = ['output', 'stdout', 'text', 'content', 'result', 'message'] as const

/** What came back from a call, as text: its text field when it has one, else the value itself. */
export function resultText(item: ToolItem): string {
  if (item.resultText?.trim()) {
    return item.resultText
  }

  const result = item.result

  if (result === undefined || result === null) {
    return ''
  }

  if (typeof result === 'object' && !Array.isArray(result)) {
    for (const key of RESULT_TEXT_KEYS) {
      const value = (result as Record<string, unknown>)[key]

      if (typeof value === 'string' && value.trim()) {
        return value
      }
    }
  }

  return stringify(result)
}

/** The message of a failed call, when the result carries one. */
export function errorText(item: ToolItem): string {
  const result = item.result

  if (result && typeof result === 'object') {
    const error = (result as Record<string, unknown>).error

    if (typeof error === 'string' && error.trim()) {
      return error
    }

    const message = (error as { message?: unknown } | undefined)?.message

    if (typeof message === 'string' && message.trim()) {
      return message
    }
  }

  return item.summary?.trim() || resultText(item)
}

export interface ArgumentLine {
  name: string
  value: string
}

/** The call's arguments, one line each, in the order the agent wrote them. */
export function argumentLines(args: ToolItem['args']): ArgumentLine[] {
  return args ? Object.entries(args).map(([name, value]) => ({ name, value: stringify(value) })) : []
}

/** The one line of the collapsed row: what the call did, or the state it is in. */
export function toolSummary(item: ToolItem): string {
  if (item.summary?.trim()) {
    return clipLine(item.summary, SUMMARY_CHARS)
  }

  if (item.context?.trim()) {
    return clipLine(item.context, SUMMARY_CHARS)
  }

  return ''
}
