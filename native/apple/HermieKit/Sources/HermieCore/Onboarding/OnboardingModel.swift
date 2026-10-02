import Foundation
import HermieGateway
import HermieProtocol
import HermieStore
import Observation

/**
 Setting up a gateway, and signing in to one again: the state behind the wizard and the sign-in sheet
 (the port of `features/onboarding/draft.ts` and its steps).

 **Address.** What is typed is probed after a pause (`Probe.resolveGatewayAddress`: https first, http
 only when no scheme was typed). A late answer for an older address is dropped. A failure carries
 what the classifier makes of it (`ProbeVerdict`): the redirect target to offer, the front door to
 open, the private-network hint. A plain-http address on a public host has to be confirmed before
 the wizard moves on (ADR-0014); one on a private network is only described.

 **Sign-in.** An ungated gateway takes its session token, which is checked against `/api/profiles`.
 A gated one signs in with native PKCE, in the system browser with the loopback listener, or in the
 in-app page as the fallback; the tokens are checked with `/api/auth/me`, which also says who signed in.

 **Nothing is stored until the end.** Tokens live in an in-memory token store until `finish()`, which
 writes the secrets to the keychain, then the registry entry and the config in one transaction, and
 activates the gateway. Abandoning the wizard (or finishing it) wipes every secret it held.
 */
@MainActor
@Observable
public final class OnboardingModel {
  public enum Mode: Sendable, Equatable {
    /// A new gateway.
    case newGateway
    /// Sign in again to one that is configured: the address and the way in are kept.
    case signIn(gatewayId: String)
  }

  /// The steps after the first. The first is the address for a new gateway and sign-in otherwise.
  public enum Step: Hashable, Sendable {
    case signIn
    case name
    case done
  }

  public enum FrontDoorKind: String, Sendable, CaseIterable {
    case custom
    case cloudflareAccess
  }

  public struct HeaderRow: Identifiable, Equatable, Sendable {
    public let id: Int
    public var name: String
    public var value: String
  }

  public enum HeaderProblem: Sendable, Equatable {
    case invalidName
    /// A header Hermie sets itself.
    case reserved
  }

  public struct ProbeFailure: Sendable, Equatable {
    /// nil for an error that is not a `GatewayError` (it is not expected).
    public var kind: GatewayErrorKind?
    /// The client's own message, for `config` errors, which phrase the typed address precisely.
    public var message: String
    public var status: Int?
    /// The bare host of the address that was probed.
    public var host: String
    /// `https://` was typed, so http was never tried.
    public var httpsWasPinned: Bool
    public var verdict: ProbeVerdict
    public var redirectedTo: String?
    public var redirectedOrigin: String?
  }

  public enum ProbeState: Sendable, Equatable {
    case idle
    /// `pinnedScheme` is the scheme that was typed (`https://`), or nil when both are being tried.
    case checking(pinnedScheme: String?)
    case found(OnboardingProbe)
    case failed(ProbeFailure)
  }

  public enum SignInState: Sendable, Equatable {
    case idle
    case inBrowser
    case inApp
    /// The credential is being checked against the gateway.
    case checking
    case signedIn
    case failed(SignInProblem)
  }

  public enum SaveProblem: Sendable, Equatable {
    /// The keychain refused; nothing was stored.
    case keychain
    /// The list on this device was written by a newer Hermie and is left alone.
    case unsupportedRegistry
    /// The local database refused; nothing was stored.
    case store
    /// Signing in again: the gateway was removed meanwhile. Nothing was stored.
    case gatewayRemoved
    /// Signing in again: the gateway now answers at another address. Nothing was stored.
    case addressChanged
  }

  public enum SaveState: Sendable, Equatable {
    case idle
    case saving
    case failed(SaveProblem)
  }

  public let mode: Mode
  public let accounts: GatewayAccounts

  // MARK: Address

  public var address = "" {
    didSet {
      if address != oldValue {
        addressEdited()
      }
    }
  }

  public var advancedShown = false

  public var frontDoorKind: FrontDoorKind = .custom {
    didSet {
      if frontDoorKind != oldValue {
        if frontDoorKind == .custom {
          // Leaving the preset drops the pair, so a secret switched off is not saved later.
          accessClientID = ""
          accessClientSecret = ""
        }

        accessChanged()
      }
    }
  }

  public var accessClientID = "" {
    didSet {
      if accessClientID != oldValue {
        accessChanged()
      }
    }
  }

  public var accessClientSecret = "" {
    didSet {
      if accessClientSecret != oldValue {
        accessChanged()
      }
    }
  }

  public var headers: [HeaderRow] = [] {
    didSet {
      if headers != oldValue {
        accessChanged()
      }
    }
  }

  public private(set) var probe: ProbeState = .idle

  // MARK: Sign-in

  /// The provider picked from the list; nil picks the only one there is.
  public var selectedProvider: String? {
    didSet {
      if selectedProvider != oldValue {
        resetSignIn()
      }
    }
  }

  public var sessionToken = "" {
    didSet {
      if sessionToken != oldValue, authMode == .sessionToken {
        resetSignIn()
      }
    }
  }

  public private(set) var signIn: SignInState = .idle
  /// Who `/api/auth/me` says signed in, once a native sign-in has been checked.
  public private(set) var identity: AuthIdentity?
  /// The in-app page in progress, for the view to show.
  public private(set) var inAppAttempt: InAppSignInAttempt?

  // MARK: Name and saving

  public var name = ""
  public var path: [Step] = []
  public private(set) var saveState: SaveState = .idle
  /// Resume mode: the stored gateway could not be read.
  public private(set) var loadFailed = false
  /// Resume mode: the address the gateway is stored under, which signing in again must not change.
  @ObservationIgnored private var storedAddress: String?
  @ObservationIgnored private var loadStarted = false

  // MARK: Private

  @ObservationIgnored private var confirmedCleartextFor: String?
  @ObservationIgnored private var tokens: TokenSet?
  @ObservationIgnored private var draftCoordinator: TokenCoordinator?
  /// The draft coordinator's address and headers: a change of either starts a new one.
  @ObservationIgnored private var draftKey: String?
  @ObservationIgnored private var probeTask: Task<Void, Never>?
  @ObservationIgnored private var signInTask: Task<Void, Never>?
  @ObservationIgnored private var inAppTimer: Task<Void, Never>?
  /// The listener of the browser sign-in in progress, so the app can ask it to listen again.
  @ObservationIgnored private var activeListener: (any LoopbackCallbackListening)?
  @ObservationIgnored private var probeTicket = 0
  @ObservationIgnored private var signInTicket = 0
  @ObservationIgnored private var nextHeaderID = 0
  /// Set once the flow ended: the fields are being wiped and must not start anything.
  @ObservationIgnored private var closed = false

  private var services: GatewayServices { accounts.services }

  public init(mode: Mode, accounts: GatewayAccounts) {
    self.mode = mode
    self.accounts = accounts
  }

  // MARK: - Reading the state

  public var resolved: OnboardingProbe? {
    if case .found(let found) = probe { found } else { nil }
  }

  public var baseURL: String? { resolved?.baseURL }

  /// How this app signs in to the probed gateway.
  public var authMode: GatewayAuthMode { resolved?.result.authMode ?? .sessionToken }

  public var providers: [AuthProvider] { resolved?.result.providers ?? [] }

  /// The provider a sign-in uses: the chosen one, or the only one.
  public var provider: AuthProvider? {
    let list = providers

    if let selectedProvider, let chosen = list.first(where: { $0.name == selectedProvider }) {
      return chosen
    }

    return list.count == 1 ? list.first : nil
  }

  /// The custom headers as they travel: named rows only, valid ones only.
  public var customHeaders: [String: String] {
    var record: [String: String] = [:]

    for row in headers where !row.name.trimmingCharacters(in: .whitespaces).isEmpty {
      if let header = try? GatewayAddress.normalizeHeader(name: row.name, value: row.value) {
        record[header.name] = header.value
      }
    }

    return record
  }

  public func headerProblem(_ row: HeaderRow) -> HeaderProblem? {
    let name = row.name.trimmingCharacters(in: .whitespaces)

    guard !name.isEmpty else {
      return nil
    }

    if GatewayAddress.isBlockedHeaderName(name) {
      return .reserved
    }

    return (try? GatewayAddress.normalizeHeader(name: row.name, value: row.value)) == nil ? .invalidName : nil
  }

  /// The preset as it travels, bound to the address being set up.
  public var frontDoor: FrontDoor {
    guard frontDoorKind == .cloudflareAccess else {
      return .none
    }

    let origin = GatewayAddress.origin(of: baseURL ?? normalizedAddress ?? "")

    return .cloudflareAccess(.init(clientID: accessClientID, clientSecret: accessClientSecret, origin: origin))
  }

  /// A complete front door that is not being sent, because the gateway is reached in the clear.
  public var frontDoorWithheld: Bool {
    frontDoor.isWithheld(for: baseURL ?? normalizedAddress ?? "")
  }

  /// Everything that goes on the wire beside the credential.
  public var wireHeaders: [String: String] {
    GatewaySecrets.wireHeaders(custom: customHeaders, frontDoor: frontDoor, baseURL: baseURL ?? "")
  }

  /// The privacy class of a cleartext address, or nil when it is not cleartext.
  public var cleartextPrivacy: HostPrivacy? {
    guard let baseURL, baseURL.lowercased().hasPrefix("http://") else {
      return nil
    }

    return HostClassification.of(baseURL).privacy
  }

  /// Plain http to a public host: the wizard asks before it goes on (ADR-0014).
  public var needsCleartextConfirmation: Bool {
    baseURL.map(HostClassification.isExposedCleartext) ?? false
  }

  public var cleartextConfirmed: Bool {
    get { baseURL != nil && confirmedCleartextFor == baseURL }
    set { confirmedCleartextFor = newValue ? baseURL : nil }
  }

  public var canLeaveAddress: Bool {
    resolved != nil && (!needsCleartextConfirmation || cleartextConfirmed)
  }

  /// A gated gateway this app can sign in to: native PKCE advertised, and a provider to use.
  public var canSignInWithProvider: Bool {
    guard let resolved, resolved.result.authMode == .nativePKCE, resolved.result.supportsNativePKCE else {
      return false
    }

    return provider != nil
  }

  /// Headers go on the wire that a browser cannot send (custom headers, the Access pair): the in-app
  /// page, which can, is the way to sign in.
  public var needsInAppSignIn: Bool {
    !wireHeaders.isEmpty
  }

  /// The browser could still get through: only the Access pair is missing from it, and an Access
  /// policy may let a person sign in interactively. Custom headers it can never send.
  public var browserMightWork: Bool {
    customHeaders.isEmpty
  }

  /// Whether the sign-in step can move on.
  public var canLeaveSignIn: Bool {
    switch authMode {
    case .sessionToken:
      return !sessionToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && signIn != .checking
    case .nativePKCE:
      return signIn == .signedIn && tokens != nil
    case .cookie:
      return false
    }
  }

  /// The name a gateway gets when none is typed: its host.
  public var defaultName: String {
    GatewayRegistry.defaultName(for: baseURL ?? address)
  }

  private var normalizedAddress: String? {
    try? GatewayAddress.normalizeBaseURL(address.trimmingCharacters(in: .whitespacesAndNewlines))
  }

  // MARK: - Address actions

  /// Point the wizard at where a redirect went, scheme and port included.
  public func useRedirectTarget(_ target: String) {
    address = target
  }

  /// Open Advanced on the Cloudflare Access preset, the usual answer to a 401 or 403 from a proxy.
  public func openFrontDoor() {
    advancedShown = true

    if frontDoorKind == .custom {
      frontDoorKind = .cloudflareAccess
    }
  }

  /// Type the same address again with `https://`, which is never downgraded.
  public func useHTTPS() {
    let current = baseURL ?? address.trimmingCharacters(in: .whitespacesAndNewlines)
    let bare = current.range(of: "://").map { String(current[$0.upperBound...]) } ?? current

    address = "https://" + bare
  }

  public func addHeader() {
    nextHeaderID += 1
    headers.append(HeaderRow(id: nextHeaderID, name: "", value: ""))
  }

  public func removeHeader(_ id: Int) {
    headers.removeAll { $0.id == id }
  }

  /// Leave the address step.
  public func continueFromAddress() {
    guard canLeaveAddress else {
      return
    }

    path = [.signIn]
  }

  /// Probe again now, without the pause (a retry button).
  public func probeAgain() {
    scheduleProbe(debounce: false)
  }

  private func addressEdited() {
    guard !closed else {
      return
    }

    confirmedCleartextFor = nil
    scheduleProbe(debounce: true)
  }

  private func accessChanged() {
    guard !closed else {
      return
    }

    scheduleProbe(debounce: true)
  }

  private func scheduleProbe(debounce: Bool) {
    probeTicket += 1
    probeTask?.cancel()

    let ticket = probeTicket
    let raw = address.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !raw.isEmpty else {
      apply(.idle)
      return
    }

    let normalized: String

    do {
      normalized = try GatewayAddress.normalizeBaseURL(raw)
    } catch {
      apply(.failed(Self.failure(error, raw: raw, normalized: raw)))
      return
    }

    let pinned: String? =
      GatewayAddress.hasExplicitScheme(raw)
      ? raw.range(of: "://").map { String(raw[..<$0.upperBound]).lowercased() } : nil
    let custom = customHeaders
    let door = frontDoor
    let services = services

    probe = .checking(pinnedScheme: pinned)

    probeTask = Task { [weak self] in
      if debounce {
        do {
          try await services.sleep(services.probeDebounce)
        } catch {
          return
        }
      }

      let outcome: ProbeState

      do {
        outcome = .found(try await services.resolve(raw, custom, door))
      } catch {
        outcome = .failed(Self.failure(error, raw: raw, normalized: normalized))
      }

      guard let self, !Task.isCancelled, ticket == self.probeTicket, !self.closed else {
        return
      }

      self.apply(outcome)
    }
  }

  private func apply(_ next: ProbeState) {
    let before = baseURL

    probe = next

    // A different gateway: who you are on the old one means nothing here.
    if baseURL != before {
      resetSignIn()
    }
  }

  static func failure(_ error: any Error, raw: String, normalized: String) -> ProbeFailure {
    let gatewayError = error as? GatewayError

    return ProbeFailure(
      kind: gatewayError?.kind,
      message: gatewayError?.message ?? "",
      status: gatewayError?.status,
      host: HostClassification.host(ofAddress: normalized),
      httpsWasPinned: GatewayAddress.hasExplicitScheme(raw) && normalized.lowercased().hasPrefix("https://"),
      verdict: ProbeVerdict.classify(error, address: normalized),
      redirectedTo: gatewayError?.redirectedTo,
      redirectedOrigin: gatewayError?.redirectedOrigin
    )
  }

  // MARK: - Resume

  /// Resume mode: read the stored gateway (address, provider, the way in) and probe it.
  public func load() async {
    // Once: the sheet that calls this is built again after every unlock.
    guard case .signIn(let id) = mode, !loadStarted else {
      return
    }

    loadStarted = true

    guard let access = try? await accounts.access(for: id) else {
      loadFailed = true
      loadStarted = false
      return
    }

    loadFailed = false

    for (name, value) in access.secrets.customHeaders.sorted(by: { $0.key < $1.key }) {
      nextHeaderID += 1
      headers.append(HeaderRow(id: nextHeaderID, name: name, value: value))
    }

    if case .cloudflareAccess(let stored) = access.secrets.frontDoor {
      frontDoorKind = .cloudflareAccess
      accessClientID = stored.clientID
      accessClientSecret = stored.clientSecret
    }

    advancedShown = !headers.isEmpty || frontDoorKind != .custom
    storedAddress = access.baseURL
    selectedProvider = access.config?.provider
    name = accounts.directory.entry(id: id)?.name ?? ""
    address = access.baseURL
    // A stored address was confirmed when it was added.
    scheduleProbe(debounce: false)
  }

  // MARK: - Sign-in actions

  /// Sign in through the system browser and the loopback listener.
  public func startBrowserSignIn(presenter: any BrowserSessionPresenting) {
    guard let baseURL, canSignInWithProvider, !closed else {
      return
    }

    cancelSignIn()
    signInTicket += 1

    let ticket = signInTicket
    let credentials = nativeCredentials(baseURL: baseURL)
    let provider = provider?.name
    let services = services
    let listener = services.makeListener()
    // One browser sign-in at a time in this process (one port): a new one, from this window or
    // another, ends the one before and waits until its listener has let go of the port.
    let gate = services.browserGate
    let previous = gate.current

    previous?.cancel()
    activeListener = listener
    signIn = .inBrowser

    let task = Task { [weak self] in
      await previous?.value

      let result: Result<TokenSet, SignInProblem> =
        Task.isCancelled
        ? .failure(.cancelled)
        : await BrowserSignIn.run(
          credentials: credentials,
          provider: provider,
          listener: listener,
          presenter: presenter,
          timeout: services.signInTimeout,
          sleep: services.sleep
        )

      guard let self, ticket == self.signInTicket else {
        return
      }

      self.activeListener = nil
      await self.signInEnded(result)
    }

    signInTask = task
    gate.current = task
  }

  /**
   The app is in front again. On iOS a suspended app's listening socket can be reclaimed while the
   browser sheet is up (the person went to another app for a one-time code, say); listen again, on
   the same port, for the same attempt. Nothing happens when nothing is listening.
   */
  public func appBecameActive() async {
    await activeListener?.resume()
  }

  /// Whether a browser sign-in is waiting for its callback.
  public var isWaitingForBrowser: Bool {
    signIn == .inBrowser
  }

  /// Sign in inside Hermie instead: the fallback page. The view shows `inAppAttempt`.
  public func startInAppSignIn() {
    guard let baseURL, canSignInWithProvider, !closed else {
      return
    }

    cancelSignIn()
    signInTicket += 1

    let ticket = signInTicket
    let credentials = nativeCredentials(baseURL: baseURL)
    let provider = provider?.name
    let headers = wireHeaders
    let door = frontDoor
    let services = services

    signIn = .inApp
    signInTask = Task { [weak self] in
      let attempt = await InAppSignInAttempt.begin(
        credentials: credentials,
        provider: provider,
        headers: headers,
        frontDoor: door
      ) { [weak self] result in
        guard let self, ticket == self.signInTicket else {
          return
        }

        self.inAppTimer?.cancel()
        self.inAppAttempt = nil
        Task { await self.signInEnded(result) }
      }

      guard let self, ticket == self.signInTicket else {
        return
      }

      guard let attempt else {
        self.signIn = .failed(.couldNotStart)
        return
      }

      self.inAppAttempt = attempt
      self.inAppTimer = Task { [weak attempt] in
        do {
          try await services.sleep(services.signInTimeout)
        } catch {
          return
        }

        attempt?.cancel(.timedOut)
      }
    }
  }

  /// Stop whatever sign-in is in progress. A browser sheet is dismissed, the listener stopped.
  public func cancelSignIn() {
    signInTicket += 1
    activeListener = nil
    signInTask?.cancel()
    signInTask = nil
    inAppTimer?.cancel()
    inAppTimer = nil
    inAppAttempt?.cancel()
    inAppAttempt = nil

    if signIn == .inBrowser || signIn == .inApp || signIn == .checking {
      signIn = .idle
    }
  }

  /// Check the credential again after a check failed (the tokens are kept).
  public func retryCheck() async {
    guard tokens != nil else {
      return
    }

    await checkNativeSignIn()
  }

  /// Leave the sign-in step: a session token is checked first; a native sign-in already was.
  /// In resume mode this is the end of the flow and saves. Answers the saved gateway id then.
  @discardableResult
  public func continueFromSignIn() async -> String? {
    switch authMode {
    case .sessionToken:
      guard canLeaveSignIn else {
        return nil
      }

      await checkSessionToken()
    case .nativePKCE:
      break
    case .cookie:
      return nil
    }

    guard signIn == .signedIn else {
      return nil
    }

    if case .signIn = mode {
      return await finish()
    }

    if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      name = defaultName
    }

    path = [.signIn, .name]
    return nil
  }

  public func continueFromName() {
    path = [.signIn, .name, .done]
  }

  private func signInEnded(_ result: Result<TokenSet, SignInProblem>) async {
    switch result {
    case .success(let fresh):
      tokens = fresh
      await checkNativeSignIn()
    case .failure(.cancelled):
      signIn = .idle
    case .failure(let problem):
      signIn = .failed(problem)
    }
  }

  /// `/api/auth/me` with the fresh tokens: proves them, and says who signed in.
  private func checkNativeSignIn() async {
    guard let baseURL, let coordinator = draftCoordinator else {
      return
    }

    signIn = .checking

    let ticket = signInTicket
    let headers = wireHeaders

    do {
      let credentials = NativePKCECredentials(
        baseURL: baseURL,
        coordinator: coordinator,
        extraHeaders: headers,
        transport: services.transport
      )
      let client = try HTTPClient(baseURL: baseURL, credentials: credentials, extraHeaders: headers, transport: services.transport)
      let me = try await client.authMe()
      // The check may have rotated the tokens; the ones to keep are the coordinator's now.
      let current = try await coordinator.current()

      guard ticket == signInTicket else {
        return
      }

      identity = me
      tokens = current ?? tokens
      signIn = tokens == nil ? .failed(.rejected) : .signedIn
    } catch {
      guard ticket == signInTicket else {
        return
      }

      signIn = .failed(.checking(error))
    }
  }

  /// `GET /api/profiles` with the session token, which an ungated gateway answers only when it is right.
  private func checkSessionToken() async {
    guard let baseURL else {
      return
    }

    signIn = .checking

    let ticket = signInTicket
    let token = sessionToken.trimmingCharacters(in: .whitespacesAndNewlines)

    do {
      let client = try HTTPClient(
        baseURL: baseURL,
        credentials: SessionTokenCredentials(token: token),
        extraHeaders: wireHeaders,
        transport: services.transport
      )

      _ = try await client.get(RESTPath.profiles)

      guard ticket == signInTicket else {
        return
      }

      signIn = .signedIn
    } catch {
      guard ticket == signInTicket else {
        return
      }

      signIn = .failed(.checking(error))
    }
  }

  /// Credentials over an in-memory token store: nothing reaches the keychain before `finish()`.
  /// Credentials of their own for each attempt, over one in-memory coordinator: nothing reaches the
  /// keychain before `finish()`, and an attempt that is still cleaning up can only end itself, never
  /// the next one's pending verifier.
  private func nativeCredentials(baseURL: String) -> NativePKCECredentials {
    let headers = wireHeaders
    let key = baseURL + "\n" + GatewaySecrets.encodeExtraHeaders(headers)

    if draftCoordinator == nil || draftKey != key {
      draftCoordinator = services.tokenCoordinator(store: MemoryTokenStore(), baseURL: baseURL, headers: headers)
      draftKey = key
    }

    return NativePKCECredentials(
      baseURL: baseURL,
      coordinator: draftCoordinator!,
      extraHeaders: headers,
      transport: services.transport
    )
  }

  private func resetSignIn() {
    cancelSignIn()

    if let coordinator = draftCoordinator {
      Task { try? await coordinator.clear() }
    }

    tokens = nil
    identity = nil
    draftCoordinator = nil
    draftKey = nil
    signIn = .idle
  }

  // MARK: - Finishing

  /**
   Store the gateway and activate it. The secrets go first, through `GatewaySecrets.save` (which
   deletes all six again when any write fails); then the registry entry and the config, in one
   transaction; a failure there takes the secrets of a new gateway back out. Answers the gateway's
   id, or nil with `saveState` saying why.
   */
  public func finish() async -> String? {
    guard let resolved, signIn == .signedIn, saveState != .saving, !closed else {
      return nil
    }

    let mode = authMode
    let id: String
    let existing: Bool

    switch self.mode {
    case .newGateway:
      id = GatewayRegistry.newGatewayId()
      existing = false
    case .signIn(let gatewayId):
      id = gatewayId
      existing = true
    }

    guard let keys = try? GatewaySecretKeys(gatewayID: id) else {
      saveState = .failed(.store)
      return nil
    }

    // Signing in again keeps the gateway where it is: an address that now resolves elsewhere (a
    // redirect taken, an http fallback) is a different gateway, set up as one.
    if existing, resolved.baseURL != storedAddress {
      saveState = .failed(.addressChanged)
      return nil
    }

    saveState = .saving

    let held = mode == .nativePKCE ? ((try? await draftCoordinator?.current()) ?? tokens) : nil

    guard mode != .nativePKCE || held != nil else {
      saveState = .idle
      signIn = .failed(.rejected)
      return nil
    }

    let baseURL = resolved.baseURL
    let custom = customHeaders
    let door = frontDoor
    let token = mode == .sessionToken ? sessionToken.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    let user = mode == .nativePKCE ? Self.displayName(identity, tokens: held) : nil
    let config = StoredGatewayConfig(
      baseUrl: baseURL,
      authMode: mode,
      provider: mode == .nativePKCE ? provider?.name : nil,
      providerDisplayName: mode == .nativePKCE ? provider?.displayName : nil,
      version: resolved.result.version.isEmpty ? nil : resolved.result.version,
      userDisplayName: user,
      userEmail: identity.flatMap { $0.email.isEmpty ? nil : $0.email },
      userPictureUrl: identity.flatMap { $0.pictureURL.isEmpty ? nil : $0.pictureURL }
    )
    let storage = services.secrets

    do {
      try await services.offMain {
        if existing {
          // A credential of the other mode must not survive next to the new one.
          for key in [keys.accessToken, keys.refreshToken, keys.tokenMeta, keys.sessionToken] {
            try storage.delete(key)
          }
        }

        try GatewaySecrets.save(
          storage: storage,
          keys: keys,
          baseURL: baseURL,
          customHeaders: custom,
          frontDoor: door,
          tokens: held,
          sessionToken: token
        )
      }
    } catch {
      saveState = .failed(.keychain)
      return nil
    }

    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let record = GatewayRecord(
      id: id,
      name: trimmedName.isEmpty ? GatewayRegistry.defaultName(for: baseURL) : trimmedName,
      address: baseURL,
      authKind: GatewayAuthKind(rawValue: mode.rawValue),
      signedInUser: user,
      addedAt: services.nowMilliseconds()
    )
    let configText: String

    do {
      configText = try config.encoded()
    } catch {
      saveState = .failed(.store)
      return nil
    }

    do {
      if existing {
        try await GatewayRegistration.signedIn(
          id: id,
          authKind: record.authKind,
          signedInUser: record.signedInUser,
          config: configText,
          in: services.store
        )
      } else {
        try await GatewayRegistration.add(record, config: configText, in: services.store)
      }
    } catch {
      // Nothing may stay behind for a gateway the list does not name: a new one never made it in,
      // and one signed in to again may have been removed meanwhile.
      if !existing || error is GatewayRegistrationError {
        _ = try? await services.offMain { try GatewaySecrets.clearCredentials(storage: storage, keys: keys) }
      }

      saveState = .failed(
        error is GatewayRegistryError ? .unsupportedRegistry : error is GatewayRegistrationError ? .gatewayRemoved : .store
      )
      return nil
    }

    if !existing {
      try? await accounts.directory.activate(id: id)
    }

    accounts.credentialsChanged(id, signedIn: true)
    saveState = .idle
    close()
    return id
  }

  /// The flow is over (finished or abandoned): stop everything and forget every secret it held.
  public func close() {
    guard !closed else {
      return
    }

    closed = true
    probeTask?.cancel()
    resetSignIn()
    sessionToken = ""
    accessClientSecret = ""
    accessClientID = ""
    headers = []
  }

  static func displayName(_ identity: AuthIdentity?, tokens: TokenSet?) -> String? {
    let candidates = [identity?.displayName, identity?.email, identity?.userID, tokens?.userID]

    return candidates.compactMap { $0 }.first { !$0.isEmpty }
  }
}
