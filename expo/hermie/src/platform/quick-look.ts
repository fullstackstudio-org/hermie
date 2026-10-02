/**
 * Looking at a file, as opposed to sending it somewhere.
 *
 * Tapping an attachment chip used to open the share sheet on every Apple
 * target, and a share sheet is a list of destinations: reading the PDF somebody
 * attached meant picking an app to read it in first. On a Mac — where Quick Look
 * is the thing people press Space for — that was conspicuously the wrong verb.
 *
 * `QLPreviewController` is the right one, and it is **iOS API**, not Mac API. So
 * this is not a Mac seam even though the Mac is what made it obvious: an iPhone
 * and an iPad get the same previewer, which is what they should have had all
 * along. It reaches `modules/hermie-mac` because that module is already this
 * app's Apple-side lever, and a second local module for one view controller
 * would be a second podspec and a second thing to keep out of an EAS archive.
 *
 * ## It answers, rather than throwing
 *
 * `false` is a normal answer and covers every expected refusal — a URI with no
 * readable file behind it, a type Quick Look has no previewer for, an older
 * binary under a newer bundle, Android, a browser. The caller falls back to the
 * share sheet, which is what the app did before, so nothing gets worse
 * anywhere. A rejected promise would make the caller tell an expected answer
 * from a real failure by reading a message.
 *
 * ## Local files only
 *
 * `file://` and nothing else. A remote attachment is brought down BEFORE it
 * reaches here, by `open-attachment.ts`, through the gateway's own
 * `GatewayHttp` — which carries the bearer, the operator's front-door headers
 * and the one 401 retry. The Swift used to do that fetch itself with a bare
 * `URLSession`, which meant an attachment on a gated gateway could never have
 * been previewed at all.
 *
 * So what this seam is handed is always a path on this device: the app's own
 * picker produced it, or the cache copy did.
 */
import { requireOptionalNativeModule } from 'expo'

type QuickLookModule = {
  previewFile?: (uri: string, name?: string) => Promise<boolean>
  supportsQuickLook?: () => boolean
}

// A registry read, not a load: calling it twice hands back the same object, so
// the other seams that ask for `HermieMac` cost nothing extra.
function nativeModule(): QuickLookModule | null {
  try {
    return requireOptionalNativeModule<QuickLookModule>('HermieMac')
  } catch {
    // No Expo module host at all — a unit test renderer, or the web bundle.
    return null
  }
}

const mac = nativeModule()

/**
 * Whether this build can preview a file at all.
 *
 * For a menu that would otherwise offer a verb nothing can carry out, and for
 * the developer screen. It is a probe on the MODULE rather than a call of
 * `previewFile` itself, because the case it exists for is an older binary under
 * a newer bundle — where the function is simply absent.
 */
export const CAN_QUICK_LOOK: boolean = (() => {
  try {
    return mac?.supportsQuickLook?.() === true
  } catch {
    return false
  }
})()

/**
 * Show one file, and say whether it was shown.
 *
 * `name` is the filename the app knows, which is not always the one the path
 * carries — a cached copy of a remote file is named by this side — and it also
 * titles the preview.
 */
export async function openInQuickLook(uri: string, name?: string): Promise<boolean> {
  if (!uri || !mac?.previewFile) {
    return false
  }

  try {
    return (await mac.previewFile(uri, name)) === true
  } catch {
    // A native rejection is still just "it did not open". The caller's fallback
    // is the share sheet and it must not have to care which of the two happened.
    return false
  }
}
