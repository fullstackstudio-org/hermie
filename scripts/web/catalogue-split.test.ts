import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isRead } from '../../native/web/scripts/catalogue-reads.mjs'
import { entryGraph, lazyKeysByFile, lazyOnlyKeys, splitReads } from '../../native/web/scripts/catalogue-split.mjs'

const dirs: string[] = []

/** A source tree in a temporary directory: `files` maps a path under `src` to its text. */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermie-split-'))

  dirs.push(dir)

  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name)

    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const IMPORT = "import { strings } from './generated/strings'\n"

describe('entryGraph', () => {
  it('follows static imports and re-exports, and neither a dynamic import nor a type-only one', () => {
    const dir = tree({
      'main.tsx':
        "import './a'\nexport * from './b'\nimport type { T } from './type-only'\nconst page = () => import('./lazy')\n",
      'a.ts': "import { x } from './c'\nexport const a = x\n",
      'b.ts': 'export const b = 1\n',
      'c.ts': 'export const x = 1\n',
      'type-only.ts': 'export type T = 1\n',
      'lazy.ts': "import './lazy-child'\n",
      'lazy-child.ts': 'export {}\n'
    })
    const names = [...entryGraph(join(dir, 'main.tsx')).keys()].map(file => file.slice(dir.length + 1)).sort()

    expect(names).toEqual(['a.ts', 'b.ts', 'c.ts', 'main.tsx'])
  })

  it('says how each module was reached', () => {
    const dir = tree({ 'main.tsx': "import './a'\n", 'a.ts': "import './b'\n", 'b.ts': 'export {}\n' })
    const graph = entryGraph(join(dir, 'main.tsx'))

    expect(graph.get(join(dir, 'b.ts'))).toBe(join(dir, 'a.ts'))
    expect(graph.get(join(dir, 'main.tsx'))).toBeUndefined()
  })
})

describe('splitReads', () => {
  it('gives what the entry reads to the entry and what only a lazy module reads to the chunks', () => {
    const dir = tree({
      'main.tsx': `${IMPORT}import './shell'\nconst page = () => import('./page')\nstrings.app.onboarding.title\n`,
      'shell.ts': `${IMPORT}strings.app.common.cancel\n`,
      'page.tsx': `${IMPORT}strings.cron.list.empty\nstrings.app.common.cancel\n`,
      'page.test.tsx': `${IMPORT}strings.never.counted\n`
    })
    const split = splitReads(dir, 'main.tsx')

    expect(split.entry).toEqual(['app.common.cancel', 'app.onboarding.title'])
    expect(split.lazy).toEqual(['app.common.cancel', 'cron.list.empty'])
    expect([...split.inEntry].sort()).toEqual(['main.tsx', 'shell.ts'])
    expect(split.byFile.get('page.tsx')).toEqual(['app.common.cancel', 'cron.list.empty'])
    expect(split.byFile.has('page.test.tsx')).toBe(false)
  })

  it('leaves a key both sides read in the entry', () => {
    const catalogue = { 'app.common.cancel': 'Cancel', 'cron.list.empty': 'Nothing', 'app.errors.x': 'X' }
    const dir = tree({
      'main.tsx': `${IMPORT}import './shell'\nconst page = () => import('./page')\n`,
      'shell.ts': `${IMPORT}strings.app.common.cancel\n`,
      'page.tsx': `${IMPORT}strings.cron.list.empty\nstrings.app.common.cancel\n`
    })

    expect(lazyOnlyKeys(catalogue, splitReads(dir, 'main.tsx'))).toEqual(['cron.list.empty'])
  })

  it('moves nothing out of the entry when either side reads the tree in a way that reaches no key', () => {
    const catalogue = { 'cron.list.empty': 'Nothing' }
    const wholeLazy = tree({
      'main.tsx': "const page = () => import('./page')\n",
      'page.tsx': `${IMPORT}f(strings)\n`
    })
    const wholeEntry = tree({
      'main.tsx': `${IMPORT}f(strings)\nconst page = () => import('./page')\n`,
      'page.tsx': `${IMPORT}strings.cron.list.empty\n`
    })

    expect(lazyOnlyKeys(catalogue, splitReads(wholeLazy, 'main.tsx'))).toEqual([])
    expect(lazyOnlyKeys(catalogue, splitReads(wholeEntry, 'main.tsx'))).toEqual([])
  })
})

describe('lazyKeysByFile', () => {
  it('gives each module outside the entry the keys that left the entry it reads, and leaves out the rest', () => {
    const catalogue = {
      'app.common.cancel': 'Cancel',
      'cron.list.empty': 'Nothing',
      'cron.list.title': 'Crons',
      'cron.detail.next': 'Next'
    }
    const dir = tree({
      'main.tsx': `${IMPORT}import './shell'\nconst page = () => import('./page')\n`,
      'shell.ts': `${IMPORT}strings.app.common.cancel\n`,
      'page.tsx': `${IMPORT}import './detail'\nimport './plain'\nstrings.cron.list\nstrings.app.common.cancel\n`,
      'detail.tsx': `${IMPORT}strings.cron.detail.next\nstrings.cron.list.title\n`,
      'plain.ts': 'export const plain = 1\n'
    })
    const split = splitReads(dir, 'main.tsx')
    const byFile = lazyKeysByFile(lazyOnlyKeys(catalogue, split), split)

    // A key two modules read is in both of theirs; the entry's keys and the modules that read none are in nobody's.
    expect([...byFile]).toEqual([
      ['detail.tsx', ['cron.list.title', 'cron.detail.next']],
      ['page.tsx', ['cron.list.empty', 'cron.list.title']]
    ])
  })
})

describe('the web client', () => {
  const src = join(__dirname, '..', '..', 'native', 'web', 'src')
  const english = JSON.parse(readFileSync(join(src, 'generated', 'locales', 'en.json'), 'utf8')) as Record<
    string,
    unknown
  >
  const split = splitReads(src, 'main.tsx')

  it('can be split: no module reads the tree in a way that reaches no key', () => {
    expect(split.entry).not.toBeNull()
    expect(split.lazy).not.toBeNull()
  })

  it('keeps the words only a page loaded on demand says out of the first load', () => {
    const lazy = new Set(lazyOnlyKeys(english, split))
    const inEntry = Object.keys(english).filter(key => !lazy.has(key) && isRead(key, split.entry ?? []))
    const under = (prefix: string): string[] => inEntry.filter(key => key.startsWith(prefix))

    // The Crons pages, the Settings pages and the chat screen's own words are pages: the entry holds none of them
    // (the sidebar's one word for Settings aside).
    expect(under('cron.')).toEqual([])
    expect(under('app.settings.')).toEqual(['app.settings.title'])

    for (const prefix of ['chat.approval.', 'chat.composer.', 'chat.options.', 'chat.notifications.']) {
      expect(under(prefix), prefix).toEqual([])
    }

    expect(lazy.size).toBeGreaterThan(300)
  })

  it('does not let the first load’s share of the catalogue grow unnoticed', () => {
    const lazy = new Set(lazyOnlyKeys(english, split))
    const inEntry = Object.keys(english).filter(key => !lazy.has(key) && isRead(key, split.entry ?? []))

    // 116 keys when this was written. A page's words that are read from a module the entry imports statically show up
    // here; if one does, load it as a chunk, or raise this with the reason.
    expect(inEntry.length).toBeLessThanOrEqual(140)
  })
})
