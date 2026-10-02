/**
 * The German catalogue, one file per English string table.
 *
 * Same rules as `../nl/index.ts`: types only, no English values, and the
 * glossary in `docs/i18n.md`. German addresses the reader as `du`, matching the
 * Dutch `je` rather than the formal register a German product would often pick
 * — Hermie is somebody's own bots on somebody's own machine.
 */
import { app } from './app'
import { botRename } from './bot-rename'
import { chat } from './chat'
import { connectors } from './connectors'
import { cron } from './cron'
import { kanban } from './kanban'
import { mcp } from './mcp'
import { memory } from './memory'
import { profiles } from './profiles'
import { skills } from './skills'

/** Every tree, by the name `catalogue.ts` knows it as. */
export const de = {
  app,
  botRename,
  chat,
  connectors,
  cron,
  kanban,
  mcp,
  memory,
  profiles,
  skills
}
