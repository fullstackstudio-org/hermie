import HermieCore
import HermieProtocol
import HermieTranscript
import SwiftUI

/// A form, a file request, a draft review or a diff review the bot asked for: a compact card with what it is, what
/// the agent called it, and how it stands. Open, it says it waits for an answer and opens the sheet
/// again (after Later); closed, it says how it ended. Never a value: the transcript's `RequestItem`
/// has nothing that could hold one, only the status, how many files and whether a draft was edited.
///
/// The agent's title is shown as plain text, cleaned and bounded, never as Markdown.
struct InteractiveRequestCardView: View {
  let item: RequestItem
  let presentation: Presentation

  @Environment(\.transcriptInteractive) private var interactive

  /// The sheet can be raised for this request: the chat holds it as open.
  private var canOpen: Bool {
    item.state == .open && interactive?.openPrompts.contains { $0.id == item.requestID } == true
  }

  var body: some View {
    let kind = Self.kind(of: item)
    let state = Self.state(of: item)
    let title = InteractivePrompt.line(item.title, limit: InteractivePrompt.titleLimit)

    HStack(alignment: .top, spacing: 10) {
      Image(systemName: Self.icon(of: item))
        .foregroundStyle(item.state == .open ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
        .frame(width: 22)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        if let kind {
          Text(kind)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        }
        Text(verbatim: title)
          .font(.callout.weight(.semibold))
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
        Text(state)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
      if canOpen, let interactive {
        Button(NativeStrings.Interactive.Card.openAction) {
          interactive.present(item.requestID)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.small)
        .accessibilityIdentifier("request.card.open")
      }
    }
    .cardSurface(tint: item.state == .open ? .orange : nil)
    .accessibilityElement(children: .contain)
    .accessibilityLabel([kind, title, state].compactMap(\.self).joined(separator: ". "))
    .accessibilityIdentifier("request.card")
  }

  // MARK: Words

  /// What kind of request it is, in the app's words; nil for a method this build does not know.
  static func kind(of item: RequestItem) -> String? {
    switch item.method {
    case "input.form": NativeStrings.Interactive.Card.form
    case "input.file": NativeStrings.Interactive.Card.file
    case "review.draft": NativeStrings.Interactive.Card.draft
    case "review.diff": NativeStrings.Interactive.Card.diff
    case "device.location": NativeStrings.Interactive.Card.location
    case "device.contact": NativeStrings.Interactive.Card.contact
    case "device.calendar": NativeStrings.Interactive.Card.calendar
    default: nil
    }
  }

  static func icon(of item: RequestItem) -> String {
    if item.state == .cancelled {
      return "xmark.circle"
    }

    switch item.method {
    case "input.file": return "paperclip"
    case "review.draft": return "text.badge.checkmark"
    case "review.diff": return "plusminus.circle"
    case "device.location": return "location"
    case "device.contact": return "person.crop.circle"
    case "device.calendar": return "calendar"
    default: return "list.bullet.rectangle"
    }
  }

  /// How a device request was answered, by the summary's keys alone (a precision, the names of the
  /// fields shared); nil for a request that is not one, or one that was skipped.
  static func deviceAnswer(of item: RequestItem) -> String? {
    typealias Words = NativeStrings.Interactive.Card

    guard item.answerSummary?.status == "answered" else {
      return nil
    }

    switch item.method {
    case "device.location":
      return item.answerSummary?.precision == "precise" ? Words.sharedPrecise : Words.sharedApproximate
    case "device.contact":
      let names = (item.answerSummary?.fields ?? []).map { NativeStrings.Interactive.Contact.field(ContactField.named($0)) }
      return names.isEmpty ? Words.sharedContactBare : Words.sharedContact(names.formatted(.list(type: .and, width: .narrow)))
    case "device.calendar":
      return Words.addedToCalendar
    default:
      return nil
    }
  }

  /// How it stands: waiting, how it was answered (by the summary's keys alone), or how it ended.
  static func state(of item: RequestItem) -> String {
    typealias Words = NativeStrings.Interactive.Card

    switch item.state {
    case .open:
      return Words.open
    case .answered:
      let summary = item.answerSummary

      if let words = deviceAnswer(of: item) {
        return words
      }

      if summary?.decision == "approved" {
        // A diff review: how many of its hunks were approved.
        if let approved = summary?.approvedHunks, let rejected = summary?.rejectedHunks {
          return Words.diffApproved(approved, of: approved + rejected)
        }

        return summary?.edited == true ? Words.approvedEdited : Words.approved
      }

      if summary?.decision == "rejected" {
        return Words.rejected
      }

      if summary?.status == "skipped" {
        return Words.skipped
      }

      if let count = summary?.count {
        return Words.files(count)
      }

      return Words.answered
    default:
      switch item.cancelReason {
      case "timeout": return Words.timedOut
      case "resolved": return Words.answeredElsewhere
      default: return Words.ended
      }
    }
  }
}
