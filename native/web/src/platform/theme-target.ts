/**
 * Where the colour scheme and the tint are applied: two attributes on the
 * document element, which `ui/theme.css` keys its custom properties on.
 *
 * The policy forbids inline styles, so the theme cannot be written as values;
 * it is a name, and the stylesheet holds what the name means. `system` writes no
 * scheme attribute at all: the stylesheet follows `prefers-color-scheme` by
 * itself, which is also what the page does before any script has run.
 */

/** The part of an element this uses, so a test can hand in its own. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

export interface AppliedTheme {
  /** `system` follows the browser; `light` and `dark` pin it. */
  scheme: 'system' | 'light' | 'dark'
  /** The tint's name (`ui/theme.css` has one block per name). */
  tint: string
}

/** The attribute that pins the scheme; absent means "follow the browser". */
export const SCHEME_ATTRIBUTE = 'data-scheme'

/** The attribute that names the tint. */
export const TINT_ATTRIBUTE = 'data-tint'

const pageRoot = (): ThemeTarget | null => (typeof document === 'undefined' ? null : document.documentElement)

/** Put a theme on the page (or on `target`). */
export function applyTheme(theme: AppliedTheme, target: ThemeTarget | null = pageRoot()): void {
  if (!target) {
    return
  }

  if (theme.scheme === 'system') {
    target.removeAttribute(SCHEME_ATTRIBUTE)
  } else {
    target.setAttribute(SCHEME_ATTRIBUTE, theme.scheme)
  }

  target.setAttribute(TINT_ATTRIBUTE, theme.tint)
}
