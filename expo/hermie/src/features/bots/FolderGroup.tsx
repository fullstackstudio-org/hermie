/**
 * The plate a folder and its chats are drawn on.
 *
 * ## Why a plate at all
 *
 * ADR-0012 drew a group as a named divider: a line, a word, and the rows below
 * it. R24 gave that thing an inside — it collapses, it counts what it is hiding,
 * a drop can land in it — and left the drawing alone, so the owner's verdict was
 * that only the NAME had changed: _"Momenteel is alleen de naam van divider naar
 * map gegaan. Ik wil dat het echt als mappen werkt."_ A heading and a container
 * are different shapes, and a container has to look like one: the rows have to
 * be visibly INSIDE something that the header is the top of.
 *
 * So the group is one sunk plate, built out of three cells that each draw their
 * own slice of it — the header rounds the top, each member continues the sides,
 * and the last member rounds the bottom. Three cells rather than one view,
 * because the rows are `FlatList` items: a single wrapper around a group would
 * mean the list could not virtualise a folder with forty chats in it, and the
 * drag measures cells.
 *
 * ## The slice is a function of position, and nothing else
 *
 * `edge` says which slice this is, and it is the only input that changes the
 * drawing. A closed folder is `'only'` — all four corners — because a closed
 * folder IS the whole group; an open one with nothing in it still has its
 * placeholder row as the bottom slice. That keeps "what does this look like" one
 * decision made in one place, rather than three booleans threaded through three
 * call sites in `BotsScreen`.
 *
 * ## The highlight is the drop target, not a hover
 *
 * While a chat is being dragged over a folder the plate takes the folder's own
 * colour. That is the whole of "dropping into a container": the reader is aiming
 * at a thing, and the thing has to say it has been aimed at. It is driven by the
 * drag's `dropKey` through the anchor's TARGET, so it lights for a drop onto the
 * header, into an empty folder, and between two chats already inside — three
 * gestures that all mean "in here".
 */
import type { ReactNode } from 'react'
import { View, type ViewStyle } from 'react-native'

import { useTheme } from '../../ui/theme'
import type { AccentName } from '../../ui/tokens'

/** Which slice of the plate a cell draws. */
export type FolderGroupEdge = 'top' | 'middle' | 'bottom' | 'only'

/**
 * How far a chat inside a folder sits in from a loose one.
 *
 * A folder reads as a container from two things at once: the plate around it and
 * the step its contents take. The step alone was what a divider had — nothing —
 * and the plate alone would leave the rows looking like a list that happens to be
 * on a card.
 */
export const FOLDER_MEMBER_INDENT = 14

export interface FolderGroupProps {
  edge: FolderGroupEdge
  /** The folder's own colour, for the plate's edge. `default` takes the theme's. */
  colour: AccentName
  /** A chat is being dragged over this folder: the plate says so. */
  targeted?: boolean
  /** Members step in; the header does not. */
  indent?: boolean
  children: ReactNode
  testID?: string
}

export function FolderGroup({ edge, colour, targeted = false, indent = false, children, testID }: FolderGroupProps) {
  const theme = useTheme()
  const swatch = theme.accent(colour)
  const rounded = theme.radii.card
  const top = edge === 'top' || edge === 'only'
  const bottom = edge === 'bottom' || edge === 'only'

  const plate: ViewStyle = {
    backgroundColor: targeted ? swatch.soft : theme.tintSunk,
    borderColor: targeted ? swatch.fill : theme.hairlineSoft,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopWidth: top ? 1 : 0,
    borderBottomWidth: bottom ? 1 : 0,
    borderTopLeftRadius: top ? rounded : 0,
    borderTopRightRadius: top ? rounded : 0,
    borderBottomLeftRadius: bottom ? rounded : 0,
    borderBottomRightRadius: bottom ? rounded : 0,
    // The plate sits where a row's own pill sits, so a folder's left edge and a
    // loose chat's left edge line up and the step inside is the only offset a
    // reader has to read.
    marginHorizontal: theme.space.sm,
    ...(top ? { marginTop: theme.space.sm } : {}),
    ...(bottom ? { marginBottom: theme.space.sm, paddingBottom: theme.space.xxs } : {}),
    ...(indent ? { paddingLeft: FOLDER_MEMBER_INDENT } : {})
  }

  return (
    <View style={plate} testID={testID}>
      {children}
    </View>
  )
}
