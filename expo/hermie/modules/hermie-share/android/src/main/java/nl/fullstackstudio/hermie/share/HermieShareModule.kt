package nl.fullstackstudio.hermie.share

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The app's half of "Share to Hermie", Android side.
 *
 * Two functions with the same names and the same answers as
 * `ios/HermieShareModule.swift`, so `src/platform/share-inbox.ts` has one shape
 * to call and `share-delivery.ts` has no platform branch in it at all. What
 * differs is only where the entries are and, on this platform, that reading
 * them is also what CREATES one.
 *
 * ## `listShares` absorbs the intent, and that is not a side effect it is
 * embarrassed about
 *
 * There is no share extension here. The system's chooser starts MainActivity
 * with an `ACTION_SEND` intent, and nothing in the app would otherwise notice:
 * the intent is not a deep link, it fires no `Linking` event, and by the time
 * JavaScript is running it is simply a field on an activity. So the first read
 * of the outbox is also when that intent becomes an entry on disk, after which
 * it is an ordinary queued share exactly like an iOS one.
 *
 * The ordering that makes this work is in `ChatRuntime`: the outbox is pumped
 * on every foreground, and being brought to the front by the chooser IS a
 * foreground. `absorb` clears the action once it has written, so a second pump
 * finds nothing to absorb and a re-render cannot duplicate a share.
 *
 * **Nothing here throws.** A share that cannot be read is a share that is not
 * delivered; it is not a reason for the launch that found it to fail.
 */
class HermieShareModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HermieShare")

    AsyncFunction("listShares") {
      val context = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, Any>>()

      try {
        // The activity rather than the application context, because the intent
        // is the activity's. A null activity means the app is not in front,
        // which is not a state a share arrives in — and the entries already on
        // disk are still listed below either way.
        HermieShareStore.absorb(context, appContext.currentActivity?.intent)
        HermieShareStore.list(context)
      } catch (error: Exception) {
        emptyList<Map<String, Any>>()
      }
    }

    AsyncFunction("clearShare") { id: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false

      try {
        HermieShareStore.clear(context, id)
      } catch (error: Exception) {
        false
      }
    }

    /**
     * The counterpart of the iOS module's targets write, and a deliberate no-op.
     *
     * `share-targets.json` exists so that an out-of-process share sheet can send
     * without the app (ADR-0026). Android has no such process: the system's
     * chooser starts MainActivity, so by the time a share exists the app is
     * running and the file would have no reader. Answering false rather than
     * omitting the function keeps `src/platform/share-inbox.ts` free of a platform
     * branch, which is the same reason `hasSharedContainer` below exists.
     */
    AsyncFunction("writeShareTargets") { _: String -> false }

    /**
     * The counterpart of the iOS module's container question.
     *
     * Always true here: there is no App Group to be missing and no entitlement
     * that can fail to be signed in, because an `ACTION_SEND` intent reaches the
     * app's own process. It exists so the developer screen can ask one question
     * on both platforms rather than branching.
     */
    Function("hasSharedContainer") { true }
  }
}
