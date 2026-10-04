import Foundation

extension GatewaySession {
  /// The model behind the New bot sheet, over this session's link and roster. A sheet builds one each
  /// time it opens: it holds a half-typed form, and a form is not kept.
  public func newBot() -> NewBotModel {
    let roster = self.roster

    return NewBotModel(
      gateway: .link(link),
      roster: NewBotRoster(
        refresh: { try await roster.refresh() },
        resolveCanonical: { try await roster.resolveCanonical($0) }
      ),
      existing: chatList.names,
      setLabel: { [arrangement] name, label in arrangement.setLabel(name, label) }
    )
  }
}
