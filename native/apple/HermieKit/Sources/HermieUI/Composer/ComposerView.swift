import HermieCore
import SwiftUI

/// The composer of one chat, for the chat screen's `composer` slot (placed
/// with `safeAreaInset(edge: .bottom)`): the queued strip, a line about why
/// nothing can be sent when that is so, the last notice, and the field with
/// one button that sends, or stops while the bot is at work and the field is
/// empty.
///
/// Keys, as the Expo app has them:
/// - a hardware keyboard (Mac, iPad, any keyboard on an iPhone): Return sends,
///   Shift-Return starts a new line, Command-Return sends too;
/// - the iPhone's on-screen keyboard: Return starts a new line, the button sends;
/// - Esc stops the bot while it is at work (a sheet that is up takes Esc first);
///   it never clears the field.
///
/// The field keeps its focus after a send. It takes plain text only:
/// attachments are a later task, which fills `ComposerModel.attachments`.
public struct ComposerView: View {
  @Bindable var model: ComposerModel

  /// Whether the caret is in the field (reported by the text view).
  @State private var focused = false
  /// Moved to put the caret back in the field.
  @State private var focusRequest = 0

  public init(model: ComposerModel) {
    self.model = model
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !model.queue.isEmpty {
        QueuedStrip(model: model)
      }

      if let explanation {
        Label(explanation, systemImage: availabilityIcon)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("composer.unavailable")
      }

      if let notice = model.notice {
        noticeRow(notice)
      }

      GlassEffectContainer(spacing: 8) {
        HStack(alignment: .bottom, spacing: 8) {
          field
          actionButton
        }
      }
    }
    // Floating glass over the transcript, as Messages' field: no bar behind it. The transcript
    // scrolls under it and stops above it (the slot is a safe-area inset of the list).
    .padding(.horizontal, 12)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .background(escapeShortcut)
    .task { await model.loadDraft() }
    .onDisappear {
      let model = self.model
      Task { await model.flushDraft() }
    }
    .onChange(of: model.lastEvent) { _, entry in
      if let entry {
        AccessibilityNotification.Announcement(Self.announcement(entry.event)).post()
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer")
  }

  // MARK: The field

  private var field: some View {
    ComposerTextField(
      text: $model.draft,
      placeholder: Strings.Chat.Composer.placeholder,
      accessibilityLabel: Strings.Chat.Composer.messageTo(bot: model.bot),
      accessibilityHint: Self.keyHint,
      maxLines: Self.maxLines,
      focusRequest: focusRequest,
      onFocusChange: { focused = $0 },
      onSend: { send() },
      onEscape: {
        guard model.running else {
          return false
        }

        stop()
        return true
      }
    )
    .overlay(alignment: .topLeading) {
      if model.draft.isEmpty {
        Text(Strings.Chat.Composer.placeholder)
          // A plain colour, not the hierarchical `.secondary`: inside glass that one turns
          // vibrant and blends with what is behind the field, below the audit's contrast.
          .foregroundStyle(Self.placeholderColor)
          .lineLimit(1)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, Self.placeholderInset.width)
          .padding(.vertical, Self.placeholderInset.height)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 2)
    // Tinted with the page's background, so the words in the field keep their contrast over a
    // busy transcript as over an empty one.
    .glassEffect(.regular.tint(Self.fieldTint), in: .rect(cornerRadius: 20))
  }

  #if os(macOS)
    private static let placeholderColor = Color(nsColor: .secondaryLabelColor)
    private static let fieldTint = Color(nsColor: .textBackgroundColor).opacity(0.6)
  #else
    private static let placeholderColor = Color(uiColor: .secondaryLabel)
    private static let fieldTint = Color(uiColor: .systemBackground).opacity(0.6)
  #endif

  /// Where the text view's first character sits, for the placeholder.
  #if os(macOS)
    private static let placeholderInset = CGSize(width: 13, height: 8)
  #else
    private static let placeholderInset = CGSize(width: 17, height: 10)
  #endif

  /// Six lines, then the field scrolls.
  static let maxLines = 6

  private static var keyHint: String {
    #if os(macOS)
      Strings.Chat.Composer.keyHint
    #else
      ""
    #endif
  }

  // MARK: The button

  /// Stop while the bot is at work and there is nothing to send; send otherwise.
  private var stopping: Bool { model.running && !hasText }

  private var hasText: Bool {
    !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.attachments.isEmpty
  }

  @ScaledMetric(relativeTo: .body) private var buttonSize: CGFloat = 32

  private var actionButton: some View {
    Button {
      if stopping {
        stop()
      } else {
        send()
      }
    } label: {
      Image(systemName: stopping ? "stop.fill" : "arrow.up")
        .font(.body.weight(.bold))
        .frame(width: buttonSize, height: buttonSize)
    }
    .buttonStyle(SendButtonStyle(role: stopping ? .stop : .send))
    .disabled(stopping ? model.isStopping : !model.canSubmit)
    .accessibilityLabel(stopping ? Strings.Chat.Composer.stop : Strings.Chat.Composer.send)
    .accessibilityHint(model.turnActive && !stopping ? NativeStrings.Composer.queueHint : "")
    .accessibilityIdentifier(stopping ? "composer.stop" : "composer.send")
  }

  /// Esc stops the bot while focus is somewhere else on the screen (a card's
  /// button, the list). The field handles its own Esc.
  private var escapeShortcut: some View {
    Button(NativeStrings.Composer.stopShortcut) { stop() }
      .keyboardShortcut(.cancelAction)
      .disabled(!model.running || focused)
      .opacity(0)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }

  private func send() {
    guard model.canSubmit else {
      return
    }

    let model = self.model
    Task { await model.submit() }
    // The field keeps its focus after a send, so the next message can follow.
    if focused {
      focusRequest += 1
    }
  }

  private func stop() {
    let model = self.model
    Task { await model.stop() }
  }

  // MARK: What the composer says

  private var explanation: String? {
    switch model.availability {
    case .ready: nil
    case .opening: NativeStrings.Composer.opening
    case .connecting: Strings.App.Chat.Connection.connecting
    case .signedOut: Strings.App.Connection.Reauth.message
    case .incompatible: Strings.App.Errors.incompatible
    }
  }

  private var availabilityIcon: String {
    switch model.availability {
    case .signedOut: "person.crop.circle.badge.exclamationmark"
    case .incompatible: "exclamationmark.triangle"
    default: "antenna.radiowaves.left.and.right"
    }
  }

  private func noticeRow(_ notice: ComposerNotice) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Label(Self.text(notice), systemImage: "exclamationmark.circle")
        .font(.footnote)
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button {
        model.dismissNotice()
      } label: {
        Image(systemName: "xmark")
          .accessibilityLabel(Strings.Chat.Sheet.close)
      }
      .buttonStyle(.borderless)
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer.notice")
  }

  static func text(_ notice: ComposerNotice) -> String {
    switch notice {
    case .notSent: Strings.Chat.Composer.notSentYet
    case .failed(let reason): NativeStrings.Composer.failed(reason)
    case .busy: Strings.Chat.Sessions.busy
    case .steerRejected: Strings.Chat.Queue.steerRejected
    case .stopFailed(let reason): NativeStrings.Composer.stopFailed(reason)
    case .other(let reason): reason
    }
  }

  static func announcement(_ event: ComposerEvent) -> String {
    switch event {
    case .sent: NativeStrings.Composer.sent
    case .queued: NativeStrings.Composer.queued
    case .stopped: NativeStrings.Composer.stopped
    }
  }
}

/// The composer's round button: the accent blue with a white arrow when there
/// is something to send, red to stop, and when there is nothing to send a
/// quiet grey disc whose arrow is still plainly there (a disabled prominent
/// button drew dark on the dark bar and all but vanished).
struct SendButtonStyle: ButtonStyle {
  enum Role {
    case send, stop
  }

  let role: Role

  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(isEnabled ? AnyShapeStyle(Color.white) : AnyShapeStyle(.secondary))
      .background(fill, in: .circle)
      // Glass only on the grey disc: glass over the solid blue or red lightened it under the
      // white glyph until the accessibility audit failed its contrast (as Messages' own solid
      // send disc, the coloured button is plain).
      .glassEffect(isEnabled ? .identity : .regular, in: .circle)
      .opacity(configuration.isPressed ? 0.75 : 1)
      .contentShape(.circle)
  }

  private var fill: AnyShapeStyle {
    guard isEnabled else { return AnyShapeStyle(.fill.secondary) }
    switch role {
    case .send: return AnyShapeStyle(BubblePalette.outgoing)
    case .stop: return AnyShapeStyle(Self.stopRed)
    }
  }

  /// A deeper red than the system's: white on it is 5.4:1 (on the system red, 3.6:1).
  static let stopRed = Color(red: 0xD7 / 255, green: 0x00 / 255, blue: 0x15 / 255)
}

/// The messages parked behind the running turn: up to three, then a count.
/// Each can be handed to the turn now (Steer), taken back into the field
/// (Edit) or dropped (Delete).
struct QueuedStrip: View {
  let model: ComposerModel

  static let limit = 3

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(model.queue.prefix(Self.limit).enumerated()), id: \.element.id) { index, entry in
        row(entry, index: index)
      }
      if model.queue.count > Self.limit {
        Text(Strings.Chat.Queue.more(count: model.queue.count - Self.limit))
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer.queue")
  }

  private func row(_ entry: QueuedMessage, index: Int) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "clock.arrow.circlepath")
        .foregroundStyle(.secondary)
        .accessibilityHidden(true)
      Text(Strings.Chat.Queue.label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
      Text(entry.text)
        .font(.callout)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
      Button {
        Task { await model.steerQueued(entry.id) }
      } label: {
        Image(systemName: "arrow.turn.down.right")
          .accessibilityLabel(Strings.Chat.Queue.steer)
      }
      .accessibilityIdentifier("composer.queue.steer.\(index)")
      if entry.attachments?.isEmpty ?? true {
        Button {
          Task { await model.editQueued(entry.id) }
        } label: {
          Image(systemName: "pencil")
            .accessibilityLabel(Strings.Chat.Queue.edit)
        }
        .accessibilityIdentifier("composer.queue.edit.\(index)")
      }
      Button(role: .destructive) {
        Task { await model.removeQueued(entry.id) }
      } label: {
        Image(systemName: "trash")
          .accessibilityLabel(Strings.Chat.Queue.delete)
      }
      .accessibilityIdentifier("composer.queue.delete.\(index)")
    }
    .buttonStyle(.borderless)
    .padding(.horizontal, 10)
    .padding(.vertical, 6)
    .background(.fill.tertiary, in: .rect(cornerRadius: 10))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("\(Strings.Chat.Queue.label): \(entry.text)")
    .accessibilityIdentifier("composer.queue.row.\(index)")
  }
}

extension NativeStrings {
  enum Composer {
    /// The message did not go out: {reason}
    static func failed(_ reason: String) -> String {
      String(
        localized: "native.composer.failed",
        defaultValue: "The message did not go out: \(reason)",
        table: "Native",
        bundle: .module
      )
    }
    /// Opening the chat…
    static var opening: String {
      String(localized: "native.composer.opening", table: "Native", bundle: .module)
    }
    /// Message queued
    static var queued: String {
      String(localized: "native.composer.queued", table: "Native", bundle: .module)
    }
    /// Sends it when the current reply is finished.
    static var queueHint: String {
      String(localized: "native.composer.queueHint", table: "Native", bundle: .module)
    }
    /// Message sent
    static var sent: String {
      String(localized: "native.composer.sent", table: "Native", bundle: .module)
    }
    /// Response stopped
    static var stopped: String {
      String(localized: "native.composer.stopped", table: "Native", bundle: .module)
    }
    /// The reply could not be stopped: {reason}
    static func stopFailed(_ reason: String) -> String {
      String(
        localized: "native.composer.stopFailed",
        defaultValue: "The reply could not be stopped: \(reason)",
        table: "Native",
        bundle: .module
      )
    }
    /// Stop
    static var stopShortcut: String {
      String(localized: "native.composer.stopShortcut", table: "Native", bundle: .module)
    }
  }
}
