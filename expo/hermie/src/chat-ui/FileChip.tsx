/**
 * A file, as a chip — in the composer's tray before it is sent and under the
 * owner's bubble afterwards.
 *
 * §6.7: a type glyph, the name middle-truncated, the size, and a remove `×`.
 * While uploading the `×` is replaced by a progress ring; a rejected file takes
 * the danger tint and says what the limit is.
 *
 * The truncation rule is the part worth stating: the HEAD is ellipsised and the
 * TAIL is kept, because the extension is the most informative part of a file name
 * and `Q3-report-final-…` tells a reader less than `…-final-v4.xlsx`.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { chatStrings } from './strings'
import { formatBytes, middleTruncate } from './format'
import type { ComposerAttachment } from './types'

export interface FileChipProps {
  name: string
  size?: number
  /** The upload's state; `undefined` is a file that is simply there. */
  status?: ComposerAttachment['status']
  progress?: number
  error?: string
  onRemove?: () => void
  /**
   * Open the file: the share sheet on a phone or a Mac, a download in a
   * browser. Absent on a chip that is still staged in the composer — there is
   * nowhere to send a file that has not been uploaded yet.
   */
  onPress?: () => void
  /** Inside an outgoing bubble the ink is white and the tint is the accent's. */
  onAccent?: boolean
  testID?: string
}

/**
 * The glyph for a family of file types.
 *
 * Deliberately a handful of shapes rather than one per extension: a reader is
 * telling a spreadsheet from a photo from an archive, not reading a MIME
 * database, and a glyph nobody recognises is worse than a generic one.
 */
export function fileGlyph(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? ''

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'svg'].includes(extension)) {
    return '▣'
  }

  if (['csv', 'tsv', 'xlsx', 'xls', 'ods', 'numbers'].includes(extension)) {
    return '▦'
  }

  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(extension)) {
    return '▥'
  }

  if (['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'epub', 'pages'].includes(extension)) {
    return '▤'
  }

  if (['mp4', 'mov', 'avi', 'mkv', 'webm', 'mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac'].includes(extension)) {
    return '▷'
  }

  return '▢'
}

/** An indeterminate ring. Static, per §5: waiting uses a hollow mark, not a blink. */
function Ring({ color, progress }: { color: string; progress?: number }) {
  const known = typeof progress === 'number' && progress > 0 && progress < 1

  return (
    <View
      style={{
        borderColor: color,
        borderRadius: 8,
        borderWidth: 2,
        height: 16,
        opacity: known ? 1 : 0.55,
        width: 16,
        // A known fraction is shown by leaving one edge open rather than by
        // animating: the ring is 16pt and an arc at that size is a smudge.
        ...(known ? { borderRightColor: 'transparent' } : {})
      }}
    />
  )
}

export function FileChip({
  name,
  size,
  status,
  progress,
  error,
  onRemove,
  onPress,
  onAccent = false,
  testID
}: FileChipProps) {
  const theme = useTheme()
  const failed = status === 'error' || Boolean(error)
  const ink = failed ? theme.colors.dangerText : onAccent ? theme.colors.onAccent : theme.colors.text
  const meta = failed ? theme.colors.dangerText : onAccent ? theme.colors.onAccent : theme.colors.textFaint

  const body = (
    <View
      style={{
        alignItems: 'center',
        backgroundColor: failed ? theme.colors.dangerText + '1F' : onAccent ? 'rgba(255,255,255,0.18)' : theme.tintSunk,
        borderColor: failed ? theme.colors.dangerText : onAccent ? 'rgba(255,255,255,0.28)' : theme.hairlineSoft,
        borderRadius: theme.radii.inset,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        maxWidth: 260,
        paddingHorizontal: theme.space.sm + 2,
        paddingVertical: theme.space.sm
      }}
      testID={testID}
    >
      <Text style={{ color: meta, fontSize: 15 }}>{fileGlyph(name)}</Text>

      <View style={{ flexShrink: 1 }}>
        <Text numberOfLines={1} style={{ color: ink }} variant="meta">
          {middleTruncate(name, 28)}
        </Text>

        {error ? (
          <Text numberOfLines={2} style={{ color: meta }} variant="micro">
            {error}
          </Text>
        ) : size ? (
          <Text style={{ color: meta }} variant="micro">
            {formatBytes(size)}
          </Text>
        ) : null}
      </View>

      {status === 'uploading' ? (
        <Ring color={meta} progress={progress} />
      ) : onRemove ? (
        <Pressable
          accessibilityLabel={chatStrings.composer.removeAttachment}
          accessibilityRole="button"
          hitSlop={TAP_SLOP}
          onPress={onRemove}
          testID={testID ? `${testID}-remove` : undefined}
        >
          <Text style={{ color: meta, fontSize: 16, lineHeight: 18 }}>{'×'}</Text>
        </Pressable>
      ) : null}
    </View>
  )

  if (!onPress) {
    return body
  }

  /*
    The chip becomes the button, and the `×` inside it stays its own.

    A nested `Pressable` wins the touch it is under, so removing a staged file
    does not also open it — which is the only overlap the two actions have, and
    the reason the remove control was never made part of the chip's own surface.
  */
  return (
    <Pressable
      accessibilityHint={chatStrings.viewer.openHint}
      accessibilityLabel={name}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
      testID={testID ? `${testID}-open` : undefined}
    >
      {body}
    </Pressable>
  )
}
