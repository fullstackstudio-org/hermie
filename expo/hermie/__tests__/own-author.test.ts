/**
 * HERM-83 polish: the reader's own author, remembered on disk per gateway so a
 * cold open does not have to guess "everything is mine" for the stretch before
 * `/api/auth/me` answers. See `own-author.ts`'s module comment for the jank
 * this replaces and why the id on disk is a guess to show, never a trust.
 */
import { namespace } from '../src/gateway/namespace'
import { OWN_AUTHOR_KEY, useOwnAuthorStore } from '../src/features/chats/own-author'
import { keyValueStore } from '../src/platform/key-value-store'

beforeEach(async () => {
  useOwnAuthorStore.getState().reset()
  await keyValueStore.deleteMany(await keyValueStore.keys())
})

/**
 * `set` queues its disk write on a serialised writeQueue rather than awaiting
 * it — the caller (a `readIdentity` answer, a sign-out) has nothing to await
 * it FOR — so a test standing in for "the app was restarted" has to let that
 * queue drain first, the way an actual restart always would.
 */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('persisting the reader’s own author', () => {
  it('writes what `set` confirms, and a fresh gateway bind reads it back', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:alex', name: 'Alex Moreno' })
    await flush()

    // A cold restart: nothing left in memory, only what made it to disk.
    useOwnAuthorStore.getState().reset()
    await useOwnAuthorStore.getState().hydrate(namespace('gateway-one'))

    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({
      id: 'authentik:alex',
      name: 'Alex Moreno'
    })
  })

  it('deletes the stored id once `set` is told there is none', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:alex' })
    useOwnAuthorStore.getState().set('gateway-one', undefined)
    await flush()
    useOwnAuthorStore.getState().reset()

    await useOwnAuthorStore.getState().hydrate(namespace('gateway-one'))

    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toBeUndefined()
  })

  it('keeps two gateways’ remembered ids apart on disk', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:alex' })
    useOwnAuthorStore.getState().set('gateway-two', { id: 'authentik:bailey' })
    await flush()
    useOwnAuthorStore.getState().reset()

    await Promise.all([
      useOwnAuthorStore.getState().hydrate(namespace('gateway-one')),
      useOwnAuthorStore.getState().hydrate(namespace('gateway-two'))
    ])

    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({ id: 'authentik:alex' })
    expect(useOwnAuthorStore.getState().byGateway['gateway-two']).toEqual({ id: 'authentik:bailey' })
  })

  it('never lets a disk read clobber an answer already confirmed in memory', async () => {
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:old' })
    useOwnAuthorStore.getState().set('gateway-one', { id: 'authentik:new' })

    await useOwnAuthorStore.getState().hydrate(namespace('gateway-one'))

    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toEqual({ id: 'authentik:new' })
  })

  it('ignores a value on disk that is not a plausible author', async () => {
    await keyValueStore.setJson(namespace('gateway-one').key(OWN_AUTHOR_KEY), { name: 'no id at all' })

    await useOwnAuthorStore.getState().hydrate(namespace('gateway-one'))

    expect(useOwnAuthorStore.getState().byGateway['gateway-one']).toBeUndefined()
  })
})
