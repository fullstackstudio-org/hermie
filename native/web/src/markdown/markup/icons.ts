/**
 * The icons of a `hermie-cards` block: the closed vocabulary of `contract/markup/icons.json`, read as it is (one
 * file, no copy), as path data on a 24x24 grid. A card's icon is a name that resolves here, never a string handed
 * into an SVG: what is drawn is a `path` element with a `d` attribute from this table, and nothing a reply wrote.
 */
import iconsSource from '../../../../../contract/markup/icons.json?raw'

export interface CardIcon {
  name: string
  /** The SF Symbol the Apple apps draw; kept in the contract, unused here. */
  sfSymbol: string
  /** The `d` attribute of one path. */
  svg: string
}

interface IconTable {
  viewBox: string
  generic: CardIcon
  icons: CardIcon[]
}

const table = JSON.parse(iconsSource) as IconTable

export const ICON_VIEW_BOX = table.viewBox

/** The glyph an unknown name falls back to. */
export const GENERIC_ICON: CardIcon = table.generic

const byName: ReadonlyMap<string, CardIcon> = new Map(table.icons.map(icon => [icon.name, icon]))

/** The names a card may use, lower case. */
export const ICON_NAMES: ReadonlySet<string> = new Set(byName.keys())

/** The glyph for a name from a validated card: the vocabulary's, or the generic one. */
export function iconFor(name: string): CardIcon {
  return byName.get(name) ?? GENERIC_ICON
}
