/**
 * The tab strip's four icons, at one size.
 *
 * Reported by the owner: chats and crons drew visibly smaller than activity and
 * settings. The cause was not a `fontSize` anybody had got wrong — the four marks
 * were Unicode characters resolved by four different fonts, which disagree about
 * how much of the em box a glyph should fill, and no font metric reconciles that.
 *
 * So the assertion has to be about the thing that actually fixes it: every tab
 * draws through `Icon`, at one size, in one slot. A snapshot would have passed
 * happily with the old glyphs in it, and a visual check is what missed this for
 * several rounds.
 *
 * The four entries come from the strip's own `tabs()` rather than from a list
 * repeated here, so a fifth destination cannot be added without this noticing.
 *
 * **`includeHiddenElements` is load-bearing in this file.** An icon hides itself
 * from the accessibility tree on purpose — it repeats the label beside it — and the
 * testing library's queries skip hidden subtrees by default. Asking for them
 * explicitly is how a test can measure a mark that a screen reader must not read.
 */
import { render, screen } from '@testing-library/react-native'
import { StyleSheet } from 'react-native'

import { SidebarFooter, tabs } from '../src/features/bots'
import { Icon, ICON_SIZE } from '../src/ui/Icon'
import { ThemeProvider } from '../src/ui/theme'

const hidden = { includeHiddenElements: true } as const

const renderStrip = () =>
  render(
    <ThemeProvider>
      <SidebarFooter onOpenSection={jest.fn()} />
    </ThemeProvider>
  )

/** The mark, and the slot it is centred in — the two numbers this file is about. */
const iconBoxes = (testID: string) => {
  const mark = screen.getByTestId(testID, hidden)
  const slot = StyleSheet.flatten(screen.getByTestId(`${testID}-box`, hidden).props.style as never) as {
    height?: number
    width?: number
  }

  return { mark: { height: mark.props.height, width: mark.props.width }, slot }
}

describe('the tab strip', () => {
  it('draws all four marks at the same size', () => {
    renderStrip()

    const marks = tabs().map(tab => iconBoxes(`tab-icon-${tab.key}`).mark)

    expect(marks).toHaveLength(4)
    expect(marks).toEqual(marks.map(() => ({ height: ICON_SIZE.tab, width: ICON_SIZE.tab })))
  })

  /**
   * The slot, not the mark, is what puts the four labels on one line: a row of
   * icons aligns on its boxes, and the boxes have to be equal for that to be true
   * whatever each mark's own weight wants to be.
   */
  it('centres every mark in the same slot, which is what aligns the labels', () => {
    renderStrip()

    for (const tab of tabs()) {
      expect(iconBoxes(`tab-icon-${tab.key}`).slot).toMatchObject({
        height: ICON_SIZE.tabSlot,
        width: ICON_SIZE.tabSlot
      })
    }
  })

  it('gives each tab its own mark rather than one glyph four times', () => {
    expect(new Set(tabs().map(tab => tab.icon)).size).toBe(tabs().length)
  })
})

describe('Icon', () => {
  it('sizes the box to the mark unless a slot is asked for', () => {
    render(
      <ThemeProvider>
        <Icon color="#000000" name="sidebar" size={18} testID="lone" />
      </ThemeProvider>
    )

    expect(iconBoxes('lone')).toMatchObject({ mark: { width: 18 }, slot: { width: 18 } })
  })

  /**
   * A mark that repeats the label beside it must not be read out as well. Every
   * icon in the app sits next to a label or inside a `Pressable` that carries one,
   * so this is a property of the component rather than of each call site — and it
   * is asserted as the absence the queries see, not as the prop that causes it.
   */
  it('stays out of the accessibility tree', () => {
    render(
      <ThemeProvider>
        <Icon color="#000000" name="chats" testID="decorative" />
      </ThemeProvider>
    )

    expect(screen.queryByTestId('decorative')).toBeNull()
    expect(screen.getByTestId('decorative', hidden)).toBeTruthy()
  })
})
