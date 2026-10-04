// @vitest-environment node
/**
 * What the first load must not import: the modules the client keeps in chunks of their own.
 *
 * `npm run client:check-bundle` measures the built entry against a byte budget, but only after a build, and the budget
 * has to leave room. This holds the structure instead, from the sources and in a second: follow every static import
 * from `main.tsx` (a dynamic `import()` is the way a chunk is meant to be reached, so it is not followed; a type-only
 * import is erased, so it is not either) and fail, naming the chain, when one reaches a module that is loaded on
 * demand. One value import of `interactive-frame.tsx` from the request layer once put every sheet's strings in the
 * first load (+79 kB) without any test noticing.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { entryGraph as sharedEntryGraph, splitReads } from '../scripts/catalogue-split.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(here, 'main.tsx')

/** Modules that exist to be loaded on demand: nothing the entry imports statically may reach them. */
const ON_DEMAND = [
  // The request sheets' chunk (`features/requests/sheets.ts`), what only a sheet draws, and the sheets' words.
  ...[
    'ApprovalSheet',
    'ClarifySheet',
    'ConfirmSheet',
    'ConnectionSheet',
    'DraftSheet',
    'FileSheet',
    'FormSheet',
    'SecretSheet',
    'SudoSheet',
    'VaultCodeSheet',
    'VaultSaveLoginSheet',
    'VaultUnlockSheet',
    'SecureSheet'
  ].map(name => `features/requests/${name}.tsx`),
  'features/requests/sheets.ts',
  // The sheets that reach for the device (a pad, the location, the contact picker, the camera, the microphone) are a
  // chunk behind that one (`device-sheets.ts`), with what only they use and the words only they and the transcript's
  // record of them say. The entry reads only `device-support.ts` and the loader.
  ...['ContactSheet', 'LocationSheet', 'ScanSheet', 'SignatureSheet', 'VoiceSheet'].map(
    name => `features/requests/${name}.tsx`
  ),
  'features/requests/device-sheets.ts',
  'features/requests/device-frame.tsx',
  'features/requests/device-answers.ts',
  'features/requests/signature-export.ts',
  'i18n/device-strings.ts',
  'i18n/record-strings.ts',
  'features/requests/interactive-frame.tsx',
  'features/requests/FormFields.tsx',
  'i18n/sheet-strings.ts',
  // The chat screen and the settings pages are chunks of their own, the small pages one together.
  'features/chat/ChatScreen.tsx',
  'features/settings/SettingsHost.tsx',
  'features/settings/settings-pages.ts',
  // What the chat controller does only when a page asks (`ChatController` hands those calls over): the chat screen's
  // chunk brings it. The upload itself goes with it; a send only names the files (`core/chats/file-references.ts`).
  'core/chat-controller-on-demand.ts',
  'core/chats/file-upload.ts',
  // What the passkey model does only for the Passkeys page (enrolment, the step-ups): the Settings pages' chunk
  // brings it.
  'core/passkey/model-on-demand.ts',
  // The Crons pages and the Activity timeline, and the words only they say.
  'features/cron/CronsPage.tsx',
  'features/activity/ActivityPage.tsx',
  'i18n/cron-strings.ts',
  // The gateway-management pages (Memory, Skills, MCP servers, Connectors, Boards), what they share, and their words.
  'features/settings/manage-pages.ts',
  'features/settings/Memory.tsx',
  'features/settings/Skills.tsx',
  'features/settings/McpServers.tsx',
  'features/settings/Connectors.tsx',
  'features/settings/Boards.tsx',
  'features/settings/manage-parts.tsx',
  'core/manage/memory.ts',
  'core/manage/skills.ts',
  'core/manage/mcp-servers.ts',
  'core/manage/connectors.ts',
  'core/manage/kanban.ts',
  'core/manage/transport.ts',
  'core/manage/route-error.ts',
  'i18n/manage-strings.ts',
  // Web Push is loaded once the session has started; only the launch click's reader is in the first load.
  'features/push/push-runtime.ts',
  'features/settings/Notifications.tsx',
  'core/push/sync.ts',
  'core/push/row.ts',
  'platform/web-push.ts',
  'state/push.ts',
  // Voice: the microphone, the reader and their engines are fetched only where a browser can use them and a reader
  // does; the Settings section and the voice choices come with the pages that read them.
  'features/voice/voice-chunk.ts',
  'features/voice/DictationButton.tsx',
  'features/voice/dictation.ts',
  'features/voice/read-aloud.ts',
  'features/voice/use-read-aloud.ts',
  'features/voice/speech-text.ts',
  'platform/speech-recognition.ts',
  'platform/speech-synthesis.ts',
  'features/settings/Voice.tsx',
  'state/voice-settings.ts',
  // A chat row's menu and a bot's profile page are chunks of their own, with the model and the picture code they use.
  'features/bots/RowMenuLayer.tsx',
  'features/bots/RowMenu.tsx',
  'features/bots/row-menu.ts',
  'features/profile/ProfilePage.tsx',
  'core/bot-profile/model.ts',
  'core/bot-profile/avatar.ts'
].map(path => join(here, path))

/** The file a relative specifier names, or undefined for a package, a stylesheet or an asset. */
function resolveModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) {
    return undefined
  }

  const base = join(dirname(from), specifier)

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

/** The modules a file imports (or re-exports from) with something that is not erased. */
function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const specifiers: string[] = []

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause
      const named = clause?.namedBindings
      const erased =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.length > 0 &&
            named.elements.every(element => element.isTypeOnly)))

      if (!erased) {
        specifiers.push(statement.moduleSpecifier.text)
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifiers.push(statement.moduleSpecifier.text)
    }
  }

  return specifiers
}

/** Every source module the entry reaches statically, each with the module it was first reached from. */
function entryGraph(): Map<string, string | undefined> {
  const reached = new Map<string, string | undefined>([[ENTRY, undefined]])
  const queue = [ENTRY]

  while (queue.length > 0) {
    const file = queue.shift() as string

    for (const specifier of staticImports(file)) {
      const target = resolveModule(file, specifier)

      if (target !== undefined && !reached.has(target)) {
        reached.set(target, file)
        queue.push(target)
      }
    }
  }

  return reached
}

/** `main.tsx > a.tsx > b.ts`: how the entry gets to `file`. */
function chainTo(reached: Map<string, string | undefined>, file: string): string {
  const chain: string[] = []

  for (let at: string | undefined = file; at !== undefined; at = reached.get(at)) {
    chain.unshift(relative(here, at))
  }

  return chain.join(' > ')
}

describe('the first load', () => {
  const reached = entryGraph()

  it('reaches the request layer, so the check below means something', () => {
    expect(reached.has(join(here, 'features/requests/RequestLayer.tsx'))).toBe(true)
    expect(reached.has(join(here, 'features/requests/sheet-busy.ts'))).toBe(true)
  })

  it('imports no module that is loaded on demand', () => {
    const leaks = ON_DEMAND.filter(file => reached.has(file)).map(file => chainTo(reached, file))

    expect(leaks).toEqual([])
  })

  it('names modules that exist', () => {
    expect(ON_DEMAND.filter(file => !existsSync(file))).toEqual([])
  })

  it('is the graph the build splits the catalogue by (the same walk, kept in one place for the build)', () => {
    expect([...sharedEntryGraph(ENTRY).keys()].sort()).toEqual([...reached.keys()].sort())
  })
})

describe('the first load’s words', () => {
  const split = splitReads(here, 'main.tsx')

  it('are read by modules the entry imports, and a page’s own words are not among them', () => {
    // The catalogue's English is inlined into the entry; what only a page loaded on demand reads is registered by the
    // page (`vite.config.ts`, `catalogueOnlyWhatIsRead`). A page's words read from a module the entry imports would
    // put them back, so the entry reads no key of these sections: the Crons pages, the Settings pages and the chat
    // screen's own words (the sidebar's one word for Settings aside).
    const paths = split.entry ?? []
    const under = (prefix: string): string[] => paths.filter(path => path.startsWith(prefix))

    expect(split.entry).not.toBeNull()
    expect(under('cron.')).toEqual([])
    expect(under('memory.')).toEqual([])
    expect(under('skills.')).toEqual([])
    expect(under('kanban.')).toEqual([])
    expect(under('connectors.')).toEqual([])
    expect(under('mcp.')).toEqual([])
    expect(under('app.settings.')).toEqual(['app.settings.title'])
    expect(under('chat.approval.')).toEqual([])
    expect(under('chat.composer.')).toEqual([])
    expect(under('chat.options.')).toEqual([])
    expect(under('chat.notifications.')).toEqual([])
  })

  it('has pages that read words of their own, which is what leaves the entry', () => {
    expect(split.inEntry.has('features/cron/CronsPage.tsx')).toBe(false)
    expect(split.byFile.get('features/cron/CronList.tsx')?.some(path => path.startsWith('cron.'))).toBe(true)
  })
})
