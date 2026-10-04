import Foundation

/// What switching YOLO mode did.
public enum YoloOutcome: Sendable, Equatable {
  /// The gateway took it: the chat now skips approval requests (`true`) or asks for them again.
  case switched(Bool)
  /// The gateway or the connection refused it; the words are for a line over the chat. The state
  /// is unchanged.
  case failed(String)
}
