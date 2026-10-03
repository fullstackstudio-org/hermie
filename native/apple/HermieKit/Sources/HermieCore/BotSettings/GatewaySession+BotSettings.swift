import Foundation
import HermieProtocol

extension GatewaySession {
  /// The model behind one bot's settings screen, over this session's link. A screen builds one per
  /// time it is opened: it holds drafts, and drafts are not kept.
  public func botSettings(for name: String) -> BotSettingsModel {
    BotSettingsModel(
      gateway: .link(link),
      profile: name,
      runtimeSessionID: { [weak self] in
        await self?.store.sessionIDs()[name]?.runtime
      },
      onChanged: { [weak self] in
        guard let self else { return }

        Task { _ = try? await self.roster.refresh() }
      }
    )
  }

  /// What this person calls the bot: the name they gave it, else the gateway's display name, else
  /// the handle.
  public func chatName(_ name: String) -> String {
    if let label = arrangement.label(name) {
      return label
    }

    guard let display = chatList.rows[name]?.bot.displayName, !display.isEmpty else {
      return name
    }

    return display
  }
}
