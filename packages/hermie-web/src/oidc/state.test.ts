import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ADMIN_STATE_FILE, emptyAdminState, loadAdminState, saveAdminState } from '../admin/state'
import {
  emptyOidcState,
  loadOidcState,
  OIDC_STATE_FILE,
  oidcStatePath,
  oidcStateSettled,
  saveOidcState,
  type OidcState
} from './state'

const issuedBy = (issuer: string): OidcState => ({ ...emptyOidcState(), issuer })

describe('saveOidcState', () => {
  const made: string[] = []

  async function freshDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'hermie-oidc-state-'))

    made.push(dir)

    return dir
  }

  afterEach(async () => {
    await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('lands overlapping writes in the order they were asked for, so the last one wins on disk', async () => {
    const stateDir = path.join(await freshDir(), 'state')
    const writes = Array.from({ length: 40 }, (_, index) =>
      saveOidcState(stateDir, issuedBy(`https://issuer-${index}.example.invalid`))
    )

    // Every one of them succeeds: none trips over a temp file another renamed.
    await expect(Promise.all(writes)).resolves.toHaveLength(40)
    expect((await loadOidcState(stateDir)).issuer).toBe('https://issuer-39.example.invalid')
    // Nothing is left behind beside the file, and the file holds a signing key.
    expect(await readdir(stateDir)).toEqual([OIDC_STATE_FILE])
    expect((await stat(oidcStatePath(stateDir))).mode & 0o777).toBe(0o600)
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700)
  })

  it('writes the state as it was at the call, not as it is when the chain gets to it', async () => {
    const stateDir = await freshDir()
    const state = issuedBy('https://ada.example.invalid')
    const first = saveOidcState(stateDir, issuedBy('https://grace.example.invalid'))
    const second = saveOidcState(stateDir, state)

    state.issuer = 'https://mallory.example.invalid'
    await Promise.all([first, second])

    expect((await loadOidcState(stateDir)).issuer).toBe('https://ada.example.invalid')
  })

  it('keeps going after a write that failed, and rejects only the one that did', async () => {
    const parent = await freshDir()
    // A FILE where the state directory should be, so `mkdir` fails.
    const stateDir = path.join(parent, 'state')

    await writeFile(stateDir, 'not a directory', 'utf8')

    const failing = saveOidcState(stateDir, issuedBy('https://lost.example.invalid'))
    const queuedBehind = saveOidcState(stateDir, issuedBy('https://also-lost.example.invalid'))

    await expect(failing).rejects.toThrow()
    await expect(queuedBehind).rejects.toThrow()
    // The chain settles rather than holding a rejection for the next caller.
    await expect(oidcStateSettled(stateDir)).resolves.toBeUndefined()

    await rm(stateDir)
    await saveOidcState(stateDir, issuedBy('https://ada.example.invalid'))

    expect((await loadOidcState(stateDir)).issuer).toBe('https://ada.example.invalid')
    expect(await readdir(stateDir)).toEqual([OIDC_STATE_FILE])
  })

  it('lets a caller that did not await a write wait for the file to catch up', async () => {
    const stateDir = await freshDir()

    void saveOidcState(stateDir, issuedBy('https://ada.example.invalid'))
    await oidcStateSettled(stateDir)

    expect((await loadOidcState(stateDir)).issuer).toBe('https://ada.example.invalid')
    // Nothing pending answers at once.
    await expect(oidcStateSettled(stateDir)).resolves.toBeUndefined()
  })

  it('keeps its chain apart from admin.json beside it', async () => {
    const stateDir = await freshDir()

    await Promise.all([
      saveOidcState(stateDir, issuedBy('https://ada.example.invalid')),
      saveAdminState(stateDir, { ...emptyAdminState(), admins: ['ada@example.invalid'] })
    ])

    expect((await loadOidcState(stateDir)).issuer).toBe('https://ada.example.invalid')
    expect((await loadAdminState(stateDir)).admins).toEqual(['ada@example.invalid'])
    expect((await readdir(stateDir)).sort()).toEqual([ADMIN_STATE_FILE, OIDC_STATE_FILE].sort())
  })
})
