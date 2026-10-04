/**
 * A click on a notification as the worker hands it over, and the one a cold start
 * carries in its address (`?hermiePush=`), read once and removed.
 *
 * A module of its own because the entry reads the launch click as the session
 * starts (`platform/push-launch.ts`), and everything it imports is in the first
 * load: the rest of `actions.ts` is loaded with Web Push, after the session has
 * started. Pure, except `takeLaunchResponse`, which is given the location and
 * history to read and rewrite.
 */

/** The query a cold start from a click carries; `src/sw/notification.ts` writes the same. */
export const PUSH_LAUNCH_PARAM = 'hermiePush'

/** One click: the button (or `default`) and the notification's data. */
export interface PushResponse {
  actionIdentifier: string
  data: Record<string, unknown>
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** A response as the worker spells it, or `null`. */
export function responseOf(value: unknown): PushResponse | null {
  if (!isObject(value)) {
    return null
  }

  return {
    actionIdentifier:
      typeof value.actionIdentifier === 'string' && value.actionIdentifier ? value.actionIdentifier : 'default',
    data: isObject(value.data) ? value.data : {}
  }
}

/**
 * The click a cold start carries, once: the query is removed from the address
 * before it is read, so a reload (or a second read) never acts on it again.
 */
export function takeLaunchResponse(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'state' | 'replaceState'>
): PushResponse | null {
  let url: URL

  try {
    url = new URL(location.href)
  } catch {
    return null
  }

  if (!url.searchParams.has(PUSH_LAUNCH_PARAM)) {
    return null
  }

  const raw = url.searchParams.get(PUSH_LAUNCH_PARAM) ?? ''

  url.searchParams.delete(PUSH_LAUNCH_PARAM)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)

  try {
    return responseOf(JSON.parse(raw))
  } catch {
    return null
  }
}
