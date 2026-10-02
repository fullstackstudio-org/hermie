package nl.fullstackstudio.hermie.widgets

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import java.io.File
import org.json.JSONObject

/**
 * The file the app writes, as the widget providers read it.
 *
 * The Android counterpart of `widget/HermieWidgetSnapshot.swift`, and the same
 * contract: the app derives everything while it still has the state to derive it
 * from (`src/features/widgets/snapshot.ts`), writes one versioned JSON document,
 * and the widget side only decodes and draws.
 *
 * **Where it lives is the one real difference from iOS.** There is no App Group
 * here because there is no second sandbox: an AppWidgetProvider is a
 * BroadcastReceiver inside the app's own process and the launcher only ever
 * holds the RemoteViews the provider handed it. So the snapshot sits in the
 * app's `SharedPreferences` — one string under one key — and the avatars in the
 * app's own files directory. Nothing is shared with anything, which is why the
 * entitlement half of the iOS story has no equivalent to get wrong.
 *
 * The version check is the same and for the same reason: an old APK against a
 * newer snapshot cannot happen here the way it can on iOS, but a snapshot left
 * behind by a previous version of the app across an update can, and half a row
 * drawn from fields that moved is worse than a line saying to open Hermie.
 */
object HermieWidgetStore {
  /** Matches `HermieWidgetsModule`; read by both providers. */
  const val PREFERENCES = "hermie.widgets"
  const val SNAPSHOT_KEY = "snapshot"
  const val AVATARS_DIRECTORY = "hermie-widget-avatars"

  /** Bumped in `snapshot.ts`; anything else is treated as no snapshot at all. */
  const val SUPPORTED_VERSION = 1

  data class Bot(
    val name: String,
    val displayName: String,
    val avatarPath: String?,
    val initials: String,
    val colour: String,
    val presence: String,
    val lastLine: String,
    val unread: Int,
    val needsInput: Boolean,
    /**
     * Which gateway this row came from, as `gatewayKeyOf` its origin.
     *
     * NOT read off the row: it is a property of the snapshot around it, stamped
     * on here so a tap can carry it without every provider having to hold a
     * second value. Null from an app that predates two gateways on one device,
     * and null for a key that is not sixteen lowercase hex digits —
     * `deep-link.ts` would ignore that anyway, and a URL carrying a malformed
     * parameter is worse than one carrying none.
     */
    val gatewayKey: String?
  )

  /** Sixteen lowercase hex digits, which is what `gatewayKeyOf` produces. */
  private fun gatewayKeyOrNull(value: String): String? =
    value.takeIf { it.length == 16 && it.all { character -> character in "0123456789abcdef" } }

  /**
   * Every bot in the snapshot, in the order the app wrote them — most recently
   * active first. An empty list means "nothing to draw", whatever the reason:
   * no file, a file that will not parse, or a version this build does not know.
   */
  fun bots(context: Context): List<Bot> {
    val raw = context
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(SNAPSHOT_KEY, null)
      ?: return emptyList()

    return try {
      val document = JSONObject(raw)

      if (document.optInt("version") != SUPPORTED_VERSION) {
        return emptyList()
      }

      val array = document.optJSONArray("bots") ?: return emptyList()
      val gatewayKey = gatewayKeyOrNull(document.optString("gatewayKey"))

      (0 until array.length()).mapNotNull { index ->
        val entry = array.optJSONObject(index) ?: return@mapNotNull null
        val name = entry.optString("name").takeIf { it.isNotEmpty() } ?: return@mapNotNull null

        Bot(
          name = name,
          displayName = entry.optString("displayName", name),
          avatarPath = entry.optString("avatarPath").takeIf { it.isNotEmpty() },
          initials = entry.optString("initials", "?"),
          colour = entry.optString("colour", "#2A72DC"),
          presence = entry.optString("presence", "offline"),
          lastLine = entry.optString("lastLine"),
          unread = entry.optInt("unread"),
          needsInput = entry.optBoolean("needsInput"),
          gatewayKey = gatewayKey
        )
      }
    } catch (error: Exception) {
      // A snapshot that will not parse is a snapshot that is not there. There is
      // nowhere for a widget to report an error to, and an empty widget says the
      // one thing that is both true and actionable.
      emptyList()
    }
  }

  /** The hex the snapshot carries, or the Blue preset's outgoing-bubble colour. */
  fun colourOf(bot: Bot): Int =
    try {
      Color.parseColor(bot.colour)
    } catch (error: IllegalArgumentException) {
      Color.parseColor("#2A72DC")
    }

  /** tokens.ts, lightPresence / darkPresence — resolved through the resource table. */
  fun presenceColour(context: Context, presence: String): Int {
    val id = when (presence) {
      "online" -> R.color.hermie_widget_online
      "working" -> R.color.hermie_widget_working
      "needsInput" -> R.color.hermie_widget_needs_input
      else -> R.color.hermie_widget_offline
    }

    return context.getColor(id)
  }

  /**
   * The avatar, as one finished circular bitmap.
   *
   * Composited here rather than in the layout because a RemoteViews cannot do
   * either half of it: there is no way to clip an ImageView to a circle from one,
   * and no way to stack a letter on a coloured shape. So the picture is loaded
   * and masked, or the initial is drawn on the chat's colour, and what crosses
   * into the launcher's process is a bitmap.
   *
   * Sized in pixels from the dp the layout reserves, so the circle is not the
   * only thing in the widget that is soft on a high-density screen.
   *
   * **The path in the snapshot is used as a FLAG, not as a path.** It is written
   * by `snapshot.ts` as `avatars/<name>.png`, which is where the iOS extension
   * finds it inside the App Group container; here the file is in the app's own
   * files directory under a name of this platform's choosing. So the file is
   * resolved from the bot's name through the one function that escapes it
   * (`HermieWidgetsModule.fileNameFor`), and the snapshot only ever answers
   * whether there is a picture to look for. Nothing from the JSON reaches the
   * file system, which is the whole of the path-traversal question.
   */
  fun avatar(context: Context, bot: Bot, sizeDp: Int): Bitmap {
    val size = (sizeDp * context.resources.displayMetrics.density).toInt().coerceAtLeast(1)
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val radius = size / 2f

    val picture = bot.avatarPath?.let {
      val directory = File(context.filesDir, AVATARS_DIRECTORY)

      BitmapFactory.decodeFile(File(directory, HermieWidgetsModule.fileNameFor(bot.name)).path)
    }

    if (picture != null) {
      canvas.drawCircle(radius, radius, radius, paint)
      paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
      canvas.drawBitmap(picture, Rect(0, 0, picture.width, picture.height), RectF(0f, 0f, size.toFloat(), size.toFloat()), paint)

      return bitmap
    }

    paint.color = colourOf(bot)
    canvas.drawCircle(radius, radius, radius, paint)

    // White, because `snapshot.ts` sends the accent value white is AA on.
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textAlign = Paint.Align.CENTER
      textSize = size * 0.44f
      isFakeBoldText = true
    }

    // `descent + ascent` is the trick that centres a line on its own optical
    // middle rather than on its baseline, which is what `textAlign` alone gives.
    canvas.drawText(bot.initials, radius, radius - (text.descent() + text.ascent()) / 2, text)

    return bitmap
  }
}
