import { describe, expect, it } from 'vitest'

import type { Arrangement } from '../../state/folders'
import { listView, type ListEntry } from './arrangement-list'

const bot = (name: string): { name: string } => ({ name })
const roster = (...names: string[]): { name: string }[] => names.map(bot)
const chat = (name: string): { kind: 'chat'; name: string } => ({ kind: 'chat', name })

/** The view as a flat description: loose chats by name, folders as `[id: a b]`, the archive after a `|`. */
function shape(view: ReturnType<typeof listView<{ name: string }>>): string {
  const top = view.entries.map((entry: ListEntry<{ name: string }>) =>
    entry.kind === 'chat' ? entry.bot.name : `[${entry.id}: ${entry.chats.map(item => item.name).join(' ')}]`
  )

  return `${top.join(' ')} | ${view.archived.map(item => item.name).join(' ')}`
}

const NONE = {}

describe('the list the sidebar draws', () => {
  it('is the roster’s own order while nobody has arranged anything', () => {
    expect(shape(listView({ entries: [], folders: [] }, NONE, NONE, roster('a', 'b', 'c')))).toBe('a b c | ')
  })

  it('follows the arrangement’s order, not the roster’s', () => {
    const arrangement: Arrangement = { entries: [chat('c'), chat('a'), chat('b')], folders: [] }

    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'b', 'c')))).toBe('c a b | ')
  })

  it('draws a folder in its place among the loose chats, with its own order', () => {
    const arrangement: Arrangement = {
      entries: [chat('a'), { kind: 'folder', id: 'f1' }, chat('d')],
      folders: [{ id: 'f1', name: 'Reading', bots: ['c', 'b'] }]
    }

    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'b', 'c', 'd')))).toBe('a [f1: c b] d | ')
  })

  it('puts a chat the arrangement has not placed at the end of the loose run, before the first folder', () => {
    const arrangement: Arrangement = {
      entries: [chat('a'), { kind: 'folder', id: 'f1' }, chat('d')],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b'] }]
    }

    // Two new ones: in the roster's order, ahead of the folder and of the loose chat after it.
    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'b', 'd', 'x', 'y')))).toBe('a x y [f1: b] d | ')
  })

  it('puts a new chat at the end when there is no folder', () => {
    const arrangement: Arrangement = { entries: [chat('b'), chat('a')], folders: [] }

    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'b', 'new')))).toBe('b a new | ')
  })

  it('drops a chat the roster no longer has, wherever it was, and leaves the rest as it was', () => {
    const arrangement: Arrangement = {
      entries: [chat('gone'), chat('a'), { kind: 'folder', id: 'f1' }],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b', 'gone-too', 'c'] }]
    }

    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'b', 'c')))).toBe('a [f1: b c] | ')
  })

  it('does not draw a folder with nothing to show', () => {
    const arrangement: Arrangement = {
      entries: [{ kind: 'folder', id: 'empty' }, { kind: 'folder', id: 'gone' }, chat('a')],
      folders: [
        { id: 'empty', name: 'Empty', bots: [] },
        { id: 'gone', name: 'Gone', bots: ['removed'] }
      ]
    }

    expect(shape(listView(arrangement, NONE, NONE, roster('a')))).toBe('a | ')
  })

  it('sets archived chats apart, from the top level and from a folder, in the order the arrangement has them', () => {
    const arrangement: Arrangement = {
      entries: [chat('a'), { kind: 'folder', id: 'f1' }, chat('d')],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b', 'c'] }]
    }

    expect(shape(listView(arrangement, { d: true, c: true, a: true }, NONE, roster('a', 'b', 'c', 'd')))).toBe(
      '[f1: b] | a c d'
    )
  })

  it('does not draw a folder whose chats are all archived', () => {
    const arrangement: Arrangement = {
      entries: [{ kind: 'folder', id: 'f1' }, chat('a')],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b'] }]
    }

    expect(shape(listView(arrangement, { b: true }, NONE, roster('a', 'b')))).toBe('a | b')
  })

  it('holds pinned chats at the top of their container', () => {
    const arrangement: Arrangement = {
      entries: [chat('a'), { kind: 'folder', id: 'f1' }, chat('d'), chat('e')],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b', 'c', 'x'] }]
    }

    expect(shape(listView(arrangement, NONE, { e: true, x: true }, roster('a', 'b', 'c', 'd', 'e', 'x')))).toBe(
      'e a [f1: x b c] d | '
    )
  })

  it('reads the roster it is given: a search that leaves some chats out draws only those', () => {
    const arrangement: Arrangement = {
      entries: [chat('a'), { kind: 'folder', id: 'f1' }],
      folders: [{ id: 'f1', name: 'Reading', bots: ['b', 'c'] }]
    }

    expect(shape(listView(arrangement, NONE, NONE, roster('a', 'c')))).toBe('a [f1: c] | ')
  })

  it('carries a folder’s name and colour, the default colour when it has none', () => {
    const arrangement: Arrangement = {
      entries: [
        { kind: 'folder', id: 'f1' },
        { kind: 'folder', id: 'f2' }
      ],
      folders: [
        { id: 'f1', name: 'Reading', colour: 'teal', bots: ['a'] },
        { id: 'f2', name: '', bots: ['b'] }
      ]
    }
    const folders = listView(arrangement, NONE, NONE, roster('a', 'b')).entries.flatMap(entry =>
      entry.kind === 'folder' ? [[entry.name, entry.colour]] : []
    )

    expect(folders).toEqual([
      ['Reading', 'teal'],
      ['', 'default']
    ])
  })
})
