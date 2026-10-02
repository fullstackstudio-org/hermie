import SwiftUI
import WidgetKit

/**
 Up to three conversations, medium: the top of the chat list, as a glance — or
 the top of ONE FOLDER of it.

 Three and not four. The row is 30pt of avatar plus two lines of type, and a fourth row at the
 height systemMedium is drawn at leaves the type below the size the app's own scale bottoms out at
 — which would make the widget the one place in Hermie with type nobody chose.

 Ordered by recency, like the small widget and unlike the sidebar, and `snapshot.ts` explains why:
 the list is an arrangement the owner made and scrolls, a widget is four square centimetres that
 get one glance. That holds INSIDE a folder as well: picking a folder says which bots, not which
 order.

 ## The folder is the one part of the arrangement that reaches a home screen

 Unconfigured, this is the whole list — which is what it always was, and what a freshly added one
 still shows. Configured, it is one folder, with a header carrying that folder's name and its two
 numbers. The numbers are the app's, computed in `snapshot.ts` and NOT added up from the rows on
 screen: a folder's unread counts its muted chats and a bot's own badge does not, so a widget that
 summed what it was drawing would be wrong by exactly those chats.

 **Each row is its own link**, so a tap lands on the chat under the finger rather than on whichever
 one the widget decided was first. That is `Link` per row rather than `widgetURL` for the square —
 the opposite choice from the small family, for the opposite reason. The header is a link too, to
 `hermie://folder/<id>`, which opens the chat list with that folder expanded and scrolled to.
 */
struct HermieBotsEntry: TimelineEntry {
  let date: Date
  let bots: [HermieBot]
  /** The folder this widget is pinned to, or nil for the whole list. */
  let folder: HermieFolder?
}

struct HermieBotsProvider: AppIntentTimelineProvider {
  /** As many as the family draws. See the note above about why it is three. */
  static let rows = 3

  func placeholder(in context: Context) -> HermieBotsEntry {
    HermieBotsEntry(date: Date(), bots: Array(HermieWidgetStore.load().bots.prefix(Self.rows)), folder: nil)
  }

  func snapshot(for configuration: HermieSelectFolderIntent, in context: Context) async -> HermieBotsEntry {
    entry(for: configuration)
  }

  /** One entry, never expiring: the app reloads this when it has something new. */
  func timeline(for configuration: HermieSelectFolderIntent, in context: Context) async -> Timeline<HermieBotsEntry> {
    Timeline(entries: [entry(for: configuration)], policy: .never)
  }

  /**
   The configured folder's rows, or the whole list's.

   Two ways to end up on the fallback and both are right: the reader never
   picked a folder, or the one they picked has been deleted — or emptied, which
   `snapshot.ts` treats the same way, because a folder with nothing in it is a
   widget that can never fill in.
   */
  private func entry(for configuration: HermieSelectFolderIntent) -> HermieBotsEntry {
    let snapshot = HermieWidgetStore.load()

    guard let chosen = configuration.folder?.id, let folder = snapshot.folder(id: chosen) else {
      return HermieBotsEntry(date: Date(), bots: Array(snapshot.bots.prefix(Self.rows)), folder: nil)
    }

    return HermieBotsEntry(date: Date(), bots: Array(snapshot.bots(in: folder).prefix(Self.rows)), folder: folder)
  }
}

struct HermieBotsWidgetView: View {
  @Environment(\.colorScheme) private var colorScheme

  let entry: HermieBotsEntry

  var body: some View {
    let colors = HermieColors(dark: colorScheme == .dark)

    Group {
      if entry.bots.isEmpty {
        HermieEmpty(colors: colors)
      } else {
        VStack(spacing: entry.folder == nil ? 10 : 6) {
          if let folder = entry.folder {
            header(folder, colors: colors)
          }

          ForEach(entry.bots) { bot in
            if let url = bot.chatURL {
              Link(destination: url) {
                HermieRow(bot: bot, colors: colors)
              }
            } else {
              HermieRow(bot: bot, colors: colors)
            }
          }

          // Pushes a short list to the top rather than spreading two rows over the
          // whole height, which reads as a layout bug rather than as a short list.
          Spacer(minLength: 0)
        }
      }
    }
    .hermieContainerBackground(colors)
  }

  /**
   The folder's name, its numbers, and how many rows did not fit.

   The badge is the folder's own `unread`, straight from the snapshot. The
   needs-input dot is drawn beside it rather than folded into the number,
   because they are different facts — one is "things arrived", the other is "a
   bot is blocked until you answer" — and the chat list already draws them that
   way.
   */
  @ViewBuilder
  private func header(_ folder: HermieFolder, colors: HermieColors) -> some View {
    let tint = folder.colour.map { Color(hexString: $0) } ?? colors.accent
    let row = HStack(spacing: 6) {
      Text(folder.name)
        .font(.system(size: 13, weight: .semibold))
        .foregroundColor(colors.text)
        .lineLimit(1)

      if folder.needsInput > 0 {
        Circle()
          .fill(colors.presence("needsInput"))
          .frame(width: 7, height: 7)
      }

      Spacer(minLength: 0)

      if folder.size > entry.bots.count {
        Text("+\(folder.size - entry.bots.count)")
          .font(.system(size: 11, weight: .medium))
          .foregroundColor(colors.muted)
      }

      if folder.unread > 0 {
        // Spelled out rather than reusing `HermieBadge`: that one takes a BOT
        // and answers the row's question, where a needs-input dot REPLACES the
        // count. A folder shows both, because the two facts are independent
        // once they are aggregated — the chat list's folder header draws them
        // side by side for the same reason.
        Text(folder.unread > 99 ? "99+" : "\(folder.unread)")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(tint))
      }
    }

    if let url = folder.listURL {
      Link(destination: url) { row }
    } else {
      row
    }
  }
}

struct HermieBotsWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: "HermieBotsWidget",
      intent: HermieSelectFolderIntent.self,
      provider: HermieBotsProvider()
    ) { entry in
      HermieBotsWidgetView(entry: entry)
    }
    .configurationDisplayName("Chats")
    .description("The three most recent conversations, or one folder's, with what is unread and what needs you.")
    .supportedFamilies([.systemMedium])
  }
}
