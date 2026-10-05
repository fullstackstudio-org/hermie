import Foundation
import HermieProtocol
import HermieStore
import Testing

@testable import HermieCore

@Suite("Push preferences")
struct PushPreferencesStoredTests {
  @Test("a reader who has just switched notifications on gets every type and no preview")
  func standard() {
    #expect(PushPreferences.standard.types == PushRows.defaultTypes)
    #expect(!PushPreferences.standard.preview)
    #expect(PushContract.types.allSatisfy { PushPreferences.standard.wants($0) })
    #expect(!PushPreferences.standard.wantsNothing)
  }

  @Test("what is stored is read back, and nothing stored is the standard")
  func roundTrip() {
    let chosen = PushPreferences.standard.setting("cron", false).setting("turn_done", false)
    var withPreview = chosen
    withPreview.preview = true

    #expect(PushPreferences.decoded(withPreview.encoded()) == withPreview)
    #expect(PushPreferences.decoded(nil) == .standard)
    #expect(PushPreferences.decoded("not json") == .standard)
    #expect(PushPreferences.decoded("[]") == .standard)
    #expect(PushPreferences.decoded("{}") == .standard)
  }

  @Test("a type the stored choices say nothing about takes the default, a stored answer wins")
  func adoption() {
    // A release that adds a type must not leave existing devices with it off.
    let stored = "{\"preview\":true,\"types\":{\"message\":false,\"cron\":true,\"turn_done\":\"yes\"}}"
    let read = PushPreferences.decoded(stored)

    #expect(!read.wants("message"))
    #expect(read.wants("cron"))
    #expect(read.wants("turn_done"), "anything but a stored boolean is the default")
    #expect(read.wants("request"))
    #expect(read.preview)
  }

  @Test("a name this build does not know is not a type")
  func unknown() {
    #expect(PushPreferences.standard.setting("telepathy", false) == .standard)
  }

  @Test("with every type off the device wants nothing")
  func wantsNothing() {
    var preferences = PushPreferences.standard

    for type in PushContract.types {
      preferences = preferences.setting(type, false)
    }

    #expect(preferences.wantsNothing)
    #expect(PushContract.types.allSatisfy { !preferences.wants($0) })
  }
}

@MainActor
@Suite("Push preferences, in the controller")
struct PushPreferencesControllerTests {
  typealias G = PushGateways

  private func started(_ rig: PushControllerTests.Rig, on controller: PushController? = nil) async {
    let controller = controller ?? rig.controller
    rig.system.current = .granted
    await controller.setGateways([G.one])
    await controller.start()
  }

  @Test("before the choices are read there are the standard ones, and nothing changes before start")
  func beforeStart() async throws {
    let rig = try PushControllerTests.Rig()

    #expect(rig.controller.preferences == .standard)

    await rig.controller.setType("cron", false)
    await rig.controller.setPreview(true)

    #expect(rig.controller.preferences == .standard)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushPreferences) == nil)
  }

  @Test("a switched type is stored, announced and read again after a relaunch")
  func persists() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    var announced = 0
    rig.controller.onPreferencesChanged = { announced += 1 }

    await rig.controller.setType("cron_done", false)
    await rig.controller.setPreview(true)

    #expect(!rig.controller.preferences.wants("cron_done"))
    #expect(rig.controller.preferences.wants("cron_failed"))
    #expect(rig.controller.preferences.preview)
    #expect(announced == 2)
    #expect(!rig.controller.preferencesWriteFailed)

    let next = rig.relaunch()
    await started(rig, on: next)

    #expect(next.preferences == rig.controller.preferences)
  }

  @Test("the same answer again changes nothing and says nothing")
  func sameAnswer() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    var announced = 0
    rig.controller.onPreferencesChanged = { announced += 1 }

    await rig.controller.setType("message", true)
    await rig.controller.setPreview(false)
    await rig.controller.setType("telepathy", false)

    #expect(announced == 0)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushPreferences) == nil)
  }

  @Test("two quick changes are two changes in order, and the second does not undo the first")
  func inOrder() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)

    async let first: Void = rig.controller.setType("message", false)
    async let second: Void = rig.controller.setType("request", false)
    async let third: Void = rig.controller.setPreview(true)
    _ = await (first, second, third)

    #expect(!rig.controller.preferences.wants("message"))
    #expect(!rig.controller.preferences.wants("request"))
    #expect(rig.controller.preferences.preview)
    let stored = PushPreferences.decoded(try await rig.settings.string(forKey: StoreKeys.pushPreferences))
    #expect(stored == rig.controller.preferences)
  }

  @Test("unreadable stored choices are the standard ones, and the next change writes them again")
  func unreadable() async throws {
    let rig = try PushControllerTests.Rig()
    try await rig.settings.setString("{broken", forKey: StoreKeys.pushPreferences)
    await started(rig)

    #expect(rig.controller.preferences == .standard)
    #expect(rig.controller.trouble == nil, "a choice that cannot be read is not a reason to pause push")

    await rig.controller.setType("cron", false)
    #expect(PushPreferences.decoded(try await rig.settings.string(forKey: StoreKeys.pushPreferences)).wants("cron") == false)
  }

  @Test("resetting the device puts the choices back")
  func reset() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    await rig.controller.setType("cron", false)

    await rig.controller.resetDevice()

    #expect(rig.controller.preferences == .standard)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushPreferences) == nil)
  }
}

@MainActor
@Suite("Push preferences, in the row")
struct PushPreferencesRowTests {
  typealias F = PushFixtures

  @Test("the row says what the reader chose, and a device that wants nothing has no row")
  func theRowFollows() async throws {
    let gateway = HoldingGateway()
    let phone = PushRowWriterTests.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = PushRowWriterTests.address()
    await phone.writer.refresh()
    await phone.sync.flush()
    #expect(PushRowWriterTests.row(gateway, "i-phone")?["types"] == .object(PushRows.defaultTypes))

    var chosen = PushPreferences.standard.setting("cron", false)
    chosen.preview = true
    phone.writer.apply(chosen)
    await phone.writer.refresh()
    await phone.sync.flush()

    let row = try #require(PushRowWriterTests.row(gateway, "i-phone"))
    #expect(row["types"]?["cron"] == false)
    #expect(row["types"]?["message"] == true)
    #expect(row["preview"] == true)

    var nothing = chosen

    for type in PushContract.types {
      nothing = nothing.setting(type, false)
    }

    phone.writer.apply(nothing)
    await phone.writer.refresh()
    await phone.sync.flush()

    #expect(PushRowWriterTests.row(gateway, "i-phone") == nil)
  }

  @Test("the row says whether urgent requests may break through Focus: the key is there while on, gone while off")
  func urgentBreakthroughInTheRow() async throws {
    let gateway = HoldingGateway()
    let phone = PushRowWriterTests.device(gateway, installation: "i-phone")
    await phone.sync.reconcile()
    phone.address.state = PushRowWriterTests.address()
    await phone.writer.refresh()
    await phone.sync.flush()
    #expect(PushRowWriterTests.row(gateway, "i-phone")?["urgentBreakthrough"] == true)

    phone.writer.urgentBreakthrough = false
    await phone.writer.refresh()
    await phone.sync.flush()

    // Absent, not false, and not carried over from the row it replaces: a sender reads "no key" as
    // "the reader does not want it", and a build that never knew the key writes none either.
    let off = try #require(PushRowWriterTests.row(gateway, "i-phone"))
    #expect(off["urgentBreakthrough"] == nil)
    #expect(off["clears"] == true)
    #expect(PushRows.addressOf(.object(off)) != nil)

    phone.writer.urgentBreakthrough = true
    await phone.writer.refresh()
    await phone.sync.flush()
    #expect(PushRowWriterTests.row(gateway, "i-phone")?["urgentBreakthrough"] == true)
  }
}
