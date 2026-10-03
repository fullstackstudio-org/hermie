import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ADMIN_STATE_FILE,
  ADMIN_STATE_VERSION,
  adminStateOf,
  adminStateSettled,
  emptyAdminState,
  loadAdminState,
  saveAdminState
} from './state'

describe('saveAdminState', () => {
  const made: string[] = []

  async function freshDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'hermie-admin-state-'))

    made.push(dir)

    return dir
  }

  afterEach(async () => {
    await Promise.all(made.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  })

  it('lands overlapping writes in the order they were asked for, so the last one wins on disk', async () => {
    const stateDir = path.join(await freshDir(), 'state')
    // Many writes fired at once, none awaited before the next is asked for:
    // the shape `noteSeen` plus an `/admin` save takes, only harder.
    const writes = Array.from({ length: 40 }, (_, index) =>
      saveAdminState(stateDir, { ...emptyAdminState(), admins: [`admin-${index}@example.invalid`] })
    )

    // Every one of them succeeds: none trips over a temp file another renamed.
    await expect(Promise.all(writes)).resolves.toHaveLength(40)
    expect((await loadAdminState(stateDir)).admins).toEqual(['admin-39@example.invalid'])
    // And nothing is left behind beside the file.
    expect(await readdir(stateDir)).toEqual([ADMIN_STATE_FILE])
  })

  it('writes the state as it was at the call, not as it is when the chain gets to it', async () => {
    const stateDir = await freshDir()
    const state = { ...emptyAdminState(), admins: ['ada@example.invalid'] }
    const first = saveAdminState(stateDir, { ...emptyAdminState(), admins: ['grace@example.invalid'] })
    const second = saveAdminState(stateDir, state)

    state.admins = ['mallory@example.invalid']
    await Promise.all([first, second])

    expect((await loadAdminState(stateDir)).admins).toEqual(['ada@example.invalid'])
  })

  it('keeps going after a write that failed, and rejects only the one that did', async () => {
    const parent = await freshDir()
    // A FILE where the state directory should be, so `mkdir` fails.
    const stateDir = path.join(parent, 'state')

    await writeFile(stateDir, 'not a directory', 'utf8')

    const failing = saveAdminState(stateDir, { ...emptyAdminState(), admins: ['lost@example.invalid'] })
    const queuedBehind = saveAdminState(stateDir, { ...emptyAdminState(), admins: ['also-lost@example.invalid'] })

    await expect(failing).rejects.toThrow()
    await expect(queuedBehind).rejects.toThrow()
    // The chain settles rather than holding a rejection for the next caller.
    await expect(adminStateSettled(stateDir)).resolves.toBeUndefined()

    await rm(stateDir)
    await saveAdminState(stateDir, { ...emptyAdminState(), admins: ['ada@example.invalid'] })

    expect((await loadAdminState(stateDir)).admins).toEqual(['ada@example.invalid'])
    expect(await readdir(stateDir)).toEqual([ADMIN_STATE_FILE])
  })

  it('lets a caller that did not await a write wait for the file to catch up', async () => {
    const stateDir = await freshDir()

    void saveAdminState(stateDir, { ...emptyAdminState(), admins: ['ada@example.invalid'] })
    await adminStateSettled(stateDir)

    expect((await loadAdminState(stateDir)).admins).toEqual(['ada@example.invalid'])
    // Nothing pending answers at once.
    await expect(adminStateSettled(stateDir)).resolves.toBeUndefined()
  })
})

describe('adminStateOf', () => {
  it('answers empty defaults for nothing at all', () => {
    expect(adminStateOf(undefined)).toEqual(emptyAdminState())
    expect(adminStateOf(null)).toEqual(emptyAdminState())
  })

  it('reads a file written before managedAdmins existed as nobody being env-managed', () => {
    const old = {
      v: ADMIN_STATE_VERSION,
      admins: ['ada@example.invalid', 'grace@example.invalid']
      // No `managedAdmins` key at all — this is the shape every file had
      // before it. Absent reads as `[]`: the feature that would have put an
      // id there did not exist yet, so nothing is there because of it.
    }

    const migrated = adminStateOf(old)

    expect(migrated.admins).toEqual(['ada@example.invalid', 'grace@example.invalid'])
    expect(migrated.managedAdmins).toEqual([])
  })

  it('reads managedAdmins literally once the field exists, and intersects it with admins', () => {
    const raw = {
      v: ADMIN_STATE_VERSION,
      admins: ['ada@example.invalid', 'grace@example.invalid'],
      // Only grace is env-managed; ada is here some other way.
      managedAdmins: ['grace@example.invalid', 'somebody-not-an-admin@example.invalid']
    }

    const parsed = adminStateOf(raw)

    expect(parsed.admins).toEqual(['ada@example.invalid', 'grace@example.invalid'])
    // The id managedAdmins named that is not actually an administrator is
    // dropped — a hand-edited file cannot claim that provenance for somebody
    // who is not even on the list.
    expect(parsed.managedAdmins).toEqual(['grace@example.invalid'])
  })

  it('an empty admin state has nothing managed', () => {
    expect(emptyAdminState().managedAdmins).toEqual([])
  })
})
