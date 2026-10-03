/**
 * A person's picture, from the page's cache (`core/people-pictures.ts`): the `data:` URI once the
 * gateway has served it, `undefined` while it is on its way, when the gateway holds none, and on a
 * page with no cache at all. The caller draws the initial for `undefined`, so a picture arriving
 * later only ever replaces a letter.
 *
 * Asking is idempotent and cheap (one request per person, a refusal remembered), so every row that
 * names a person asks on mount and the cache settles it.
 */
import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

import type { PeoplePicturesState } from '../../core/people-pictures'
import { useChatRuntime } from './chat-runtime'

/** What a page without a cache reads, so the hook is the same hook there. */
const NO_PICTURES = createStore<PeoplePicturesState>(() => ({ pictures: {} }))

export interface PersonPictureOptions {
  /** Where the gateway said this person's picture lives (`/api/auth/me`'s `picture_url`). */
  path?: string | undefined
  /** Do not ask: the gateway already said it holds none (an empty `picture_url`). */
  skip?: boolean | undefined
}

export function usePersonPicture(id: string | undefined, options: PersonPictureOptions = {}): string | undefined {
  const pictures = useChatRuntime()?.pictures
  const uri = useStore(pictures?.store ?? NO_PICTURES, state => (id ? state.pictures[id] : undefined))
  const { path, skip } = options

  useEffect(() => {
    if (id && !skip) {
      pictures?.request(id, path)
    }
  }, [pictures, id, path, skip])

  return uri
}
