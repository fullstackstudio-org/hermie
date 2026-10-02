import Foundation

/// What the sign-in types may say about a secret they hold: whether there is one.
enum SignInRedaction {
  static func presence(_ value: String) -> String {
    value.isEmpty ? "<empty>" : "<redacted>"
  }
}

/// The model holds a session token, a front-door secret, header values and tokens while the flow
/// runs: a description, a debug description or a mirror (a failed test's dump, a `print`, the
/// debugger's `po`) says what step it is on and nothing it holds.
extension OnboardingModel: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public nonisolated var description: String { "OnboardingModel(<redacted>)" }
  public nonisolated var debugDescription: String { description }
  public nonisolated var customMirror: Mirror { Mirror(self, children: ["state": "<redacted>"]) }
}

extension OnboardingModel.HeaderRow: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "HeaderRow(id: \(id), name: \(name), value: \(SignInRedaction.presence(value)))" }
  public var debugDescription: String { description }
  public var customMirror: Mirror {
    Mirror(self, children: ["id": id, "name": name, "value": SignInRedaction.presence(value)])
  }
}

/// The attempt carries the wire headers and the front door's script, both of which hold the secret.
extension InAppSignInAttempt: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public nonisolated var description: String { "InAppSignInAttempt(<redacted>)" }
  public nonisolated var debugDescription: String { description }
  public nonisolated var customMirror: Mirror { Mirror(self, children: ["state": "<redacted>"]) }
}
