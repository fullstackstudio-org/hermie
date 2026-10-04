import HermieCore
import SwiftUI

/// Over the chat: why a row's action did nothing, so a tap is never silent. An attachment only on
/// the gateway's disk (or one the gateway would not hand over), and a Retry that sent nothing.
struct ChatActionNotices: View {
  let feed: ChatFeed

  var body: some View {
    if let text = Self.text(attachment: feed.attachmentNotice, retry: feed.lastRetry) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(text, systemImage: "info.circle")
          .font(.footnote)
          .frame(maxWidth: .infinity, alignment: .leading)
          .fixedSize(horizontal: false, vertical: true)
        Button {
          feed.dismissActionNotices()
        } label: {
          Image(systemName: "xmark")
            .accessibilityLabel(Strings.Chat.Sheet.close)
        }
        .buttonStyle(.borderless)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(.regularMaterial, in: .rect(cornerRadius: 12))
      .padding(.horizontal, ChatSpacing.edgeMargin)
      .padding(.vertical, 4)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("chat.actionNotice")
    }
  }

  static func text(attachment: AttachmentOpenResult?, retry: RetryOutcome?) -> String? {
    switch attachment {
    case .unavailable(let name)?:
      return NativeStrings.ChatActions.attachmentUnavailable(SecurePrompt.displayText(name, limit: SecurePrompt.nameLimit))
    case .failed(let name)?:
      return NativeStrings.ChatActions.attachmentFailed(SecurePrompt.displayText(name, limit: SecurePrompt.nameLimit))
    case .preview?, nil:
      break
    }

    switch retry {
    case .busy?: return Strings.Chat.Menu.turnRunning
    case .nothing?: return Strings.Chat.Menu.nothingToRegenerate
    case .resent?, nil: return nil
    }
  }
}

extension NativeStrings {
  enum ChatActions {
    /// “{name}” is on the gateway's disk and cannot be opened on this device.
    static func attachmentUnavailable(_ name: String) -> String {
      String(
        localized: "native.chat.attachment.unavailable",
        defaultValue: "“\(name)” is on the gateway's disk and cannot be opened on this device.",
        table: "Native", bundle: .module)
    }

    /// “{name}” could not be fetched from the gateway.
    static func attachmentFailed(_ name: String) -> String {
      String(
        localized: "native.chat.attachment.failed", defaultValue: "“\(name)” could not be fetched from the gateway.",
        table: "Native", bundle: .module)
    }
  }
}
