/**
 * A colleague's picture for the group chat's transcript (HERM-120 Task 2) —
 * fetched by `author.id` and cached per gateway, the same store the reader's
 * own Account picture uses.
 *
 * Three stable callbacks, spread straight onto `TranscriptList`:
 *
 *  - `resolveSenderPictureUri` READS what the cache holds. It starts nothing, so
 *    a row may call it while it renders;
 *  - `requestSenderPicture` ASKS for it — a row calls it from an effect, never
 *    during render, because starting the fetch writes the store, and a store
 *    write from inside another component's render is exactly what React warns
 *    about;
 *  - `subscribeSenderPictures` tells a row when the cache changes, so the row
 *    showing a picture repaints the moment it lands. Rows are memoised against
 *    the transcript context by IDENTITY, and none of these callbacks changes
 *    identity when a picture arrives — which is why, before this, a
 *    colleague's picture only appeared once the next message rebuilt the list.
 *
 * `RowView` only ever uses these for a row already proven to be a colleague's
 * (`!own && item.author`), so the reader's own messages and unattributed rows
 * never reach them.
 */
import { useCallback } from 'react'

import { authPicturePath } from '@hermie/gateway-client'
import type { MessageAuthor } from '@hermie/transcript'

import { useGateway } from '../../gateway'
import { personPictureKey, personPictureUri, usePeoplePicturesStore } from './people-pictures'

export interface SenderPictureSource {
  resolveSenderPictureUri: (author: MessageAuthor) => string | undefined
  requestSenderPicture: (author: MessageAuthor) => void
  subscribeSenderPictures: (listener: () => void) => () => void
}

const subscribeSenderPictures = (listener: () => void): (() => void) => usePeoplePicturesStore.subscribe(listener)

export function useSenderPictureResolver(): SenderPictureSource {
  const { gatewayId, http } = useGateway()
  const ensure = usePeoplePicturesStore(state => state.ensure)

  const resolveSenderPictureUri = useCallback(
    (author: MessageAuthor) => {
      if (!gatewayId || !author.id) {
        return undefined
      }

      return personPictureUri(
        usePeoplePicturesStore.getState().byKey[personPictureKey(gatewayId, authPicturePath(author.id))]
      )
    },
    [gatewayId]
  )

  const requestSenderPicture = useCallback(
    (author: MessageAuthor) => {
      if (!gatewayId || !http || !author.id) {
        return
      }

      const path = authPicturePath(author.id)

      ensure(personPictureKey(gatewayId, path), http, path)
    },
    [gatewayId, http, ensure]
  )

  return { resolveSenderPictureUri, requestSenderPicture, subscribeSenderPictures }
}
