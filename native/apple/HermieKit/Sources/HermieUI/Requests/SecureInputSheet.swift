import HermieCore
import SwiftUI

extension View {
  /// Answer the chat's one-string prompts (`secret`, `sudo`, `vault.*`): the
  /// sheet for the oldest open one, raised as it arrives, never over the app
  /// lock (it waits and comes up after the unlock), and the chat's notice when
  /// one expired, was withdrawn, or asked for something this app cannot show.
  public func secureInput(_ model: SecureInputModel) -> some View {
    modifier(SecureInputModifier(model: model))
  }
}

struct SecureInputModifier: ViewModifier {
  let model: SecureInputModel

  @Environment(AppLaunch.self) private var launch: AppLaunch?

  private struct Presented: Identifiable {
    let id: String
  }

  /// What decides whether the next prompt comes up.
  private struct Raise: Equatable {
    let next: String?
    let locked: Bool
  }

  /// The app lock's plate is up, or its setting not read yet. (`LockGate` does
  /// not build the chat behind the plate at all; this holds for a screen that
  /// sits elsewhere.)
  private var locked: Bool {
    guard let lock = launch?.lock else {
      return false
    }

    return !lock.ready || lock.machine.locked
  }

  func body(content: Content) -> some View {
    content
      .safeAreaInset(edge: .top, spacing: 0) {
        SecureInputNoticeView(model: model)
      }
      .sheet(item: presented) { _ in
        SecureInputSheetView(model: model)
          .presentationDetents([.large])
          // Opaque: what is asked is read against a plain background.
          .presentationBackground(.background)
          // While the prompt is open the sheet goes by Send or Skip only.
          .interactiveDismissDisabled(model.presented != nil)
          #if os(macOS)
            .frame(minWidth: 420, idealWidth: 480, minHeight: 360)
          #endif
      }
      .onChange(of: Raise(next: model.nextToPresent, locked: locked), initial: true) { _, raise in
        if !raise.locked, let next = raise.next {
          model.present(next)
        }
      }
      .onChange(of: model.presentedID == nil || model.presented != nil || model.presentedOutcome != nil) { _, showing in
        // The shown prompt ended with nothing to say (answered elsewhere on
        // this device, or its chat let go of it): the sheet goes.
        if !showing {
          model.dismiss()
        }
      }
      .onChange(of: model.lastAnswered) { _, answered in
        if answered != nil {
          AccessibilityNotification.Announcement(NativeStrings.Requests.answered).post()
        }
      }
      .onChange(of: model.presentedOutcome) { _, outcome in
        if let outcome {
          AccessibilityNotification.Announcement(SecureInputNoticeView.text(outcome, bot: model.bot)).post()
        }
      }
  }

  private var presented: Binding<Presented?> {
    Binding(
      get: { locked ? nil : model.presentedID.map(Presented.init(id:)) },
      set: { value in
        // Only a sheet whose prompt has ended goes away by itself.
        if value == nil, model.presentedID != nil, model.presented == nil {
          model.dismiss()
        }
      }
    )
  }
}

/// The sheet for one prompt. Its chrome is the app's own and the same every
/// time: who asks (the bot, by the name this app knows it under), on which
/// gateway, and for what kind of thing. What the request says is shown as plain
/// text, bounded, never as Markdown or links. Nothing is ever filled in for the
/// person, and the field is cleared when the sheet goes.
struct SecureInputSheetView: View {
  let model: SecureInputModel

  /// How long after the sheet appears Send stays off, so a sheet that comes up
  /// under a moving finger cannot send.
  static let tapGuard: Duration = .milliseconds(400)

  @State private var value = SecretValue()
  @State private var identifier = ""
  @State private var armed = false
  @FocusState private var focus: Field?
  @AccessibilityFocusState private var voiceOverFocus: Field?

  enum Field: Hashable {
    case identifier
    case value
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let prompt = model.presentedPrompt {
          SecureInputChrome(model: model, prompt: prompt)

          if model.presented != nil {
            SecureInputDetails(kind: prompt.kind)
            fields(prompt)
            // Who receives it is part of the decision: full contrast.
            Text(Self.receiver(prompt.kind))
              .font(.footnote)
              .fixedSize(horizontal: false, vertical: true)
              .accessibilityIdentifier("secureInput.receiver")
            status
          } else {
            outcome
          }
        }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollDismissesKeyboard(.interactively)
    // Send and Skip (or Close) stay pinned under the content, above the
    // keyboard, at every text size.
    .safeAreaInset(edge: .bottom, spacing: 0) {
      actions
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.background)
    }
    .task(id: model.presentedID) {
      armed = false
      let first: Field = model.presentedPrompt.map(Self.isLogin) == true ? .identifier : .value
      focus = first
      voiceOverFocus = first
      try? await Task.sleep(for: Self.tapGuard)
      armed = true
    }
    .onChange(of: model.presentedID) {
      clear()
    }
    .onChange(of: model.presented == nil) { _, ended in
      if ended {
        clear()
      }
    }
    .onDisappear {
      clear()
    }
  }

  // MARK: Fields

  @ViewBuilder private func fields(_ prompt: SecurePrompt) -> some View {
    switch prompt.kind {
    case .secret:
      maskedField(NativeStrings.SecureInput.valueLabel, prompt: prompt)
    case .sudo:
      maskedField(NativeStrings.SecureInput.passwordLabel, prompt: prompt)
    case .vaultUnlock:
      maskedField(NativeStrings.SecureInput.masterPasswordLabel, prompt: prompt)
    case .vaultCode:
      // A one-time code is shown as typed, as on the desktop: a typo must be
      // visible, and the system can offer the code it just received.
      fieldLabel(NativeStrings.SecureInput.codeLabel) {
        TextField(NativeStrings.SecureInput.codeLabel, text: $value.revealed)
          .textContentType(.oneTimeCode)
          #if os(iOS)
            .keyboardType(.asciiCapableNumberPad)
          #endif
          .modifier(PlainEntry())
          .focused($focus, equals: .value)
          .accessibilityFocused($voiceOverFocus, equals: .value)
          .onSubmit { submit(prompt) }
          .accessibilityIdentifier("secureInput.field")
      }
    case .vaultSaveLogin:
      // The one place the system's password manager takes part: a login it
      // can fill, and offer to keep.
      fieldLabel(NativeStrings.SecureInput.usernameLabel) {
        TextField(NativeStrings.SecureInput.usernameLabel, text: $identifier)
          .textContentType(.username)
          .modifier(PlainEntry())
          .focused($focus, equals: .identifier)
          .accessibilityFocused($voiceOverFocus, equals: .identifier)
          .onSubmit { focus = .value }
          .accessibilityIdentifier("secureInput.identifier")
      }
      fieldLabel(NativeStrings.SecureInput.passwordLabel) {
        SecureField(NativeStrings.SecureInput.passwordLabel, text: $value.revealed)
          .textContentType(.password)
          .modifier(PlainEntry())
          .focused($focus, equals: .value)
          .accessibilityFocused($voiceOverFocus, equals: .value)
          .onSubmit { submit(prompt) }
          .accessibilityIdentifier("secureInput.field")
      }
    }
  }

  /// The masked field for a secret, the sudo password and a master password.
  /// No content type: the system must not offer to save an API key or the
  /// gateway's administrator password as a website's password.
  private func maskedField(_ label: String, prompt: SecurePrompt) -> some View {
    fieldLabel(label) {
      SecureField(label, text: $value.revealed)
        .modifier(PlainEntry())
        .focused($focus, equals: .value)
        .accessibilityFocused($voiceOverFocus, equals: .value)
        .onSubmit { submit(prompt) }
        .accessibilityIdentifier("secureInput.field")
    }
  }

  private func fieldLabel(_ label: String, @ViewBuilder field: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label)
        .font(.subheadline.weight(.semibold))
        .accessibilityHidden(true)
      field()
        .textFieldStyle(.roundedBorder)
        .disabled(model.isSending)
    }
  }

  // MARK: Status and buttons

  @ViewBuilder private var status: some View {
    if model.isSending {
      HStack(spacing: 6) {
        ProgressView()
          .controlSize(.small)
        Text(NativeStrings.Requests.sending)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("secureInput.sending")
    } else if model.hasFailed {
      Label(NativeStrings.Requests.failed(nil), systemImage: "exclamationmark.triangle")
        .font(.caption)
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("secureInput.failed")
    } else if model.secondsLeft != nil {
      TimelineView(.periodic(from: .now, by: 1)) { _ in
        let left = model.secondsLeft ?? 0
        Label(NativeStrings.SecureInput.expiresIn(RequestCountdownView.clock(left)), systemImage: "timer")
          .font(.caption.monospacedDigit())
          .foregroundStyle(left <= 10 ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
          .accessibilityIdentifier("secureInput.countdown")
      }
    }
  }

  /// Send and Skip while the prompt is open; Close once it ended.
  @ViewBuilder private var actions: some View {
    if let prompt = model.presentedPrompt, model.presented != nil {
      VStack(spacing: 10) {
        Button {
          submit(prompt)
        } label: {
          Text(sendTitle(prompt))
            .font(.title3.weight(.semibold))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .keyboardShortcut(.defaultAction)
        .disabled(!(armed && model.canSend(value, identifier: identifier)))
        .accessibilityIdentifier(model.hasFailed ? "secureInput.retry" : "secureInput.send")

        Button {
          Task {
            if await model.skip() {
              clear()
            }
          }
        } label: {
          Text(NativeStrings.SecureInput.skip)
            .font(.title3.weight(.semibold))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(.primary)
        .controlSize(.large)
        // Esc answers '' as Skip does.
        .keyboardShortcut(.cancelAction)
        .disabled(model.isSending)
        .accessibilityIdentifier("secureInput.skip")
      }
    } else {
      Button {
        model.dismiss()
      } label: {
        Text(NativeStrings.SecureInput.close)
          .font(.title3.weight(.semibold))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.bordered)
      .tint(.primary)
      .controlSize(.large)
      .keyboardShortcut(.cancelAction)
      .accessibilityIdentifier("secureInput.close")
    }
  }

  private func sendTitle(_ prompt: SecurePrompt) -> String {
    if model.hasFailed {
      return NativeStrings.Requests.retry
    }

    return Self.isLogin(prompt) ? NativeStrings.SecureInput.save : NativeStrings.SecureInput.send
  }

  @ViewBuilder private var outcome: some View {
    if let outcome = model.presentedOutcome {
      Label(SecureInputNoticeView.sheetText(outcome), systemImage: "clock.badge.xmark")
        .font(.headline)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("secureInput.outcome")
    }
  }

  // MARK: Acting

  /// Send what is in the field (Send, Return, Retry): the value still in the
  /// field is what goes, and the field is cleared once it went out.
  private func submit(_ prompt: SecurePrompt) {
    guard armed, model.canSend(value, identifier: identifier) else {
      return
    }

    let typed = value
    let name = identifier

    Task {
      if await model.send(typed, identifier: name) {
        clear()
      }
    }
  }

  private func clear() {
    value.clear()
    identifier = ""
  }

  static func isLogin(_ prompt: SecurePrompt) -> Bool {
    if case .vaultSaveLogin = prompt.kind {
      return true
    }

    return false
  }

  /// Who receives the value, and what becomes of it, in one line.
  static func receiver(_ kind: SecurePromptKind) -> String {
    switch kind {
    case .secret: NativeStrings.SecureInput.receiverStored
    case .vaultSaveLogin: NativeStrings.SecureInput.receiverLogin
    case .sudo, .vaultUnlock, .vaultCode: NativeStrings.SecureInput.receiverUsed
    }
  }
}

/// No corrections, no capitals, nothing the keyboard learns from.
private struct PlainEntry: ViewModifier {
  func body(content: Content) -> some View {
    content
      .autocorrectionDisabled()
      #if os(iOS)
        .textInputAutocapitalization(.never)
      #endif
      .privacySensitive()
  }
}

/// The sheet's constant top: the app's own icon and words for who asks, for
/// what kind of thing, and on which gateway.
struct SecureInputChrome: View {
  let model: SecureInputModel
  let prompt: SecurePrompt

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Image(systemName: "lock.shield.fill")
        .font(.title)
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
      Text(Self.title(prompt.kind, bot: model.bot))
        .font(.title2.bold())
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("secureInput.title")
      Text(NativeStrings.SecureInput.gateway(model.gatewayName))
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("secureInput.gateway")
    }
  }

  static func title(_ kind: SecurePromptKind, bot: String) -> String {
    switch kind {
    case .secret: NativeStrings.SecureInput.titleSecret(bot)
    case .sudo: NativeStrings.SecureInput.titleSudo(bot)
    case .vaultUnlock: NativeStrings.SecureInput.titleVaultUnlock(bot)
    case .vaultCode: NativeStrings.SecureInput.titleVaultCode(bot)
    case .vaultSaveLogin: NativeStrings.SecureInput.titleVaultSaveLogin(bot)
    }
  }
}

/// What the request itself says, as plain text (`Text(verbatim:)`: never
/// Markdown, never a link), already cleaned and bounded by `SecurePrompt`.
struct SecureInputDetails: View {
  let kind: SecurePromptKind

  var body: some View {
    switch kind {
    case .secret(let envVar, let prompt):
      if !prompt.isEmpty {
        quoted(prompt)
      }
      if !envVar.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(NativeStrings.SecureInput.storedAs)
            .foregroundStyle(.secondary)
          Text(verbatim: envVar)
            .font(.body.monospaced())
            .accessibilityIdentifier("secureInput.envVar")
        }
        .accessibilityElement(children: .combine)
      }
    case .sudo(let command):
      Text(NativeStrings.SecureInput.sudoLead)
        .fixedSize(horizontal: false, vertical: true)
      if command.isEmpty {
        Text(NativeStrings.SecureInput.sudoNoCommand)
          .foregroundStyle(.secondary)
      } else {
        Text(verbatim: command)
          .font(.body.monospaced())
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(.background.secondary, in: .rect(cornerRadius: 10))
          .accessibilityIdentifier("secureInput.command")
      }
    case .vaultUnlock(let name):
      Text(NativeStrings.SecureInput.vaultUnlockLead(name))
        .fixedSize(horizontal: false, vertical: true)
    case .vaultCode(let site, let hint):
      Text(site.isEmpty ? NativeStrings.SecureInput.vaultCodeLeadNoSite : NativeStrings.SecureInput.vaultCodeLead(site))
        .fixedSize(horizontal: false, vertical: true)
      if !hint.isEmpty {
        quoted(hint)
      }
    case .vaultSaveLogin(let site, let origin):
      Text(verbatim: site)
        .font(.title3.weight(.semibold).monospaced())
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("secureInput.site")
      Text(NativeStrings.SecureInput.vaultSaveLoginLead(site))
        .fixedSize(horizontal: false, vertical: true)
      if !origin.isEmpty, origin != site {
        Text(verbatim: origin)
          .font(.footnote.monospaced())
          .foregroundStyle(.secondary)
      }
    }
  }

  private func quoted(_ text: String) -> some View {
    Text(verbatim: text)
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(.background.secondary, in: .rect(cornerRadius: 10))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("secureInput.prompt")
  }
}

/// The chat's line about a prompt that ended without the person's answer, or
/// one this app could not show. Nothing when there is none.
public struct SecureInputNoticeView: View {
  let model: SecureInputModel

  public init(model: SecureInputModel) {
    self.model = model
  }

  public var body: some View {
    if let entry = model.notice {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Label(Self.text(entry.notice, bot: model.bot), systemImage: Self.icon(entry.notice))
          .font(.footnote)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        Button {
          model.dismissNotice()
        } label: {
          Image(systemName: "xmark")
            .accessibilityLabel(NativeStrings.SecureInput.close)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier("secureInput.notice.dismiss")
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(.bar)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("secureInput.notice")
    }
  }

  static func icon(_ notice: SecureInputNotice) -> String {
    switch notice {
    case .expired: "clock.badge.xmark"
    case .withdrawn: "xmark.circle"
    case .unsupported: "exclamationmark.bubble"
    }
  }

  /// On the chat, where the bot has to be named.
  static func text(_ notice: SecureInputNotice, bot: String) -> String {
    switch notice {
    case .expired: NativeStrings.SecureInput.expired
    case .withdrawn: NativeStrings.SecureInput.withdrawn
    case .unsupported(let method): NativeStrings.SecureInput.unsupported(bot: bot, method: method)
    }
  }

  /// In the sheet, under the bot's own title.
  static func sheetText(_ notice: SecureInputNotice) -> String {
    switch notice {
    case .expired: NativeStrings.SecureInput.expired
    case .withdrawn, .unsupported: NativeStrings.SecureInput.withdrawn
    }
  }
}

extension NativeStrings {
  enum SecureInput {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// {bot} asks for a secret
    static func titleSecret(_ bot: String) -> String {
      String(localized: "native.secureInput.title.secret", defaultValue: "\(bot) asks for a secret", table: "Native", bundle: .module)
    }
    /// {bot} asks for an administrator password
    static func titleSudo(_ bot: String) -> String {
      String(
        localized: "native.secureInput.title.sudo", defaultValue: "\(bot) asks for an administrator password",
        table: "Native", bundle: .module)
    }
    /// {bot} asks to unlock a password manager
    static func titleVaultUnlock(_ bot: String) -> String {
      String(
        localized: "native.secureInput.title.vaultUnlock", defaultValue: "\(bot) asks to unlock a password manager",
        table: "Native", bundle: .module)
    }
    /// {bot} asks for a one-time code
    static func titleVaultCode(_ bot: String) -> String {
      String(
        localized: "native.secureInput.title.vaultCode", defaultValue: "\(bot) asks for a one-time code",
        table: "Native", bundle: .module)
    }
    /// {bot} asks to save a login
    static func titleVaultSaveLogin(_ bot: String) -> String {
      String(
        localized: "native.secureInput.title.vaultSaveLogin", defaultValue: "\(bot) asks to save a login",
        table: "Native", bundle: .module)
    }
    /// On gateway {name}
    static func gateway(_ name: String) -> String {
      String(localized: "native.secureInput.gateway", defaultValue: "On gateway \(name)", table: "Native", bundle: .module)
    }
    /// Stored as
    static var storedAs: String {
      String(localized: "native.secureInput.variable", table: "Native", bundle: .module)
    }
    /// The bot wants to run this command with administrator rights…
    static var sudoLead: String {
      String(localized: "native.secureInput.sudo.lead", table: "Native", bundle: .module)
    }
    /// The gateway did not say which command.
    static var sudoNoCommand: String {
      String(localized: "native.secureInput.sudo.noCommand", table: "Native", bundle: .module)
    }
    /// Enter the master password of {name}.
    static func vaultUnlockLead(_ name: String) -> String {
      String(
        localized: "native.secureInput.vaultUnlock.lead", defaultValue: "Enter the master password of \(name).",
        table: "Native", bundle: .module)
    }
    /// Enter the code for {site}.
    static func vaultCodeLead(_ site: String) -> String {
      String(localized: "native.secureInput.vaultCode.lead", defaultValue: "Enter the code for \(site).", table: "Native", bundle: .module)
    }
    /// Enter the code the website asked for.
    static var vaultCodeLeadNoSite: String {
      String(localized: "native.secureInput.vaultCode.leadNoSite", table: "Native", bundle: .module)
    }
    /// Save a login for {site}.
    static func vaultSaveLoginLead(_ site: String) -> String {
      String(
        localized: "native.secureInput.vaultSaveLogin.lead", defaultValue: "Save a login for \(site).", table: "Native",
        bundle: .module)
    }
    /// Value
    static var valueLabel: String { string("native.secureInput.field.value") }
    /// Password
    static var passwordLabel: String { string("native.secureInput.field.password") }
    /// Master password
    static var masterPasswordLabel: String { string("native.secureInput.field.masterPassword") }
    /// Code
    static var codeLabel: String { string("native.secureInput.field.code") }
    /// Username
    static var usernameLabel: String { string("native.secureInput.field.username") }
    /// Hermie sends this to the gateway, which stores it for this bot…
    static var receiverStored: String { string("native.secureInput.receiver.stored") }
    /// Hermie sends this to the gateway, where the bot uses it…
    static var receiverUsed: String { string("native.secureInput.receiver.used") }
    /// Hermie sends this to the gateway, which saves it in the bot's password vault…
    static var receiverLogin: String { string("native.secureInput.receiver.login") }
    /// Send
    static var send: String { string("native.secureInput.send") }
    /// Save
    static var save: String { string("native.secureInput.save") }
    /// Skip
    static var skip: String { string("native.secureInput.skip") }
    /// Close
    static var close: String { string("native.secureInput.close") }
    /// Expires in {time}
    static func expiresIn(_ time: String) -> String {
      String(localized: "native.secureInput.expiresIn", defaultValue: "Expires in \(time)", table: "Native", bundle: .module)
    }
    /// The request expired. Nothing was sent.
    static var expired: String { string("native.secureInput.expired") }
    /// The bot no longer asks for this. Nothing was sent.
    static var withdrawn: String { string("native.secureInput.withdrawn") }
    /// {bot} asked for something this app cannot show: {method}
    static func unsupported(bot: String, method: String) -> String {
      String(
        localized: "native.secureInput.unsupported",
        defaultValue: "\(bot) asked for something this app cannot show: \(method)",
        table: "Native",
        bundle: .module
      )
    }
  }
}
