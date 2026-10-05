import HermieCore
import SwiftUI

/**
 A bot's Decision log, on its settings page: one row, in the style of the Usage and Vault rows, that says how many
 decisions the bot has in the log and opens its own page (`DecisionLogScreen`, narrowed to this bot of this gateway).

 The count is read from this device's log (`DecisionLog.count`): no gateway call, so it is there at once, also
 offline. It follows the log while the page is open. Without a launch in the environment (a host that only draws the
 settings page) there is no log, and no row.
 */
struct BotDecisionLogSection: View {
  let chat: ChatRef
  let session: GatewaySession

  @Environment(AppLaunch.self) private var launch: AppLaunch?
  @State private var count: Int?

  var body: some View {
    if let log = launch?.decisions {
      Section {
        NavigationLink {
          DecisionLogScreen(log: log, scope: .init(gatewayID: session.gatewayID, bot: chat.bot))
        } label: {
          LabeledContent {
            Text(verbatim: count.map { $0 == 0 ? "–" : String($0) } ?? "")
              .foregroundStyle(.secondary)
              .monospacedDigit()
          } label: {
            Label(NativeStrings.Decisions.title, systemImage: "checklist")
          }
        }
        .accessibilityIdentifier("hermie.botSettings.decisions")
      }
      .task(id: log.revision) {
        count = await log.count(gatewayID: session.gatewayID, bot: chat.bot)
      }
    }
  }
}
