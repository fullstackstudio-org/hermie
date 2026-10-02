/**
 * Which surface a tool call renders as.
 *
 * Ported from `apps/desktop/src/lib/tool-render-class.ts`. The classification
 * lives on its own because two consumers have to agree on it: the transcript
 * decides what to draw, and a caller deciding how much of a turn to mount has
 * to price what the drawing actually costs.
 */

const FILE_EDIT_TOOL_NAMES = new Set(['edit_file', 'patch', 'write_file'])

/** Renders a diff — the deliverable of the turn, not scaffolding around it. */
export function isFileEditTool(toolName: string): boolean {
  return FILE_EDIT_TOOL_NAMES.has(toolName)
}

// Tools that draw their own surface and must never be folded into a summary:
// a question the user has to answer, an image they asked for, the several
// agents a fan-out is running, a consent card whose controls must stay visible.
const CARD_TOOL_NAMES = new Set(['clarify', 'delegate_task', 'image_generate', 'manage_connections'])

export function isCardTool(toolName: string): boolean {
  return CARD_TOOL_NAMES.has(toolName) || isFileEditTool(toolName)
}

// Activity tools that render nothing at all: a `todo` part belongs in its own
// panel, and a reaction's UI is the emoji landing on the bubble. Both still
// render when they FAIL, which is a bounded error row either way.
const SILENT_TOOL_NAMES = new Set(['react_to_message', 'todo', 'todo_list'])

export function isSilentTool(toolName: string): boolean {
  return SILENT_TOOL_NAMES.has(toolName)
}

export type ToolFamily = 'terminal' | 'file-read' | 'file-write' | 'diff' | 'search' | 'browser' | 'mcp' | 'other'

const TERMINAL_NAMES = new Set(['bash', 'shell', 'run_command', 'terminal', 'exec', 'execute_command'])
const FILE_READ_NAMES = new Set(['read_file', 'read', 'cat_file', 'list_files', 'glob', 'grep', 'search_files'])
const SEARCH_NAMES = new Set(['web_search', 'search', 'web.search', 'fetch', 'http_fetch', 'http.fetch'])
const BROWSER_NAMES = new Set(['browser', 'browse', 'computer_use', 'playwright', 'screenshot'])

/**
 * The icon family a tool belongs to. A patch or a write is a diff, a read is a
 * document, an MCP call keeps its own mark — an agent's tool list is long
 * enough that the glyph is what the eye actually reads.
 */
export function toolFamily(toolName: string): ToolFamily {
  const name = toolName.toLowerCase()

  if (name.includes('__') || name.startsWith('mcp')) {
    return 'mcp'
  }

  if (isFileEditTool(name) || name.includes('patch') || name.includes('diff')) {
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

/** The glyph drawn in a tool card's icon slot. Unicode, so no icon font. */
export function toolGlyph(family: ToolFamily): string {
  switch (family) {
    case 'terminal':
      return '›_'
    case 'file-read':
      return '▤'
    case 'file-write':
      return '✎'
    case 'diff':
      return '±'
    case 'search':
      return '⌕'
    case 'browser':
      return '▣'
    case 'mcp':
      return '⧉'
    default:
      return '⚙'
  }
}
