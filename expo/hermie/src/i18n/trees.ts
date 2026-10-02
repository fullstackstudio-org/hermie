/**
 * Every English string table, under the tree name its catalogue uses.
 *
 * The one place that knows the full set. A coverage test walks this rather than
 * a list of its own, so adding a twelfth string table to the app is enough to
 * put it in front of the completeness check — a test with its own copy of the
 * list would pass happily while the new table went untranslated.
 *
 * These are the localised proxies rather than the raw objects, which is
 * deliberate and safe: under English a proxy hands back exactly what it wraps,
 * and the tests that walk this reset the locale first.
 */
import { renameStrings } from '../features/bot-rename/strings'
import { connectorStrings } from '../features/connectors/strings'
import { cronStrings } from '../features/cron/strings'
import { kanbanStrings } from '../features/kanban/strings'
import { mcpStrings } from '../features/mcp/strings'
import { memoryStrings } from '../features/memory/strings'
import { profileStrings } from '../features/profiles/strings'
import { skillStrings } from '../features/skills/strings'
import { chatStrings } from '../chat-ui/strings'
import type { TreeName } from './catalogue'
import { strings } from './strings'

export const ENGLISH_TREES: Record<TreeName, object> = {
  app: strings,
  chat: chatStrings,
  botRename: renameStrings,
  connectors: connectorStrings,
  cron: cronStrings,
  kanban: kanbanStrings,
  mcp: mcpStrings,
  memory: memoryStrings,
  profiles: profileStrings,
  skills: skillStrings
}

export const TREE_NAMES = Object.keys(ENGLISH_TREES) as TreeName[]
