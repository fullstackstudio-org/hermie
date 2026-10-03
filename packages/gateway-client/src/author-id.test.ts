/**
 * HERM-83: the reader's own author id, built from `/api/auth/me` exactly the
 * way the gateway builds the per-message author stamp.
 *
 * The gateway answers `/api/auth/me` with the provider's BARE `user_id` and the
 * `provider` beside it, and stamps a row with `"<provider>:<user_id>"`. A client
 * that compared the bare id with the stamp called every one of the reader's own
 * messages somebody else's. These tests start from the response body the
 * gateway actually sends and go through the one parser (`GatewayHttp.authMe`).
 */
import { describe, expect, it } from 'vitest'

import { startFakeGateway } from '@hermie/fake-gateway'
import {
  authorLabel,
  authorViaOf as engineAuthorViaOf,
  rowsToItems,
  type TranscriptRow,
  type UserItem
} from '@hermie/transcript'

import { authorIdOf, authorStampOf, authorViaOf, AUTHOR_VIA_CLIENT_LIMIT, ownAuthorOf } from './author-id'
import type { CredentialProvider } from './credentials'
import type { FetchLike } from './fetch-json'
import { GatewayHttp } from './http'

const anonymous: CredentialProvider = {
  mode: 'session_token',
  httpAuthHeaders: async () => ({}),
  dialPlan: async (wsUrl: string) => ({ url: wsUrl, headers: {} }),
  onRejected: async () => 'reauth' as const,
  signOut: async () => undefined
}

async function meFrom(body: Record<string, unknown>) {
  const fetchImpl = (async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })) as unknown as FetchLike

  return new GatewayHttp({ baseUrl: 'http://gateway.test', credentials: anonymous, fetchImpl }).authMe()
}

const ME_BODY = {
  user_id: '7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
  email: 'alex@example.test',
  display_name: 'Alex Moreno',
  org_id: '',
  provider: 'authentik',
  expires_at: 1_790_000_000
}

describe('authorIdOf', () => {
  it('builds `<provider>:<user_id>` from an OIDC `/api/auth/me` answer', async () => {
    expect(authorIdOf(await meFrom(ME_BODY))).toBe('authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40')
  })

  it('builds `basic:alice` for a basic-auth login, keeping it apart from an OIDC `alice`', async () => {
    const basic = authorIdOf(await meFrom({ ...ME_BODY, user_id: 'alice', provider: 'basic' }))
    const oidc = authorIdOf(await meFrom({ ...ME_BODY, user_id: 'alice', provider: 'authentik' }))

    expect(basic).toBe('basic:alice')
    expect(oidc).toBe('authentik:alice')
  })

  it('strips surrounding whitespace from both halves, as the gateway does, and nothing else', async () => {
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: '  Alice \n', provider: '\tAuthentik ' }))).toBe(
      'Authentik:Alice'
    )
  })

  it('keeps case exactly: the gateway never folds it', async () => {
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: 'Alice', provider: 'Basic' }))).toBe('Basic:Alice')
  })

  it('strips the separators Python strips and JavaScript does not, and keeps the BOM Python keeps', () => {
    // `str.strip()` strips U+001C..U+001F and U+0085; `String.prototype.trim`
    // does not. `trim` strips U+FEFF; `str.strip()` does not.
    expect(authorIdOf({ provider: '\u001cbasic\u0085', userId: '\u001falice' })).toBe('basic:alice')
    expect(authorIdOf({ provider: 'basic', userId: '\uFEFFalice' })).toBe('basic:\uFEFFalice')
  })

  it('has no id when the provider is missing, rather than falling back to the email', async () => {
    const { provider: _provider, ...withoutProvider } = ME_BODY

    expect(authorIdOf(await meFrom(withoutProvider))).toBeUndefined()
    expect(authorIdOf(await meFrom({ ...ME_BODY, provider: '   ' }))).toBeUndefined()
  })

  it('has no id when the user id is missing, rather than falling back to the email', async () => {
    const { user_id: _userId, ...withoutUser } = ME_BODY

    expect(authorIdOf(await meFrom(withoutUser))).toBeUndefined()
    expect(authorIdOf(await meFrom({ ...ME_BODY, user_id: '' }))).toBeUndefined()
  })
})

describe('ownAuthorOf', () => {
  it('carries the display name the gateway stamps beside the id, stripped', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, display_name: ' Alex Moreno ' }))).toEqual({
      id: 'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40',
      name: 'Alex Moreno'
    })
  })

  it('omits the name rather than carrying an empty one, and never borrows the email for it', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, display_name: '' }))).toEqual({
      id: 'authentik:7f3a9c21-0b4e-4d2a-9f61-3c5e8a7b1d40'
    })
  })

  it('is nothing at all when there is no id to carry', async () => {
    expect(ownAuthorOf(await meFrom({ ...ME_BODY, provider: '' }))).toBeUndefined()
  })

  it('never carries an agent marker: the reader typing is never an agent', async () => {
    expect(ownAuthorOf(await meFrom(ME_BODY))).not.toHaveProperty('via')
  })
})

/*
  The agent marker (`display_metadata.author.via`, `replayed_by.via`; contract/gateway/mcp.md). The
  gateway stamps the person with `via` beside them when an agent sent the turn on their behalf.
*/
describe('authorViaOf', () => {
  it('reads kind and client and ignores the keys it does not know', () => {
    expect(authorViaOf({ kind: 'mcp', client: 'Claude Code', version: '2.1', extra: { a: 1 } })).toEqual({
      kind: 'mcp',
      client: 'Claude Code'
    })
  })

  it('is no marker for a value that is not an object with a string kind and a client that says something', () => {
    for (const value of [
      undefined,
      null,
      'mcp',
      7,
      [],
      {},
      { kind: 'mcp' },
      { client: 'x' },
      { kind: 7, client: 'x' }
    ]) {
      expect(authorViaOf(value)).toBeUndefined()
    }

    expect(authorViaOf({ kind: 'mcp', client: ' \u200b\n ' })).toBeUndefined()
    expect(authorViaOf({ kind: 'mcp', client: 7 })).toBeUndefined()
  })

  it('cleans the client to one plain line of at most 80 code points', () => {
    expect(authorViaOf({ kind: 'mcp', client: 'Claude\u202e \u200bCode\n*Pro*' })?.client).toBe('Claude Code *Pro*')
    expect(Array.from(authorViaOf({ kind: 'mcp', client: '𝒞'.repeat(200) })?.client ?? '')).toHaveLength(
      AUTHOR_VIA_CLIENT_LIMIT
    )
  })

  it('reads every marker the way the transcript engine reads it on a history row', () => {
    for (const via of [
      { kind: 'mcp', client: 'Claude Code', version: '2.1' },
      { kind: ' mcp ', client: '  Claude   Code  ' },
      { kind: 'mcp', client: 'Claude\u202e \u200bCode\n*Pro*' },
      { kind: 'mcp', client: '𝒞'.repeat(200) },
      { kind: 'mcp', client: ' \u200b ' },
      { kind: 'mcp', client: 7 },
      'mcp',
      null
    ]) {
      const row = { role: 'user', row_id: 1, text: 'hi', display_metadata: { author: { id: 'a:1', via } } }
      const fromRow = (rowsToItems([row], 'rpc')[0] as UserItem).author?.via

      expect(authorViaOf(via)).toEqual(fromRow)
      expect(engineAuthorViaOf(via)).toEqual(fromRow)
    }
  })
})

describe('an agent’s turn through the fake gateway', () => {
  it('reaches the engine as the person, marked, and labelled `<name> via <client>`', async () => {
    const gateway = await startFakeGateway({ port: 0 })

    try {
      const injected = await fetch(`${gateway.url}/__fake/inject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: 'researcher',
          user: 'summarise the open pull requests',
          assistant: 'Three are open.',
          author: { id: 'authentik:robin', name: 'Robin', via: { kind: 'mcp', client: 'Claude Code' } },
          replayed_by: { id: 'authentik:sam', name: 'Sam', via: { kind: 'mcp', client: 'Claude Code' } },
          stream: false
        })
      }).then(response => response.json() as Promise<{ stored_session_id: string }>)

      const history = await fetch(
        `${gateway.url}/api/sessions/${injected.stored_session_id}/messages?order=latest&limit=2`
      ).then(response => response.json() as Promise<{ messages: TranscriptRow[] }>)
      const user = rowsToItems(history.messages, 'rest').find((item): item is UserItem => item.kind === 'user')

      expect(history.messages.map(row => row.role)).toContain('user')

      expect(user?.author).toEqual({
        id: 'authentik:robin',
        name: 'Robin',
        via: { kind: 'mcp', client: 'Claude Code' }
      })
      expect(user?.replayedBy?.via).toEqual({ kind: 'mcp', client: 'Claude Code' })
      expect(authorLabel(user?.author, user?.author?.name ?? '')).toBe('Robin via Claude Code')
      // The stamp read from the raw row says the same as the engine does.
      const metadata = history.messages.find(row => row.role === 'user')?.display_metadata as { author?: unknown }

      expect(authorStampOf(metadata.author)).toEqual(user?.author)
    } finally {
      await gateway.close()
    }
  })
})

describe('authorStampOf', () => {
  it('reads the person and the marker beside them', () => {
    expect(authorStampOf({ id: 'oidc:user-a', name: 'Robin', via: { kind: 'mcp', client: 'Claude Code' } })).toEqual({
      id: 'oidc:user-a',
      name: 'Robin',
      via: { kind: 'mcp', client: 'Claude Code' }
    })
  })

  it('reads a person without a marker as the stamp always was', () => {
    expect(authorStampOf({ id: 'oidc:user-a', name: 'Robin' })).toEqual({ id: 'oidc:user-a', name: 'Robin' })
    expect(authorStampOf({ id: 'oidc:user-a' })).toEqual({ id: 'oidc:user-a' })
  })

  it('ignores keys it does not know, on the author and inside `via`', () => {
    expect(
      authorStampOf({ id: 'oidc:user-a', locale: 'nl', via: { kind: 'mcp', client: 'Claude Code', version: '2.1' } })
    ).toEqual({ id: 'oidc:user-a', via: { kind: 'mcp', client: 'Claude Code' } })
  })

  it('loses a malformed marker on its own and keeps the person', () => {
    expect(authorStampOf({ id: 'oidc:user-a', name: 'Robin', via: 'mcp' })).toEqual({
      id: 'oidc:user-a',
      name: 'Robin'
    })
    expect(authorStampOf({ id: 'oidc:user-a', via: { kind: 'mcp', client: ' ' } })).toEqual({ id: 'oidc:user-a' })
  })

  it('is no author without a usable id, or with a name of another type, and never an author of a marker alone', () => {
    for (const value of [
      null,
      'oidc:user-a',
      [],
      {},
      { id: '' },
      { id: 7 },
      { id: 'oidc:user-a', name: 7 },
      { via: { kind: 'mcp', client: 'Claude Code' } }
    ]) {
      expect(authorStampOf(value)).toBeUndefined()
    }
  })
})
