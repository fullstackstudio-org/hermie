/**
 * The shape every item view shares, and the one comparison they are memoised on.
 *
 * The engine bumps an item's `version` on every change to it, so `(id,
 * version)` is an exact key; the presentation is the selectors' call and can
 * change without the item changing (a verbosity switch). Anything else a view
 * reads comes through `ItemContext`, which does not change while a chat is open.
 */
import type { Presentation, TranscriptItem } from '@hermie/transcript'

export interface RowViewProps<Item extends TranscriptItem> {
  item: Item
  presentation: Presentation
}

export function sameRowView<Item extends TranscriptItem>(a: RowViewProps<Item>, b: RowViewProps<Item>): boolean {
  return a.item.id === b.item.id && a.item.version === b.item.version && a.presentation === b.presentation
}
