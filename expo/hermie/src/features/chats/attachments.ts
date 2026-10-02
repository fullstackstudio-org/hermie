/**
 * Picking a photo for the composer.
 *
 * Two jobs, and the second is the one that matters: get bytes, then make them
 * small enough to send. A modern phone photo is 4032 px on its long edge and
 * several megabytes; `image.attach_bytes` takes base64 over the same WebSocket
 * the transcript streams on, so an unresized photo stalls the chat it was meant
 * to illustrate. 1568 px is the longest edge a vision model reads at full
 * resolution — past that the extra pixels cost bandwidth and buy nothing.
 *
 * There used to be a second picker, and a third module holding what the two
 * agreed on, because macOS had no photo library and no `expo-image-manipulator`.
 * Since ADR-0011 the Mac is the iPad build, with both, so there is one picker
 * and one file.
 */
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import { Image, Linking } from 'react-native'

import { strings } from '../../i18n/strings'

/** The longest edge an attachment is resized to before it is encoded. */
export const MAX_ATTACHMENT_EDGE = 1568

export interface PickedAttachment {
  id: string
  filename: string
  /** Raw base64, no `data:` prefix — `image.attach_bytes` takes it as-is. */
  base64: string
  /** Local URI, for the composer's thumbnail. */
  uri?: string
}

let counter = 0

/** A stable id for one staged attachment, unique within a session. */
const nextAttachmentId = (): string => `attachment-${Date.now().toString(36)}-${(counter += 1)}`

function filenameFor(uri: string, given: string | null | undefined): string {
  if (given) {
    return given
  }

  const tail = uri.split('/').pop()?.split('?')[0]

  return tail && tail.includes('.') ? tail : 'image.jpg'
}

/**
 * Open the photo library and return one attachment, or `null` when the user
 * backed out.
 *
 * No permission is requested first, deliberately. `launchImageLibraryAsync`
 * goes through PHPicker on iOS and the Android photo picker on Android, and
 * both run OUT of process: the app never sees the library, only the one item
 * handed back, and neither platform asks for a grant. Asking anyway put a
 * scary system prompt about full library access in front of a user who wanted
 * to attach one screenshot — and a "Limited" answer, which is the one most
 * people give, came back as `granted: false` and refused the picker that would
 * have worked perfectly.
 *
 * The permission path still exists for the older OS versions that do gate the
 * picker: the error is caught, and the message points at Settings rather than
 * at the platform's own wording.
 */
export async function pickAttachment(): Promise<PickedAttachment | null> {
  let picked: ImagePicker.ImagePickerResult

  try {
    picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
      // Not `base64: true`: that would encode the ORIGINAL, which is the whole
      // thing this function exists to avoid. The resize below encodes instead.
      exif: false
    })
  } catch (error) {
    throw new Error(permissionMessage(error))
  }

  const asset = picked.canceled ? undefined : picked.assets?.[0]

  if (!asset) {
    // Cancelled, or a picker that returned nothing: not an error, and nothing
    // to show for it.
    return null
  }

  return resizeToBase64(asset.uri, filenameFor(asset.uri, asset.fileName), asset.width, asset.height)
}

/** Offer the one action that can fix a refused picker. */
export function openAppSettings(): void {
  void Linking.openSettings().catch(() => undefined)
}

function permissionMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return /permission|denied|authoriz/i.test(text) ? strings.chat.attach.permission : text
}

/**
 * Resize past the cap and encode. Below the cap the image is still re-encoded
 * as JPEG, because that is what bounds a 12 MB PNG screenshot.
 */
export async function resizeToBase64(
  uri: string,
  filename: string,
  width?: number,
  height?: number
): Promise<PickedAttachment> {
  const longest = Math.max(width ?? 0, height ?? 0)
  const actions: ImageManipulator.Action[] =
    longest > MAX_ATTACHMENT_EDGE
      ? [
          (width ?? 0) >= (height ?? 0)
            ? { resize: { width: MAX_ATTACHMENT_EDGE } }
            : { resize: { height: MAX_ATTACHMENT_EDGE } }
        ]
      : []

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    base64: true,
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG
  })

  return {
    id: nextAttachmentId(),
    filename: filename.replace(/\.(png|heic|heif|webp|gif)$/i, '.jpg'),
    base64: result.base64 ?? '',
    uri: result.uri
  }
}

/**
 * The pixel size of an image at `uri`, for a caller that has no asset object to
 * read `width`/`height` off — a pasted image, native or web, is exactly that:
 * the pasteboard hands back bytes and a URI, never dimensions.
 *
 * `Image.getSize` rather than a second image-decoding library, because React
 * Native already ships one that works on every platform this app runs on,
 * including the web build through React Native Web's own `ImageLoader`.
 *
 * Resolves to an empty object rather than rejecting: a size this function could
 * not read is not a reason to refuse the paste, only a reason `resizeToBase64`
 * skips the resize step and encodes the image at whatever size it already is.
 */
export function imageDimensions(uri: string): Promise<{ width?: number; height?: number }> {
  return new Promise(resolve => {
    Image.getSize(
      uri,
      (width, height) => resolve({ height, width }),
      () => resolve({})
    )
  })
}
