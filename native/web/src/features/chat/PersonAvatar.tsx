import { type ReactElement } from 'react'

import { Avatar } from '../../ui/primitives'
import { type PersonPictureOptions, usePersonPicture } from './use-person-picture'

export interface PersonAvatarProps extends PersonPictureOptions {
  /** `<provider>:<sub>`, as a message row's author carries it: the key of the picture and of the ground. */
  id: string
  /** What the person is called, for the initial. */
  name: string
}

/**
 * A person's picture, or their initial on a ground picked from their id until it arrives (and for
 * good where the gateway holds none). Decorative: wherever it sits, the person is named in text
 * beside it.
 */
export function PersonAvatar({ id, name, path, skip }: PersonAvatarProps): ReactElement {
  const uri = usePersonPicture(id, { path, skip })

  return <Avatar name={name} tintKey={id} uri={uri} />
}
