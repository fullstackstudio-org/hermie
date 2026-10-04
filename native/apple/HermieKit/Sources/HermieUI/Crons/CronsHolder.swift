import HermieCore
import SwiftUI

/**
 The one `CronsModel` of the live session, shared by the two columns that draw crons: the list in the
 sidebar and the open cron in the detail column read the same rows, so a pause in one is a pause in
 the other without either asking the gateway twice.

 The shell owns one holder and puts it in the environment. It builds the model on first use and again
 when the live session is another one (a gateway switch, a sign-in), and holds the session weakly: a
 model of a session that is gone is not kept alive by this.
 */
@MainActor
final class CronsHolder {
  private weak var session: GatewaySession?
  private var model: CronsModel?

  nonisolated init() {}

  func model(for session: GatewaySession) -> CronsModel? {
    if let model, self.session === session {
      return model
    }

    let made = session.crons()
    self.session = session
    model = made

    return made
  }
}

extension EnvironmentValues {
  @Entry var cronsHolder: CronsHolder? = nil
}
