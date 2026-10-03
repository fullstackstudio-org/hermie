/**
 * What an initials avatar is made of, as pure functions: the letter and which of
 * the theme's eight grounds it sits on. Ported from the Expo app's
 * `initialFor` and `tintIndex` (`chat-ui/format.ts`), so a bot has the same
 * letter and the same colour on every client.
 */

/** The first character of a name, upper-cased; `?` for a name with none. */
export function initialFor(name: string): string {
  const first = Array.from(name.trim())[0]

  return first ? first.toUpperCase() : '?'
}

/** A stable bucket for a name, so the same bot always gets the same ground. */
export function tintIndex(name: string, buckets: number): number {
  let hash = 0

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }

  return buckets > 0 ? hash % buckets : 0
}

/** How many grounds `ui/theme.css` defines (`--hm-avatar-0` to `--hm-avatar-7`). */
export const AVATAR_GROUNDS = 8
