/**
 * The signed-in person's own picture, for Settings → Account (HERM-120 Task 1).
 *
 * `path` is `config.userPictureUrl` — `/api/auth/me`'s own `picture_url`,
 * captured once at sign-in (`configFromDraft`, alongside `userDisplayName`).
 * Absent draws the initial, exactly as before this feature existed; present,
 * this fetches and caches the bytes the same way a colleague's picture is
 * fetched in the group chat, through the one cache both share.
 */
import { useEffect } from 'react'

import { useGateway } from '../../gateway'
import { personPictureKey, personPictureUri, usePeoplePicturesStore } from './people-pictures'

export function useOwnPictureUri(path: string | undefined): string | undefined {
  const { gatewayId, http } = useGateway()
  const key = gatewayId && path ? personPictureKey(gatewayId, path) : undefined
  const entry = usePeoplePicturesStore(state => (key ? state.byKey[key] : undefined))
  const ensure = usePeoplePicturesStore(state => state.ensure)

  useEffect(() => {
    if (key && path && http) {
      ensure(key, http, path)
    }
  }, [key, path, http, ensure])

  return personPictureUri(entry)
}
