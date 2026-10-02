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

  static let policies: [FakeCloud.Conflict] = [.newestWrite, .cloudWins]

  /// Takes a random device offline or brings it back.
  static func randomHoldOrRelease(_ cloud: FakeCloud, held: inout Set<String>, using generator: inout SplitMix64) {
    let device = devices.randomElement(using: &generator)!
    if held.remove(device) != nil {
      cloud.release(device)
    } else {
      held.insert(device)
      cloud.hold(device)
    }
  }

  /// Random writes and deletes on three devices, with random deliveries in
  /// random order and devices going offline and back between them: once every
  /// device is back and everything is delivered, in a random interleaving,
  /// every replica holds what the cloud holds. Under both policies.
  @Test(arguments: policies, 0..<50)
  func everyInterleavingConverges(conflict: FakeCloud.Conflict, seed: UInt64) throws {
    var edits = SplitMix64(seed: seed)
    var delivery = SplitMix64(seed: ~seed)
    let cloud = FakeCloud(conflict: conflict)
    let stores = Self.devices.map(cloud.replica)
    var held = Set<String>()

    for step in 0..<40 {
      try Self.randomEdit(stores, step: step, using: &edits)
      if Int.random(in: 0..<5, using: &delivery) == 0 {
        Self.randomHoldOrRelease(cloud, held: &held, using: &delivery)
      }
      if Bool.random(using: &delivery) {
        let device = Self.devices.randomElement(using: &delivery)!
        let count = cloud.pending(to: device).count
        if count > 0 { cloud.deliver(at: Int.random(in: 0..<count, using: &delivery), to: device) }
      }
    }
    for device in held.sorted() { cloud.release(device) }
    cloud.deliverAll(using: &delivery)

    #expect(cloud.pendingCount == 0)
    for store in stores { #expect(try store.all() == cloud.cloudItems(), "\(conflict) seed \(seed)") }
  }

  /// The random edits above do reach the refusal path under `.cloudWins`, so
  /// the convergence tests exercise it.
  @Test func randomEditsProduceRefusals() throws {
    var refusals = 0
    for seed in UInt64(0)..<20 {
      var edits = SplitMix64(seed: seed)
      var offline = SplitMix64(seed: ~seed)
      let cloud = FakeCloud(conflict: .cloudWins)
      let stores = Self.devices.map(cloud.replica)
      var held = Set<String>()
      for step in 0..<40 {
        try Self.randomEdit(stores, step: step, using: &edits)
        if Int.random(in: 0..<4, using: &offline) == 0 {
          Self.randomHoldOrRelease(cloud, held: &held, using: &offline)
        }
      }
      for device in held.sorted() { cloud.release(device) }
      refusals += cloud.refused().count
    }
    #expect(refusals > 20)
  }

  /// The same edits, made with devices going offline and back, then every
  /// device released in a random order and everything delivered in a random
  /// order. Every replica ends with what the cloud holds, under both
  /// policies. Under `.newestWrite` that is the same outcome every time; under
  /// `.cloudWins` it may depend on which device reached the cloud first, so no
  /// single outcome is asserted.
  @Test(arguments: policies, 0..<50)
  func theDeliveryOrder(conflict: FakeCloud.Conflict, seed: UInt64) throws {
    var outcomes = Set<[String]>()
    for order in 0..<4 {
      var edits = SplitMix64(seed: seed)
      var offline = SplitMix64(seed: seed &+ 7)
      var delivery = SplitMix64(seed: seed &* 31 &+ UInt64(order))
      let cloud = FakeCloud(conflict: conflict)
      let stores = Self.devices.map(cloud.replica)
      var held = Set<String>()

      for step in 0..<20 {
        try Self.randomEdit(stores, step: step, using: &edits)
        if Int.random(in: 0..<4, using: &offline) == 0 {
          Self.randomHoldOrRelease(cloud, held: &held, using: &offline)
        }
      }
      for device in held.shuffled(using: &delivery) { cloud.release(device) }
      cloud.deliverAll(using: &delivery)

      #expect(cloud.pendingCount == 0)
      for store in stores {
        #expect(try store.all() == cloud.cloudItems(), "\(conflict) seed \(seed) order \(order)")
      }
      outcomes.insert(cloud.cloudItems().map { "\($0.account)=\($0.value)" })
    }
    if conflict == .newestWrite {
      #expect(outcomes.count == 1, "seed \(seed)")
    }
  }

  // MARK: - Conflict policies

  /// Both devices hold the item; B goes offline and edits it, A edits it
  /// online, later in time; then B comes back.
  @Test(arguments: policies)
  func anOfflineEditMeetsAnOnlineEdit(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "v0"))
    cloud.deliverAll()

    cloud.hold("B")
    try mac.put(Self.item("gw.1", "offline B"))  // based on v0, made first
    try phone.put(Self.item("gw.1", "online A"))  // reaches the cloud first, written later
    cloud.release("B")
    cloud.deliverAll()

    // The later write and the first to reach the cloud are the same here.
    for store in [phone, mac] { #expect(try store.all() == [Self.item("gw.1", "online A")], "\(conflict)") }
    #expect(cloud.cloudItems() == [Self.item("gw.1", "online A")])
    if conflict == .cloudWins {
      #expect(cloud.refused() == [FakeCloud.Write(device: "B", account: "gw.1", kind: .put)])
    } else {
      #expect(cloud.refused() == [])
    }
  }

  /// The same, but the offline edit is the later one: newest write keeps it;
  /// the cloud refuses it, because it was made from a stale copy, and B gets
  /// A's copy back.
  @Test(arguments: policies)
  func aLaterOfflineEditMadeFromAStaleCopy(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "v0"))
    cloud.deliverAll()

    cloud.hold("B")
    try phone.put(Self.item("gw.1", "online A"))
    try mac.put(Self.item("gw.1", "offline B"))  // later, but based on v0
    cloud.release("B")
    #expect(try mac.all() == [Self.item("gw.1", "offline B")])  // until the cloud's answer arrives
    cloud.deliverAll()

    let winner = conflict == .newestWrite ? "offline B" : "online A"
    for store in [phone, mac] { #expect(try store.all() == [Self.item("gw.1", winner)], "\(conflict)") }
    #expect(cloud.cloudItems() == [Self.item("gw.1", winner)])
    #expect(cloud.refused().count == (conflict == .cloudWins ? 1 : 0))
  }

  /// B deletes offline; A edits online; B comes back. Newest write: the
  /// later delete wins. Cloud wins: the stale delete is refused and the item
  /// comes back on B.
  @Test(arguments: policies)
  func aStaleDeleteCanLose(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "v0"))
    cloud.deliverAll()

    cloud.hold("B")
    try phone.put(Self.item("gw.1", "renamed"))
    try mac.delete(account: "gw.1")
    cloud.release("B")
    cloud.deliverAll()

    let expected = conflict == .newestWrite ? [] : [Self.item("gw.1", "renamed")]
    for store in [phone, mac] { #expect(try store.all() == expected, "\(conflict)") }
    #expect(cloud.cloudItems() == expected)
    if conflict == .cloudWins {
      #expect(cloud.refused() == [FakeCloud.Write(device: "B", account: "gw.1", kind: .delete)])
    }
  }

  /// A refused change is not passed on: a third device never sees it, not
  /// even briefly.
  @Test func aRefusedChangeIsNotPassedOn() throws {
    let cloud = FakeCloud(conflict: .cloudWins)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    let ipad = cloud.replica("C")
    try phone.put(Self.item("gw.1", "v0"))
    cloud.deliverAll()

    cloud.hold("B")
    try phone.put(Self.item("gw.1", "online A"))
    try mac.put(Self.item("gw.1", "offline B"))
    try mac.put(Self.item("gw.1", "offline B again"))  // based on its own refused write: refused too
    cloud.release("B")

    #expect(cloud.pending(to: "C") == ["gw.1"])  // A's edit only
    #expect(cloud.pending(to: "B") == ["gw.1", "gw.1", "gw.1"])  // A's edit, and the cloud's copy twice
    cloud.deliverNext(to: "C")
    #expect(try ipad.all() == [Self.item("gw.1", "online A")])
    cloud.deliverAll()
    #expect(try mac.all() == [Self.item("gw.1", "online A")])
    #expect(cloud.refused().count == 2)
  }

  /// Under cloud wins, an offline chain of edits on an item nobody else
  /// touched is accepted in full.
  @Test func anOfflineChainOnAnUntouchedItemIsAccepted() throws {
    let cloud = FakeCloud(conflict: .cloudWins)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "v0"))
    cloud.deliverAll()

    cloud.hold("B")
    try mac.put(Self.item("gw.1", "v1"))
    try mac.put(Self.item("gw.1", "v2"))
    try mac.delete(account: "gw.1")
    try mac.put(Self.item("gw.1", "v3"))
    cloud.release("B")
    cloud.deliverAll()

    #expect(cloud.refused() == [])
    for store in [phone, mac] { #expect(try store.all() == [Self.item("gw.1", "v3")]) }
  }

  // MARK: - Wipe and rejoin

  @Test(arguments: policies)
  func aWipedDeviceLosesItsItemsAndSendsNothing(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "one"))
    try phone.put(Self.item("gw.2", "two"))
    cloud.deliverAll()

    cloud.hold("B")
    try mac.put(Self.item("gw.3", "never uploaded"))
    try phone.put(Self.item("gw.4", "waiting for B"))
    let writesBefore = cloud.writes()

    cloud.wipeLocal("B")
    #expect(try mac.all() == [])
    #expect(cloud.pending(to: "B") == [])
    #expect(cloud.writes() == writesBefore)

    cloud.release("B")
    cloud.deliverAll()
    // Nothing travelled: A keeps everything, the never-uploaded write is gone.
    #expect(try phone.all().map(\.account) == ["gw.1", "gw.2", "gw.4"])
    #expect(cloud.pending(to: "A") == [])
    #expect(try mac.all() == [])

    // A change made afterwards still reaches it.
    try phone.put(Self.item("gw.5", "later"))
    cloud.deliverAll()
    #expect(try mac.all() == [Self.item("gw.5", "later")])
  }

  @Test(arguments: policies)
  func rejoinDownloadsEverythingTheCloudHolds(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "one"))
    try phone.put(Self.item("gw.2", "two"))
    try phone.delete(account: "gw.2")
    try phone.put(Self.item("gw.3", "three"))
    cloud.deliverAll()

    cloud.wipeLocal("B")
    #expect(try mac.all() == [])
    cloud.rejoin("B")
    #expect(cloud.pending(to: "B") == ["gw.1", "gw.3"])
    cloud.deliverAll()
    #expect(try mac.all() == cloud.cloudItems())

    // And the rejoined device's edits are accepted again.
    try mac.put(Self.item("gw.1", "edited on B"))
    cloud.deliverAll()
    #expect(try phone.all() == [Self.item("gw.1", "edited on B"), Self.item("gw.3", "three")])
    #expect(cloud.refused() == [])
  }

  /// A wiped device that writes an account the cloud already holds, before
  /// it has downloaded anything: the cloud refuses the blind write and sends
  /// its own copy, the only way that device learns it.
  @Test(arguments: policies)
  func aBlindWriteAfterAWipe(conflict: FakeCloud.Conflict) throws {
    let cloud = FakeCloud(conflict: conflict)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "from A"))
    cloud.deliverAll()

    cloud.wipeLocal("B")
    try mac.put(Self.item("gw.1", "blind B"))
    cloud.deliverAll()

    let winner = conflict == .newestWrite ? "blind B" : "from A"
    for store in [phone, mac] { #expect(try store.all() == [Self.item("gw.1", winner)], "\(conflict)") }
  }

  @Test func rejoinUnderImmediateDeliveryArrivesAtOnce() throws {
    let cloud = FakeCloud(delivery: .immediate)
    let phone = cloud.replica("A")
    let mac = cloud.replica("B")
    try phone.put(Self.item("gw.1", "one"))
    cloud.wipeLocal("B")
    #expect(try mac.all() == [])
    cloud.rejoin("B")
    #expect(try mac.all() == [Self.item("gw.1", "one")])
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
