/**
 * The picture cache behind an Account avatar and a colleague's, in the group
 * chat (HERM-120) — the rules the ticket calls out by name: dedupe a
 * concurrent request, never refetch a cached miss, and never let two gateways
 * share a picture through the same key.
 */
import {
  personPictureKey,
  personPictureUri,
  usePeoplePicturesStore,
  type PictureFetchOutcome
} from '../src/features/people/people-pictures'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })

  return { promise, resolve }
}

beforeEach(() => {
  usePeoplePicturesStore.getState().reset()
})

describe('personPictureKey', () => {
  it('scopes the same path to different gateways separately', () => {
    expect(personPictureKey('gw-a', '/api/auth/picture?id=x')).not.toBe(
      personPictureKey('gw-b', '/api/auth/picture?id=x')
    )
  })
})

describe('usePeoplePicturesStore.ensure', () => {
  it('fetches once, caches the result, and answers a ready picture', async () => {
    const fetchAuthenticatedPicture = jest.fn(async (): Promise<PictureFetchOutcome> => ({
      kind: 'ready',
      dataUri: 'data:image/png;base64,AAAA'
    }))
    const key = personPictureKey('gw-a', '/api/auth/picture?id=x')

    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')

    // Synchronously, before the fetch resolves: the cache already reads 'loading'.
    expect(usePeoplePicturesStore.getState().byKey[key]).toBe('loading')

    await Promise.resolve().then(() => Promise.resolve())

    expect(personPictureUri(usePeoplePicturesStore.getState().byKey[key])).toBe('data:image/png;base64,AAAA')
    expect(fetchAuthenticatedPicture).toHaveBeenCalledTimes(1)
  })

  it('dedupes two concurrent calls for the same key into one fetch', async () => {
    const { promise, resolve } = deferred<PictureFetchOutcome>()
    const fetchAuthenticatedPicture = jest.fn(() => promise)
    const key = personPictureKey('gw-a', '/api/auth/picture?id=x')

    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')
    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')

    expect(fetchAuthenticatedPicture).toHaveBeenCalledTimes(1)

    resolve({ kind: 'ready', dataUri: 'data:image/png;base64,AAAA' })
    await promise
  })

  it('caches a 404 as unavailable and never asks again', async () => {
    const fetchAuthenticatedPicture = jest.fn(async (): Promise<PictureFetchOutcome> => ({ kind: 'missing' }))
    const key = personPictureKey('gw-a', '/api/auth/picture?id=nobody')

    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=nobody')
    await Promise.resolve().then(() => Promise.resolve())

    expect(usePeoplePicturesStore.getState().byKey[key]).toBe('unavailable')
    expect(personPictureUri(usePeoplePicturesStore.getState().byKey[key])).toBeUndefined()

    // A caller asking again — a re-render, a remount — must not refetch.
    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=nobody')
    expect(fetchAuthenticatedPicture).toHaveBeenCalledTimes(1)
  })

  it('caches any other failure the same way as a 404', async () => {
    const fetchAuthenticatedPicture = jest.fn(async (): Promise<PictureFetchOutcome> => ({ kind: 'error' }))
    const key = personPictureKey('gw-a', '/api/auth/picture?id=x')

    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')
    await Promise.resolve().then(() => Promise.resolve())

    expect(usePeoplePicturesStore.getState().byKey[key]).toBe('unavailable')
  })

  it('never mixes two gateways’ pictures for the same author id', async () => {
    const pictureFor = (dataUri: string) =>
      jest.fn(async (): Promise<PictureFetchOutcome> => ({ kind: 'ready', dataUri }))
    const path = '/api/auth/picture?id=self-hosted%3Asam-sub'
    const keyA = personPictureKey('gw-a', path)
    const keyB = personPictureKey('gw-b', path)

    usePeoplePicturesStore
      .getState()
      .ensure(keyA, { fetchAuthenticatedPicture: pictureFor('data:image/png;base64,A') }, path)
    usePeoplePicturesStore
      .getState()
      .ensure(keyB, { fetchAuthenticatedPicture: pictureFor('data:image/png;base64,B') }, path)
    await Promise.resolve().then(() => Promise.resolve())

    expect(personPictureUri(usePeoplePicturesStore.getState().byKey[keyA])).toBe('data:image/png;base64,A')
    expect(personPictureUri(usePeoplePicturesStore.getState().byKey[keyB])).toBe('data:image/png;base64,B')
  })

  it('reset() clears the cache, so the next ensure fetches again', async () => {
    const fetchAuthenticatedPicture = jest.fn(async (): Promise<PictureFetchOutcome> => ({ kind: 'missing' }))
    const key = personPictureKey('gw-a', '/api/auth/picture?id=x')

    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')
    await Promise.resolve().then(() => Promise.resolve())
    usePeoplePicturesStore.getState().reset()
    usePeoplePicturesStore.getState().ensure(key, { fetchAuthenticatedPicture }, '/api/auth/picture?id=x')

    expect(fetchAuthenticatedPicture).toHaveBeenCalledTimes(2)
  })
})
