/**
 * The browser tab's name: the one piece of window chrome the client owns, and
 * the only label a visitor sees when the tab is not in front.
 *
 * `formatPageTitle` is the Expo app's (`src/platform/platform-contracts.ts`),
 * unchanged: `Screen · Hermie`, or `Hermie` alone. The Expo `usePageTitle` hook
 * is not ported here because this layer is React-free; a component calls
 * `setPageTitle` from an effect.
 */

/** The app's own name, which ends every title. */
export const APP_TITLE = 'Hermie'

export function formatPageTitle(screen: string | undefined, app = APP_TITLE): string {
  return screen && screen !== app ? `${screen} · ${app}` : app
}

/** Name the tab after `screen` (or after the app alone). */
export function setPageTitle(
  screen: string | undefined,
  target: { title: string } | null = typeof document === 'undefined' ? null : document
): void {
  if (target) {
    target.title = formatPageTitle(screen)
  }
}
