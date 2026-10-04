import Foundation

/// Which of a chat's sheets has the screen. SwiftUI shows one sheet at a time and drops a second
/// one raised over it, so an approval that arrived while a form was open would never be seen. The
/// order: an approval, a passkey confirmation or a secure prompt is time-critical and comes first;
/// a form, a file request or a draft review gives way to it (`InteractiveModel.yield()`, not Later,
/// so it comes back by itself) and does not come up while one waits.
@MainActor
public struct ChatSheetOrder {
  let requests: RequestsModel
  let secureInput: SecureInputModel
  let interactive: InteractiveModel

  public init(requests: RequestsModel, secureInput: SecureInputModel, interactive: InteractiveModel) {
    self.requests = requests
    self.secureInput = secureInput
    self.interactive = interactive
  }

  /// An approval, a confirmation or a secure prompt is waiting for the screen or has it: the
  /// interactive sheet steps aside, and does not come up.
  public var interactiveBlocked: Bool {
    requests.nextToPresent != nil || requests.presentedRequestID != nil || secureInput.nextToPresent != nil
      || secureInput.presentedID != nil
  }

  /// An interactive sheet has the screen: an approval or a secure prompt waits to be raised until
  /// it has stepped aside, which it does the moment one is waiting.
  public var holdForInteractive: Bool {
    interactive.presentedID != nil
  }
}
