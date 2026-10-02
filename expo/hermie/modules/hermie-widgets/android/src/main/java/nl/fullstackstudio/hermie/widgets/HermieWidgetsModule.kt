package nl.fullstackstudio.hermie.widgets

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URLEncoder

/**
 * The app's half of the home-screen widgets, Android side.
 *
 * Three functions with the same names and the same answers as
 * `ios/HermieWidgetsModule.swift`, so `src/platform/widgets.ts` has one shape to
 * call and `src/features/widgets/widget-sync.ts` has no platform branch in it at
 * all. What differs is only where the bytes go and how the redraw is asked for:
 *
 *  - **No App Group.** An AppWidgetProvider runs in the app's own process, so
 *    there is nothing to share across a sandbox boundary. The snapshot is one
 *    string in `SharedPreferences` and the avatars are files in `filesDir`.
 *  - **A broadcast rather than `WidgetCenter`.** `AppWidgetManager` is asked for
 *    the ids of every widget each provider has on a home screen, and an
 *    `APPWIDGET_UPDATE` intent carrying those ids is sent to the provider —
 *    which is the documented way to make a provider redraw on demand, and the
 *    only one that does not need the widget to be waiting on a period.
 *
 * Nothing here throws, for the reason the iOS half gives: a widget that is one
 * turn out of date is a widget, and a message that failed to send because a
 * picture could not be written is a bug.
 */
class HermieWidgetsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HermieWidgets")

    AsyncFunction("writeSnapshot") { json: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false

      context
        .getSharedPreferences(HermieWidgetStore.PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .putString(HermieWidgetStore.SNAPSHOT_KEY, json)
        // `commit` and not `apply`: the broadcast below reaches the provider on
        // the main thread within microseconds, and `apply` only promises the
        // write eventually. The one case that matters is the app being killed
        // right after backgrounding, which is exactly when the last write
        // happens (`WidgetSync.pause`).
        .commit()

      notifyProviders(context)

      true
    }

    AsyncFunction("writeAvatar") { botName: String, base64: String ->
      val context = appContext.reactContext ?: return@AsyncFunction false

      try {
        val directory = File(context.filesDir, HermieWidgetStore.AVATARS_DIRECTORY)
        directory.mkdirs()

        val bytes = Base64.decode(base64, Base64.DEFAULT)

        if (bytes.isEmpty()) {
          return@AsyncFunction false
        }

        File(directory, fileNameFor(botName)).writeBytes(bytes)

        true
      } catch (error: Exception) {
        false
      }
    }

    AsyncFunction("pruneAvatars") { keep: List<String> ->
      val context = appContext.reactContext ?: return@AsyncFunction 0
      val directory = File(context.filesDir, HermieWidgetStore.AVATARS_DIRECTORY)
      val wanted = keep.map { fileNameFor(it) }.toSet()

      directory.listFiles()?.count { file -> file.name !in wanted && file.delete() } ?: 0
    }

    /** The counterpart of the iOS probe. Always true here: there is no container to miss. */
    Function("hasSharedContainer") { true }
  }

  /**
   * Redraw every Hermie widget that is actually on a home screen.
   *
   * `getAppWidgetIds` answers an empty array when none is, and an
   * `APPWIDGET_UPDATE` with an empty id array is a broadcast nobody acts on — so
   * the common case (an app with no widgets added) costs one array allocation
   * and nothing else.
   */
  private fun notifyProviders(context: Context) {
    val manager = AppWidgetManager.getInstance(context)

    for (provider in listOf(HermieSmallWidgetProvider::class.java, HermieMediumWidgetProvider::class.java)) {
      val ids = manager.getAppWidgetIds(ComponentName(context, provider))

      if (ids.isEmpty()) {
        continue
      }

      context.sendBroadcast(
        Intent(context, provider).apply {
          action = AppWidgetManager.ACTION_APPWIDGET_UPDATE
          putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids)
        }
      )
    }
  }

  companion object {
    /**
     * `<escaped name>.png`, escaped the way `encodeURIComponent` escapes.
     *
     * The same rule as the Swift module's, and for the same reason: `snapshot.ts`
     * writes `avatars/<encodeURIComponent(name)>.png` into the JSON and the
     * provider looks the file up by that string, so a bot name that escapes
     * differently here is a picture that is written and never found.
     *
     * `URLEncoder` is close but not equal — it encodes a space as `+` and leaves
     * `*` alone where `encodeURIComponent` leaves `!~*'()` alone and encodes a
     * space as `%20` — so the three differences are corrected rather than
     * papered over. The result is byte-for-byte what the JavaScript produced.
     */
    fun fileNameFor(botName: String): String {
      val encoded = URLEncoder.encode(botName, "UTF-8")
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%7E", "~")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")

      return "$encoded.png"
    }
  }
}
