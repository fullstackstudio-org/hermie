import HermieCore
import HermieGateway
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/**
 The sheet for a `confirm` at level `passkey` (plan `confirm-passkey.md`, P10 and P15).

 It is drawn by the app and never by the agent. The frame is fixed: who asks (the bot, by the name
 this app knows it under), on which gateway (its name and its address, the host the passkey is made
 for), and the two buttons, whose words are the app's. What the request says is the one thing that
 is not: the title, the summary and the detail are shown as the gateway sent them and as the
 challenge commits to them, with `Text(verbatim:)` (never Markdown, never a link), the detail in
 a monospaced block that scrolls sideways and is never wrapped or cut, so a line break and the
 spaces of a command stay where they are.

 Nothing answers by itself: for 400 ms after the sheet appears nothing can be pressed, Esc and a
 swipe do not close it while it is open (`RequestsModel.dismissSheet()` refuses), and Return is
 not Confirm. Confirm starts the ceremony (the system's passkey sheet, over this one); dismissing
 that returns here. A refused answer is a state with its reason in plain words and the same
 buttons, so the person can try again.

 The chrome and the buttons are pinned, only the request's text scrolls, so who asks and the
 buttons stay in view at any text size.
 */
struct ConfirmSheetView: View {
  let requests: RequestsModel
  let passkeys: PasskeyModel
  let confirmation: PasskeyConfirmation

  /// How long after the sheet appears its buttons stay off.
  static let tapGuard: Duration = .milliseconds(400)
  /// The most of a pinned area's text size, so the chrome and the buttons leave room for the text.
  static let pinnedTextSize: DynamicTypeSize = .xxxLarge

  @State private var armed = false
  @State private var review = ConfirmDetailReview()
  @AccessibilityFocusState private var titleFocused: Bool
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  /// The detail does not fit and has not been read to its end: Confirm stays off. With VoiceOver on
  /// the whole text, markers included, is read out as the element's label, so nothing is gated.
  private var detailUnread: Bool {
    guard let detail = confirmation.display.detail, !detail.isEmpty, !voiceOver else { return false }
    return !review.complete
  }

  var body: some View {
    VStack(spacing: 0) {
      ConfirmChrome(requests: requests, confirmation: confirmation, titleFocused: $titleFocused)
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .dynamicTypeSize(...Self.pinnedTextSize)
      Divider()
      ScrollView {
        ConfirmText(display: confirmation.display, review: $review)
          .padding(20)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      // The request's words are read sharp to the edge, never faded under the pinned chrome.
      .scrollEdgeEffectHidden(true, for: .vertical)
      Divider()
      ConfirmFooter(
        requests: requests,
        passkeys: passkeys,
        confirmation: confirmation,
        armed: armed,
        detailUnread: detailUnread,
        rpID: passkeys.configuration.rpID ?? ""
      )
      .padding(.horizontal, 20)
      .padding(.vertical, 12)
      .dynamicTypeSize(...Self.pinnedTextSize)
    }
    .background(.background)
    // Not in front: nothing of the request shows in the app switcher or on a shared screen. While
    // the system's passkey sheet is up the app is not active either, and the person needs this
    // text to decide, so the cover stays off then.
    .overlay {
      if scenePhase != .active, confirmation.phase != .signing {
        PrivacyCoverView()
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("confirm.sheet")
    .task(id: confirmation.id) {
      armed = false
      titleFocused = true
      try? await Task.sleep(for: Self.tapGuard)
      armed = !Task.isCancelled
    }
    .task(id: confirmation.expiresAt) {
      // At zero the gateway has given up: end it here too, without waiting for its message.
      let wait = confirmation.expiresAt.timeIntervalSinceNow

      if wait > 0 {
        try? await Task.sleep(for: .seconds(wait))
      }

      guard !Task.isCancelled else { return }
      await passkeys.expireIfDue(confirmation.id)
    }
  }
}

/// The constant top: the app's own words for who asks and on which gateway. VoiceOver starts here.
struct ConfirmChrome: View {
  let requests: RequestsModel
  let confirmation: PasskeyConfirmation
  var titleFocused: AccessibilityFocusState<Bool>.Binding

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label {
        Text(NativeStrings.Confirm.title(requests.botName))
          .accessibilityIdentifier("confirm.title")
      } icon: {
        Image(systemName: "lock.shield.fill")
          .foregroundStyle(.tint)
          .accessibilityHidden(true)
      }
      .font(.title2.bold())
      .lineLimit(3)
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityAddTraits(.isHeader)
      .accessibilityFocused(titleFocused)

      VStack(alignment: .leading, spacing: 2) {
        if !requests.gatewayName.isEmpty {
          Text(NativeStrings.SecureInput.gateway(requests.gatewayName))
            .font(.subheadline)
            .lineLimit(1)
            .truncationMode(.middle)
            .accessibilityIdentifier("confirm.gateway")
        }
        // The address the passkey is made for, as the app dials it: it tells two gateways apart.
        Text(verbatim: confirmation.display.host)
          .font(.subheadline.monospaced())
          .lineLimit(1)
          .truncationMode(.middle)
          .accessibilityLabel(NativeStrings.Confirm.address(confirmation.display.host))
          .accessibilityIdentifier("confirm.host")
      }
      .foregroundStyle(.secondary)
      .accessibilityElement(children: .contain)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// What the request says, exactly as the gateway sent it.
struct ConfirmText: View {
  let display: ConfirmDisplay
  @Binding var review: ConfirmDetailReview

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if !display.title.isEmpty {
        Text(verbatim: display.title)
          .font(.headline)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("confirm.requestTitle")
      }

      if !display.summary.isEmpty {
        Text(verbatim: display.summary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("confirm.summary")
      }

      if let detail = display.detail, !detail.isEmpty {
        ConfirmDetailBlock(detail: detail, review: $review)
      }
    }
  }
}

/// The detail: monospaced, every line break kept, never wrapped and never cut, with its whitespace
/// made visible (`ConfirmDetailMarkup`). It has a viewport of its own that scrolls both ways with the
/// scroll bars always showing, and says how long it is when it does not fit. Copy puts the exact
/// text on the pasteboard, not the marked one.
struct ConfirmDetailBlock: View {
  let detail: String
  @Binding var review: ConfirmDetailReview

  @ScaledMetric(relativeTo: .body) private var viewportHeight: CGFloat = 220
  @State private var copied = false
  @State private var content = CGSize.zero
  @State private var viewport = CGSize.zero

  var body: some View {
    let markup = ConfirmDetailMarkup(detail, emptyLines: NativeStrings.Confirm.emptyLines)

    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(NativeStrings.Confirm.detailLabel)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)

        Spacer()

        Button(copied ? NativeStrings.Confirm.copiedDetail : NativeStrings.Confirm.copyDetail, systemImage: copied ? "checkmark" : "doc.on.doc") {
          ConfirmDetailBoard.copy(detail)
          copied = true
        }
        .font(.caption)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .accessibilityIdentifier("confirm.detail.copy")
      }

      ScrollView([.horizontal, .vertical]) {
        Text(verbatim: markup.text)
          .font(.body.monospaced())
          .fixedSize(horizontal: true, vertical: true)
          .padding(12)
          .accessibilityIdentifier("confirm.detail")
          .onGeometryChange(for: CGSize.self, of: \.size) { size in
            content = size
            review.measure(content: size, viewport: viewport)
          }
      }
      .frame(maxHeight: viewportHeight)
      .scrollIndicators(.visible)
      .scrollIndicatorsFlash(onAppear: true)
      .background(.background.secondary, in: .rect(cornerRadius: 10))
      .clipShape(.rect(cornerRadius: 10))
      .onGeometryChange(for: CGSize.self, of: \.size) { size in
        viewport = size
        review.measure(content: content, viewport: size)
      }
      .onScrollGeometryChange(for: CGRect.self, of: \.visibleRect) { _, visible in
        review.see(visible: visible, content: content)
      }
      .accessibilityIdentifier("confirm.detailViewport")

      if review.overflows {
        Text(NativeStrings.Confirm.detailStats(lines: markup.lines, longest: markup.longestLine))
          .font(.caption)
          .accessibilityIdentifier("confirm.detail.stats")
      }
    }
  }

}

/// The pasteboard for the detail: the exact text, for this device only, gone after two minutes.
@MainActor
enum ConfirmDetailBoard {
  static func copy(_ detail: String) {
    #if os(iOS)
      UIPasteboard.general.setItems(
        [["public.utf8-plain-text": detail]],
        options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(120)])
    #elseif os(macOS)
      write(detail, to: .general)
    #endif
  }

  #if os(macOS)
    /// Put `detail`, exactly, on `board`.
    static func write(_ detail: String, to board: NSPasteboard) {
      board.clearContents()
      board.setString(detail, forType: .string)
    }
  #endif
}

/// The pinned bottom: which name the system sheet will show, the time left, the state of the
/// answer, and the buttons.
struct ConfirmFooter: View {
  let requests: RequestsModel
  let passkeys: PasskeyModel
  let confirmation: PasskeyConfirmation
  let armed: Bool
  /// The detail does not fit and has not been read to its end.
  let detailUnread: Bool
  let rpID: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if confirmation.isOpen {
        // The system sheet names the RP, the same for every gateway; this request is for the host.
        Text(NativeStrings.Confirm.passkeyNote(rp: rpID, host: confirmation.display.host))
          .font(.footnote)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("confirm.note")
        ConfirmCountdown(expiresAt: confirmation.expiresAt)
      }

      if let status = ConfirmSheetText.status(for: confirmation.phase, mayHaveArrived: confirmation.answerMayHaveArrived) {
        // A line of its own per state: a state that follows another within a frame (a fast link
        // answers at once) is a new view, so what it starts (the announcement) always runs. A task
        // or an `onChange` watching the phase from inside the sheet missed such a state.
        ConfirmStatusLine(status: status, announced: confirmation.phase != .signing)
          .id(status.text)
      }

      if detailUnread, confirmation.phase.isActionable {
        Label(NativeStrings.Confirm.scrollToConfirm, systemImage: "arrow.down.right")
          .font(.footnote)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("confirm.scrollHint")
      }

      ConfirmActions(
        requests: requests, passkeys: passkeys, confirmation: confirmation, armed: armed, detailUnread: detailUnread)

      if ConfirmSheetText.closesByItself(confirmation.phase) {
        ConfirmLinger(requests: requests, confirmationID: confirmation.id)
      }
    }
  }
}

/// The time left, once a second; it reads from the moment the gateway gives up.
struct ConfirmCountdown: View {
  let expiresAt: Date

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let left = max(0, Int(expiresAt.timeIntervalSince(context.date).rounded(.up)))

      Label(NativeStrings.SecureInput.expiresIn(RequestCountdownView.clock(left)), systemImage: "timer")
        .font(.caption.monospacedDigit())
        .foregroundStyle(left <= 10 ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
        .accessibilityIdentifier("confirm.countdown")
    }
  }
}

/// One line about where the answer stands.
struct ConfirmStatusLine: View {
  let status: ConfirmSheetText.Status
  /// Say it aloud when it appears (the system's own sheet speaks for the signing state).
  var announced = false

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      if status.busy {
        ProgressView()
          .controlSize(.small)
      } else {
        Image(systemName: status.symbol)
          .foregroundStyle(symbolStyle)
          .accessibilityHidden(true)
      }

      Text(status.text)
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("confirm.status")
    .task {
      if announced {
        AccessibilityNotification.Announcement(status.text).post()
      }
    }
  }

  /// The label colour: the tints (green, orange, red) miss the contrast audit on a plain
  /// background, and the symbol's shape says what the sentence says.
  private var symbolStyle: AnyShapeStyle {
    AnyShapeStyle(Color.primary)
  }
}

/// Puts the sheet away a moment after the answer is in or the person said no, so the outcome can
/// be read (and heard). It is in the sheet only in those two states, so it starts when they begin.
struct ConfirmLinger: View {
  let requests: RequestsModel
  let confirmationID: String

  var body: some View {
    Color.clear
      .frame(height: 0)
      .accessibilityHidden(true)
      .task {
        try? await Task.sleep(for: .seconds(ConfirmSheetText.lingerSeconds))

        guard !Task.isCancelled, requests.presentedConfirmation?.id == confirmationID else { return }
        requests.dismissSheet()
      }
  }
}

/// Confirm and Decline while the confirmation is open, Close once it is over.
struct ConfirmActions: View {
  let requests: RequestsModel
  let passkeys: PasskeyModel
  let confirmation: PasskeyConfirmation
  let armed: Bool
  let detailUnread: Bool

  var body: some View {
    if confirmation.isOpen {
      // Re-read every second: the buttons go off the moment the time is up.
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let enabled = armed && confirmation.isActionable(at: context.date)

        ViewThatFits(in: .horizontal) {
          HStack(spacing: 10) {
            declineButton(enabled: enabled)
            confirmButton(enabled: enabled && !detailUnread)
          }
          VStack(spacing: 10) {
            confirmButton(enabled: enabled && !detailUnread)
            declineButton(enabled: enabled)
          }
        }
      }
    } else {
      Button {
        requests.dismissSheet()
      } label: {
        Text(NativeStrings.SecureInput.close)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .accessibilityIdentifier("confirm.close")
    }
  }

  private func confirmButton(enabled: Bool) -> some View {
    Button {
      Task { await passkeys.confirm(confirmation.id) }
    } label: {
      Text(NativeStrings.Confirm.confirm)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(!enabled)
    .accessibilityHint(NativeStrings.Confirm.confirmHint)
    .accessibilityIdentifier("confirm.confirm")
  }

  private func declineButton(enabled: Bool) -> some View {
    Button {
      Task { await passkeys.decline(confirmation.id) }
    } label: {
      Text(NativeStrings.Confirm.decline)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .tint(.primary)
    .controlSize(.large)
    .disabled(!enabled)
    .accessibilityIdentifier("confirm.decline")
  }
}

extension NativeStrings {
  enum Confirm {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// {bot} asks you to confirm
    static func title(_ bot: String) -> String {
      String(localized: "native.confirm.title", defaultValue: "\(bot) asks you to confirm", table: "Native", bundle: .module)
    }
    /// Address {host}
    static func address(_ host: String) -> String {
      String(localized: "native.confirm.address", defaultValue: "Address \(host)", table: "Native", bundle: .module)
    }
    /// The answer may have reached the gateway. You can try again, or check whether the action ran.
    static var notSentMaybeArrived: String { string("native.confirm.notSentMaybeArrived") }
    /// The answer may have reached the gateway. Check whether the action ran.
    static var outcomeUnknown: String { string("native.confirm.outcomeUnknown") }
    /// ⋯ {count} empty lines ⋯
    static func emptyLines(_ count: Int) -> String {
      String(
        localized: "native.confirm.detail.emptyLines", defaultValue: "\u{22EF} \(count) empty lines \u{22EF}", table: "Native",
        bundle: .module)
    }
    /// Copy details
    static var copyDetail: String { string("native.confirm.copyDetail") }
    /// Copied
    static var copiedDetail: String { string("native.confirm.copiedDetail") }
    /// Scroll to the end of the details to confirm.
    static var scrollToConfirm: String { string("native.confirm.scrollToConfirm") }
    /// {lines} lines · longest line {longest} characters
    static func detailStats(lines: Int, longest: Int) -> String {
      if lines == 1 {
        return String(
          localized: "native.confirm.detailStats.one", defaultValue: "1 line · longest line \(longest) characters",
          table: "Native", bundle: .module)
      }

      return String(
        localized: "native.confirm.detailStats.other",
        defaultValue: "\(lines) lines · longest line \(longest) characters", table: "Native", bundle: .module)
    }
    /// Details
    static var detailLabel: String { string("native.confirm.detailLabel") }
    /// Your device will ask for your passkey for {rp}…
    static func passkeyNote(rp: String, host: String) -> String {
      String(
        localized: "native.confirm.passkeyNote",
        defaultValue:
          "Your device will ask for your passkey for \(rp). That name is the same for every gateway; this request is for \(host).",
        table: "Native",
        bundle: .module
      )
    }
    /// Confirm with passkey
    static var confirm: String { string("native.confirm.confirm") }
    /// Asks your device for your passkey.
    static var confirmHint: String { string("native.confirm.confirmHint") }
    /// Decline
    static var decline: String { string("native.confirm.decline") }
    /// Waiting for your passkey…
    static var signing: String { string("native.confirm.signing") }
    /// Answer received. The gateway is verifying it.
    static var received: String { string("native.confirm.received") }
    /// You declined this request.
    static var declined: String { string("native.confirm.declined") }
    /// The gateway does not know this passkey…
    static var refusedUnknownCredential: String { string("native.confirm.refused.unknownCredential") }
    /// Your device did not confirm that it is you…
    static var refusedUserVerification: String { string("native.confirm.refused.userVerification") }
    /// The gateway did not accept the passkey answer…
    static var refusedOther: String { string("native.confirm.refused.other") }
    /// The answer did not reach the gateway…
    static var notSent: String { string("native.confirm.notSent") }
    /// This request timed out. Nothing was confirmed.
    static var timedOut: String { string("native.confirm.timedOut") }
    /// Another device answered this request.
    static var answeredElsewhere: String { string("native.confirm.answeredElsewhere") }
    /// Too many answers were refused…
    static var tooManyAttempts: String { string("native.confirm.tooManyAttempts") }
    /// The gateway could not verify your answer. Nothing was confirmed.
    static var verificationFailed: String { string("native.confirm.verificationFailed") }
    /// This device may not answer this request.
    static var notAllowed: String { string("native.confirm.notAllowed") }
    /// No passkey for this gateway is available on this device…
    static var noCredential: String { string("native.confirm.noCredential") }
    /// This device cannot confirm with a passkey right now…
    static var cannotConfirm: String { string("native.confirm.cannotConfirm") }
    /// The request was withdrawn. Nothing was confirmed.
    static var withdrawn: String { string("native.confirm.withdrawn") }
  }
}

