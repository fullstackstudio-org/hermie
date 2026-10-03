import SwiftUI

/// Gives a row hosted in a collection view cell the environment of the
/// `TranscriptList` it belongs to (the chat's actions, its disclosure memory,
/// the observable models the screen put there, a forced text size), without
/// what belongs to the cell's own host: whether accessibility is on and the
/// display scale.
///
/// A whole environment captured from the list and applied as is carried
/// `accessibilityEnabled` from the moment it was captured; rows hosted before
/// an assistive technology attached kept it off and never joined the
/// accessibility tree (the UI tests found no rows until something scrolled).
struct RowEnvironmentBridge<Content: View>: View {
  let captured: EnvironmentValues
  let content: Content

  @Environment(\.accessibilityEnabled) private var accessibilityEnabled
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    content.environment(\.self, bridged)
  }

  private var bridged: EnvironmentValues {
    var environment = captured
    environment.accessibilityEnabled = accessibilityEnabled
    environment.displayScale = displayScale
    return environment
  }
}
