package nl.fullstackstudio.hermie.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import java.net.URLEncoder

/**
 * The two home-screen widgets, and the drawing both of them share.
 *
 * They are the Android counterparts of `HermieBotWidget` (systemSmall) and
 * `HermieBotsWidget` (systemMedium), down to the same three-row cap and the same
 * "most recently active first" ordering — the ordering is not decided here at
 * all, it is the order `snapshot.ts` wrote.
 *
 * **What Android does not have.** There is no accessory family, so the lock
 * screen's "N need input" has no counterpart: `widgetCategory="keyguard"` was
 * removed in Android 5 and never replaced. And there is no per-widget
 * configuration, so the small widget always shows the most recent chat rather
 * than one the reader pinned — see the note in `res/xml/hermie_widget_small_info.xml`
 * for why that is a stated limitation rather than a half-built picker.
 *
 * **Updates are pushed, never polled.** `updatePeriodMillis` is 0 in both
 * provider files; `HermieWidgetsModule` broadcasts an update when the app writes
 * the snapshot. The cost is the same one iOS's `.never` policy pays and it is
 * stated in the same place: a phone whose Hermie has not run for a week shows a
 * week-old widget, which is honest for a client with no background delivery of
 * its own.
 */
class HermieSmallWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val bot = HermieWidgetStore.bots(context).firstOrNull()

    for (id in ids) {
      manager.updateAppWidget(id, HermieWidgets.small(context, bot))
    }
  }
}

class HermieMediumWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val bots = HermieWidgetStore.bots(context).take(HermieWidgets.ROWS)

    for (id in ids) {
      manager.updateAppWidget(id, HermieWidgets.medium(context, bots))
    }
  }
}

/** Everything both providers draw, so the two cannot disagree about a bead. */
object HermieWidgets {
  /** Three, for the reason `HermieBotsWidget.swift` gives about the type scale. */
  const val ROWS = 3

  /**
   * One row's four ids, so the medium layout's deliberate triplication (see the
   * comment in `hermie_widget_medium.xml`) is bound through one function instead
   * of three copies of the same Kotlin.
   */
  private data class RowIds(val avatar: Int, val bead: Int, val name: Int, val lastLine: Int, val badge: Int)

  private val ROW_IDS = listOf(
    RowIds(R.id.hermie_row1_avatar, R.id.hermie_row1_bead, R.id.hermie_row1_name, R.id.hermie_row1_last_line, R.id.hermie_row1_badge),
    RowIds(R.id.hermie_row2_avatar, R.id.hermie_row2_bead, R.id.hermie_row2_name, R.id.hermie_row2_last_line, R.id.hermie_row2_badge),
    RowIds(R.id.hermie_row3_avatar, R.id.hermie_row3_bead, R.id.hermie_row3_name, R.id.hermie_row3_last_line, R.id.hermie_row3_badge)
  )

  fun small(context: Context, bot: HermieWidgetStore.Bot?): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hermie_widget_small)

    if (bot == null) {
      views.setViewVisibility(R.id.hermie_empty, View.VISIBLE)
      views.setViewVisibility(R.id.hermie_head, View.GONE)
      views.setViewVisibility(R.id.hermie_name, View.GONE)
      views.setViewVisibility(R.id.hermie_last_line, View.GONE)

      return views
    }

    views.setViewVisibility(R.id.hermie_empty, View.GONE)
    views.setImageViewBitmap(R.id.hermie_avatar, HermieWidgetStore.avatar(context, bot, 38))
    tintBead(context, views, R.id.hermie_bead, bot.presence)
    views.setTextViewText(R.id.hermie_name, bot.displayName)
    views.setTextViewText(
      R.id.hermie_last_line,
      bot.lastLine.ifEmpty { "No messages yet." }
    )
    badge(context, views, R.id.hermie_badge, bot)

    // The whole square is one tap target, which is what systemSmall is on iOS too.
    views.setOnClickPendingIntent(R.id.hermie_empty, chatIntent(context, null))
    views.setOnClickPendingIntent(R.id.hermie_name, chatIntent(context, bot))
    views.setOnClickPendingIntent(R.id.hermie_avatar, chatIntent(context, bot))
    views.setOnClickPendingIntent(R.id.hermie_last_line, chatIntent(context, bot))

    return views
  }

  fun medium(context: Context, bots: List<HermieWidgetStore.Bot>): RemoteViews {
    val views = RemoteViews(context.packageName, R.layout.hermie_widget_medium)

    views.setViewVisibility(R.id.hermie_empty, if (bots.isEmpty()) View.VISIBLE else View.GONE)

    if (bots.isEmpty()) {
      views.setOnClickPendingIntent(R.id.hermie_empty, chatIntent(context, null))
    }

    for ((index, ids) in ROW_IDS.withIndex()) {
      val bot = bots.getOrNull(index)

      // GONE rather than empty: two conversations should draw as two rows at the
      // top, not as two rows and a hole.
      val visibility = if (bot == null) View.GONE else View.VISIBLE

      for (id in listOf(ids.avatar, ids.bead, ids.name, ids.lastLine)) {
        views.setViewVisibility(id, visibility)
      }

      if (bot == null) {
        views.setViewVisibility(ids.badge, View.GONE)

        continue
      }

      views.setImageViewBitmap(ids.avatar, HermieWidgetStore.avatar(context, bot, 30))
      tintBead(context, views, ids.bead, bot.presence)
      views.setTextViewText(ids.name, bot.displayName)
      views.setTextViewText(ids.lastLine, bot.lastLine)
      badge(context, views, ids.badge, bot)

      // Each row is its own link, so a tap lands on the chat under the finger —
      // the same choice `HermieBotsWidget` makes with `Link` per row.
      for (id in listOf(ids.avatar, ids.name, ids.lastLine, ids.badge)) {
        views.setOnClickPendingIntent(id, chatIntent(context, bot))
      }
    }

    return views
  }

  /**
   * The bead's colour, applied to one shared drawable.
   *
   * `setColorFilter` through `setInt` rather than four drawables, because the
   * four states come from a string in the snapshot and a RemoteViews cannot pick
   * a drawable by one. The shape's stroke stays the surface colour, so the bead
   * keeps reading as sitting ON the avatar rather than as a hole in it.
   */
  private fun tintBead(context: Context, views: RemoteViews, id: Int, presence: String) {
    views.setInt(id, "setColorFilter", HermieWidgetStore.presenceColour(context, presence))
  }

  /**
   * The unread count, or a dot for "needs input", or nothing.
   *
   * Needs input wins over a count, for the reason `presence.ts` gives: a question
   * aimed at a person outranks the fact that some messages arrived. Nothing is
   * drawn when there is neither, rather than a zero.
   */
  @Suppress("UNUSED_PARAMETER")
  private fun badge(context: Context, views: RemoteViews, id: Int, bot: HermieWidgetStore.Bot) {
    when {
      bot.needsInput -> {
        views.setViewVisibility(id, View.VISIBLE)
        // No number: this is the dot the iOS widget draws, and a count would
        // answer a different question from the one the state is about.
        views.setTextViewText(id, " ")
        views.setInt(id, "setBackgroundResource", R.drawable.hermie_widget_badge_needs_input)
      }
      bot.unread > 0 -> {
        views.setViewVisibility(id, View.VISIBLE)
        views.setTextViewText(id, if (bot.unread > 99) "99+" else bot.unread.toString())
        views.setInt(id, "setBackgroundResource", R.drawable.hermie_widget_badge)
      }
      else -> views.setViewVisibility(id, View.GONE)
    }
  }

  /**
   * `hermie://chat/<bot>?gateway=<key>`, as a PendingIntent the launcher can fire.
   *
   * The same URL the iOS widgets carry and the same one `src/platform/deep-link.ts`
   * parses, so the tap behaviour is one piece of TypeScript on both platforms.
   * A null bot opens the app's list, which is what the empty state should do.
   *
   * The gateway parameter is what stops a tap on a device with two gateways
   * being a coin toss: without it the named bot opens on whichever gateway is
   * current, and two rosters routinely share names. It is appended unescaped
   * because it is hex by the time it reaches here — `HermieWidgetStore` drops
   * anything that is not — and left off entirely when there is none, which is
   * exactly how every snapshot written before this field looked.
   *
   * Three things about the flags. `FLAG_IMMUTABLE` because nothing may fill this
   * intent in — it is complete, and a mutable one handed to the launcher is a
   * capability handed to the launcher. The request code is the bot's hash, because
   * PendingIntents with equal request codes and equal intents are the SAME
   * PendingIntent, and three rows sharing one would all open the first row's chat.
   * And `FLAG_ACTIVITY_SINGLE_TOP` is deliberately absent: `MainActivity` is
   * already `singleTask`, which is what makes a second tap arrive at `onNewIntent`
   * and reach JavaScript as a `url` event rather than relaunching the app.
   */
  private fun chatIntent(context: Context, bot: HermieWidgetStore.Bot?): PendingIntent {
    val uri = bot?.let {
      val gateway = it.gatewayKey?.let { key -> "?gateway=$key" } ?: ""

      "hermie://chat/${encode(it.name)}$gateway"
    } ?: "hermie://chat"

    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri)).apply {
      `package` = context.packageName
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    return PendingIntent.getActivity(
      context,
      bot?.name?.hashCode() ?: 0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  /** `encodeURIComponent`, for a URL path segment. See `HermieWidgetsModule.fileNameFor`. */
  private fun encode(value: String): String =
    URLEncoder.encode(value, "UTF-8")
      .replace("+", "%20")
      .replace("%21", "!")
      .replace("%7E", "~")
      .replace("%27", "'")
      .replace("%28", "(")
      .replace("%29", ")")
}
