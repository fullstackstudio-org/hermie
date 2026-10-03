import Foundation
import HermieGateway
import HermieStore
import Synchronization
import Testing

@testable import HermieCore

/// The app's one live session: it follows the registry's active gateway once the launch is ready,
/// shuts the old session down before it builds the next, rebuilds on a change of credentials, and
/// says when there is nothing to sign in with.
@MainActor
@Suite("Live gateway")
struct LiveGatewayTests {
  /// A launch on memory with two gateways added through the engine, the first active.
  @MainActor
  struct Fixture {
    let launch: AppLaunch
    let accounts: GatewayAccounts
    let first: String
    let second: String

    init(firstToken: String? = "first-token", secondToken: String? = "second-token") async throws {
      launch = AppLaunch(environment: .inMemory(dataDirectory: nil, authenticator: ScriptedAuthenticator()))
      accounts = GatewayAccounts(launch: launch, services: GatewayServices())
      await launch.start()
      first = try await launch.sync.addGateway(
        NewGateway(name: "First", address: "http://127.0.0.1:1", authKind: .sessionToken, sessionToken: firstToken))
      second = try await launch.sync.addGateway(
        NewGateway(name: "Second", address: "http://127.0.0.1:2", authKind: .sessionToken, sessionToken: secondToken))
      await launch.gateways.load()
    }
  }

  /// Sessions over scripted links, one per gateway opened, in order.
  final class Built: Sendable {
    let sessions = Mutex<[String]>([])
  }

  static func scripted(_ built: Built) -> LiveGateway.Connector {
    { record in
      built.sessions.withLock { $0.append(record.id) }
      return GatewaySession(gatewayID: record.id, link: ScriptedLink())
    }
  }

  @Test("follows the active gateway, waits for the launch, and shuts the old session down first")
  func followsTheActiveGateway() async throws {
    let fixture = try await Fixture()
    let built = Built()
    let ready = Mutex(false)
    let live = LiveGateway(
      directory: fixture.launch.gateways,
      connector: Self.scripted(built),
      ready: { ready.withLock { $0 } }
    )

    live.start()
    try await Task.sleep(for: .milliseconds(50))
    #expect(built.sessions.withLock { $0 }.isEmpty, "nothing is read before the launch is ready")

    // The flag is not observable here, so the change of the active gateway re-reads it.
    ready.withLock { $0 = true }
    try await fixture.launch.gateways.activate(id: fixture.second)
    try await eventually("the second session") { await MainActor.run { live.session?.gatewayID == fixture.second } }
    let second = try #require(live.session)

    try await fixture.launch.gateways.activate(id: fixture.first)
    try await eventually("the first session") { await MainActor.run { live.session?.gatewayID == fixture.first } }

    #expect(await second.hasNoLiveTasks(), "the previous session is shut down")
    #expect(built.sessions.withLock { $0 } == [fixture.second, fixture.first])

    await live.shutdown()
    #expect(live.session == nil)
    #expect(live.phase == .none)
  }

  @Test("the accounts connector reads the credentials through the engine and needs one")
  func accountsConnector() async throws {
    let fixture = try await Fixture(secondToken: nil)
    let connect = LiveGateway.accountsConnector(launch: fixture.launch, accounts: fixture.accounts)
    let registry = try await fixture.launch.gateways.store.load()

    let first = try #require(registry.gateway(id: fixture.first))
    let second = try #require(registry.gateway(id: fixture.second))

    let session = try await connect(first)
    #expect(session?.gatewayID == fixture.first)
    #expect(session?.passkeys == nil, "no passkey setup on the launch: no confirm level")
    #expect(try await connect(second) == nil, "no token stored")
  }

  @Test("the accounts connector gives every session the launch's passkey setup")
  func accountsConnectorPasskeys() async throws {
    let fixture = try await Fixture()
    let authenticator = SystemPasskeyAuthenticator(anchor: { nil })

    fixture.launch.passkey = .live(
      configuration: PasskeyConfiguration(rpID: "confirm.hermie.dev"),
      authenticator: authenticator,
      lock: fixture.launch.lock,
      keyValues: fixture.launch.keyValues
    )

    let connect = LiveGateway.accountsConnector(launch: fixture.launch, accounts: fixture.accounts)
    let record = try #require(try await fixture.launch.gateways.store.load().gateway(id: fixture.first))
    let session = try #require(try await connect(record))
    let passkeys = try #require(session.passkeys)

    #expect(passkeys.configuration.rpID == "confirm.hermie.dev")
    await session.shutdown()
  }

  @Test("a sign-out ends the session and the revision bump leaves it signed out")
  func signOutEndsTheSession() async throws {
    let fixture = try await Fixture()
    let live = LiveGateway(launch: fixture.launch, accounts: fixture.accounts)

    live.start()
    try await eventually("the session") { await MainActor.run { live.phase == .live } }
    let session = try #require(live.session)

    await fixture.accounts.signOut(fixture.first)
    try await eventually("signed out") { await MainActor.run { live.phase == .signedOut } }
    #expect(live.session == nil)
    #expect(await session.hasNoLiveTasks(), "the signed-out session is shut down")
    await live.shutdown()
  }

  @Test("following the same gateway with the same credentials keeps the session")
  func sameGatewayKeepsTheSession() async throws {
    let fixture = try await Fixture()
    let built = Built()
    let live = LiveGateway(directory: fixture.launch.gateways, connector: Self.scripted(built))

    await live.follow(fixture.first)
    let session = try #require(live.session)
    await live.follow(fixture.first)
    #expect(live.session === session)
    #expect(built.sessions.withLock { $0.count } == 1)
    await live.shutdown()
  }
}
