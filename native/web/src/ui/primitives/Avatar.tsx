import { type ReactElement, useState } from 'react'

import { AVATAR_GROUNDS, initialFor, tintIndex } from './avatar-parts'
import './primitives.css'

export interface AvatarProps {
  /** What the bot is called: the letter and the ground come from it. */
  name: string
  /** The bot's picture (a `data:` URL the roster read), when it has one. */
  uri?: string | undefined
}

/**
 * The bot's picture, or its initial on a ground that never changes for that
 * name. Purely decorative: the row it sits in names the bot in text.
 */
export function Avatar({ name, uri }: AvatarProps): ReactElement {
  // A picture that fails to decode falls back to the initial rather than to a broken icon.
  const [failed, setFailed] = useState<string | null>(null)
  const showPicture = Boolean(uri) && failed !== uri

  return (
    <span aria-hidden="true" className={`hm-avatar hm-avatar--${tintIndex(name, AVATAR_GROUNDS)}`}>
      {showPicture ? (
        <img alt="" className="hm-avatar__picture" src={uri} onError={() => setFailed(uri ?? null)} />
      ) : (
        initialFor(name)
      )}
    </span>
  )
}
