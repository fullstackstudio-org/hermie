/**
 * The browser's language preference list, most preferred first: the one thing the
 * language rules read from the browser itself (`i18n/locale.ts`).
 *
 * `navigator.languages` when the browser has it, else the single
 * `navigator.language`, else nothing (a page with no `navigator`, which is a test).
 */
export function browserLanguages(
  nav: Pick<Navigator, 'languages' | 'language'> | undefined = globalThis.navigator as Navigator | undefined
): readonly string[] {
  if (!nav) {
    return []
  }

  return nav.languages?.length ? nav.languages : nav.language ? [nav.language] : []
}
