import HermieCore
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
  /// The lines of a message's menu, as the chat stands when it is opened (not when the row was built:
  /// rows are not redrawn when the newest reply moves on). Defaults to Copy and nothing else.
  public var messageMenu: @MainActor @Sendable (_ item: TranscriptItem) -> MessageMenu
  /// A turn-starting or forking line of that menu was chosen: Regenerate, Edit and resend, Branch from
  /// here. The copies are the row's own (`copy`).
  public var chooseMessageAction: @MainActor @Sendable (_ action: MessageMenu.Action, _ item: TranscriptItem) -> Void
  /// Where the pictures of the chat's messages come from: their thumbnails, and the gallery they open.
  /// Set by the chat screen for its own session; a row outside a chat (a lab, a preview) has none and
  /// shows a picture as a chip.
  var images: MessageImageStore?
  /// Where the files the chat's bot shared come from, how its sounds and videos play, and what is up over the
  /// chat for them. Set by the chat screen for its own session; a row outside a chat has none and shows every
  /// shared file as a plain chip.
  var outbox: OutboxMedia?

  public init(
    answerApproval: @escaping @MainActor @Sendable (ApprovalItem, String) -> Void = { _, _ in },
    answerClarify: @escaping @MainActor @Sendable (ClarifyItem, [String: String]) -> Void = { _, _ in },
    openBotChat: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    retry: @escaping @MainActor @Sendable (AssistantItem) -> Void = { _ in },
    openAttachment: @escaping @MainActor @Sendable (String) -> Void = { _ in },
    copy: @escaping @MainActor @Sendable (String) -> Void = TranscriptItemActions.copyToPasteboard,
    messageMenu: @escaping @MainActor @Sendable (TranscriptItem) -> MessageMenu = {
      MessageMenu.menu(for: $0, context: .readOnly)
    },
    chooseMessageAction: @escaping @MainActor @Sendable (MessageMenu.Action, TranscriptItem) -> Void = { _, _ in }
  ) {
    self.answerApproval = answerApproval
    self.answerClarify = answerClarify
    self.openBotChat = openBotChat
    self.retry = retry
    self.openAttachment = openAttachment
    self.copy = copy
    self.messageMenu = messageMenu
    self.chooseMessageAction = chooseMessageAction
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

    /// How often each row's view appeared: a row the lazy list let go of and built again appears
    /// again, and runs its `body` again for that reason alone.
    public private(set) static var appearances: [String: Int] = [:]

    public static func appeared(_ id: String) {
      appearances[id, default: 0] += 1
    }

    public static func reset() {
      counts = [:]
      appearances = [:]
    }
  }
#endif
