/**
 * The two lists, which are one list.
 *
 * `reconcileIssuerPeople` is exercised directly here — it is a pure transition
 * and every interesting case is a state, not a request — and then once end to
 * end through the real server, because the claim that matters is not "the
 * function is right" but "an account created on `/admin/oidc` is on `/admin`".
 *
 * Every transition in the round trip is a separate assertion rather than one
 * long walk, because the failure this guards against is one of them silently
 * doing nothing.
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startHermieWeb, type HermieWebServer } from '../server'
import { createAccount, enableProvider, removeAccount, setAccountRole } from '../oidc/accounts'
import { emptyOidcState, type OidcState } from '../oidc/state'
import { reconcileIssuerPeople } from './people'
import { adminStateSettled, emptyAdminState, loadAdminState, saveAdminState, type AdminState } from './state'

const GATEWAY_PUBLIC_URL = 'https://hermes.example.invalid'

/** An enabled provider with the accounts named, and nothing else. */
function issuerWith(accounts: { username: string; role: 'admin' | 'user' }[]): OidcState {
  let state = enableProvider(emptyOidcState(), {
    origin: 'https://hermie.example.invalid',
    gatewayPublicUrl: GATEWAY_PUBLIC_URL,
    allowInsecure: false
  })

  for (const account of accounts) {
    state = createAccount(state, {
      username: account.username,
      email: `${account.username}@example.invalid`,
      displayName: '',
      role: account.role,
      password: 'a password long enough to be one'
    }).state
  }

  return state
}

const subOf = (oidc: OidcState, username: string): string =>
  oidc.users.find(user => user.username === username)?.sub ?? ''

describe('reconcileIssuerPeople', () => {
  it('gives every account a row and puts the administrators on the list', () => {
    const oidc = issuerWith([
      { username: 'ada', role: 'admin' },
      { username: 'grace', role: 'user' }
    ])
    const state = reconcileIssuerPeople(emptyAdminState(), oidc)

    expect(Object.keys(state.users).sort()).toEqual([subOf(oidc, 'ada'), subOf(oidc, 'grace')].sort())
    expect(state.admins).toEqual([subOf(oidc, 'ada')])
    // A row that exists because an account does says so, and has never been seen.
    expect(state.users[subOf(oidc, 'ada')]).toMatchObject({ fromIssuer: true, seenAt: 0, email: 'ada@example.invalid' })
  })

  it('answers the same object when there is nothing to do, so nothing is rewritten', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'admin' }])
    const once = reconcileIssuerPeople(emptyAdminState(), oidc)

    expect(reconcileIssuerPeople(once, oidc)).toBe(once)
  })

  it('follows a role in both directions', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'user' }])
    const sub = subOf(oidc, 'ada')
    const asUser = reconcileIssuerPeople(emptyAdminState(), oidc)

    expect(asUser.admins).toEqual([])

    const promoted = reconcileIssuerPeople(asUser, setAccountRole(oidc, sub, 'admin'))

    expect(promoted.admins).toEqual([sub])
    expect(reconcileIssuerPeople(promoted, setAccountRole(oidc, sub, 'user')).admins).toEqual([])
  })

  it('takes a deleted account off both lists when nobody ever signed in as it', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'admin' }])
    const sub = subOf(oidc, 'ada')
    const before = reconcileIssuerPeople(emptyAdminState(), oidc)
    const after = reconcileIssuerPeople(before, removeAccount(oidc, sub))

    expect(after.admins).toEqual([])
    expect(after.users[sub]).toBeUndefined()
  })

  it('keeps the row of somebody who did sign in, and stops calling it an account', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'admin' }])
    const sub = subOf(oidc, 'ada')
    const seen = reconcileIssuerPeople(emptyAdminState(), oidc)
    const held = seen.users[sub]

    expect(held).toBeDefined()

    const visited: AdminState = { ...seen, users: { ...seen.users, [sub]: { ...held!, seenAt: 1_700_000_000 } } }
    const after = reconcileIssuerPeople(visited, removeAccount(oidc, sub))

    // The visit happened; deleting the account does not unhappen it.
    expect(after.users[sub]?.seenAt).toBe(1_700_000_000)
    expect(after.users[sub]?.fromIssuer).toBe(false)
    // But nothing can authenticate as that id any more, so it is not an
    // administrator of anything.
    expect(after.admins).toEqual([])
  })

  it('never touches an id no account claims', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'user' }])
    const held: AdminState = {
      ...emptyAdminState(),
      admins: ['someone@example.org'],
      users: {
        'someone@example.org': {
          userId: 'someone@example.org',
          displayName: 'Someone Else',
          email: '',
          seenAt: 0,
          allowedBots: null,
          readOnly: false,
          pushAllowed: true
        }
      }
    }
    const after = reconcileIssuerPeople(held, oidc)

    // Never seen, no account — and still here, because nothing here created it.
    expect(after.users['someone@example.org']).toBeDefined()
    expect(after.admins).toContain('someone@example.org')
  })

  it('changes nothing at all while the provider is off', () => {
    const oidc = issuerWith([{ username: 'ada', role: 'admin' }])
    const off: OidcState = { ...oidc, enabled: false }
    const held = emptyAdminState()

    /*
      Not merely "correct": an operator who turns the provider off to test
      something must not discover that they are no longer an administrator of
      the service they turned it off from.
    */
    expect(reconcileIssuerPeople(held, off)).toBe(held)
  })
})

describe('an account on the issuer is a person on the people list', () => {
  const ADA = { username: 'ada', password: 'hunter2', userId: 'ada@example.invalid', displayName: 'Ada Lovelace' }

  let gateway: FakeGateway
  let web: HermieWebServer
  let stateDir: string

  /** Sign in to the gateway, which is what the `/admin` gate checks. */
  async function signIn(): Promise<string> {
    const login = await fetch(`${web.url}/auth/password-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'self-hosted', ...ADA, next: '/' })
    })

    return (login.headers.get('set-cookie') ?? '').split(';')[0] as string
  }

  async function open(cookie: string, at: string): Promise<{ body: string; cookie: string; csrf: string }> {
    const response = await fetch(`${web.url}${at}`, { headers: { cookie } })
    const body = await response.text()
    const csrf = decodeURIComponent(
      /hermie_admin_csrf=([^;,]*)/.exec(response.headers.get('set-cookie') ?? '')?.[1] ?? ''
    )

    return { body, csrf, cookie: `${cookie}; hermie_admin_csrf=${encodeURIComponent(csrf)}` }
  }

  async function post(at: string, fields: Record<string, string>): Promise<string> {
    const page = await open(await signIn(), '/admin/people')
    const response = await fetch(`${web.url}${at}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: page.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: page.csrf, ...fields }).toString()
    })

    return new URL(response.headers.get('location') ?? '/', web.url).searchParams.get('notice') ?? ''
  }

  const subFor = (username: string): string => web.oidc.users.find(user => user.username === username)?.sub ?? ''

  beforeAll(async () => {
    const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-people-static-'))
    await mkdir(staticDir, { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

    stateDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-people-state-'))
    await saveAdminState(stateDir, { ...emptyAdminState(), admins: [ADA.userId] })

    gateway = await startFakeGateway({ port: 0, auth: 'cookie', accounts: [ADA], streamDelayMs: 1 })
    web = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir,
      stateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })

    await web.oidc.update(state =>
      enableProvider(state, { origin: web.url, gatewayPublicUrl: GATEWAY_PUBLIC_URL, allowInsecure: false })
    )
  })

  afterAll(async () => {
    await web.close()
    await gateway.close()
  })

  it('shows an account created as an administrator on both lists, at once', async () => {
    await post('/admin/oidc/user', { do: 'create', username: 'katherine', role: 'admin' })

    const sub = subFor('katherine')
    const state = await loadAdminState(stateDir)

    expect(sub).toBeTruthy()
    expect(state.admins).toContain(sub)
    expect(state.users[sub]).toMatchObject({ fromIssuer: true, displayName: 'katherine' })

    const page = await open(await signIn(), '/admin/people')

    expect(page.body).toContain(sub)
    expect(page.body).toContain('katherine')
    // The row says where the person came from, and the source is the way to the
    // page that owns them. The subject id is not on the line any more — it is on
    // the pointer and in the panel, which is what the two assertions above see.
    expect(page.body).toContain('<a href="/admin/oidc">account on this service</a>')
    expect(page.body).toContain(`title="${sub}"`)
    // The administrator's own gateway id is still there beside it.
    expect(page.body).toContain(ADA.userId)
  })

  it('follows a role changed on the identity page', async () => {
    const sub = subFor('katherine')

    await post('/admin/oidc/user', { do: 'role', sub, role: 'user' })
    expect((await loadAdminState(stateDir)).admins).not.toContain(sub)

    await post('/admin/oidc/user', { do: 'role', sub, role: 'admin' })
    expect((await loadAdminState(stateDir)).admins).toContain(sub)
  })

  it('changes the ACCOUNT’s role when the box is cleared on the people page', async () => {
    const sub = subFor('katherine')

    await post('/admin/user', { userId: sub, pushAllowed: '1' })

    // The role moved, not just this service's list — so the identity page and
    // the people page cannot end up disagreeing.
    expect(web.oidc.users.find(user => user.sub === sub)?.role).toBe('user')
    expect((await loadAdminState(stateDir)).admins).not.toContain(sub)

    await post('/admin/user', { userId: sub, admin: '1', pushAllowed: '1' })

    expect(web.oidc.users.find(user => user.sub === sub)?.role).toBe('admin')
    expect((await loadAdminState(stateDir)).admins).toContain(sub)
  })

  it('keeps the per-person options a row carries, which are this service’s own', async () => {
    const sub = subFor('katherine')

    await post('/admin/user', { userId: sub, admin: '1', allowedBots: 'researcher', readOnly: '1' })

    const row = (await loadAdminState(stateDir)).users[sub]

    expect(row).toMatchObject({ allowedBots: ['researcher'], readOnly: true, pushAllowed: false, fromIssuer: true })
    // And the role survived a save that was not about it.
    expect(web.oidc.users.find(user => user.sub === sub)?.role).toBe('admin')
  })

  it('takes the account off both lists when it is deleted', async () => {
    const sub = subFor('katherine')

    await post('/admin/oidc/user', { do: 'remove', sub })

    const state = await loadAdminState(stateDir)

    expect(state.admins).not.toContain(sub)
    expect(state.users[sub]).toBeUndefined()
    expect((await open(await signIn(), '/admin/people')).body).not.toContain(sub)
  })

  it('says when a gateway sign-in and an account here share a username, and merges neither', async () => {
    /*
      The owner's own deployment, in one test: a gateway that authenticates `max`
      with its own password file, and an account called `max` on the built-in
      issuer. They are two identities as far as the gateway is concerned — two
      `Session.user_id`s — so the list keeps two rows and says why.
    */
    await post('/admin/oidc/user', { do: 'create', username: 'ada', role: 'user' })

    // The gateway's own row exists once this service has seen her use it.
    await fetch(`${web.url}/api/auth/me`, { headers: { cookie: await signIn() } })

    const sub = subFor('ada')
    const page = await open(await signIn(), '/admin/people')
    // The row is written to memory as the request is served and to the file
    // just behind it, without being awaited. That write is queued on the
    // file's write chain by the time the response is out, so waiting for the
    // chain is enough; no polling.
    await adminStateSettled(stateDir)
    const state = await loadAdminState(stateDir)

    expect(Object.keys(state.users)).toContain(ADA.userId)
    expect(Object.keys(state.users)).toContain(sub)
    expect(page.body).toContain('same username as the account on this service')
    expect(page.body).toContain('same username as the gateway sign-in')

    await post('/admin/oidc/user', { do: 'remove', sub })
  })

  it('reconciles a state directory written before the two lists were one', async () => {
    /*
      The migration, run the way it actually runs: a second server over the same
      state directory, with an account on the issuer that the people list has
      never heard of.
    */
    await web.oidc.update(state => {
      const created = createAccount(state, {
        username: 'dorothy',
        email: 'dorothy@example.invalid',
        displayName: 'Dorothy V',
        role: 'admin',
        password: 'a password long enough to be one'
      })

      return created.state
    })

    const sub = subFor('dorothy')
    const held = await loadAdminState(stateDir)

    // Undo the reconcile on disk, which is what an older deployment's file is.
    await saveAdminState(stateDir, {
      ...held,
      admins: held.admins.filter(id => id !== sub),
      users: Object.fromEntries(Object.entries(held.users).filter(([id]) => id !== sub))
    })

    const staticDir = await mkdtemp(path.join(tmpdir(), 'hermie-web-people-restart-'))
    await mkdir(staticDir, { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>Hermie</title>', 'utf8')

    const restarted = await startHermieWeb({
      gatewayUrl: gateway.url,
      port: 0,
      staticDir,
      stateDir,
      version: '9.9.9',
      selfUpdate: false,
      env: {}
    })

    try {
      const after = await loadAdminState(stateDir)

      expect(after.admins).toContain(sub)
      expect(after.users[sub]).toMatchObject({ fromIssuer: true, displayName: 'Dorothy V' })
    } finally {
      await restarted.close()
    }
  })
})
