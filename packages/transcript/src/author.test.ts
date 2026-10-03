/**
 * The agent marker on an author (`author.via`, `replayed_by.via`) and the one label it makes:
 * `<name> via <client>`. The shapes are `contract/gateway/mcp.md`.
 */
import { describe, expect, it } from 'vitest'

import { AUTHOR_VIA_CLIENT_LIMIT, authorLabel, authorViaOf } from './author'
import { rowsToItems } from './rows-to-items'
import { viaMalformedRows, viaReplayedRow, viaRow } from './__fixtures__/rows'
import type { UserItem } from './types'

const only = (row: Parameters<typeof rowsToItems>[0][number]): UserItem => rowsToItems([row], 'rpc')[0] as UserItem

describe('authorViaOf', () => {
  it('reads kind and client, and ignores keys it does not know', () => {
    expect(authorViaOf({ kind: 'mcp', client: 'Claude Code', version: '2.1', extra: { a: 1 } })).toEqual({
      kind: 'mcp',
      client: 'Claude Code'
    })
  })

  it('accepts a kind other than mcp, because a later gateway may add one', () => {
    expect(authorViaOf({ kind: 'api', client: 'Zapier' })).toEqual({ kind: 'api', client: 'Zapier' })
  })

  it('is absent for anything that is not an object with a string kind and a client that says something', () => {
    for (const value of [
      undefined,
      null,
      'mcp',
      7,
      [],
      {},
      { kind: 'mcp' },
      { client: 'Claude Code' },
      { kind: '', client: 'Claude Code' },
      { kind: 7, client: 'Claude Code' },
      { kind: 'mcp', client: 7 },
      { kind: 'mcp', client: '' },
      { kind: 'mcp', client: ' \u200b\u202e\n ' }
    ]) {
      expect(authorViaOf(value)).toBeUndefined()
    }
  })

  it('cleans the client to one plain line of at most 80 code points', () => {
    expect(authorViaOf({ kind: 'mcp', client: '  Claude\u202e \u200bCode\n*Pro*  ' })).toEqual({
      kind: 'mcp',
      client: 'Claude Code *Pro*'
    })

    const long = authorViaOf({ kind: 'mcp', client: '𝒞'.repeat(200) })

    expect(Array.from(long?.client ?? '')).toHaveLength(AUTHOR_VIA_CLIENT_LIMIT)
  })
})

describe('authorLabel', () => {
  it('is `<name> via <client>` for an author with a marker', () => {
    expect(authorLabel({ via: { kind: 'mcp', client: 'Claude Code' } }, 'Robin')).toBe('Robin via Claude Code')
  })

  it('is the name as it is for a person typing', () => {
    expect(authorLabel({}, 'Robin')).toBe('Robin')
    expect(authorLabel(undefined, 'Robin')).toBe('Robin')
  })

  it('leaves `via <client>` when there is no name, so an agent is never labelled as nobody', () => {
    expect(authorLabel({ via: { kind: 'mcp', client: 'Claude Code' } }, '  ')).toBe('via Claude Code')
  })

  it('writes `via` as a plain word and the name and client as they are, with no Markdown of its own', () => {
    const label = authorLabel({ via: { kind: 'mcp', client: 'My *Agent*' } }, '_Robin_')

    expect(label).toBe('_Robin_ via My *Agent*')
    expect(label).not.toMatch(/[*_]via|via[*_]|\\/u)
  })
})

describe('display_metadata.author.via on a history row', () => {
  it('projects the person with the marker, ignoring the keys it does not know', () => {
    expect(only(viaRow).author).toEqual({
      id: 'oidc:user-a',
      name: 'Robin',
      via: { kind: 'mcp', client: 'Claude Code' }
    })
  })

  it('reads the same marker from the REST shape of the row', () => {
    const rest = { role: 'user', id: 70, content: viaRow.text, display_metadata: viaRow.display_metadata }

    expect((rowsToItems([rest], 'rest')[0] as UserItem).author?.via).toEqual({ kind: 'mcp', client: 'Claude Code' })
  })

  it('reads the marker of a JSON-text display_metadata too', () => {
    const item = only({ ...viaRow, display_metadata: JSON.stringify(viaRow.display_metadata) })

    expect(item.author?.via).toEqual({ kind: 'mcp', client: 'Claude Code' })
  })

  it('reads `replayed_by` with its own marker and leaves the author the original one', () => {
    const item = only(viaReplayedRow)

    expect(item.author).toEqual({ id: 'oidc:user-a', name: 'Robin' })
    expect(item.replayedBy).toEqual({ id: 'oidc:user-b', name: 'Sam', via: { kind: 'mcp', client: 'Claude Code' } })
  })

  it('has no `replayedBy` on a row that was not retried', () => {
    expect(only(viaRow).replayedBy).toBeUndefined()
  })

  it('leaves a malformed `via` out and keeps the person beside it', () => {
    for (const key of ['stringVia', 'blankClient', 'numericClient', 'missingKind'] as const) {
      expect(only(viaMalformedRows[key]!).author, key).toEqual({ id: 'oidc:user-a', name: 'Robin' })
    }
  })

  it('does not make an author out of a `via` alone', () => {
    expect(only(viaMalformedRows.noAuthor!).author).toBeUndefined()
  })

  it('cleans a client name carrying invisible characters and a long tail', () => {
    const via = only(viaMalformedRows.unclean!).author?.via

    expect(via?.client.startsWith('Claude Code *Pro* x')).toBe(true)
    expect(Array.from(via?.client ?? '')).toHaveLength(AUTHOR_VIA_CLIENT_LIMIT)
  })
})
