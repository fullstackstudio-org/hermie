/**
 * What a menu is, once, for both of the things that draw one.
 *
 * A chat row's options are the same list of intentions whether the platform
 * draws them as a `UIMenu` under the pointer or the app draws them as a bottom
 * sheet. Describing the list as data rather than as JSX is what lets the two
 * paths share one definition, and it is why the native menu could be added
 * without a second copy of "what a row can do" appearing beside the first.
 *
 * The shape is deliberately the intersection of what `UIMenu` offers and what a
 * sheet can honestly reproduce. `systemImage` is the one field a sheet ignores —
 * an SF Symbol has no drawn equivalent here and a missing icon is not a missing
 * action.
 */

export interface MenuItem {
  /**
   * What `onSelect` reports. Unique within one menu, including across submenus:
   * the native side reports a leaf's id and nothing about its parent.
   */
  id: string
  title: string
  /** SF Symbol name. Drawn by the native menu; ignored by the fallback sheet. */
  systemImage?: string
  destructive?: boolean
  disabled?: boolean
  /** Drawn with a checkmark. Used by the colour swatches and nothing else. */
  selected?: boolean
  /**
   * Children as a titled SECTION of the parent menu rather than as a submenu.
   * `Colour` wants a submenu; a group of three related lines wants this.
   */
  inline?: boolean
  children?: MenuItem[]
}

/**
 * Every leaf in a menu, depth first.
 *
 * The fallback sheet renders a flat list, and a test that asserts "the menu
 * offers Archive" should not have to know whether Archive sits at the top level.
 */
export function menuLeaves(items: readonly MenuItem[]): MenuItem[] {
  return items.flatMap(item => (item.children?.length ? menuLeaves(item.children) : [item]))
}

/** Drop the items a caller decided not to offer, so call sites can stay declarative. */
export function menuItems(...items: (MenuItem | false | null | undefined)[]): MenuItem[] {
  return items.filter((item): item is MenuItem => Boolean(item))
}
