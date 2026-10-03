import Foundation
import HermieGateway
import HermieStore
import Observation

/**
 The pictures of the people in a shared chat, as the gateway serves them.

 A person's picture is `GET /api/auth/picture?id=<provider>:<sub>` behind the gateway's own auth:
 the gateway fetched it from the identity provider at sign-in and keeps a copy, so this app never
 contacts the provider and never holds an address it could leak. The bytes come through the session's
 link (its credentials, its 401 handling) and are kept as the `data:` URI they arrive as, which is
 what `AvatarImages` already draws.

 One per gateway session, keyed by the same `author.id` a message row carries. What it promises:

 - A picture is asked for once, however many rows name its author: a request for an id already in
   flight, already fetched this launch, or lately refused shares the one answer.
 - A person the gateway holds no picture of (404) is not asked about again for `missingRetry`; a
   gateway that failed or could not be reached is not asked again for `errorRetry`. A chat of rows
   from somebody with no picture is one request, not one per row per scroll.
 - A picture that was fetched before is on disk, in the key-value store under the gateway's
   namespace (the bots' avatars live the same way), so the next launch paints it at once and then
   asks the gateway once whether it changed. A 404 removes the stored copy; an error keeps it.
 - A sign-out forgets all of it (`clear()`), memory and disk, and an answer still on its way when
   that happens is dropped.
 - Nothing is logged: not an id, not a byte.

 A view reads `slot(for:).dataURI`, which is observed per person, so one picture arriving redraws
 that person's avatars and nobody else's.
 */
@MainActor
@Observable
public final class PeoplePictures {
  /// One person's picture, observed on its own.
  @MainActor
  @Observable
  public final class Slot {
    /// The picture as a `data:` URI, or `nil` while it is on its way and when there is none.
    public internal(set) var dataURI: String?

    init(dataURI: String? = nil) {
      self.dataURI = dataURI
    }
  }

  /// How long a 404 stands: the gateway holds no picture of this person, which rarely changes mid-session.
  public nonisolated static let missingRetry: Duration = .seconds(15 * 60)
  /// How long a refused or unreachable answer stands: long enough not to storm a struggling gateway.
  public nonisolated static let errorRetry: Duration = .seconds(2 * 60)
  /// The longest `data:` URI kept, in characters: a gateway that sends more is not sending an avatar.
  public nonisolated static let maxDataURILength = 1_500_000
  /// The longest author id asked about, in characters.
  nonisolated static let maxIDLength = 256
  /// Where a person's picture is stored (`hermie.person.<id>@<gateway>`).
  nonisolated static let diskPrefix = "hermie.person."

  public typealias Fetch = @Sendable (String) async -> PictureFetchOutcome

  @ObservationIgnored private let fetch: Fetch
  @ObservationIgnored private let keyValues: KeyValueStore?
  @ObservationIgnored private let namespace: GatewayNamespace
  @ObservationIgnored private let clock: any ConnectionClock
  @ObservationIgnored private var slots: [String: Slot] = [:]
  @ObservationIgnored private var inFlight: [String: Task<Void, Never>] = [:]
  /// Ids fetched successfully since launch (or since `clear()`).
  @ObservationIgnored private var fetched: Set<String> = []
  /// Id → when it may be asked for again, after a miss or an error.
  @ObservationIgnored private var retryAt: [String: Duration] = [:]
  /// Bumped by `clear()`, so an answer that arrives after a sign-out is dropped.
  @ObservationIgnored private var epoch = 0

  public init(
    gatewayID: String,
    keyValues: KeyValueStore? = nil,
    clock: any ConnectionClock = SystemConnectionClock(),
    fetch: @escaping Fetch
  ) {
    self.fetch = fetch
    self.keyValues = keyValues
    self.namespace = GatewayNamespace(gatewayID)
    self.clock = clock
  }

  /// The person's slot. Created empty on the first ask; reading it starts nothing: `request(_:)` does.
  public func slot(for id: String) -> Slot {
    if let slot = slots[id] {
      return slot
    }

    let slot = Slot()
    slots[id] = slot
    return slot
  }

  /// Make sure this person's picture is being fetched or is held. Fire and forget: the result lands
  /// in `slot(for:)`, and a person with no picture simply never gets one.
  public func request(_ id: String, path: String? = nil) {
    Task { await load(id, path: path) }
  }

  /// `request(_:)`, and the answer awaited: the picture is settled when this returns.
  ///
  /// `path` is where the gateway said the picture lives (`/api/auth/me`'s `picture_url`); without
  /// it, or with an address that is not the picture route, the id's own path is used.
  public func load(_ id: String, path: String? = nil) async {
    guard Self.isAskable(id) else {
      return
    }

    if let running = inFlight[id] {
      await running.value
      return
    }

    guard !fetched.contains(id) else {
      return
    }

    if let wait = retryAt[id], clock.now < wait {
      return
    }

    let target = Self.pictureRoute(path, id: id)
    let mine = epoch
    let task = Task<Void, Never> { [weak self] in
      if let self {
        await self.run(id, path: target, epoch: mine)
      }
    }

    inFlight[id] = task
    await task.value
  }

  /// Ask again whatever was held or refused before: the reader's own picture on a sign-in, which may
  /// have changed on the identity provider since the last time.
  public func refresh(_ id: String, path: String?) async {
    fetched.remove(id)
    retryAt[id] = nil
    await load(id, path: path)
  }

  /// The gateway says it holds no picture of this person (an empty `picture_url`): draw the initial,
  /// and drop a stored copy of an earlier one.
  public func noteNone(_ id: String) async {
    guard Self.isAskable(id) else {
      return
    }

    slot(for: id).dataURI = nil
    fetched.remove(id)
    await disk?.write(id, nil)
  }

  /// Forget everything held, memory and disk, for a sign-out.
  public func clear() async {
    epoch += 1

    for task in inFlight.values {
      task.cancel()
    }

    inFlight = [:]
    fetched = []
    retryAt = [:]

    for slot in slots.values {
      slot.dataURI = nil
    }

    await disk?.removeAll()
  }

  // MARK: - One load

  private func run(_ id: String, path: String, epoch mine: Int) async {
    let slot = slot(for: id)

    // Stale while revalidating: what was fetched on an earlier launch is shown at once.
    if slot.dataURI == nil, let stored = await disk?.read(id), mine == epoch, slot.dataURI == nil {
      slot.dataURI = stored
    }

    let outcome = await fetch(path)

    guard mine == epoch else {
      return
    }

    inFlight[id] = nil

    switch outcome {
    case .ready(let dataURI) where dataURI.count <= Self.maxDataURILength:
      fetched.insert(id)
      retryAt[id] = nil

      if slot.dataURI != dataURI {
        slot.dataURI = dataURI
      }

      await disk?.write(id, dataURI)
    case .missing:
      retryAt[id] = clock.now + Self.missingRetry
      slot.dataURI = nil
      await disk?.write(id, nil)
    case .ready, .error:
      // An error keeps a picture already held: the gateway being away is no news about the person.
      retryAt[id] = clock.now + Self.errorRetry
    }
  }

  // MARK: - Pieces

  private var disk: PeopleDiskCache? {
    keyValues.map { PeopleDiskCache(store: $0, namespace: namespace) }
  }

  static func isAskable(_ id: String) -> Bool {
    !id.isEmpty && id.count <= maxIDLength
  }

  /// The address to ask: the one the gateway named when it is the picture route, else the id's own.
  static func pictureRoute(_ path: String?, id: String) -> String {
    if let path, path.hasPrefix(GatewayAddress.authPicturePathPrefix + "?") {
      return path
    }

    return GatewayAddress.authPicturePath(id: id)
  }
}

/// The pictures on disk, per gateway, in the key-value store, so a sign-out or a removal that
/// purges the gateway's namespace takes them with it.
struct PeopleDiskCache: Sendable {
  let store: KeyValueStore
  let namespace: GatewayNamespace

  /// The key of one person. The id is percent-encoded: an `@` in it would be read as the start of
  /// the namespace, and the gateway's purge would not find the key again.
  func key(_ id: String) -> String {
    let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: ":-._"))
    return namespace.key(PeoplePictures.diskPrefix + (id.addingPercentEncoding(withAllowedCharacters: safe) ?? id))
  }

  func read(_ id: String) async -> String? {
    try? await store.string(forKey: key(id))
  }

  func write(_ id: String, _ dataURI: String?) async {
    let key = key(id)

    if let dataURI {
      try? await store.setString(dataURI, forKey: key)
    } else {
      try? await store.removeValue(forKey: key)
    }
  }

  /// Every stored picture of this gateway.
  func removeAll() async {
    guard let keys = try? await store.keys() else {
      return
    }

    for key in keys where key.hasPrefix(PeoplePictures.diskPrefix) && key.hasSuffix(namespace.key("")) {
      try? await store.removeValue(forKey: key)
    }
  }
}
