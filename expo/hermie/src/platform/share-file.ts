/**
 * Handing a file to the rest of the system.
 *
 * On the phones and on the Mac's iPad build that is the share sheet, which is
 * the one surface that already knows every destination the reader has — Files,
 * Mail, Quick Look, another app. `Share.share({ url })` is React Native's own
 * and takes a `file://` URI, so nothing native has to be added for it.
 *
 * The browser half is `share-file.web.ts`, and it is a different verb: a page
 * cannot open a share sheet, so it downloads instead. Same function, same
 * promise, different meaning — which is why the name says `share` and the
 * caller's label is resolved per platform rather than hard-coded to either
 * word.
 */
import { Share } from 'react-native'

/** What the action is called on this platform, for a menu item or a hint. */
export const SHARE_FILE_VERB: 'share' | 'download' = 'share'

/**
 * Offer one file to the system.
 *
 * Resolves `false` when there was nothing to offer or the sheet could not open;
 * a dismissed sheet is a `true` — the reader saw it and chose nothing, which is
 * not a failure the caller should report as one.
 */
export async function shareFile(uri: string, _name?: string): Promise<boolean> {
  if (!uri) {
    return false
  }

  try {
    // The RESULT is deliberately ignored. `Share.share` resolves with
    // `dismissedAction` when the reader closed the sheet without picking a
    // destination, and that is a decision rather than a failure — reporting it
    // as one would put an error in front of somebody who simply changed their
    // mind. Only a sheet that never opened lands in the catch.
    await Share.share({ url: uri })

    return true
  } catch {
    // A share sheet that will not open is not worth an error card over: the
    // reader still has the image on screen.
    return false
  }
}
