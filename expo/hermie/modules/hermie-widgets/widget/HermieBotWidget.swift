import SwiftUI
import WidgetKit

/**
 One conversation, small: the avatar, the name, the bead and the last line.

 ## The timeline has one entry and never expires

 `.never` is the reload policy, and that is not laziness — it is the whole design. Every fact a
 widget shows is something only the app can know, and the app already knows the moment each of them
 changes: a message lands, a turn starts, an approval opens. So the app writes the file and calls
 `WidgetCenter.shared.reloadAllTimelines()` (`HermieWidgetsModule`), and the extension has nothing
 to schedule. A refresh policy on top of that would spend the day's budget re-reading a file that
 has not changed.

 The cost is stated plainly because a reader will hit it: a phone whose Hermie has not run for a
 week shows a week-old widget. It is the correct trade for a client that has no background delivery
 of its own — there is no push in this app, and a widget that lied about being live would be worse
 than one that is honestly out of date.

 ## The tap

 `widgetURL` rather than `Link`, because on systemSmall the whole square is one tap target and
 anything else would put an invisible seam in it. The URL is `hermie://chat/<bot>`, which
 `src/platform/deep-link.ts` parses and both shells act on.
 */
struct HermieBotEntry: TimelineEntry {
  let date: Date
  let bot: HermieBot?
}

struct HermieBotProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> HermieBotEntry {
    HermieBotEntry(date: Date(), bot: HermieWidgetStore.load().bots.first)
  }

  func snapshot(for configuration: HermieSelectBotIntent, in context: Context) async -> HermieBotEntry {
    HermieBotEntry(date: Date(), bot: resolve(configuration))
  }

  func timeline(for configuration: HermieSelectBotIntent, in context: Context) async -> Timeline<HermieBotEntry> {
    Timeline(entries: [HermieBotEntry(date: Date(), bot: resolve(configuration))], policy: .never)
  }

  /**
   The configured chat, or the most recent one.

   Two ways to end up on the fallback and both are right: the reader never picked one, or the one
   they picked has left the roster. `bots` is sorted most-recently-active first by the app, so
   `first` is the whole of "most recent" — there is no second ordering here to disagree with the
   app's.
   */
  private func resolve(_ configuration: HermieSelectBotIntent) -> HermieBot? {
    let bots = HermieWidgetStore.load().bots

    if let chosen = configuration.bot?.id, let bot = bots.first(where: { $0.name == chosen }) {
      return bot
    }

    return bots.first
  }
}

struct HermieBotWidgetView: View {
  @Environment(\.colorScheme) private var colorScheme

  let entry: HermieBotEntry

  var body: some View {
    let colors = HermieColors(dark: colorScheme == .dark)

    Group {
      if let bot = entry.bot {
        VStack(alignment: .leading, spacing: 6) {
          HStack(alignment: .top, spacing: 0) {
            HermieAvatarWithBead(bot: bot, colors: colors, size: 38)
            Spacer(minLength: 0)
            HermieBadge(bot: bot, colors: colors)
          }

          Text(bot.displayName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(colors.text)
            .lineLimit(1)

          Text(bot.lastLine.isEmpty ? "No messages yet." : bot.lastLine)
            .font(.system(size: 12))
            .foregroundStyle(colors.muted)
            // Three lines is what fits under the name on the smallest square this
            // family is drawn at, measured on an iPhone 17 Pro.
            .lineLimit(3)

          Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(bot.chatURL)
      } else {
        HermieEmpty(colors: colors)
      }
    }
    .hermieContainerBackground(colors)
  }
}

struct HermieBotWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "HermieBotWidget",
      intent: HermieSelectBotIntent.self,
      provider: HermieBotProvider()
    ) { entry in
      HermieBotWidgetView(entry: entry)
    }
    .configurationDisplayName("Chat")
    .description("One conversation: who it is, what they last said, and whether they need you.")
    .supportedFamilies([.systemSmall])
  }
}
