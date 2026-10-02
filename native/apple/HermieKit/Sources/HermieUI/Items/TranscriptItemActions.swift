import HermieTranscript
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/// What the rows can ask the chat screen to do. Every closure is the screen's;
/// the rows do no networking and hold no model.
///
/// Rows compare on their item alone, so these closures must not change while a
/// chat is open: capture the screen's model by reference, not values that move.
public struct TranscriptItemActions: Sendable {
  /// An approval was answered with one of its `choices`.
  public var answerApproval: @MainActor @Sendable (_ item: ApprovalItem, _ choice: String) -> Void
  /// A clarify was answered: qid → answer, multi-select answers joined with ", ".
  public var answerClarify: @MainActor @Sendable (_ item: ClarifyItem, _ answers: [String: String]) -> Void
  /// Open the chat with another bot, by handle.
  public var openBotChat: @MainActor @Sendable (_ handle: String) -> Void
  /// Retry a failed reply.
  public var retry: @MainActor @Sendable (_ item: AssistantItem) -> Void
  /// Open an attachment by its reference (`@file:…`, `@image:…`).
  public var openAttachment: @MainActor @Sendable (_ reference: String) -> Void
  /// Copy text. Defaults to the system pasteboard.
  public var copy: @MainActor @Sendable (_ text: String) -> Void

  public init(
    answerApproval: @escaping @MainActor @Sendable (ApprovalItem, String) -> Void = { _, _ in },
    answerClarify: @escaping @MainActor @Sendable (ClarifyItem, [String: String]) -> Void = { _, _ in },
    openBotChat: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    retry: @escaping @MainActor @Sendable (AssistantItem) -> Void = { _ in },
    openAttachment: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    copy: @escaping @MainActor @Sendable (String) -> Void = TranscriptItemActions.copyToPasteboard
  ) {
    self.answerApproval = answerApproval
    self.answerClarify = answerClarify
    self.openBotChat = openBotChat
    self.retry = retry
    self.openAttachment = openAttachment
    self.copy = copy
  }

  /// Does nothing but copy.
  public static let none = TranscriptItemActions()

  @MainActor
  public static func copyToPasteboard(_ text: String) {
    #if os(iOS)
      UIPasteboard.general.string = text
    #elseif os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #endif
  }
}

/// Which disclosures the reader opened, per row, for as long as the chat is
/// open — so a thought opened, scrolled away and scrolled back to is still
/// open, though the lazy list dropped the row's view in between.
///
/// Each disclosure has its own observable box, so opening one re-renders that
/// row and no other.
@MainActor
public final class TranscriptExpansion {
  @Observable
  @MainActor
  public final class Box {
    public var isExpanded: Bool

    init(_ isExpanded: Bool) {
      self.isExpanded = isExpanded
    }
  }

  private var boxes: [String: Box] = [:]

  public nonisolated init() {}

  /// The environment's default: a memory nobody owns, for previews and rows
  /// drawn outside a chat screen.
  nonisolated static let unowned = TranscriptExpansion()

  /// The box for `key`, created closed or open per `default`.
  public func box(_ key: String, default isExpanded: Bool) -> Box {
    if let box = boxes[key] {
      return box
    }
    let box = Box(isExpanded)
    boxes[key] = box
    return box
  }
}

extension EnvironmentValues {
  /// The chat's disclosure memory; the chat screen gives each chat its own.
  @Entry public var transcriptExpansion = TranscriptExpansion.unowned
  /// The rows' actions; the chat screen sets them once.
  @Entry public var transcriptItemActions = TranscriptItemActions.none
}

#if DEBUG
  /// Counts `body` evaluations per row id, for the transcript lab and the UI
  /// tests that prove a streamed delta re-renders one row.
  ///
  /// Main-actor only and not observable: reading it never re-renders anything.
  @MainActor
  public enum RenderCounter {
    public private(set) static var counts: [String: Int] = [:]

    public static func tick(_ id: String) {
      counts[id, default: 0] += 1
    }

    public static func reset() {
      counts = [:]
    }
  }
#endif
