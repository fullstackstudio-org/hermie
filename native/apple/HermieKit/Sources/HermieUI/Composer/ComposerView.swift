import HermieCore
import PhotosUI
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
/// The field keeps its focus after a send.
///
/// While the field holds a command being written (a line that starts with a slash), a list of the
/// gateway's commands opens above it (`SlashCompletionList`, `ComposerModel`'s `suggestions`): on
/// the Mac the arrow keys move, Tab or Return take a line and Esc closes it, on iPhone and iPad a
/// tap takes it.
///
/// A "+" at the leading edge adds attachments, as in Messages: on iPhone and iPad a menu (Photo
/// Library, Camera where there is one, Files), on the Mac the file picker; files can also be
/// dropped on the chat (`attachmentDropTarget`, set on the whole screen) and pictures or copied files
/// pasted into the field. Each becomes a chip above the field (`AttachmentStrip`) that uploads at
/// once; the send button waits until every chip is ready.
public struct ComposerView: View {
  @Bindable var model: ComposerModel

  /// Off while a request covers the chat: nothing is typed, pasted or sent from here.
  @Environment(\.isEnabled) private var isEnabled
  /// Whether the caret is in the field (reported by the text view).
  @State private var focused = false
  /// Moved to put the caret back in the field.
  @State private var focusRequest = 0
  /// What the plus menu opened.
  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoSelection: [PhotosPickerItem] = []
  #if os(iOS)
    @State private var showCamera = false
  #endif

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

      if !model.tray.items.isEmpty {
        AttachmentStrip(tray: model.tray)
      }

      if model.suggestionsOpen {
        SlashCompletionList(model: model, onAccept: { focusRequest += 1 })
      }

      GlassEffectContainer(spacing: 8) {
        HStack(alignment: .bottom, spacing: 8) {
          attachButton
          field
          actionButton
        }
      }
    }
    // Floating glass over the transcript, as Messages' field: no bar behind it. The transcript
    // scrolls under it and stops above it (the slot is a safe-area inset of the list). As far in
    // from the window's edges as the bubbles.
    .padding(.horizontal, Self.edgeInset)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .attachmentPickers(
      photos: $showPhotos, files: $showFiles, selection: $photoSelection,
      onPhotos: { items in AttachmentIntake.addPhotos(items, to: model.tray) },
      onFiles: { urls in AttachmentIntake.addFiles(urls, to: model.tray) }
    )
    #if os(iOS)
      // A sheet, not a full-screen cover: the chat stays standing under it, as under the photo
      // library and the file importer.
      .sheet(isPresented: $showCamera) {
        CameraPicker { data in
          AttachmentIntake.addCameraPhoto(data, to: model.tray)
        }
        .ignoresSafeArea()
      }
    #endif
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
    // Words put back from a message's menu (Edit and resend): the caret goes to the field.
    .onChange(of: model.focusRequests) { _, _ in
      focusRequest += 1
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("composer")
  }

  // MARK: The field

  private var field: some View {
    ComposerTextField(
      // Typing goes through the model, which refuses it while a request has the screen.
      text: Binding(get: { model.draft }, set: { model.type($0) }),
      placeholder: Strings.Chat.Composer.placeholder,
      accessibilityLabel: Strings.Chat.Composer.messageTo(bot: model.bot),
      accessibilityHint: Self.keyHint,
      maxLines: Self.maxLines,
      controlHeight: controlHeight,
      focusRequest: focusRequest,
      onFocusChange: { focused = $0 },
      onSend: { returnPressed() },
      onEscape: {
        // The command list closes first; Esc stops the bot only when no list is open.
        if model.handle(.escape) {
          return true
        }

        guard model.running else {
          return false
        }

        stop()
        return true
      },
      onPaste: { items in
        guard isEnabled else { return }
        AttachmentIntake.addPasted(items, to: model.tray)
      },
      completionKeysActive: model.suggestionsOpen && !model.suggestions.isEmpty,
      onCompletionKey: { model.handle($0) }
    )
    // The placeholder is the text view's own (`ComposerTextField`), drawn on the typed text's first
    // line: no overlay with insets to keep in step with it.
    .padding(.horizontal, 4)
    // Tinted with the page's background, so the words in the field keep their contrast over a
    // busy transcript as over an empty one. As round as the buttons beside it on one line.
    .glassEffect(.regular.tint(Self.fieldTint), in: .rect(cornerRadius: controlHeight / 2))
  }

  #if os(macOS)
    static let fieldTint = Color(nsColor: .textBackgroundColor).opacity(0.6)
  #else
    static let fieldTint = Color(uiColor: .systemBackground).opacity(0.6)
  #endif

  /// The composer's distance from the window's left and right edges: the bubbles'.
  static let edgeInset = ChatSpacing.edgeMargin

  /// Six lines, then the field scrolls.
  static let maxLines = 6

  /// The height of one line of the field, and the size of the round buttons beside it: they share
  /// it, so the plus, the text and the send button sit on one centre line. Scales with Dynamic Type,
  /// up to one and a half times: at the largest accessibility sizes three round buttons the size of
  /// the text would leave the field no room for a word.
  #if os(macOS)
    private static let baseControlHeight: CGFloat = 32
  #else
    private static let baseControlHeight: CGFloat = 40
  #endif

  @ScaledMetric(relativeTo: .body) private var scaledControlHeight: CGFloat = ComposerView.baseControlHeight

  private var controlHeight: CGFloat { min(scaledControlHeight, Self.baseControlHeight * 1.5) }

  // MARK: Attachments

  /// The plus: a menu on iPhone and iPad (Photo Library, Camera where there is one, Files), the
  /// file picker on the Mac.
  @ViewBuilder private var attachButton: some View {
    #if os(iOS)
      Menu {
        Button {
          showPhotos = true
        } label: {
          Label(NativeStrings.Composer.Attach.photoLibrary, systemImage: "photo.on.rectangle")
        }
        .accessibilityIdentifier("composer.attach.photos")

        if CameraPicker.isAvailable {
          Button {
            showCamera = true
          } label: {
            Label(NativeStrings.Composer.Attach.camera, systemImage: "camera")
          }
          .accessibilityIdentifier("composer.attach.camera")
        }

        Button {
          showFiles = true
        } label: {
          Label(NativeStrings.Composer.Attach.files, systemImage: "folder")
        }
        .accessibilityIdentifier("composer.attach.files")
      } label: {
        attachGlyph
      }
      .menuStyle(.button)
      .menuIndicator(.hidden)
      .buttonStyle(AttachButtonStyle())
      .accessibilityLabel(NativeStrings.Composer.Attach.add)
      .accessibilityIdentifier("composer.attach")
    #else
      Button {
        showFiles = true
      } label: {
        attachGlyph
      }
      .buttonStyle(AttachButtonStyle())
      .help(NativeStrings.Composer.Attach.chooseFile)
      .accessibilityLabel(NativeStrings.Composer.Attach.chooseFile)
      .accessibilityIdentifier("composer.attach")
    #endif
  }

  private var attachGlyph: some View {
    Image(systemName: "plus")
      .font(.body.weight(.bold))
      .frame(width: controlHeight, height: controlHeight)
  }

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
    !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !model.tray.isEmpty
  }

  /// What VoiceOver says after "Send": that it waits for the attachments, or that it queues.
  private var sendHint: String {
    if model.tray.blocked, !stopping {
      return NativeStrings.Composer.Attach.waitingHint
    }

    return model.turnActive && !stopping ? NativeStrings.Composer.queueHint : ""
  }

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
        .frame(width: controlHeight, height: controlHeight)
    }
    .buttonStyle(SendButtonStyle(role: stopping ? .stop : .send))
    .disabled(stopping ? model.isStopping : !model.canSubmit)
    .accessibilityLabel(stopping ? Strings.Chat.Composer.stop : Strings.Chat.Composer.send)
    .accessibilityHint(sendHint)
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

  /// Return from the field: takes the line of the command list the arrow keys are on when there is
  /// one to take, and sends otherwise.
  private func returnPressed() {
    // Covered by a request: Return is not a send (the field is off as well; this is the second lock).
    guard isEnabled else {
      return
    }

    if model.handle(.enter) {
      return
    }

    send()
  }

  private func send() {
    guard isEnabled, model.canSubmit else {
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
    case .commandFailed(let reason): NativeStrings.Composer.commandFailed(reason)
    }
  }

  static func announcement(_ event: ComposerEvent) -> String {
    switch event {
    case .sent: NativeStrings.Composer.sent
    case .queued: NativeStrings.Composer.queued
    case .stopped: NativeStrings.Composer.stopped
    case .commandRan: NativeStrings.Composer.commandRan
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

/// The plus's colours, as Messages draws its own: a flat grey disc with a white plus, which
/// stays visible on the black page where a dark glass disc vanished. The disc is a plain fill
/// (no glass, no gradient), picked so the shape is at least 3:1 against the page it sits on
/// (black in dark mode, white in light) and the white glyph is at least 3:1 against the disc.
enum AttachPalette {
  static let fillLight = (red: 0x70, green: 0x70, blue: 0x78)
  static let fillDark = (red: 0x63, green: 0x63, blue: 0x66)

  static let fill = Color.dynamic(
    light: (fillLight.red, fillLight.green, fillLight.blue),
    dark: (fillDark.red, fillDark.green, fillDark.blue))
}

/// The plus beside the field: a clearly visible filled grey circle with a bold white plus, round,
/// the same height as one line of the field. Dimmed, not recoloured, when it is disabled.
struct AttachButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(Color.white)
      .background(AttachPalette.fill, in: .circle)
      .opacity(isEnabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
      // 44 pt to touch on iPhone and iPad while the disc stays the field's line height (40 pt):
      // the shape reaches two points past the layout frame on every side.
      .contentShape(.circle.inset(by: -Self.hitSlop))
  }

  #if os(iOS)
    static let hitSlop: CGFloat = 2
  #else
    static let hitSlop: CGFloat = 0
  #endif
}

extension View {
  /// The pickers the plus opens: the photo library, and the file importer (for any file, several at a time).
  func attachmentPickers(
    photos: Binding<Bool>,
    files: Binding<Bool>,
    selection: Binding<[PhotosPickerItem]>,
    onPhotos: @escaping ([PhotosPickerItem]) -> Void,
    onFiles: @escaping ([URL]) -> Void
  ) -> some View {
    photosPicker(
      isPresented: photos,
      selection: selection,
      maxSelectionCount: 10,
      matching: .any(of: [.images, .videos]),
      // A HEIC photograph arrives as a JPEG: the gateway reads that as an image.
      // What the library holds: a movie is not transcoded to be picked. A photo is made ready for the
      // gateway (location removed, HEIC as JPEG) by `AttachmentStaging.stage(libraryItem:name:)`.
      preferredItemEncoding: .current
    )
    .onChange(of: selection.wrappedValue) { _, items in
      guard !items.isEmpty else { return }
      onPhotos(items)
      selection.wrappedValue = []
    }
    .fileImporter(isPresented: files, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      if case .success(let urls) = result {
        onFiles(urls)
      }
    }
  }
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
      // A message with attachments waits for its own turn: a steer folds words into the running
      // one, and an image cannot ride along.
      if entry.attachments?.isEmpty ?? true {
        Button {
          Task { await model.steerQueued(entry.id) }
        } label: {
          Image(systemName: "arrow.turn.down.right")
            .accessibilityLabel(Strings.Chat.Queue.steer)
        }
        .accessibilityIdentifier("composer.queue.steer.\(index)")
      }
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
    /// The command did not run: {reason}
    static func commandFailed(_ reason: String) -> String {
      String(
        localized: "native.composer.commandFailed",
        defaultValue: "The command did not run: \(reason)",
        table: "Native",
        bundle: .module
      )
    }
    /// Command ran
    static var commandRan: String {
      String(localized: "native.composer.commandRan", table: "Native", bundle: .module)
    }
    /// The lines of the command list under the field.
    enum Commands {
      /// Puts the command in the message.
      static var insertHint: String {
        String(localized: "native.composer.commands.insertHint", table: "Native", bundle: .module)
      }
      /// Skill
      static var skill: String {
        String(localized: "native.composer.commands.skill", table: "Native", bundle: .module)
      }
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
