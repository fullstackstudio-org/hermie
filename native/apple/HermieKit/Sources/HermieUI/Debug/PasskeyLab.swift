#if DEBUG
  import Foundation
  import HermieCore
  @_spi(GatewaySync) import HermieGateway
  import HermieStore
  import SwiftUI

  /// The passkey confirm sheet and the Passkeys page against a fake gateway that verifies passkeys
  /// (`--auth native --passkey`), as a debug screen: the real request area (`answeringRequests`),
  /// the notices, and the real settings page, over a session whose passkey model runs the
  /// authenticator the host hands in (the lab app's software one; no shipped app has any).
  ///
  /// Launch arguments: `-HermieLabGateway <address>` (required), `-HermieLabBot <name>` (default
  /// `researcher`). The lab signs in the way the native sign-in page does, against the fake's
  /// automatic approval, and keeps everything in memory: nothing is written to disk, and the
  /// keychain is never touched.
  public struct PasskeyLabView: View {
    @State private var model: PasskeyLabModel

    public init(authenticator: any PasskeyAuthenticator) {
      _model = State(initialValue: PasskeyLabModel(authenticator: authenticator))
    }

    public var body: some View {
      content
        .task { await model.start() }
        .navigationTitle(model.bot)
        #if os(iOS)
          .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    @ViewBuilder private var content: some View {
      if let session = model.session, let passkeys = session.passkeys, let requests = model.requests {
        List {
          Section {
            Text(model.status(passkeys))
              .accessibilityIdentifier("passkeyLab.status")
            NavigationLink("Passkeys") {
              PasskeysSettingsPage(model: passkeys, gatewayName: "Lab")
            }
            .accessibilityIdentifier("passkeyLab.passkeys")
          }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
          PasskeyNoticesView(model: passkeys)
        }
        .answeringRequests(with: requests)
      } else {
        ContentUnavailableView {
          Label("Passkey lab", systemImage: "key")
        } description: {
          Text(model.failure ?? model.progress)
            .accessibilityIdentifier("passkeyLab.status")
        }
      }
    }
  }

  @MainActor
  @Observable
  final class PasskeyLabModel {
    private(set) var session: GatewaySession?
    private(set) var requests: RequestsModel?
    private(set) var progress = "Starting…"
    private(set) var failure: String?

    @ObservationIgnored let bot = UserDefaults.standard.string(forKey: "HermieLabBot") ?? "researcher"
    @ObservationIgnored private let authenticator: any PasskeyAuthenticator
    @ObservationIgnored private var started = false

    init(authenticator: any PasskeyAuthenticator) {
      self.authenticator = authenticator
    }

    /// What the lab says about the passkey level, for the UI tests to wait on.
    func status(_ passkeys: PasskeyModel) -> String {
      guard let capability = passkeys.capability else {
        return "waiting"
      }

      return capability.passkeyAccepted ? "passkey accepted" : "passkey not accepted: \(capability.verdict)"
    }

    func start() async {
      guard !started else { return }
      started = true

      guard let address = UserDefaults.standard.string(forKey: "HermieLabGateway"), !address.isEmpty else {
        failure = "Launch with -HermieLabGateway http://127.0.0.1:<port> (a fake gateway with --auth native --passkey)."
        return
      }

      do {
        progress = "Signing in…"
        let credentials = try await signIn(address)

        var options = GatewaySession.Options()
        // `-HermiePasskeyName` tells two phones of one account apart on the Passkeys page.
        let name = UserDefaults.standard.string(forKey: "HermiePasskeyName") ?? "Lab phone"
        options.passkey = PasskeySetup(
          configuration: PasskeyConfiguration(rpID: "confirm.hermie.dev", displayName: name),
          authenticator: authenticator
        )
        let record = GatewayRecord(id: "glab-passkeys", name: "Lab", address: address, authKind: .nativePKCE, addedAt: 0)
        let session = try GatewaySession(
          record: record,
          credentials: credentials,
          database: try SQLiteStore(.inMemory),
          options: options
        )
        progress = "Connecting…"
        await session.start()
        try await waitFor("the gateway and \(bot)") {
          session.status.phase == .ready && session.chatList.rows[self.bot] != nil
        }

        try await session.open(bot)
        requests = RequestsModel(session: session, bot: bot)
        self.session = session
      } catch {
        failure = "Could not open \(bot): \(error)"
      }
    }

    /// The native sign-in without a web view, as the integration tests do it: begin, let the fake
    /// approve (`auto=1`), redeem the callback.
    private func signIn(_ address: String) async throws -> NativePKCECredentials {
      let transport = HTTPTransport()
      let probe = try await Probe.probeGateway(address, transport: transport)
      let keys = try GatewaySecretKeys(gatewayID: "lab_passkeys")
      let coordinator = TokenCoordinator(
        store: SecretTokenStore(storage: InMemorySecretStorage(), keys: keys),
        refresh: { held in
          try await NativeAuth.refreshTokens(
            baseURL: address, refreshToken: held.refreshToken, provider: held.provider,
            options: NativeAuth.Options(transport: transport))
        },
        nowSeconds: { Date().timeIntervalSince1970 }
      )
      let credentials = NativePKCECredentials(
        baseURL: address, coordinator: coordinator, canRevoke: probe.supportsNativeRevoke, transport: transport)
      let start = try await credentials.beginSignIn()
      let callback = try await Self.approve(start.authorizeURL + "&auto=1")
      _ = try await credentials.completeSignIn(redirectURL: callback)
      return credentials
    }

    /// The `location` of the gateway's redirect, which is not followed.
    private static func approve(_ url: String) async throws -> String {
      guard let target = URL(string: url) else { throw URLError(.badURL) }
      let (_, response) = try await URLSession.shared.data(for: URLRequest(url: target), delegate: NoRedirects())

      guard let location = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "location") else {
        throw URLError(.badServerResponse)
      }

      return location
    }

    private func waitFor(_ what: String, _ condition: @MainActor () -> Bool) async throws {
      let deadline = ContinuousClock.now + .seconds(30)

      while !condition() {
        guard ContinuousClock.now < deadline else {
          throw PasskeyLabTimeout(what: what)
        }

        try await Task.sleep(for: .milliseconds(50))
      }
    }
  }

  private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
      completionHandler(nil)
    }
  }

  private struct PasskeyLabTimeout: Error, CustomStringConvertible {
    var what: String
    var description: String { "timed out waiting for \(what)" }
  }
#endif
