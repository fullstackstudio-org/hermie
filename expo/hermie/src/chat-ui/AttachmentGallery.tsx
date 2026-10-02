/**
 * The attachments on one message, laid out the way a messenger lays them out.
 *
 * An image the app can actually load is a rounded, aspect-fit image card; a
 * file — or an image whose bytes are not reachable — stays the `FileChip` it
 * has always been. Which of the two a reference gets is decided by whether a
 * URI resolved for it, never by the filename: a `.png` the gateway holds on its
 * own disk is a name and nothing more, and an `<Image>` pointed at an absolute
 * path draws a grey rectangle where a chip would have said something true.
 *
 * ## The grid counts PICTURES, not attachments
 *
 * Two pictures go side by side, three or more go three across, one fills the
 * width. A chip beside them always takes a full-width row of its own: a
 * filename squeezed into a third of a bubble is a filename nobody can read, and
 * cutting the one picture in a message down to a third because two PDFs came
 * with it would shrink the only thing worth looking at.
 *
 * ## Why the cells are percentages
 *
 * A bubble sizes itself to its content, so there is no width to measure at the
 * time the cells need one — and a measured layout would need a pass the test
 * renderer never runs. The literals below leave the gaps room; a true 33.33 %
 * plus two gaps overflows and `flexWrap` drops the third picture onto its own
 * line.
 */
import { View, type ViewStyle } from 'react-native'

import { useTheme } from '../ui/theme'
import { FileChip } from './FileChip'
import { ImageCard } from './ImageCard'

/** One attachment as the bubble holds it, after the host resolved its URI. */
export interface GalleryAttachment {
  /** The stored reference: `@image:/srv/shot.png`, or `@file:…`. */
  reference: string
  /** The filename, already derived by `attachmentName`. */
  name: string
  /** Something `Image` can load, when the host had one. Absent ⇒ a chip. */
  uri?: string
  size?: number
}

export interface AttachmentGalleryProps {
  attachments: readonly GalleryAttachment[]
  /** Inside an outgoing bubble the chips take white ink and an accent tint. */
  onAccent?: boolean
  /** Open the full-screen viewer, or hand the file to the system. */
  onOpen?: (attachment: GalleryAttachment) => void
  testID?: string
}

/** How many pictures go across, given how many there are. */
export function gridColumns(pictures: number): number {
  if (pictures <= 1) {
    return 1
  }

  return pictures === 2 || pictures === 4 ? 2 : 3
}

/** Cell widths per column count. Literals, so they narrow and leave gap room. */
const CELL: Record<number, ViewStyle['width']> = { 1: '100%', 2: '48%', 3: '31%' }

/**
 * The tallest a single image card gets.
 *
 * A lone picture is the message, so it is allowed to be large; in a grid the
 * cell's own width already bounds it and this caps how tall a portrait crop
 * may grow before the bubble becomes a column of one photo.
 */
export const GALLERY_SOLO_MAX_HEIGHT = 260
export const GALLERY_GRID_HEIGHT = 108

export function AttachmentGallery({
  attachments,
  onAccent = false,
  onOpen,
  testID = 'attachments'
}: AttachmentGalleryProps) {
  const theme = useTheme()

  if (!attachments.length) {
    return null
  }

  const pictures = attachments.filter(entry => Boolean(entry.uri)).length
  const columns = gridColumns(pictures)

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.xs }} testID={testID}>
      {attachments.map((entry, index) => {
        const picture = Boolean(entry.uri)
        const id = `${testID}-${index}`

        return (
          <View key={entry.reference} style={{ width: picture ? CELL[columns] : '100%' }}>
            {entry.uri ? (
              <ImageCard
                // A grid cell is a fixed, cropped square-ish thumb; a lone
                // picture takes its own ratio up to the ceiling.
                {...(columns > 1 ? { height: GALLERY_GRID_HEIGHT } : { maxHeight: GALLERY_SOLO_MAX_HEIGHT })}
                name={entry.name}
                onAccent={onAccent}
                {...(onOpen ? { onPress: () => onOpen(entry) } : {})}
                testID={id}
                uri={entry.uri}
              />
            ) : (
              <FileChip
                name={entry.name}
                onAccent={onAccent}
                {...(onOpen ? { onPress: () => onOpen(entry) } : {})}
                {...(entry.size !== undefined ? { size: entry.size } : {})}
                testID={id}
              />
            )}
          </View>
        )
      })}
    </View>
  )
}
