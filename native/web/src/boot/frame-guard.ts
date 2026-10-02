/**
 * Refuse to run inside a frame.
 *
 * The page shares its origin with the gateway's dashboard, and its session
 * cookie is `SameSite=Lax`: a cross-site frame arrives signed out, but a
 * same-site sibling (another subdomain of the same site) could frame the client
 * with a live session and dress it up for a click. `frame-ancestors` would stop
 * that, but it cannot be set from a `<meta>` policy and the static route sends
 * no headers (plan W6, "Clickjacking"). So the entry module checks first and,
 * when framed, replaces the document's body with one sentence and does nothing
 * else: no locale chunk, no storage, no request, no React.
 *
 * The sentence is picked from the browser's language list directly, because
 * the locale machinery (`initLocale`) reads storage and may fetch a chunk, and
 * neither may happen here.
 */
import { localeForBrowser } from '../i18n/locale'
import { WEB_STRINGS_SOURCE } from '../i18n/web-strings'

/** The two window properties the check compares. */
export interface FrameWindow {
  readonly top: unknown
  readonly self: unknown
}

/**
 * Is the page inside a frame? Reading `top` across origins is allowed (only
 * its contents are not), but anything that throws counts as framed: the safe
 * answer for a check like this is the one that refuses.
 */
export function isFramed(win: FrameWindow): boolean {
  try {
    return win.top !== win.self
  } catch {
    return true
  }
}

/** The refusal in the first of `languages` the client speaks, else English. */
export function refusalText(languages: readonly string[]): string {
  return WEB_STRINGS_SOURCE.frameGuard.refused[localeForBrowser(languages)]
}

/** What `refuseInFrame` touches, so a test can hand in its own. */
export interface FrameGuardEnvironment {
  window: FrameWindow
  document: Document
  languages: readonly string[]
}

const pageEnvironment = (): FrameGuardEnvironment => ({
  window,
  document,
  languages: navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : []
})

/**
 * When framed, replace the page with the refusal and return true; the caller
 * then stops. Otherwise touch nothing and return false.
 */
export function refuseInFrame(environment: FrameGuardEnvironment = pageEnvironment()): boolean {
  if (!isFramed(environment.window)) {
    return false
  }

  const { document: doc } = environment
  const text = refusalText(environment.languages)
  const paragraph = doc.createElement('p')

  paragraph.textContent = text
  paragraph.className = 'frame-refused'
  doc.documentElement.lang = localeForBrowser(environment.languages)
  doc.body.replaceChildren(paragraph)

  return true
}
