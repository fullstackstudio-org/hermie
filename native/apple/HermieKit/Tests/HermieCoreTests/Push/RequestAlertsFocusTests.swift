import Foundation
import HermieProtocol
import HermieShared
import HermieStore
import Testing

@testable import HermieCore

/// How loudly a request's notification may interrupt, and what a Focus filter lets through.
@MainActor
@Suite("Request alerts and Focus")
struct RequestAlertsFocusTests {
  private static let english = RequestAlertCopy.english
  private let key = PushGateways.one.key

  // MARK: Interruption level

  @Test("an approval, a question and a confirmation are time-sensitive")
  func urgentKindsAreTimeSensitive() async {
    for (method, level) in [
      ("approval", nil), ("clarify", nil), ("confirm", PushConfirmLevel.plain), ("confirm", .passkey)
    ] as [(String, PushConfirmLevel?)] {
      let rig = AlertRig()
      rig.background()
      await rig.update([openRequest("srq-1", method, level: level)])

      #expect(rig.center.posted.first?.interruption == .timeSensitive, "\(method) \(String(describing: level))")
    }
  }

  @Test("every other kind of request is posted at the active level")
  func otherKindsAreActive() async {
    for method in PushRequestMethod.allCases where !method.isUrgent {
      let rig = AlertRig()
      rig.background()
      await rig.update([openRequest("srq-1", method.rawValue)])

      #expect(rig.center.posted.first?.interruption == .active, "\(method)")
    }
  }

  @Test("exactly the approval, the question and the confirmation are urgent")
  func urgentSet() {
    #expect(Set(PushRequestMethod.allCases.filter(\.isUrgent)) == [.approval, .clarify, .confirm])
    #expect(!OpenRequest(gatewayId: "g1", chat: "scout", method: "telepathy", requestId: "x").isUrgent)
  }

  @Test("with the setting off an urgent request is active too")
  func settingOff() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.settings.urgentBreaksThroughFocus = false
    await rig.update([openRequest("srq-1", "approval"), openRequest("srq-2", "confirm")])

    #expect(rig.center.posted.map(\.interruption) == [.active, .active])
  }

  @Test("the setting is read when the request arrives")
  func settingIsRead() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.settings.urgentBreaksThroughFocus = false
    await rig.update([openRequest("srq-1", "approval")])

    rig.knobs.settings.urgentBreaksThroughFocus = true
    await rig.update([openRequest("srq-1", "approval"), openRequest("srq-2", "approval")])

    #expect(rig.center.posted.map(\.interruption) == [.active, .timeSensitive])
  }

  @Test("without the entitlement nothing is posted above the active level")
  func notEntitled() async {
    let rig = AlertRig(entitled: false)
    rig.background()
    await rig.update([openRequest("srq-1", "approval")])

    #expect(rig.center.posted.first?.interruption == .active)
  }

  @Test("the level of a request, as a pure function")
  func level() {
    let approval = openRequest("a", "approval")
    let form = openRequest("f", "input.form")

    #expect(LocalInterruption.level(for: approval, entitled: true, urgentBreaksThroughFocus: true) == .timeSensitive)
    #expect(LocalInterruption.level(for: approval, entitled: false, urgentBreaksThroughFocus: true) == .active)
    #expect(LocalInterruption.level(for: approval, entitled: true, urgentBreaksThroughFocus: false) == .active)
    #expect(LocalInterruption.level(for: form, entitled: true, urgentBreaksThroughFocus: true) == .active)
  }

  @Test("both apps carry the entitlement in every entitlements file, and the build says so")
  func entitlement() throws {
    #expect(RequestAlerts.timeSensitiveEntitled)

    for app in ["ios", "macos"] {
      for file in ["Hermie", "Hermie-NoPasskey"] {
        let plist = try PasskeyBuildSettingsTests.plist("\(app)/App/\(file).entitlements")

        #expect(
          plist["com.apple.developer.usernotifications.time-sensitive"] as? Bool == true, "\(app)/\(file)")
      }
    }

    for file in PasskeyBuildSettingsTests.extensionEntitlements() {
      let plist = try PasskeyBuildSettingsTests.plist(file)

      #expect(plist["com.apple.developer.usernotifications.time-sensitive"] == nil, "\(file): no extension posts")
    }
  }

  // MARK: The Focus filter

  @Test("without a filter a request is posted as before")
  func noFilter() async {
    let rig = AlertRig()
    rig.background()
    await rig.update([openRequest("srq-1", "input.form")])

    #expect(rig.center.posted.count == 1)
  }

  @Test("with all bots allowed a request is posted")
  func allBots() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.focus = FocusFilter(scope: .all)
    await rig.update([openRequest("srq-1", "approval")])

    #expect(rig.center.posted.count == 1)
  }

  @Test("with chosen bots only theirs are posted, matched by gateway and handle")
  func chosenBots() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.focus = FocusFilter(scope: .chosen, bots: [FocusFilter.Bot(gatewayKey: key, handle: "scout")])

    await rig.update([
      openRequest("srq-1", "approval", chat: "scout"),
      openRequest("srq-2", "approval", chat: "ops")
    ])
    #expect(rig.center.posted.map(\.identifier) == [RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-1")])

    // The same handle on a gateway the filter does not name.
    await rig.update([openRequest("srq-3", "approval", chat: "scout")], gateway: "g2", key: PushGateways.two.key)
    #expect(rig.center.posted.count == 1)
  }

  @Test("with no bots allowed nothing is posted, urgent or not")
  func noBots() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.focus = FocusFilter(scope: .none)
    await rig.update([openRequest("srq-1", "approval"), openRequest("srq-2", "input.form")])

    #expect(rig.center.posted.isEmpty)
    #expect(rig.alerts.postedIdentifiers.isEmpty)
  }

  @Test("with only urgent requests allowed an approval is posted and a form is not")
  func urgentOnly() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.focus = FocusFilter(scope: .all, urgentOnly: true)
    await rig.update([
      openRequest("srq-1", "input.form"),
      openRequest("srq-2", "approval"),
      openRequest("srq-3", "sudo"),
      openRequest("srq-4", "confirm", level: .passkey)
    ])

    #expect(
      rig.center.posted.map(\.identifier).sorted()
        == [
          RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-2"),
          RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-4")
        ])
  }

  @Test("the filter is read when the request arrives, and a request held back stays held back")
  func readOnArrival() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.focus = FocusFilter(scope: .none)
    await rig.update([openRequest("srq-1", "approval")])
    #expect(rig.center.posted.isEmpty)

    rig.knobs.focus = .unfiltered
    await rig.update([openRequest("srq-1", "approval"), openRequest("srq-2", "approval")])

    // The first was decided when it arrived; the Focus ending does not post it late.
    #expect(rig.center.posted.map(\.identifier) == [RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-2")])
  }

  @Test("the decision names the filter as the reason, and a filter never beats the permission")
  func policy() {
    func context(focusAllows: Bool, permission: PushPermission = .granted) -> LocalAlertContext {
      LocalAlertContext(
        permission: permission, enabled: true, appActive: false, chatVisible: false, focusAllows: focusAllows)
    }

    #expect(LocalAlertPolicy.decide(context(focusAllows: true)) == .post)
    #expect(LocalAlertPolicy.decide(context(focusAllows: false)) == .skip(.focusFilter))
    #expect(LocalAlertPolicy.decide(context(focusAllows: false, permission: .denied)) == .skip(.notAuthorised))
  }
}

/// "Urgent requests break through Focus", the switch in Settings → Notifications.
@MainActor
@Suite("Urgent requests break through Focus, in the controller")
struct UrgentBreakthroughTests {
  private func started(_ rig: PushControllerTests.Rig, on controller: PushController? = nil) async {
    let controller = controller ?? rig.controller
    rig.system.current = .granted
    await controller.setGateways([PushGateways.one])
    await controller.start()
  }

  @Test("it is on before anything is stored, and nothing changes before start")
  func defaultOn() async throws {
    let rig = try PushControllerTests.Rig()

    #expect(rig.controller.urgentBreaksThroughFocus)

    await rig.controller.setUrgentBreaksThroughFocus(false)
    #expect(rig.controller.urgentBreaksThroughFocus)
    #expect(try await rig.settings.value(Bool.self, forKey: StoreKeys.pushUrgentBreakthrough) == nil)

    await started(rig)
    #expect(rig.controller.urgentBreaksThroughFocus)
  }

  @Test("switching it off is stored and read again after a relaunch")
  func persists() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)

    await rig.controller.setUrgentBreaksThroughFocus(false)

    #expect(!rig.controller.urgentBreaksThroughFocus)
    #expect(!rig.controller.urgentWriteFailed)
    #expect(try await rig.settings.value(Bool.self, forKey: StoreKeys.pushUrgentBreakthrough) == false)

    let next = rig.relaunch()
    await started(rig, on: next)
    #expect(!next.urgentBreaksThroughFocus)

    await next.setUrgentBreaksThroughFocus(true)
    #expect(next.urgentBreaksThroughFocus)
    #expect(rig.relaunch().urgentBreaksThroughFocus, "a controller that has not started reads the default")
  }

  @Test("it is a choice of this device: switching it writes nothing to the preferences")
  func notAPreference() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    var announced = 0
    rig.controller.onPreferencesChanged = { announced += 1 }

    await rig.controller.setUrgentBreaksThroughFocus(false)

    #expect(announced == 0)
    #expect(rig.controller.preferences == .standard)
    #expect(try await rig.settings.string(forKey: StoreKeys.pushPreferences) == nil)
  }

  @Test("an unreadable stored value is the default, on")
  func unreadable() async throws {
    let rig = try PushControllerTests.Rig()
    try await rig.settings.setString("\"maybe\"", forKey: StoreKeys.pushUrgentBreakthrough)
    await started(rig)

    #expect(rig.controller.urgentBreaksThroughFocus)
    #expect(rig.controller.trouble == nil)
  }

  @Test("resetting the device puts it back on")
  func reset() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    await rig.controller.setUrgentBreaksThroughFocus(false)

    await rig.controller.resetDevice()

    #expect(rig.controller.urgentBreaksThroughFocus)
    #expect(try await rig.settings.value(Bool.self, forKey: StoreKeys.pushUrgentBreakthrough) == nil)
  }

  @Test("the alerts that read the controller follow the switch")
  func alertsFollow() async throws {
    let rig = try PushControllerTests.Rig()
    await started(rig)
    await rig.controller.setEnabled(true)

    let center = RecordingLocalNotifications()
    let alerts = RequestAlerts(push: rig.controller, center: center)
    alerts.presence.report(window: UUID(), active: false, key: false, chat: nil)

    alerts.update(gatewayId: "g1", gatewayKey: PushGateways.one.key, requests: [openRequest("srq-1", "approval")])
    await alerts.flush()

    await rig.controller.setUrgentBreaksThroughFocus(false)
    alerts.update(
      gatewayId: "g1", gatewayKey: PushGateways.one.key,
      requests: [openRequest("srq-1", "approval"), openRequest("srq-2", "approval")])
    await alerts.flush()

    #expect(center.posted.map(\.interruption) == [.timeSensitive, .active])
  }
}
