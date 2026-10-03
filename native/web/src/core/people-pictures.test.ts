/**
 * The people's pictures: one request per person, a refusal remembered for a while, and a sign-out
 * that leaves nothing behind.
 */
import type { PictureFetchOutcome } from '@hermie/gateway-client'
import { describe, expect, it, vi } from 'vitest'

import {
  createPeoplePictures,
  ERROR_RETRY_MS,
  MAX_PICTURE_CHARS,
  MISSING_RETRY_MS,
  type PeoplePicturesOptions
} from './people-pictures'

const READY = { kind: 'ready', dataUri: 'data:image/png;base64,AAAA' } as const

function harness(answer: (path: string) => PictureFetchOutcome | Promise<PictureFetchOutcome>) {
  let clock = 1_000
  const fetchPicture = vi.fn<PeoplePicturesOptions['fetchPicture']>(async path => answer(path))
  const pictures = createPeoplePictures({ fetchPicture, now: () => clock })

  return {
    pictures,
    fetchPicture,
    advance: (ms: number) => {
      clock += ms
    },
    held: () => pictures.store.getState().pictures,
    settle: () => new Promise<void>(resolve => setTimeout(resolve, 0))
  }
}

describe('createPeoplePictures', () => {
  it('fetches a person through the authenticated picture route and keeps the data URI under their id', async () => {
    const { pictures, fetchPicture, held, settle } = harness(() => READY)

    pictures.request('authentik:robin')
    await settle()

    expect(fetchPicture).toHaveBeenCalledWith('/api/auth/picture?id=authentik%3Arobin')
    expect(held()).toEqual({ 'authentik:robin': READY.dataUri })
  })

  it('asks once however many rows name the same person, while the first answer is in flight and after it', async () => {
    const { pictures, fetchPicture, settle } = harness(() => READY)

    pictures.request('authentik:robin')
    pictures.request('authentik:robin')
    pictures.request('authentik:robin')
    await settle()
    pictures.request('authentik:robin')

    expect(fetchPicture).toHaveBeenCalledTimes(1)
  })

  it('uses the path the gateway named for a picture, but only when it is the picture route', async () => {
    const { pictures, fetchPicture, settle } = harness(() => READY)

    pictures.request('self-hosted:sam', '/api/auth/picture?id=self-hosted%3Asam')
    pictures.request('self-hosted:lee', '/somewhere/else?id=self-hosted%3Alee')
    await settle()

    expect(fetchPicture.mock.calls.map(([path]) => path)).toEqual([
      '/api/auth/picture?id=self-hosted%3Asam',
      '/api/auth/picture?id=self-hosted%3Alee'
    ])
  })

  it('draws nobody for a person the gateway holds no picture of, and does not ask again for a while', async () => {
    const { pictures, fetchPicture, held, advance, settle } = harness(() => ({ kind: 'missing' }))

    pictures.request('authentik:nobody')
    await settle()
    pictures.request('authentik:nobody')
    advance(MISSING_RETRY_MS - 1)
    pictures.request('authentik:nobody')
    await settle()

    expect(held()).toEqual({})
    expect(fetchPicture).toHaveBeenCalledTimes(1)

    advance(2)
    pictures.request('authentik:nobody')
    await settle()

    expect(fetchPicture).toHaveBeenCalledTimes(2)
  })

  it('holds off a gateway that failed for a shorter while than a 404, and then tries again', async () => {
    let answer: PictureFetchOutcome = { kind: 'error' }
    const { pictures, fetchPicture, held, advance, settle } = harness(() => answer)

    pictures.request('authentik:robin')
    await settle()
    pictures.request('authentik:robin')

    expect(fetchPicture).toHaveBeenCalledTimes(1)

    answer = READY
    advance(ERROR_RETRY_MS + 1)
    pictures.request('authentik:robin')
    await settle()

    expect(fetchPicture).toHaveBeenCalledTimes(2)
    expect(held()).toEqual({ 'authentik:robin': READY.dataUri })
  })

  it('treats a request that throws as an error rather than letting it escape', async () => {
    const { pictures, fetchPicture, held, settle } = harness(() => {
      throw new Error('socket hang up')
    })

    pictures.request('authentik:robin')
    await settle()
    pictures.request('authentik:robin')

    expect(held()).toEqual({})
    expect(fetchPicture).toHaveBeenCalledTimes(1)
  })

  it('does not keep a picture bigger than an avatar can be', async () => {
    const { pictures, held, settle } = harness(() => ({
      kind: 'ready',
      dataUri: `data:image/png;base64,${'A'.repeat(MAX_PICTURE_CHARS)}`
    }))

    pictures.request('authentik:robin')
    await settle()

    expect(held()).toEqual({})
  })

  it('forgets everything on a sign-out, including an answer that was still on its way', async () => {
    let release: (outcome: PictureFetchOutcome) => void = () => undefined
    const { pictures, held, settle } = harness(() => new Promise<PictureFetchOutcome>(resolve => (release = resolve)))

    pictures.request('authentik:robin')
    pictures.clear()
    release(READY)
    await settle()

    expect(held()).toEqual({})

    // And nothing is held against the person: the next reader may ask again at once.
    pictures.request('authentik:robin')
    expect(Object.keys(held())).toEqual([])
  })

  it('ignores an empty id', async () => {
    const { pictures, fetchPicture, settle } = harness(() => READY)

    pictures.request('')
    await settle()

    expect(fetchPicture).not.toHaveBeenCalled()
  })
})
