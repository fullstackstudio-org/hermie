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
 swipe are Later (the sheet goes, nothing is answered, the gateway keeps waiting; refused while an
 answer is on its way), and Return is not Confirm. Confirm starts the ceremony (the system's passkey sheet, over this one); dismissing
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
  @State private var fieldsReview = ConfirmFieldsReview()
  @AccessibilityFocusState private var titleFocused: Bool
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  /// The detail has not been wholly in view and read to its end: Confirm stays off. With VoiceOver on
  /// the whole text, markers included, is read out as the element's label, so nothing is gated.
  private var detailUnread: Bool {
    guard !voiceOver else { return false }
    let detailPending = confirmation.display.detail.map { !$0.isEmpty && !review.complete } ?? false
    // The structured fields are what is being confirmed: they have to have been in view too.
    let fieldsPending = !confirmation.display.fields.isEmpty && !fieldsReview.complete
    return detailPending || fieldsPending
  }

  var body: some View {
    VStack(spacing: 0) {
      ConfirmChrome(requests: requests, confirmation: confirmation, titleFocused: $titleFocused)
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .dynamicTypeSize(...Self.pinnedTextSize)
      Divider()
      ConfirmTextArea(display: confirmation.display, review: $review, fieldsReview: $fieldsReview)
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

/**
 Where the detail's frame sits in the scrolling text, and which part of that text is in view. Held
 outside the view state, because the window moves with every tick of the scroll: only when the frame
 goes wholly in view or out of it does the review change.
 */
@MainActor
final class ConfirmFrameTracker {
  /// The scrolling text's coordinate space: its content's, which does not move as it scrolls.
  nonisolated static let space = "confirm.text"

  /// The detail's frame, and the part of the text in view, both in that space.
  var frame = CGRect.zero
  var window = CGRect.zero
  /// The structured fields' frame, in the same space.
  var fieldsFrame = CGRect.zero

  /// Tell the review whether the fields have been in view, if that has changed.
  func syncFields(_ review: Binding<ConfirmFieldsReview>) {
    var next = review.wrappedValue
    next.see(frame: fieldsFrame, window: window)

    if next != review.wrappedValue {
      review.wrappedValue = next
    }
  }

  /// Tell the review whether the frame is wholly in view, if that has changed.
  func sync(_ review: Binding<ConfirmDetailReview>) {
    let wholly = ConfirmDetailReview.isWhollyIn(frame: frame, window: window)

    if review.wrappedValue.inView != wholly {
      review.wrappedValue.place(inView: wholly)
    }
  }
}

/// The request's own words, the only part of the sheet that scrolls.
struct ConfirmTextArea: View {
  let display: ConfirmDisplay
  @Binding var review: ConfirmDetailReview
  @Binding var fieldsReview: ConfirmFieldsReview

  @State private var tracker = ConfirmFrameTracker()
  /// The height of the scrolling text's window: the detail's box is held to it.
  @State private var window: CGFloat = 0

  var body: some View {
    ScrollView {
      ConfirmText(display: display, review: $review, tracker: tracker, window: window, fieldsReview: $fieldsReview)
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .coordinateSpace(.named(ConfirmFrameTracker.space))
    }
    // The request's words are read sharp to the edge, never faded under the pinned chrome.
    .scrollEdgeEffectHidden(true, for: .vertical)
    .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { window = $0 }
    .onScrollGeometryChange(for: CGRect.self, of: \.visibleRect) { _, visible in
      tracker.window = visible
      tracker.sync($review)
      tracker.syncFields($fieldsReview)
    }
  }
}

/// What the request says, exactly as the gateway sent it.
struct ConfirmText: View {
  let display: ConfirmDisplay
  @Binding var review: ConfirmDetailReview
  let tracker: ConfirmFrameTracker
  let window: CGFloat
  @Binding var fieldsReview: ConfirmFieldsReview

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

      // The key facts, apart from the summary and the detail, in the frame's order (the challenge
      // commits to them in that order): the ones the person is really confirming.
      if !display.fields.isEmpty {
        ConfirmFieldsView(fields: display.fields)
          .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(ConfirmFrameTracker.space)) }) { frame in
            tracker.fieldsFrame = frame
            tracker.syncFields($fieldsReview)
          }
      }

      if let detail = display.detail, !detail.isEmpty {
        ConfirmDetailBlock(detail: detail, review: $review, tracker: tracker, window: window)
      }
    }
  }
}

/// The structured fields of a confirmation (contract/confirm-passkey §4.1): every one, in order, as its
/// label and its value, plain text. A value is never parsed, converted, rounded, localised or linked,
/// and never truncated or ellipsized: one that does not fit wraps onto more lines. What the kind
/// changes is only how it is drawn: an amount large and bold with its currency beside it, a recipient
/// and a domain monospaced, the other kinds plain.
struct ConfirmFieldsView: View {
  let fields: [ConfirmField]

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(fields) { field in
        ConfirmFieldRow(field: field)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.background.secondary, in: .rect(cornerRadius: 12))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("confirm.fields")
  }
}

/// One field: its label, small, and its value under it.
struct ConfirmFieldRow: View {
  let field: ConfirmField

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: field.label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)

      value
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    // One element: the label, then the value (and the currency of an amount).
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(field.label)
    .accessibilityValue(Self.spoken(field))
    .accessibilityIdentifier("confirm.field.\(field.id)")
  }

  /// How a kind is drawn: an amount large and bold with its currency, a recipient and a domain
  /// monospaced (and never a link), every other kind plain.
  enum Style: Equatable {
    case amount, monospaced, plain

    static func of(_ kind: ConfirmFieldKind) -> Style {
      switch kind {
      case .amount: .amount
      case .recipient, .domain: .monospaced
      case .text, .model, .count, .date: .plain
      }
    }
  }

  @ViewBuilder private var value: some View {
    switch Style.of(field.kind) {
    case .amount:
      amountView()
    case .monospaced:
      Text(verbatim: field.value)
        .font(.body.monospaced())
    case .plain:
      Text(verbatim: field.value)
        .font(.body)
    }
  }

  /// An amount: the value large and bold, its currency beside it, each its own text view (its own
  /// paragraph for the bidirectional algorithm: a right-to-left currency can never reorder the sign or
  /// the digits of the value). Plain text: no markdown is read and nothing in it is a link.
  static func amountParts(_ field: ConfirmField) -> (value: String, currency: String?) {
    (field.value, field.currency)
  }

  private func amountView() -> some View {
    let parts = Self.amountParts(field)

    return HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(verbatim: parts.value)
        .font(.title.bold())
        .fixedSize(horizontal: false, vertical: true)

      if let currency = parts.currency {
        Text(verbatim: currency)
          .font(.title3.bold())
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  /// What VoiceOver reads as the value: the value, and an amount's currency after it.
  static func spoken(_ field: ConfirmField) -> String {
    guard field.kind == .amount, let currency = field.currency else {
      return field.value
    }

    return "\(field.value) \(currency)"
  }
}

/// The detail: monospaced, every line break kept, never wrapped and never cut, with its whitespace
/// made visible (`ConfirmDetailMarkup`). It has a viewport of its own that scrolls both ways with the
/// scroll bars always showing, and says how long it is when it does not fit. The viewport is never
/// taller than the sheet's scrolling text (`ConfirmDetailLayout`), so it can be wholly in view, which
/// Confirm waits for (`ConfirmDetailReview`). Copy puts the exact text on the pasteboard, not the
/// marked one.
struct ConfirmDetailBlock: View {
  let detail: String
  @Binding var review: ConfirmDetailReview
  let tracker: ConfirmFrameTracker
  /// The height of the sheet's scrolling text: the viewport is never taller, so it can be wholly in view.
  let window: CGFloat

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
      .frame(maxHeight: ConfirmDetailLayout.viewportHeight(preferred: viewportHeight, window: window))
      .scrollIndicators(.visible)
      .scrollIndicatorsFlash(onAppear: true)
      .background(.background.secondary, in: .rect(cornerRadius: 10))
      .clipShape(.rect(cornerRadius: 10))
      .onGeometryChange(for: CGRect.self, of: { $0.frame(in: .named(ConfirmFrameTracker.space)) }) { frame in
        viewport = frame.size
        review.measure(content: content, viewport: frame.size)
        tracker.frame = frame
        tracker.sync($review)
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
  /// The detail has not been wholly in view and read to its end.
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

      // The system's sheet was dismissed on a device that holds none of these passkeys: most likely it
      // said there is none here. Explained, with the way to add one; a plain dismissal says nothing.
      if confirmation.isOpen, confirmation.passkeyMissingHere {
        ConfirmNoPasskeyNote(requests: requests)
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

/**
 What the sheet says when the system's passkey sheet was dismissed on a device that holds no passkey
 for this gateway (`PasskeyConfirmation.passkeyMissingHere`): the sentence, and "Add a passkey here",
 which puts this sheet away (Later: the request stays open and waits) and opens Settings → Passkeys
 at adding one. Confirm stays on, so trying again, once a synced passkey has arrived, needs no detour.
 */
struct ConfirmNoPasskeyNote: View {
  let requests: RequestsModel

  @Environment(AppRouter.self) private var router: AppRouter?
  #if os(macOS)
    @Environment(\.openSettings) private var openSettings
  #endif

  /// How long this sheet is given to go before Settings comes up over the chat, where a sheet cannot
  /// be presented while another is leaving.
  static let handover: Duration = .milliseconds(450)

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label {
        Text(NativeStrings.Confirm.passkeyNotHere)
          .font(.callout)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: "key")
          .foregroundStyle(Color.primary)
          .accessibilityHidden(true)
      }
      .accessibilityIdentifier("confirm.noPasskey.text")

      Button(NativeStrings.Confirm.addPasskeyHere) {
        addPasskeyHere()
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .accessibilityHint(NativeStrings.Confirm.addPasskeyHereHint)
      .accessibilityIdentifier("confirm.noPasskey.add")
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("confirm.noPasskey")
    .task {
      AccessibilityNotification.Announcement(NativeStrings.Confirm.passkeyNotHere).post()
    }
  }

  private func addPasskeyHere() {
    ShellRequests.shared.settingsCategory = .passkeys
    ShellRequests.shared.passkeysAddFlow = true
    requests.dismissSheet()

    #if os(macOS)
      openSettings()
    #else
      guard let router else { return }

      Task { @MainActor in
        try? await Task.sleep(for: Self.handover)
        router.present(.settings)
      }
    #endif
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
            laterButton
            declineButton(enabled: enabled)
            confirmButton(enabled: enabled && !detailUnread)
          }
          VStack(spacing: 10) {
            confirmButton(enabled: enabled && !detailUnread)
            declineButton(enabled: enabled)
            laterButton
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

  /// Later (Esc): the sheet goes and nothing is answered; the gateway keeps waiting until Confirm,
  /// Decline or its deadline, and the chat says it is waiting. Off while an answer is on its way.
  private var laterButton: some View {
    Button {
      requests.dismissSheet()
    } label: {
      Text(Strings.Chat.Clarify.later)
        .font(.title3.weight(.semibold))
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.bordered)
    .tint(.primary)
    .controlSize(.large)
    .keyboardShortcut(.cancelAction)
    .disabled(RequestsModel.inFlight(confirmation))
    .accessibilityIdentifier("confirm.later")
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
    /// Your passkey for this gateway isn't on this device yet…
    static var passkeyNotHere: String { string("native.confirm.passkeyNotHere") }
    /// Add a passkey here
    static var addPasskeyHere: String { string("native.confirm.addPasskeyHere") }
    /// Opens Settings. The request stays open and waits.
    static var addPasskeyHereHint: String { string("native.confirm.addPasskeyHereHint") }
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

