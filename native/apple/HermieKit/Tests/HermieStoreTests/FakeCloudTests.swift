import Foundation
import Testing

@testable import HermieStore

@Suite struct InMemorySyncedItemStoreTests {
  @Test func roundTrip() throws {
    try SyncedItemStoreContract.checkRoundTrip(InMemorySyncedItemStore())
  }

  @Test func values() throws {
    try SyncedItemStoreContract.checkValues(InMemorySyncedItemStore())
  }

  @Test func independentAccounts() throws {
    try SyncedItemStoreContract.checkIndependentAccounts(InMemorySyncedItemStore())
  }

  @Test func invalidAccounts() {
    SyncedItemStoreContract.checkInvalidAccounts(InMemorySyncedItemStore())
  }

  /// The contract holds on a replica that shares its cloud with others.
  @Test func contractOnAReplicaWithNeighbours() throws {
    let cloud = FakeCloud(delivery: .immediate)
    let store = cloud.replica("A")
    _ = cloud.replica("B")
    try SyncedItemStoreContract.checkRoundTrip(store)
    try SyncedItemStoreContract.checkIndependentAccounts(store)
  }

  @Test func descriptionsNameNoAccountOrValue() throws {
    let store = InMemorySyncedItemStore()
    try store.put(SyncedItem(account: "gw.secretaccount", value: "secret-value"))
    for text in ["\(store)", "\(store.cloud)", String(reflecting: store.cloud)] {
      #expect(!text.contains("secret"), "\(text)")
    }
  }
}

@Suite struct FakeCloudTests {
  static func item(_ account: String, _ value: String) -> SyncedItem {
    SyncedItem(account: account, value: value)
  }

  // MARK: - Delivery

  @Test func aWriteStaysOnItsDeviceUntilDelivered() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")

    try phone.put(Self.item("gw.1", "home"))
    #expect(try phone.all() == [Self.item("gw.1", "home")])
    #expect(try mac.all() == [])
    #expect(cloud.pending(to: "B") == ["gw.1"])
    #expect(cloud.pending(to: "A") == [])
    #expect(cloud.cloudItems() == [Self.item("gw.1", "home")])

    cloud.deliverAll()
    #expect(try mac.all() == [Self.item("gw.1", "home")])
    #expect(cloud.pendingCount == 0)
  }

  @Test func immediateDeliveryReachesEveryDeviceAtOnce() throws {
    let cloud = FakeCloud(delivery: .immediate)
    let stores = ["A", "B", "C"].map(cloud.replica)
    try stores[0].put(Self.item("gw.1", "v"))
    for store in stores { #expect(try store.all() == [Self.item("gw.1", "v")]) }
    try stores[2].delete(account: "gw.1")
    for store in stores { #expect(try store.all() == []) }
  }

  @Test func aDeviceAddedLaterReceivesWhatTheCloudHolds() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    try phone.put(Self.item("gw.1", "one"))
    try phone.put(Self.item("gw.2", "two"))
    try phone.delete(account: "gw.2")

    let ipad = cloud.replica("C")
    #expect(try ipad.all() == [])
    #expect(cloud.pending(to: "C") == ["gw.1"])
    cloud.deliverAll()
    #expect(try ipad.all() == [Self.item("gw.1", "one")])
  }

  @Test func theSameNameIsTheSameReplica() throws {
    let cloud = FakeCloud()
    try cloud.replica("A").put(Self.item("gw.1", "v"))
    #expect(try cloud.replica("A").all() == [Self.item("gw.1", "v")])
    #expect(cloud.devices == ["A"])
  }

  // MARK: - Whole-item last writer wins

  /// Both devices write the same account before either delivery: the later
  /// write wins on both, whichever arrives first, and nothing is merged.
  @Test func concurrentWritesSettleOnTheLaterWholeItem() throws {
    for newestFirst in [false, true] {
      let cloud = FakeCloud()
      let phone = cloud.replica("A")
      let mac = cloud.replica("B")

      try phone.put(Self.item("gw.1", #"{"name":"Phone"}"#))
      try mac.put(Self.item("gw.1", #"{"token":"Mac"}"#))

      if newestFirst {
        #expect(cloud.deliverNewest(to: "A"))
        #expect(cloud.deliverNewest(to: "B"))
      } else {
        cloud.deliverAll()
      }
      #expect(try phone.all() == [Self.item("gw.1", #"{"token":"Mac"}"#)])
      #expect(try mac.all() == [Self.item("gw.1", #"{"token":"Mac"}"#)])
      #expect(cloud.cloudItems() == [Self.item("gw.1", #"{"token":"Mac"}"#)])
    }
  }

  /// An older change delivered after a newer one is ignored on arrival.
  @Test func anOlderChangeArrivingLateIsIgnored() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")

    try phone.put(Self.item("gw.1", "first"))
    try phone.put(Self.item("gw.1", "second"))
    #expect(cloud.pending(to: "B") == ["gw.1", "gw.1"])

    #expect(cloud.deliverNewest(to: "B"))
    #expect(try mac.all() == [Self.item("gw.1", "second")])
    #expect(cloud.deliverNext(to: "B"))
    #expect(try mac.all() == [Self.item("gw.1", "second")])
    #expect(!cloud.deliverNext(to: "B"))
  }

  @Test func aDeleteTravelsAndAnOlderWriteDoesNotBringTheItemBack() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")

    try phone.put(Self.item("gw.1", "v"))
    cloud.deliverAll()
    try mac.put(Self.item("gw.1", "renamed"))  // older than the delete below
    try phone.delete(account: "gw.1")

    cloud.deliverAll()
    #expect(try phone.all() == [])
    #expect(try mac.all() == [])
    #expect(cloud.cloudItems() == [])
  }

  @Test func deletingWhatIsNotThereChangesNothingAndDoesNotTravel() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    _ = cloud.replica("B")
    try phone.delete(account: "gw.1")
    #expect(cloud.pendingCount == 0)
    #expect(cloud.writes() == [])
  }

  @Test func deliverAtPicksAnyWaitingChange() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    for index in 1...3 { try phone.put(Self.item("gw.\(index)", "v")) }

    #expect(cloud.deliver(at: 1, to: "B"))
    #expect(try mac.all().map(\.account) == ["gw.2"])
    #expect(cloud.pending(to: "B") == ["gw.1", "gw.3"])
    #expect(!cloud.deliver(at: 5, to: "B"))
  }

  // MARK: - Held devices

  @Test func aHeldDeviceNeitherReceivesNorSendsUntilReleased() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")

    cloud.hold("B")
    try phone.put(Self.item("gw.1", "from A"))
    try mac.put(Self.item("gw.2", "from B"))

    cloud.deliverAll()
    #expect(!cloud.deliverNext(to: "B"))
    #expect(try mac.all() == [Self.item("gw.2", "from B")])
    #expect(try phone.all() == [Self.item("gw.1", "from A")])
    #expect(cloud.cloudItems() == [Self.item("gw.1", "from A")])
    #expect(cloud.pendingCount == 2)  // one waiting for B, one still on B

    cloud.release("B")
    cloud.deliverAll()
    let both = [Self.item("gw.1", "from A"), Self.item("gw.2", "from B")]
    #expect(try phone.all() == both)
    #expect(try mac.all() == both)
    #expect(cloud.cloudItems() == both)
  }

  @Test func releaseUnderImmediateDeliveryCatchesUp() throws {
    let cloud = FakeCloud(delivery: .immediate)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    cloud.hold("B")
    try phone.put(Self.item("gw.1", "a"))
    try mac.put(Self.item("gw.2", "b"))
    #expect(try phone.all().map(\.account) == ["gw.1"])

    cloud.release("B")
    #expect(try phone.all().map(\.account) == ["gw.1", "gw.2"])
    #expect(try mac.all().map(\.account) == ["gw.1", "gw.2"])
  }

  // MARK: - Convergence

  static let accounts = ["gw.1", "gw.2", "gw.3"]
  static let devices = ["A", "B", "C"]

  /// One random edit on a random device.
  static func randomEdit(
    _ stores: [InMemorySyncedItemStore],
    step: Int,
    using generator: inout SplitMix64
  ) throws {
    let store = stores.randomElement(using: &generator)!
    let account = accounts.randomElement(using: &generator)!
    if Int.random(in: 0..<4, using: &generator) == 0 {
      try store.delete(account: account)
    } else {
      try store.put(SyncedItem(account: account, value: "\(store.device)-\(step)"))
    }
  }

  /// Random writes and deletes on three devices, with random deliveries in
  /// random order between them: once everything is delivered, in a random
  /// interleaving, every replica holds what the cloud holds.
  @Test(arguments: 0..<50)
  func everyInterleavingConverges(seed: UInt64) throws {
    var edits = SplitMix64(seed: seed)
    var delivery = SplitMix64(seed: ~seed)
    let cloud = FakeCloud()
    let stores = Self.devices.map(cloud.replica)

    for step in 0..<40 {
      try Self.randomEdit(stores, step: step, using: &edits)
      if Bool.random(using: &delivery) {
        let device = Self.devices.randomElement(using: &delivery)!
        let count = cloud.pending(to: device).count
        if count > 0 { cloud.deliver(at: Int.random(in: 0..<count, using: &delivery), to: device) }
      }
    }
    cloud.deliverAll(using: &delivery)

    #expect(cloud.pendingCount == 0)
    for store in stores { #expect(try store.all() == cloud.cloudItems(), "seed \(seed)") }
  }

  /// The same edits made offline, then delivered in different random orders:
  /// the same outcome every time.
  @Test(arguments: 0..<50)
  func theDeliveryOrderDoesNotChangeTheOutcome(seed: UInt64) throws {
    var outcomes = Set<[String]>()
    for order in 0..<4 {
      var edits = SplitMix64(seed: seed)
      var delivery = SplitMix64(seed: seed &* 31 &+ UInt64(order))
      let cloud = FakeCloud()
      let stores = Self.devices.map(cloud.replica)

      for step in 0..<20 { try Self.randomEdit(stores, step: step, using: &edits) }
      cloud.deliverAll(using: &delivery)

      for store in stores { #expect(try store.all() == cloud.cloudItems(), "seed \(seed) order \(order)") }
      outcomes.insert(cloud.cloudItems().map { "\($0.account)=\($0.value)" })
    }
    #expect(outcomes.count == 1, "seed \(seed)")
  }

  // MARK: - Faults

  @Test func anUnavailableDeviceListsNothingAndIgnoresWrites() throws {
    let cloud = FakeCloud(delivery: .immediate)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "v"))

    cloud.setAvailability(.unavailable, on: "B")
    #expect(mac.availability() == .unavailable)
    #expect(try mac.all() == [])
    try mac.put(Self.item("gw.2", "ignored"))
    try mac.delete(account: "gw.1")
    #expect(try phone.all() == [Self.item("gw.1", "v")])
    #expect(cloud.writes() == [FakeCloud.Write(device: "A", account: "gw.1", kind: .put)])

    cloud.setAvailability(.available, on: "B")
    #expect(try mac.all() == [Self.item("gw.1", "v")])
  }

  @Test func failNextThrowsOnceAndChangesNothing() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    cloud.failNext(.put, on: "A", with: .interactionNotAllowed)
    cloud.failNext(.all, on: "A", with: .keychain(operation: .list, status: -1))

    #expect(throws: SecretStoreError.interactionNotAllowed) { try phone.put(Self.item("gw.1", "v")) }
    #expect(cloud.writes() == [])
    #expect(throws: SecretStoreError.keychain(operation: .list, status: -1)) { try phone.all() }

    try phone.put(Self.item("gw.1", "v"))
    #expect(try phone.all() == [Self.item("gw.1", "v")])

    cloud.failNext(.delete, on: "A", with: .interactionNotAllowed)
    #expect(throws: SecretStoreError.interactionNotAllowed) { try phone.delete(account: "gw.1") }
    #expect(try phone.all() == [Self.item("gw.1", "v")])
  }

  @Test func writesAreRecordedWithoutValues() throws {
    let cloud = FakeCloud()
    let phone = cloud.replica("A")
    try phone.put(Self.item("gw.1", "v"))
    try phone.delete(account: "gw.1")
    #expect(
      cloud.writes() == [
        FakeCloud.Write(device: "A", account: "gw.1", kind: .put),
        FakeCloud.Write(device: "A", account: "gw.1", kind: .delete)
      ])
  }

  @Test func concurrentCallsAreSafe() async throws {
    let cloud = FakeCloud(delivery: .immediate)
    let stores = ["A", "B", "C"].map(cloud.replica)
    try await withThrowingTaskGroup(of: Void.self) { group in
      for index in 0..<300 {
        group.addTask {
          let store = stores[index % 3]
          let account = "gw.\(index % 7)"
          if index.isMultiple(of: 5) {
            try store.delete(account: account)
          } else {
            try store.put(SyncedItem(account: account, value: "\(index)"))
          }
          _ = try store.all()
        }
      }
      try await group.waitForAll()
    }
    for store in stores { #expect(try store.all() == cloud.cloudItems()) }
  }
}

/// A small seeded generator, so a failing convergence case can be replayed.
struct SplitMix64: RandomNumberGenerator {
  var state: UInt64

  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
