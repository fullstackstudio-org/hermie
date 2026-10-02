/**
 * Picking a square photo for a bot.
 *
 * The composer's picker (`features/chats/attachments.ts`) already solved the
 * hard half of this — the permission story, why no grant is requested, and the
 * resize that keeps a 12 MB screenshot off the socket — and this deliberately
 * does NOT reuse it, for one reason: an attachment is whatever shape it was and
 * an avatar is a square. `pickAttachment` resizes the long edge and keeps the
 * aspect ratio, so a landscape photo would arrive here as a wide strip that the
 * round `Avatar` would centre-crop differently on every surface that drew it.
 *
 * So the crop happens HERE, before the bytes leave the device:
 *
 *  - **Square, from the centre.** `allowsEditing` hands the platform's own
 *    cropper to the reader, which is the control they already know from setting
 *    a contact picture. It is not enough on its own — a reader who taps past it,
 *    and Android's picker where the editor is advisory, both still produce a
 *    rectangle — so the centre crop below runs regardless and is what actually
 *    guarantees the shape.
 *  - **Small.** An avatar is drawn at 40pt in a chat list. 512 px is past every
 *    surface that draws it at any scale factor, and it keeps the base64 the
 *    gateway stores in a profile's assets in the low tens of kilobytes rather
 *    than the low megabytes.
 *
 * The result is a bare base64 string: `profiles.set_asset` takes "a data URL or
 * bare base64 (PNG/JPEG/WebP, sniffed)", and a bare one is the smaller of the
 * two by the length of the prefix.
 */
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'

import { strings } from '../../i18n/strings'

/** The edge of the square that is stored. See the note above about 40pt. */
export const AVATAR_EDGE = 512

export interface PickedAvatar {
  /** Raw base64, no `data:` prefix — `profiles.set_asset` takes it as-is. */
  base64: string
  /** A local URI, so the sheet can show the new picture before the upload lands. */
  uri: string
}

/**
 * The centre square of an image of this size.
 *
 * Exported because it is the part worth testing on its own: a renderer cannot
 * crop anything, and the arithmetic is where an off-by-one puts a one-pixel
 * band of the original down one edge of every avatar.
 */
export function centreSquare(
  width: number,
  height: number
): { originX: number; originY: number; width: number; height: number } {
  const edge = Math.max(1, Math.min(Math.floor(width), Math.floor(height)))

  return {
    // Floored rather than rounded: an odd difference has to land INSIDE the
    // image, and rounding up on the last row is a crop the platform refuses.
    originX: Math.floor((width - edge) / 2),
    originY: Math.floor((height - edge) / 2),
    width: edge,
    height: edge
  }
}

/**
 * Open the photo library and return one square avatar, or `null` when the
 * reader backed out.
 *
 * No permission is requested first, for the reason `attachments.ts` sets out at
 * length: both platform pickers run out of process, neither asks for a grant,
 * and asking anyway turned a "Limited" answer into a refused picker that would
 * have worked. The catch is what covers the older versions that do gate it.
 */
export async function pickAvatar(): Promise<PickedAvatar | null> {
  let picked: ImagePicker.ImagePickerResult

  try {
    picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      // The platform's own cropper, locked square. The centre crop below still
      // runs: this is the reader's chance to choose WHICH square, not the thing
      // that guarantees there is one.
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
      exif: false
    })
  } catch (error) {
    throw new Error(permissionMessage(error))
  }

  const asset = picked.canceled ? undefined : picked.assets?.[0]

  if (!asset) {
    // Cancelled, or a picker that returned nothing. Not an error, and nothing
    // to show for it.
    return null
  }

  return cropToSquare(asset.uri, asset.width, asset.height)
}

/**
 * Crop to the centre square, shrink to `AVATAR_EDGE` and encode.
 *
 * JPEG rather than PNG, and that is a real trade rather than a default: an
 * avatar is a photograph, the gateway sniffs the type off the bytes so either
 * would be accepted, and a 512 px PNG of a photo is several times the size of
 * the same thing as JPEG for no difference anybody can see at 40pt.
 */
export async function cropToSquare(uri: string, width?: number, height?: number): Promise<PickedAvatar> {
  const actions: ImageManipulator.Action[] = []

  // A picker that reported no dimensions — which the web picker does — cannot
  // be cropped by arithmetic. The resize still squares it, because both edges
  // are named, and that is the honest fallback.
  if (width && height) {
    actions.push({ crop: centreSquare(width, height) })
  }

  actions.push({ resize: { width: AVATAR_EDGE, height: AVATAR_EDGE } })

  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    base64: true,
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG
  })

  return { base64: result.base64 ?? '', uri: result.uri }
}

function permissionMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)

  return /permission|denied|authoriz/i.test(text) ? strings.chat.attach.permission : text
}
