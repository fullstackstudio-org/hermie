import Foundation
import HermieGateway
import HermieProtocol
import HermieStore

/// The two calls the sync makes (`profiles.list`, `profiles.configure`), as one
/// function, so a test can hand over a closure and production a connection.
public struct UIMetaGateway: Sendable {
  public let request: @Sendable (_ method: String, _ params: JSONObject) async throws -> JSONValue

  public init(request: @escaping @Sendable (_ method: String, _ params: JSONObject) async throws -> JSONValue) {
    self.request = request
  }

  /// Over a session's link (`GatewaySession`'s runtime seam).
  public static func link(_ link: any GatewayLink) -> UIMetaGateway {
    UIMetaGateway { method, params in
      try await link.requestReply(method, params: .object(params)).result
    }
  }

  /// Over a bare connection.
  public static func connection(_ connection: GatewayConnection) -> UIMetaGateway {
    UIMetaGateway { method, params in
      try await connection.request(method, params: .object(params))
    }
  }
}

/// One concern's part in the app section (settings, the chat list, the push
/// rows): how it folds an arriving copy and what it takes out of it.
///
/// This is the seam later concerns plug into without the core changing: each
/// edits its own fields with `UIMetaSync.updateApp` / `updateBot` and reads them
/// back here. The sync holds a contributor weakly: whoever builds one owns it.
public protocol UIMetaContributor: AnyObject, Sendable {
  /// Adjust the app section a gateway's copy produced, for the fields this
  /// concern owns. Pure: it runs under the sync's lock and must not call back
  /// into the sync. (This device's push rows are folded by the sync itself;
  /// see `UIMetaSync.setPushRow`.)
  func merge(app: inout JSONObject, arriving snapshot: UIMetaSnapshot)

  /// The gateway's copy has been taken in: hand this concern's fields to its
  /// store. Read them from `UIMetaSync.app` / `bot(_:)` at the time of the
  /// call, not from `documents`: an edit can land between the take and this
  /// call, and `documents` is the copy from before it.
  ///
  /// Awaited before the sync sends anything, as the reference applies before it
  /// flushes, and on a conflict from INSIDE the running flush. So it must not
  /// await `flush()`, `settle()` or `reconcile()` (that would wait on itself);
  /// an edit through `updateApp` / `updateBot` is fine, it is sent by the same
  /// run. It must not report the fields it applies back as a local change
  /// (`UIMetaSettingsBridge` shows how: deaf while it applies, diffing against
  /// what it applied).
  func didApply(_ documents: UIMetaDocuments, snapshot: UIMetaSnapshot) async
}

extension UIMetaContributor {
  public func merge(app: inout JSONObject, arriving snapshot: UIMetaSnapshot) {}
}

/// What survives a relaunch: the device's copy without the push rows, whose it
/// is, and which sections had not reached the gateway yet.
public struct UIMetaStoredCopy: Sendable, Hashable, Codable {
  /// The sections, `push` removed (`UIMetaDocuments.persistable`).
  public var documents: UIMetaDocuments
  /// The person the app section belongs to; another person never inherits it.
  public var owner: String?
  /// The gateway the copy belongs to, when the caller named one.
  public var gateway: String?
  /// Sections changed here and not yet taken by the gateway.
  public var pendingApp: Bool
  public var pendingBots: [String]

  public init(
    documents: UIMetaDocuments,
    owner: String? = nil,
    gateway: String? = nil,
    pendingApp: Bool = false,
    pendingBots: [String] = []
  ) {
    self.documents = documents
    self.owner = owner
    self.gateway = gateway
    self.pendingApp = pendingApp
    self.pendingBots = pendingBots
  }
}

/// Where the device's copy of its sections lives between launches.
///
/// It is what makes a change made with no gateway survive a relaunch, with its
/// dirty marks and its date (a local section dated later than the gateway's is
/// an unsent change even when no mark survived).
public protocol UIMetaPersistence: Sendable {
  func load() async -> UIMetaStoredCopy?
  func save(_ copy: UIMetaStoredCopy) async
}

/// The copy in the per-gateway key-value store, under `hermie.ui_meta`.
public struct KeyValueUIMetaPersistence: UIMetaPersistence {
  /// The base key; it is namespaced per gateway.
  public static let key = "hermie.ui_meta"

  public let store: KeyValueStore
  public let namespace: GatewayNamespace

  public init(store: KeyValueStore, namespace: GatewayNamespace) {
    self.store = store
    self.namespace = namespace
  }

  public func load() async -> UIMetaStoredCopy? {
    // A copy this build cannot read is a copy it does not have: the gateway's
    // is taken on the next reconcile.
    try? await store.value(UIMetaStoredCopy.self, forKey: namespace.key(Self.key))
  }

  public func save(_ copy: UIMetaStoredCopy) async {
    // A save that failed is a choice that may be re-taken from the gateway on
    // the next launch, which is not worth surfacing as an error.
    try? await store.set(copy, forKey: namespace.key(Self.key))
  }
}
