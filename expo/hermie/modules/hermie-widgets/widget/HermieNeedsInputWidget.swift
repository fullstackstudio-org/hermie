import SwiftUI
import WidgetKit

/**
 "N need input", for the lock screen and the watch-style accessory families.

 One number, because that is the whole budget. An accessory widget is drawn in a single tint the
 system picks — it is rendered as a vibrant monochrome stencil, so the app's colours do not reach
 it at all — and it is read at arm's length while the phone is face up on a desk. The only thing
 worth putting there is the count of conversations that have stopped and are waiting on a person,
 which is exactly the state `presence.ts` ranks above everything except being offline.

 It is deliberately not "unread". Unread is mail; this is a turn that will not finish until somebody
 answers it, and ADR-0010 is the reason that distinction is load-bearing rather than cosmetic: an
 agent's question is answered by an explicit tap and until then the work is stopped.

 The tap opens the chat that is waiting, when exactly one is. With none there is nothing to open, and
 with several there is no one right answer, so both of those open the app's own list instead.
 */
struct HermieNeedsInputEntry: TimelineEntry {
  let date: Date
  let count: Int
  /** Set only when exactly one bot is waiting, which is when a tap has one answer. */
  let only: HermieBot?
}

struct HermieNeedsInputProvider: TimelineProvider {
  func placeholder(in context: Context) -> HermieNeedsInputEntry {
    let waiting = HermieWidgetStore.load().bots.filter(\.needsInput)

    return HermieNeedsInputEntry(date: Date(), count: waiting.count, only: waiting.count == 1 ? waiting.first : nil)
  }

  func getSnapshot(in context: Context, completion: @escaping (HermieNeedsInputEntry) -> Void) {
    completion(placeholder(in: context))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<HermieNeedsInputEntry>) -> Void) {
    completion(Timeline(entries: [placeholder(in: context)], policy: .never))
  }
}

struct HermieNeedsInputWidgetView: View {
  @Environment(\.widgetFamily) private var family

  let entry: HermieNeedsInputEntry

  var body: some View {
    Group {
      if family == .accessoryCircular {
        // A gauge rather than a label: the circular family is a dial-shaped hole
        // and a bare number in it reads as clipped.
        ZStack {
          AccessoryWidgetBackground()
          VStack(spacing: -2) {
            Text("\(entry.count)")
              .font(.system(size: 22, weight: .semibold))
            Text("need")
              .font(.system(size: 9))
          }
        }
      } else {
        VStack(alignment: .leading, spacing: 1) {
          Text("Hermie")
            .font(.system(size: 13, weight: .semibold))
          Text(label)
            .font(.system(size: 15))
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .widgetURL(entry.only?.chatURL ?? URL(string: "hermie://chat"))
    .containerBackground(for: .widget) { Color.clear }
  }

  /**
   The rectangular family's line.

   Singular and plural are spelled out rather than built from a format string, because there are
   exactly three cases and one of them ("Nothing waiting") is not a count at all.
   */
  private var label: String {
    switch entry.count {
    case 0:
      return "Nothing waiting"
    case 1:
      return entry.only.map { "\($0.displayName) needs input" } ?? "1 needs input"
    default:
      return "\(entry.count) need input"
    }
  }
}

struct HermieNeedsInputWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "HermieNeedsInputWidget", provider: HermieNeedsInputProvider()) { entry in
      HermieNeedsInputWidgetView(entry: entry)
    }
    .configurationDisplayName("Needs input")
    .description("How many conversations have stopped and are waiting on you.")
    .supportedFamilies([.accessoryRectangular, .accessoryCircular])
  }
}
