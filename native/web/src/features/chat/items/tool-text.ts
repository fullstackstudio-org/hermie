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

/** The family a tool's glyph is drawn from (the Expo app's `tool-render-class.ts`). */
export type ToolFamily = 'terminal' | 'file-read' | 'file-write' | 'diff' | 'search' | 'browser' | 'mcp' | 'other'

const FILE_EDIT_NAMES = new Set(['edit_file', 'patch', 'write_file'])
const TERMINAL_NAMES = new Set(['bash', 'shell', 'run_command', 'terminal', 'exec', 'execute_command'])
const FILE_READ_NAMES = new Set(['read_file', 'read', 'cat_file', 'list_files', 'glob', 'grep', 'search_files'])
const SEARCH_NAMES = new Set(['web_search', 'search', 'web.search', 'fetch', 'http_fetch', 'http.fetch'])
const BROWSER_NAMES = new Set(['browser', 'browse', 'computer_use', 'playwright', 'screenshot'])

/**
 * Which family a tool belongs to: a patch or a write is a diff, a read is a
 * document, an MCP call keeps its own mark. An agent's tool list is long enough
 * that the glyph is what the eye reads first.
 */
export function toolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase()

  if (name.includes('__') || name.startsWith('mcp')) {
    return 'mcp'
  }

  if (FILE_EDIT_NAMES.has(name) || name.includes('patch') || name.includes('diff')) {
    return 'diff'
  }

  if (TERMINAL_NAMES.has(name) || name.includes('command') || name.includes('shell')) {
    return 'terminal'
  }

  if (FILE_READ_NAMES.has(name) || name.startsWith('read') || name.includes('file_read')) {
    return 'file-read'
  }

  if (name.startsWith('write') || name.includes('file_write') || name.includes('create_file')) {
    return 'file-write'
  }

  if (BROWSER_NAMES.has(name) || name.startsWith('browser')) {
    return 'browser'
  }

  if (SEARCH_NAMES.has(name) || name.includes('search') || name.includes('fetch')) {
    return 'search'
  }

  return 'other'
}

/** The glyph in a tool card's icon slot. Characters, so no icon font; decoration only. */
export function toolGlyph(family: ToolFamily): string {
  switch (family) {
    case 'terminal':
      return '\u203a_'
    case 'file-read':
      return '\u25a4'
    case 'file-write':
      return '\u270e'
    case 'diff':
      return '\u00b1'
    case 'search':
      return '\u2315'
    case 'browser':
      return '\u25a3'
    case 'mcp':
      return '\u29c9'
    default:
      return '\u2699'
  }
}

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

/**
 * The one line of the collapsed row: what the call did, in the first words that
 * apply: the tool's own summary, the gateway's preview of the call, the result
 * in a line. The state (running, failed, how long) has its own place in the row.
 */
export function toolSummary(item: ToolItem): string {
  if (item.summary?.trim()) {
    return clipLine(item.summary, SUMMARY_CHARS)
  }

  if (item.context?.trim()) {
    return clipLine(item.context, SUMMARY_CHARS)
  }

  const isRunning = item.status === 'running' || item.status === 'generating'

  if (item.resultKnown && !isRunning && !item.isError && item.status !== 'error') {
    const result = resultText(item)

    return result.trim() ? clipLine(result, SUMMARY_CHARS) : ''
  }

  return ''
}
