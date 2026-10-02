/**
 * The row context menu, where the platform does not draw one.
 *
 * ## It is the SAME menu, and that had stopped being true
 *
 * `row-menu-items.ts` opens by saying that the native menu and this sheet "are
 * two ways of drawing ONE list of intentions". This file did not read it. It was
 * written first, the shared model arrived with the native menu, and only the
 * native side was moved onto it — so the two drifted exactly as far as the
 * changes that landed afterwards. What this sheet offered was a colour, Archive,
 * and one line per section; what it did not offer was **Open**, **Mark as read**,
 * **Move up**, **Move down** and **Add divider above**. Its only ordering item
 * read "Move to No section", which is the top group — so on a build that reaches
 * this sheet, moving a chat to the top really is all a reader can do.
 *
 * It is now rendered FROM `rowMenuItems`, and it takes the item list rather than
 * building one, so there is no second opinion about what a row can do: a new item
 * appears in both menus or in neither.
 *
 * ## The one node that is drawn rather than listed
 *
 * `colour`. Its children are the nine accents and the sheet has the room to draw
 * them as swatches, which is a better control than nine lines of colour names and
 * is the one the chat options sheet already uses. The swatches are keyed off that
 * node's own children, so they come from the same list as everything else — the
 * special case is in the DRAWING, not in the model.
 *
 * A `BottomSheet` rather than a floating popover on purpose: the sheet already
 * owns the Escape stack, the backdrop and the "one modal at a time" rule, and a
 * second presentation mechanism would be a second set of those problems. Every
 * action is an explicit button — nothing in here is answered by a swipe
 * (ADR-0010).
 */
import { useState } from 'react'
import { View } from 'react-native'

import { strings } from '../../i18n/strings'
import { BottomSheet, SheetPage } from '../../ui/BottomSheet'
import { AccentSwatches } from '../../ui/AccentSwatches'
import type { MenuItem } from '../../ui/menu'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, type AccentName } from '../../ui/tokens'
import { Row } from './menu-row'

export type RowMenuProps = {
  visible: boolean
  botName: string
  displayName: string
  accent: AccentName
  /** Exactly what the native menu would show, from `rowMenuItems`. */
  items: readonly MenuItem[]
  onClose: () => void
  /** A selection, by the id `rowMenuItems` gave it. The same handler the native menu reports to. */
  onSelect: (id: string) => void
}

/** `accent:teal` and `section:d3f` are ids, not labels; the id is what a caller reports. */
const COLOUR_ID = 'colour'

/** `move:-1` and `section:d3f` carry a colon, which reads badly in a test id. */
const testIdFor = (prefix: string, id: string) => `${prefix}-${id.replace(/:/gu, '-')}`

export function RowMenu({ accent, botName, displayName, items, onClose, onSelect, visible }: RowMenuProps) {
  const theme = useTheme()

  /**
   * Which submenu is open, or null for the top level.
   *
   * A PAGE rather than an expanded section: a submenu here is "Move to section",
   * which is a list as long as the reader has sections, and inlining it would put
   * Archive below a variable number of lines. `SheetPage` is the same back
   * control every other sheet uses.
   */
  const [page, setPage] = useState<MenuItem | null>(null)

  const choose = (id: string) => {
    onSelect(id)
    onClose()
  }

  const lines = (list: readonly MenuItem[], prefix: string) =>
    list.map(item => {
      if (item.id === COLOUR_ID && item.children?.length) {
        return (
          <View key={item.id}>
            <Text color="textFaint" style={{ marginBottom: theme.space.xs }} variant="micro">
              {item.title.toUpperCase()}
            </Text>
            <AccentSwatches accent={accent} onSelect={name => choose(`accent:${name}`)} testIDPrefix={botName} />
          </View>
        )
      }

      if (item.children?.length && !item.inline) {
        return (
          <Row
            key={item.id}
            onPress={() => setPage(item)}
            testID={testIdFor(prefix, item.id)}
            title={`${item.title}…`}
          />
        )
      }

      // An inline group is a SECTION of the parent menu — the native side flattens
      // it with a separator, and here it is the same lines with a gap above them.
      if (item.children?.length) {
        return (
          <View key={item.id} style={{ gap: theme.space.xs, marginTop: theme.space.sm }}>
            {lines(item.children, prefix)}
          </View>
        )
      }

      // A disabled line is SHOWN, not dropped: the native menu greys Mark as read
      // out on a row with nothing unread rather than hiding it, and a menu whose
      // length changes with state is a menu whose items move under the reader.
      if (item.disabled) {
        return (
          <Text
            color="textFaint"
            key={item.id}
            style={{ lineHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
            testID={testIdFor(prefix, item.id)}
            variant="body"
          >
            {item.title}
          </Text>
        )
      }

      return (
        <Row
          key={item.id}
          onPress={() => choose(item.id)}
          testID={testIdFor(prefix, item.id)}
          title={item.title}
          {...(item.destructive ? { tone: 'danger' as const } : {})}
        />
      )
    })

  return (
    <BottomSheet
      accessibilityLabel={strings.layout.rowActions(displayName)}
      onClosed={() => setPage(null)}
      onRequestClose={onClose}
      testID="row-menu"
      visible={visible}
    >
      {page ? (
        <SheetPage onBack={() => setPage(null)} testID="row-menu-back" title={page.title}>
          <View style={{ gap: theme.space.xs }}>{lines(page.children ?? [], 'row-menu')}</View>
        </SheetPage>
      ) : (
        <View style={{ gap: theme.space.md }}>
          <Text variant="sheetTitle">{displayName}</Text>
          <View style={{ gap: theme.space.xs }}>{lines(items, 'row-menu')}</View>
        </View>
      )}
    </BottomSheet>
  )
}
