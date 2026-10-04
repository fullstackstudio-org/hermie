import HermieCore
import HermieGateway
import HermieProtocol
import SwiftUI

#if os(iOS)
  import UIKit
#elseif os(macOS)
  import AppKit
#endif

/**
 Settings → Gateways → Passkeys: one gateway's passkeys (plan `confirm-passkey.md`, P6, P7 and
 CP-10). Where they stand, in one sentence and with the reason in plain words; the passkeys of this
 account on the gateway (name, when it was added, when it was last used) with a way to remove each
 after a confirmation; "Add with a code" for a code from the gateway's operator (or from one's own
 passkey on another device); and "Create a code for another device" where the operator allows it.

 Everything it shows and does is `PasskeyModel`'s: the page only reads the model and calls its
 actions. Adding, creating a code and removing each open the system's passkey sheet, and the page
 tells what happened in plain words; the person dismissing that sheet is not an error.

 "Add a passkey" (`PasskeySelfEnrolSection`) is above "Add with a code" when the gateway lets this
 person add a passkey by signing in again and this session can sign in through the browser
 (`PasskeyModel.canSelfEnrol`); the flow and its state are the model's (`selfEnrolment`), and the
 page keeps nothing of them that a rebuilt page could not read back.
 */
struct PasskeysSettingsPage: View {
  let model: PasskeyModel
  let gatewayName: String

  @State private var code = ""
  @State private var working = false
  @State private var failure: String?
  @State private var invite: PasskeyInvite?
  @State private var removing: PasskeyCredentialInfo?
  /// The browser sheet of step 1 of "Add a passkey".
  @State private var presenter = WebAuthenticationPresenter()
  /// Moves once a second while a countdown or a waiting period is on screen.
  @State private var tick = 0
  /// Opened from the confirm sheet's "Add a passkey here": scroll to the add flow once it is there.
  @State private var wantsAddFlow = false
  @FocusState private var codeFocused: Bool
  @Environment(\.scenePhase) private var scenePhase

  /// Where "Add a passkey here" lands: the sign-in-again flow where the gateway offers it, else the code.
  private enum AddAnchor: Hashable {
    case selfEnrol
    case code
  }

  var body: some View {
    ScrollViewReader { proxy in
      page
        .onChange(of: ShellRequests.shared.passkeysAddFlow, initial: true) { _, requested in
          if requested {
            ShellRequests.shared.passkeysAddFlow = false
            wantsAddFlow = true
          }
        }
        .task(id: wantsAddFlow && PasskeysPageState.of(model).canEnrol) {
          await scrollToAddFlow(proxy)
        }
    }
  }

  private func scrollToAddFlow(_ proxy: ScrollViewProxy) async {
    guard wantsAddFlow, PasskeysPageState.of(model).canEnrol else { return }

    // The sections are in place a moment after the state is.
    try? await Task.sleep(for: .milliseconds(150))
    guard !Task.isCancelled else { return }

    let target: AddAnchor = PasskeysSelfEnrolState.of(model, now: Date()) == .hidden ? .code : .selfEnrol

    withAnimation { proxy.scrollTo(target, anchor: .top) }
    wantsAddFlow = false
  }

  @ViewBuilder private var page: some View {
    let state = PasskeysPageState.of(model)
    let _ = tick
    let now = Date()
    let selfState = PasskeysSelfEnrolState.of(model, now: now)

    Form {
      noticesSection
      stateSection(state)

      if !model.credentials.isEmpty, state.canEnrol {
        credentialsSection
      }

      if state.canEnrol {
        if selfState != .hidden {
          PasskeySelfEnrolSection(
            state: selfState,
            gatewayName: gatewayName,
            coolingOff: PasskeysText.coolingOffNotice(seconds: model.status?.selfEnrol?.coolingOffS),
            busy: working,
            signIn: signInAgain,
            create: createPasskey,
            another: addAnother
          )
          .id(AddAnchor.selfEnrol)
        }

        addSection
      }

      if state == .enrolled {
        inviteSection
      }

      failureSection
    }
    .formStyle(.grouped)
    .navigationTitle(NativeStrings.Passkeys.title)
    .accessibilityIdentifier("hermie.passkeys.page")
    .task { await model.refresh() }
    .task(id: ticking(now: now)) {
      guard ticking(now: Date()) else { return }

      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        // A grant past its time is over: the model says so (and drops its secret) rather than the page.
        model.expireSelfEnrolmentIfDue()
        tick &+= 1
      }
    }
    .background(PresentationAnchorReader(box: presenter.anchor))
    .onChange(of: scenePhase) { _, phase in
      sceneChanged(phase)
    }
    .onDisappear {
      invite = nil
      forgetFinishedSelfEnrolment()
    }
    .confirmationDialog(
      NativeStrings.Passkeys.removeTitle,
      isPresented: removalPresented,
      titleVisibility: .visible,
      presenting: removing
    ) { credential in
      Button(NativeStrings.Passkeys.removeAction, role: .destructive) {
        remove(credential)
      }
      .accessibilityIdentifier("hermie.passkeys.remove.confirm")
      Button(Strings.App.Common.cancel, role: .cancel) {}
    } message: { _ in
      Text(NativeStrings.Passkeys.removeMessage)
    }
  }

  // MARK: Sections

  @ViewBuilder private var noticesSection: some View {
    if !model.notices.isEmpty {
      Section {
        ForEach(model.notices) { notice in
          PasskeyNoticeRow(model: model, notice: notice)
        }
      }
    }
  }

  private func stateSection(_ state: PasskeysPageState) -> some View {
    let words = PasskeysText.state(state)

    return Section {
      Label {
        Text(words.text)
          .fixedSize(horizontal: false, vertical: true)
      } icon: {
        Image(systemName: words.symbol)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.passkeys.state")
    } header: {
      SettingsNote(NativeStrings.Passkeys.stateHeader(gatewayName))
    } footer: {
      SettingsNote(NativeStrings.Passkeys.stateFooter)
    }
  }

  private var credentialsSection: some View {
    Section {
      ForEach(Array(model.credentials.enumerated()), id: \.offset) { _, credential in
        PasskeyCredentialRow(credential: credential, busy: working) {
          removing = credential
        }
      }
    } header: {
      SettingsNote(NativeStrings.Passkeys.credentialsHeader)
    }
  }

  private var addSection: some View {
    Section {
      TextField(NativeStrings.Passkeys.codeField, text: $code)
        .id(AddAnchor.code)
        .autocorrectionDisabled()
        .privacySensitive()
        .focused($codeFocused)
        #if os(iOS)
          .textInputAutocapitalization(.characters)
        #endif
        .accessibilityIdentifier("hermie.passkeys.code")

      Button(NativeStrings.Passkeys.addAction) {
        enrol()
      }
      .disabled(working || code.trimmingCharacters(in: .whitespaces).isEmpty)
      .accessibilityIdentifier("hermie.passkeys.add")
    } header: {
      SettingsNote(NativeStrings.Passkeys.addHeader)
    } footer: {
      SettingsNote(NativeStrings.Passkeys.addFooter)
    }
  }

  @ViewBuilder private var inviteSection: some View {
    Section {
      if let invite {
        PasskeyInviteView(invite: invite) {
          self.invite = nil
        }
      } else if model.status?.userInvites == true {
        Button(NativeStrings.Passkeys.inviteAction) {
          mintInvite()
        }
        .disabled(working)
        .accessibilityIdentifier("hermie.passkeys.invite")
      }
    } header: {
      SettingsNote(NativeStrings.Passkeys.inviteHeader)
    } footer: {
      SettingsNote(model.status?.userInvites == true ? NativeStrings.Passkeys.inviteFooter : NativeStrings.Passkeys.invitesOff)
    }
  }

  @ViewBuilder private var failureSection: some View {
    if let failure {
      Section {
        Label {
          Text(failure)
            .foregroundStyle(Color.primary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: "exclamationmark.triangle")
            .foregroundStyle(Color.primary)
            .accessibilityHidden(true)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("hermie.passkeys.failure")
      }
    }
  }

  // MARK: Actions

  private var removalPresented: Binding<Bool> {
    Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })
  }

  private func enrol() {
    let typed = code
    // The keyboard goes, so that a failure said below the field is not read behind it.
    codeFocused = false

    run {
      _ = try await model.enrol(code: typed)
      code = ""
    }
  }

  /// Step 1: sign in again through the system browser for a fresh grant.
  private func signInAgain() {
    codeFocused = false
    run {
      _ = try await model.beginSelfEnrolment(presenter: presenter)
    }
  }

  /// Step 2: the system's passkey sheet, with what step 1 got.
  private func createPasskey() {
    guard let grantID = model.selfEnrolment?.grantID else { return }

    run {
      _ = try await model.enrol(grantID: grantID)
    }
  }

  private func addAnother() {
    failure = nil
    model.forgetSelfEnrolment()
  }

  /// A countdown, or a passkey cooling off, is on screen: the page redraws once a second.
  private func ticking(now: Date) -> Bool {
    if let phase = model.selfEnrolment?.phase {
      switch phase {
      case .signingIn, .signInEnded, .ready, .enrolling: return true
      case .failed, .done: break
      }
    }

    return model.credentials.contains { PasskeysText.coolingOff($0, now: now) != nil }
  }

  /// The sign-in browser sheet makes the app resign active, and the lock may take this page down
  /// meanwhile: an attempt in progress (and a grant ready to use) stays with the model. A finished
  /// one (added, or ended in a reason) goes when the page does.
  private func forgetFinishedSelfEnrolment() {
    guard let phase = model.selfEnrolment?.phase else { return }

    switch phase {
    case .done, .failed: model.forgetSelfEnrolment()
    case .signingIn, .signInEnded, .ready, .enrolling: break
    }
  }

  /// The sign-in sheet stays up while the person goes elsewhere (to a password manager, say): on iOS
  /// the presenter asks for the few seconds the system grants. The listener listening again on
  /// return is `PasskeyModel.appBecameActive()`, which the app's wiring calls, not this page.
  private func sceneChanged(_ phase: ScenePhase) {
    switch phase {
    case .background where model.selfEnrolment?.phase == .signingIn:
      presenter.appWentToBackground()
    case .active:
      presenter.appBecameActive()
    default:
      break
    }
  }

  private func mintInvite() {
    codeFocused = false
    run {
      invite = try await model.mintInvite()
    }
  }

  private func remove(_ credential: PasskeyCredentialInfo) {
    guard let id = credential.id else { return }

    run {
      try await model.revoke(credentialID: id)
    }
  }

  /// One action at a time; what it throws is said in plain words, and a dismissed system sheet says
  /// nothing.
  private func run(_ action: @escaping @MainActor () async throws -> Void) {
    guard !working else { return }
    working = true
    failure = nil

    Task {
      do {
        try await action()
      } catch let error as PasskeyActionError {
        failure = PasskeysSelfEnrolState.failureLine(
          for: error,
          state: PasskeysSelfEnrolState.of(model, now: Date()),
          host: gatewayName
        )
      } catch {
        failure = NativeStrings.Passkeys.unreadable
      }

      working = false
    }
  }
}

/// One passkey of the account: its name as the gateway has it, when it was added and last used,
/// and the way to remove it.
struct PasskeyCredentialRow: View {
  let credential: PasskeyCredentialInfo
  let busy: Bool
  let remove: () -> Void

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        // The name is the passkey's own, set by the app that made it: plain text.
        Text(verbatim: Self.shownName(credential))
          .font(.body)
          .fixedSize(horizontal: false, vertical: true)
        Text(Self.added(credential.createdAt))
          .font(.footnote)
        Text(Self.lastUsed(credential.lastUsedAt))
          .font(.footnote)

        if let coolingOff = PasskeysText.coolingOff(credential, now: Date()) {
          Label {
            Text(coolingOff)
              .font(.footnote)
          } icon: {
            Image(systemName: "clock")
              .accessibilityHidden(true)
          }
          .accessibilityIdentifier("hermie.passkeys.credential.coolingOff")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("hermie.passkeys.credential")

      Button(NativeStrings.Passkeys.removeAction, systemImage: "trash", role: .destructive, action: remove)
        .labelStyle(.iconOnly)
        .buttonStyle(.borderless)
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(.rect)
        .disabled(busy)
        .accessibilityLabel(Text(verbatim: "\(NativeStrings.Passkeys.removeAction): \(Self.shownName(credential))"))
        .accessibilityIdentifier("hermie.passkeys.remove")
    }
    .accessibilityElement(children: .contain)
  }

  /// The name the gateway holds for the passkey: one bounded line.
  static func shownName(_ credential: PasskeyCredentialInfo) -> String {
    PasskeyModel.displayName(credential.name)
  }

  static func added(_ at: Double?) -> String {
    guard let at else { return NativeStrings.Passkeys.addedUnknown }
    return NativeStrings.Passkeys.added(Self.format(at))
  }

  static func lastUsed(_ at: Double?) -> String {
    guard let at else { return NativeStrings.Passkeys.neverUsed }
    return NativeStrings.Passkeys.lastUsed(Self.format(at))
  }

  private static func format(_ unix: Double) -> String {
    Date(timeIntervalSince1970: unix).formatted(date: .abbreviated, time: .shortened)
  }
}

/// A freshly made code for another device: shown once, with a copy button and when it expires. It
/// is dropped when the page goes away.
struct PasskeyInviteView: View {
  let invite: PasskeyInvite
  let hide: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: invite.code)
        .font(.title3.monospaced().weight(.semibold))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("hermie.passkeys.invite.code")

      if let expires = invite.expiresAt {
        Text(NativeStrings.Passkeys.inviteExpires(expires.formatted(date: .omitted, time: .shortened)))
          .font(.footnote)
          .accessibilityIdentifier("hermie.passkeys.invite.expires")
      }

      HStack(spacing: 16) {
        Button(NativeStrings.Passkeys.copyCode, systemImage: "doc.on.doc") {
          PasskeyCodeBoard.copy(invite)
        }
        .accessibilityIdentifier("hermie.passkeys.invite.copy")

        Button(NativeStrings.Passkeys.hideCode, systemImage: "eye.slash", action: hide)
          .accessibilityIdentifier("hermie.passkeys.invite.hide")
      }
      .buttonStyle(.borderless)
    }
    .accessibilityElement(children: .contain)
  }
}

/// The pasteboard for a code. On iOS it stays on this device and the system removes it when the code
/// expires. On macOS it is written with the markers that clipboard managers honour (concealed and
/// transient, so it is not kept in their history) and cleared when the code expires, if the
/// pasteboard still holds that value (nothing else was copied meanwhile). macOS has no local-only
/// pasteboard, so a Universal Clipboard to a nearby device is not prevented, and if the app is quit
/// before the code expires the value stays until the next copy.
@MainActor
enum PasskeyCodeBoard {
  /// The markers of nspasteboard.org: a clipboard manager skips what carries them.
  static let concealedType = "org.nspasteboard.ConcealedType"
  static let transientType = "org.nspasteboard.TransientType"

  #if os(macOS)
    private static var clearing: Task<Void, Never>?
  #endif

  static func copy(_ invite: PasskeyInvite) {
    #if os(iOS)
      var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]

      if let expires = invite.expiresAt {
        options[.expirationDate] = expires
      }

      UIPasteboard.general.setItems([["public.utf8-plain-text": invite.code]], options: options)
    #elseif os(macOS)
      let board = NSPasteboard.general
      let written = write(invite.code, to: board)

      clearing?.cancel()
      clearing = nil

      guard let expires = invite.expiresAt else { return }

      let code = invite.code
      clearing = Task { @MainActor in
        let wait = expires.timeIntervalSinceNow

        if wait > 0 {
          try? await Task.sleep(for: .seconds(wait))
        }

        guard !Task.isCancelled else { return }
        clearIfUnchanged(board, written: written, code: code)
      }
    #endif
  }

  #if os(macOS)
    /// Put `code` on `board` with the concealed and transient markers; the change count after it.
    static func write(_ code: String, to board: NSPasteboard) -> Int {
      let concealed = NSPasteboard.PasteboardType(concealedType)
      let transient = NSPasteboard.PasteboardType(transientType)
      board.clearContents()
      board.declareTypes([.string, concealed, transient], owner: nil)
      board.setString(code, forType: .string)
      board.setData(Data(), forType: concealed)
      board.setData(Data(), forType: transient)
      return board.changeCount
    }

    /// Remove the code from the pasteboard when it is still what the pasteboard holds.
    static func clearIfUnchanged(_ board: NSPasteboard, written: Int, code: String) {
      guard board.changeCount == written, board.string(forType: .string) == code else { return }
      board.clearContents()
    }
  #endif
}

/// The Passkeys category in Settings: the live gateway's passkeys, when this build has passkeys.
/// Only the live gateway has a session, so only its passkeys can be read and changed.
struct PasskeysSettingsEntry: View {
  @Environment(AppLaunch.self) private var launch
  @Environment(LiveGateway.self) private var live: LiveGateway?

  var body: some View {
    if let model = live?.session?.passkeys, let id = live?.gatewayID, let entry = launch.gateways.entry(id: id) {
      PasskeysSettingsPage(model: model, gatewayName: entry.name)
    } else {
      Form {
        Section {
          Text(NativeStrings.Passkeys.notOffered)
        } footer: {
          SettingsNote(NativeStrings.Passkeys.stateFooter)
        }
      }
      .formStyle(.grouped)
      .accessibilityIdentifier("hermie.settings.passkeys.none")
    }
  }
}

extension NativeStrings {
  enum Passkeys {
    private static func string(_ key: String.LocalizationValue) -> String {
      String(localized: key, table: "Native", bundle: .module)
    }

    /// Passkeys
    static var title: String { string("native.passkeys.title") }
    /// Passkeys on {gateway}
    static func stateHeader(_ gateway: String) -> String {
      String(localized: "native.passkeys.stateHeader", defaultValue: "Passkeys on \(gateway)", table: "Native", bundle: .module)
    }
    /// A passkey lets you confirm what a bot asks…
    static var stateFooter: String { string("native.passkeys.stateFooter") }
    /// Checking this gateway…
    static var loading: String { string("native.passkeys.state.loading") }
    /// This version of Hermie has no passkey support…
    static var notConfigured: String { string("native.passkeys.state.notConfigured") }
    /// This gateway does not offer passkeys.
    static var notOffered: String { string("native.passkeys.state.notOffered") }
    /// This gateway does not list the address Hermie uses…
    static var originNotListed: String { string("native.passkeys.state.originNotListed") }
    /// Too many attempts. Try again in {n} seconds.
    static func rateLimited(seconds: Int) -> String {
      String(
        localized: "native.passkeys.state.rateLimited", defaultValue: "Too many attempts. Try again in \(seconds) seconds.",
        table: "Native", bundle: .module)
    }
    /// Too many attempts. Try again in a moment.
    static var rateLimitedSoon: String { string("native.passkeys.state.rateLimitedSoon") }
    /// Hermie could not read the passkey settings from this gateway.
    static var unreadable: String { string("native.passkeys.state.unreadable") }
    /// Passkeys are turned off on this gateway.
    static var disabled: String { string("native.passkeys.state.disabled") }
    /// The operator of this gateway has not set an address for passkeys.
    static var noBaseURL: String { string("native.passkeys.state.noBaseURL") }
    /// This gateway is only reachable on a private address…
    static var privateOrigin: String { string("native.passkeys.state.privateOrigin") }
    /// Passkeys need a signed-in account…
    static var noIdentity: String { string("native.passkeys.state.noIdentity") }
    /// This gateway does not accept the passkey identity this version of Hermie uses.
    static var rpNotAccepted: String { string("native.passkeys.state.rpNotAccepted") }
    /// No passkey for this gateway yet…
    static var notEnrolled: String { string("native.passkeys.state.notEnrolled") }
    /// Passkey confirmation is on for this gateway.
    static var enrolled: String { string("native.passkeys.state.enrolled") }
    /// Passkeys of your account
    static var credentialsHeader: String { string("native.passkeys.credentials.header") }
    /// Added {date}
    static func added(_ date: String) -> String {
      String(localized: "native.passkeys.added", defaultValue: "Added \(date)", table: "Native", bundle: .module)
    }
    /// Added at an unknown time
    static var addedUnknown: String { string("native.passkeys.addedUnknown") }
    /// Last used {date}
    static func lastUsed(_ date: String) -> String {
      String(localized: "native.passkeys.lastUsed", defaultValue: "Last used \(date)", table: "Native", bundle: .module)
    }
    /// Never used
    static var neverUsed: String { string("native.passkeys.neverUsed") }
    /// Remove passkey
    static var removeAction: String { string("native.passkeys.remove.action") }
    /// Remove this passkey?
    static var removeTitle: String { string("native.passkeys.remove.title") }
    /// You will be asked for a passkey…
    static var removeMessage: String { string("native.passkeys.remove.message") }
    /// Add with a code
    static var addHeader: String { string("native.passkeys.add.header") }
    /// Code from the gateway's operator
    static var codeField: String { string("native.passkeys.add.field") }
    /// Add passkey
    static var addAction: String { string("native.passkeys.add.action") }
    /// The operator of this gateway gives you a one-time code…
    static var addFooter: String { string("native.passkeys.add.footer") }
    /// Create a code for another device
    static var inviteHeader: String { string("native.passkeys.invite.header") }
    /// Create a code
    static var inviteAction: String { string("native.passkeys.invite.action") }
    /// Use it on the other device or in a browser…
    static var inviteFooter: String { string("native.passkeys.invite.footer") }
    /// The operator of this gateway has turned off creating codes here.
    static var invitesOff: String { string("native.passkeys.invite.off") }
    /// Expires at {time}
    static func inviteExpires(_ time: String) -> String {
      String(localized: "native.passkeys.invite.expires", defaultValue: "Expires at \(time)", table: "Native", bundle: .module)
    }
    /// Copy code
    static var copyCode: String { string("native.passkeys.invite.copy") }
    /// Hide code
    static var hideCode: String { string("native.passkeys.invite.hide") }
    /// That code does not look right…
    static var invalidCode: String { string("native.passkeys.failure.invalidCode") }
    /// That code is not valid, has expired or was already used.
    static var codeNotValid: String { string("native.passkeys.failure.codeNotValid") }
    /// No passkey of yours for this gateway is available…
    static var noPasskeyHere: String { string("native.passkeys.failure.noPasskey") }
    /// See the notice above…
    static var seeNotice: String { string("native.passkeys.failure.seeNotice") }
    /// The gateway's answer was not what Hermie expected.
    static var badAnswer: String { string("native.passkeys.failure.badAnswer") }
    /// Another passkey prompt is open…
    static var promptBusy: String { string("native.passkeys.failure.promptBusy") }
    /// This device cannot use passkeys right now…
    static var cannotUsePasskeys: String { string("native.passkeys.failure.cannotUse") }
    /// The passkey prompt did not finish…
    static var promptFailed: String { string("native.passkeys.failure.promptFailed") }
    /// This passkey is already on this gateway.
    static var alreadyEnrolled: String { string("native.passkeys.failure.alreadyEnrolled") }
    /// Too slow…
    static var tooSlow: String { string("native.passkeys.failure.tooSlow") }
    /// The gateway refused…
    static var refused: String { string("native.passkeys.failure.refused") }

    /// Adding a passkey by signing in again, and the sentence for each reason it may not go ahead.
    enum SelfEnrol {
      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }

      /// Add a passkey
      static var header: String { string("native.passkeys.self.header") }
      /// You will sign in again to prove it is you, then your device creates the passkey.
      static var footer: String { string("native.passkeys.self.footer") }
      /// Step {n} of 2: {title}
      static func stepLabel(_ number: Int, _ title: String) -> String {
        String(
          localized: "native.passkeys.self.step.label", defaultValue: "Step \(number) of 2: \(title)", table: "Native",
          bundle: .module)
      }
      /// Sign in again
      static var step1Title: String { string("native.passkeys.self.step1.title") }
      /// A sign-in sheet for this gateway opens.
      static var step1Idle: String { string("native.passkeys.self.step1.idle") }
      /// Waiting for the sign-in…
      static var step1Waiting: String { string("native.passkeys.self.step1.waiting") }
      /// You signed in again.
      static var step1Done: String { string("native.passkeys.self.step1.done") }
      /// Create the passkey
      static var step2Title: String { string("native.passkeys.self.step2.title") }
      /// Available once you have signed in again.
      static var step2Locked: String { string("native.passkeys.self.step2.locked") }
      /// Your device can now create the passkey.
      static var step2Ready: String { string("native.passkeys.self.step2.ready") }
      /// Waiting for your passkey…
      static var step2Waiting: String { string("native.passkeys.self.step2.waiting") }
      /// The passkey was added.
      static var step2Done: String { string("native.passkeys.self.step2.done") }
      /// Sign in again
      static var signInAction: String { string("native.passkeys.self.signIn.action") }
      /// Create the passkey
      static var createAction: String { string("native.passkeys.self.create.action") }
      /// Add another passkey
      static var anotherAction: String { string("native.passkeys.self.another.action") }
      /// Time left: {m:ss}
      static func timeLeft(_ time: String) -> String {
        String(
          localized: "native.passkeys.self.timeLeft", defaultValue: "Time left: \(time)", table: "Native", bundle: .module)
      }
      /// Time left
      static var timeLeftLabel: String { string("native.passkeys.self.timeLeft.label") }
      /// Less than a minute
      static var lessThanMinute: String { string("native.passkeys.self.timeLeft.lessThanMinute") }
      /// A passkey added this way cannot confirm anything until {duration} after it was added.
      static func coolingOffNotice(_ duration: String) -> String {
        String(
          localized: "native.passkeys.self.coolingOff.notice",
          defaultValue: "A passkey added this way cannot confirm anything until \(duration) after it was added.",
          table: "Native", bundle: .module)
      }
      /// Not usable yet: ready from {date}
      static func credentialCoolingOff(_ date: String) -> String {
        String(
          localized: "native.passkeys.self.credential.coolingOff", defaultValue: "Not usable yet: ready from \(date)",
          table: "Native", bundle: .module)
      }
      /// The sign-in was closed before it finished…
      static var signInClosed: String { string("native.passkeys.self.reason.signInClosed") }
      /// This set-up has expired…
      static var expired: String { string("native.passkeys.self.reason.expired") }
      /// That sign-in was already used for a passkey…
      static var spent: String { string("native.passkeys.self.reason.spent") }
      /// The sign-in did not complete…
      static var notFresh: String { string("native.passkeys.self.reason.notFresh") }
      /// Your identity provider reused an earlier sign-in…
      static var authNotFresh: String { string("native.passkeys.self.reason.authNotFresh") }
      /// Your identity provider does not say when you signed in…
      static var authTimeMissing: String { string("native.passkeys.self.reason.authTimeMissing") }
      /// You signed in as someone else…
      static var userMismatch: String { string("native.passkeys.self.reason.userMismatch") }
      /// You signed in with another sign-in method…
      static var providerMismatch: String { string("native.passkeys.self.reason.providerMismatch") }
      /// That sign-in did not count…
      static var failed: String { string("native.passkeys.self.reason.failed") }
      /// Adding a passkey by signing in again is switched off on this gateway…
      static var disabled: String { string("native.passkeys.self.reason.disabled") }
      /// Your sign-in provider cannot ask you to sign in again…
      static var noReauth: String { string("native.passkeys.self.reason.noReauth") }
      /// Another step of adding the passkey is still running…
      static var busy: String { string("native.passkeys.self.reason.busy") }
      /// This gateway cannot add a passkey by signing in again…
      static var notOffered: String { string("native.passkeys.self.reason.notOffered") }
    }

    enum Notice {
      /// Passkey confirmations are off: this gateway no longer identifies itself…
      static var gatewayIDMismatch: String { string("native.passkeys.notice.gatewayIDMismatch") }
      /// Passkey confirmations are off: this gateway presents an identity that belongs to another gateway.
      static var gatewayIDConflict: String { string("native.passkeys.notice.gatewayIDConflict") }
      /// This gateway presents the same identity as "{name}"…
      static func sameGateway(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.sameGateway",
          defaultValue:
            "This gateway presents the same passkey identity as \u{201C}\(name)\u{201D}, which you added already. If it is the same gateway under another address, link them. Until then its passkey confirmations are off.",
          table: "Native", bundle: .module)
      }
      /// Same gateway as {name}
      static func sameGatewayAction(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.sameGatewayAction", defaultValue: "Same gateway as \(name)", table: "Native",
          bundle: .module)
      }
      /// Hermie could not read the passkey records it keeps for this gateway…
      static var pinUnreadable: String { string("native.passkeys.notice.pinUnreadable") }
      /// This gateway asked for a confirmation in a version this app does not know…
      static var unsupportedVersion: String { string("native.passkeys.notice.unsupportedVersion") }
      /// A confirmation arrived that this device has no passkey for…
      static var noCredentialForApp: String { string("native.passkeys.notice.noCredentialForApp") }
      /// A confirmation arrived that this app could not read…
      static var malformedRequest: String { string("native.passkeys.notice.malformedRequest") }
      /// A confirmation arrived that had already expired…
      static var expiredOnArrival: String { string("native.passkeys.notice.expiredOnArrival") }
      /// A passkey was added to your account on this gateway: {name}
      static func added(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.added",
          defaultValue: "A passkey was added to your account on this gateway without this device: \(name)",
          table: "Native", bundle: .module)
      }
      /// A passkey was removed from your account on this gateway: {name}
      static func revoked(_ name: String) -> String {
        String(
          localized: "native.passkeys.notice.revoked",
          defaultValue: "A passkey was removed from your account on this gateway without this device: \(name)",
          table: "Native", bundle: .module)
      }

      private static func string(_ key: String.LocalizationValue) -> String {
        String(localized: key, table: "Native", bundle: .module)
      }
    }
  }
}
