/**
 * An attached image, inside the bubble.
 *
 * Two shapes, and which one it takes is the difference between a grid and a
 * single picture — the same split iMessage makes:
 *
 *  - **In a grid** the card is a fixed height and the picture FILLS it, cropped.
 *    Uniform cells are what makes a grid read as a grid, and a row of three
 *    letterboxed thumbnails with mismatched bands is just three pictures that
 *    happen to be next to each other.
 *  - **On its own** the card takes the picture's own aspect ratio, capped at
 *    `maxHeight`, and the picture is CONTAINED. A lone attachment is the
 *    message, and a screenshot cropped to a card's aspect loses the part
 *    somebody attached it to show.
 *
 * The ratio is measured rather than assumed, because nothing upstream knows it:
 * an attachment is a URI and a filename. It comes off the `onLoad` EVENT rather
 * than from `Image.getSize`, and that is deliberate on two counts: `getSize` is
 * a second native round trip for bytes the `<Image>` is already fetching, and it
 * reaches the platform loader directly, so a URI the loader will not touch
 * throws out of the effect instead of calling the failure callback that exists
 * for it. The event cannot do either. Until it arrives the card falls back to
 * `maxHeight`, so it never renders at zero and never collapses the bubble.
 *
 * `overflow: 'hidden'` on the frame rather than a radius on the `Image`: a
 * radius on an `Image` is ignored on Android, and the frame is also what draws
 * the hairline that keeps a white screenshot from bleeding into a light bubble.
 */
import { useState } from 'react'
import { Image, Pressable, View } from 'react-native'

import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface ImageCardProps {
  uri: string
  /** The filename; the accessible name of the card. */
  name?: string
  /**
   * A fixed height, for a grid cell. The picture fills and crops.
   *
   * Mutually exclusive with `maxHeight` — one of the two decides the shape.
   */
  height?: number
  /** A ceiling, for a lone picture that otherwise takes its own ratio. */
  maxHeight?: number
  /**
   * The card is inside an outgoing bubble.
   *
   * It matters because a contained picture shows the frame's own colour down
   * the sides. A neutral sunk grey there is a grey bar inside a blue bubble;
   * translucent white lets the bubble's own colour through instead, and works
   * in either theme without a second blue being invented for it.
   */
  onAccent?: boolean
  onPress?: () => void
  testID?: string
}

/**
 * The height a contained picture should take at this width.
 *
 * Exported and pure so the rule can be stated without a renderer: the ratio
 * wins until it would exceed the ceiling, and a picture with no measured ratio
 * yet takes the ceiling rather than zero.
 */
export function cardAspect(ratio: number | null): { aspectRatio: number } | { height: number } | null {
  return ratio && Number.isFinite(ratio) && ratio > 0 ? { aspectRatio: ratio } : null
}

export function ImageCard({ uri, name, height, maxHeight, onAccent = false, onPress, testID }: ImageCardProps) {
  const theme = useTheme()
  const [ratio, setRatio] = useState<number | null>(null)
  const fixed = height !== undefined

  const shape = fixed ? { height } : (cardAspect(ratio) ?? { height: maxHeight })

  const frame = (
    <View
      style={{
        // A tint behind the picture, so a contained image has a surface rather
        // than a hole in the bubble while it loads.
        backgroundColor: onAccent ? 'rgba(255,255,255,0.18)' : theme.tintSunk,
        borderColor: onAccent ? 'rgba(255,255,255,0.28)' : theme.hairlineSoft,
        borderRadius: theme.radii.thumb,
        borderWidth: 1,
        overflow: 'hidden',
        width: '100%',
        ...(maxHeight !== undefined ? { maxHeight } : {}),
        ...shape
      }}
      testID={testID ? `${testID}-frame` : undefined}
    >
      <Image
        accessibilityIgnoresInvertColors
        // Only a lone picture needs the ratio; a grid cell is a fixed box and
        // measuring it would re-render the row for nothing.
        {...(fixed
          ? {}
          : {
              onLoad: (event: { nativeEvent?: { source?: { width?: number; height?: number } } }) => {
                const source = event.nativeEvent?.source

                if (source?.width && source.height) {
                  setRatio(source.width / source.height)
                }
              }
            })}
        resizeMode={fixed ? 'cover' : 'contain'}
        source={{ uri }}
        style={{ height: '100%', width: '100%' }}
        testID={testID ? `${testID}-image` : undefined}
      />
    </View>
  )

  if (!onPress) {
    return frame
  }

  return (
    <Pressable
      accessibilityHint={chatStrings.viewer.openHint}
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
      testID={testID}
    >
      {frame}
    </Pressable>
  )
}
