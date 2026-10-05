import Foundation
import HermieProtocol
import HermieShared
import Testing

@testable import HermieCore

/// A local notification centre that records what it was asked and shows what would be delivered:
/// the same identifier replaces. It never touches `UNUserNotificationCenter`.
@MainActor
final class RecordingLocalNotifications: LocalNotificationCenter {
  private(set) var posted: [LocalNotificationContent] = []
  private(set) var removals: [[String]] = []
  /// What the system would still show, by identifier.
  private(set) var delivered: [String: LocalNotificationContent] = [:]

  func post(_ content: LocalNotificationContent) async {
    posted.append(content)
    delivered[content.identifier] = content
  }

  func remove(identifiers: [String]) async {
    removals.append(identifiers)

    for identifier in identifiers {
      delivered[identifier] = nil
    }
  }
}

/// What the reader chose, as a test turns it.
@MainActor
final class AlertKnobs {
  var settings = LocalAlertSettings(permission: .granted, enabled: true, preferences: .standard)
  /// The Focus filter in effect: none until a test sets one.
  var focus = FocusFilter.unfiltered
  var muted: Set<String> = []
  private(set) var badges: [Int] = []
  private(set) var bounces = 0

  func badge(_ count: Int) { badges.append(count) }
  func bounce() { bounces += 1 }
}

@MainActor
struct AlertRig {
  let center = RecordingLocalNotifications()
  let knobs = AlertKnobs()
  let alerts: RequestAlerts
  let window = UUID()

  init(entitled: Bool = RequestAlerts.timeSensitiveEntitled) {
    let center = self.center
    let knobs = self.knobs

    alerts = RequestAlerts(
      center: center,
      settings: { knobs.settings },
      isMuted: { gateway, bot in knobs.muted.contains("\(gateway)/\(bot)") },
      setBadge: { knobs.badge($0) },
      requestDockAttention: { knobs.bounce() },
      timeSensitive: entitled,
      focusFilter: { knobs.focus }
    )
  }

  /// The app in the background: no window is active.
  func background() {
    alerts.presence.report(window: window, active: false, key: false, chat: nil)
  }

  /// The app in front, with `chat` on screen in the key window.
  func front(showing chat: AppPresence.Chat? = nil, key: Bool = true) {
    alerts.presence.report(window: window, active: true, key: key, chat: chat)
  }

  func update(_ requests: [OpenRequest], gateway: String = "g1", key: String = PushGateways.one.key, authoritative: Bool = true) async {
    alerts.update(gatewayId: gateway, gatewayKey: key, requests: requests, authoritative: authoritative)
    await alerts.flush()
  }
}

func openRequest(
  _ id: String = "srq-1",
  _ method: String = "input.form",
  chat: String = "scout",
  gateway: String = "g1",
  text: String = "",
  level: PushConfirmLevel? = nil,
  session: String = "rt-1"
) -> OpenRequest {
  OpenRequest(
    gatewayId: gateway, chat: chat, chatName: chat.capitalized, method: method, requestId: id, sessionId: session,
    level: level, text: text)
}

/// A local notification for a request that arrives while the app is not in front: when, what it says,
/// how it is named, when it goes away, and where a tap lands.
@MainActor
@Suite("Local notifications for requests")
struct RequestAlertsTests {
  // MARK: The decision

  private func context(
    permission: PushPermission = .granted,
    enabled: Bool = true,
    preferences: PushPreferences = .standard,
    muted: Bool = false,
    appActive: Bool = false,
    chatVisible: Bool = false
  ) -> LocalAlertContext {
    LocalAlertContext(
      permission: permission, enabled: enabled, preferences: preferences, muted: muted, appActive: appActive,
      chatVisible: chatVisible)
  }

  @Test("in the background a request is posted")
  func backgroundPosts() {
    #expect(LocalAlertPolicy.decide(context()) == .post)
  }

  @Test("in front with the chat on screen nothing is posted; in front on another chat it is")
  func visibleChat() {
    #expect(LocalAlertPolicy.decide(context(appActive: true, chatVisible: true)) == .skip(.chatInFront))
    #expect(LocalAlertPolicy.decide(context(appActive: true, chatVisible: false)) == .post)
    // A chat that is on screen in a window the person is not in is not looked at.
    #expect(LocalAlertPolicy.decide(context(appActive: false, chatVisible: true)) == .post)
  }

  @Test("without the system's permission or with the switch off nothing is posted, and nothing is asked")
  func permissionAndSwitch() {
    #expect(LocalAlertPolicy.decide(context(permission: .undetermined)) == .skip(.notAuthorised))
    #expect(LocalAlertPolicy.decide(context(permission: .denied)) == .skip(.notAuthorised))
    #expect(LocalAlertPolicy.decide(context(enabled: false)) == .skip(.switchedOff))
  }

  @Test("the reader's switch for requests decides; the others do not")
  func typeSwitch() {
    #expect(
      LocalAlertPolicy.decide(context(preferences: PushPreferences.standard.setting("request", false)))
        == .skip(.typeOff))

    let others = PushContract.types.filter { $0 != "request" }.reduce(PushPreferences.standard) { $0.setting($1, false) }
    #expect(LocalAlertPolicy.decide(context(preferences: others)) == .post, "a request has its own switch")
  }

  @Test("a mute never silences a request, as for a remote one")
  func muteDoesNotSilence() {
    #expect(LocalAlertPolicy.decide(context(muted: true)) == .post)
    #expect(
      LocalAlertPolicy.decide(context(preferences: PushPreferences.standard.setting("request", false), muted: true))
        == .skip(.typeOff))
  }

  // MARK: Where the person is

  @Test("the app is in front while any window is active; a chat is seen only in a key window")
  func presence() {
    let presence = AppPresence()
    let main = UUID()
    let other = UUID()
    let scout = AppPresence.Chat(gatewayId: "g1", bot: "scout")
    let ops = AppPresence.Chat(gatewayId: "g1", bot: "ops")

    #expect(!presence.isActive)

    presence.report(window: main, active: true, key: true, chat: scout)
    presence.report(window: other, active: true, key: false, chat: ops)
    #expect(presence.isActive)
    #expect(presence.isVisible(scout))
    #expect(!presence.isVisible(ops), "visible but not key: the person is typing elsewhere")
    #expect(!presence.isVisible(AppPresence.Chat(gatewayId: "g2", bot: "scout")), "another gateway's scout")

    presence.report(window: main, active: false, key: false, chat: scout)
    #expect(presence.isActive, "the second window is still active")
    #expect(!presence.isVisible(scout))

    presence.windowClosed(other)
    #expect(!presence.isActive)
  }

  // MARK: What it says

  private static let english = RequestAlertCopy.english

  @Test("previews off: every kind says only that it needs attention, and nothing of its own")
  func previewOff() {
    for method in PushRequestMethod.allCases {
      let request = openRequest("srq-9", method.rawValue, text: "rm -rf the-secret-folder", level: .passkey)
      let content = RequestAlertContent.make(
        request, gatewayKey: PushGateways.one.key, preview: false, copy: Self.english, interruption: .active,
        badge: 1)

      #expect(content.body == "Needs your attention", "\(method)")
      #expect(!content.body.contains("secret"), "\(method)")
      #expect(content.title == "Scout")
    }
  }

  @Test("previews on: every kind says the contract's words for it")
  func contractWords() throws {
    guard case .array(let examples)? = try ContractFiles.json("push/contract.json")["examples"]?["list"] else {
      Issue.record("no examples")
      return
    }

    var checked: Set<String> = []

    for example in examples {
      let data = example["data"]?.objectValue ?? [:]

      guard data["type"] == .string("request"), data["clear"] != .bool(true),
        let method = data["method"]?.stringValue, let body = example["body"]?.stringValue
      else {
        continue
      }

      let level = data["level"]?.stringValue.flatMap(PushConfirmLevel.init(rawValue:))
      let request = openRequest("srq-1", method, level: level)
      let content = RequestAlertContent.make(
        request, gatewayKey: PushGateways.one.key, preview: true, copy: Self.english, interruption: .active,
        badge: nil)

      #expect(content.body == body, "\(example["name"]?.stringValue ?? method)")
      checked.insert(method)
    }

    #expect(checked == Set(PushRequestMethod.allCases.map(\.rawValue)), "every method has an example")
  }

  @Test("only an approval or a clarify carries its own words, and only when previews are on")
  func ownWords() {
    let secrets = "the password is hunter2"

    for method in PushRequestMethod.allCases {
      let request = openRequest("srq-1", method.rawValue, text: secrets)
      let on = RequestAlertContent.body(for: request, preview: true, copy: Self.english)
      let off = RequestAlertContent.body(for: request, preview: false, copy: Self.english)

      #expect(!off.contains("hunter2"), "\(method) with previews off")

      if method.carriesPreview {
        #expect(on == "\(Self.english.phrase(method, nil)): \(secrets)", "\(method)")
      } else {
        #expect(on == Self.english.phrase(method, nil), "\(method) never carries text")
        #expect(!on.contains("hunter2"), "\(method)")
      }
    }

    #expect(PushRequestMethod.allCases.filter(\.carriesPreview) == [.approval, .clarify])
  }

  @Test("an approval's line is one clean, bounded line")
  func lineIsCleaned() {
    let text = "Run\u{202E}the build\nand then\u{0007} " + String(repeating: "x", count: 400)
    let body = RequestAlertContent.body(
      for: openRequest("appr-1", "approval", text: text), preview: true, copy: Self.english)

    #expect(!body.contains("\n"))
    #expect(!body.contains("\u{202E}"))
    #expect(!body.contains("\u{0007}"))
    #expect(body.hasPrefix("Needs your approval: Run"))
    #expect(body.count <= "Needs your approval: ".count + RequestAlertContent.textLimit + 1)
    #expect(body.hasSuffix("…"))
  }

  @Test("an approval with no line says what it is; a request of a kind this build does not know says it needs attention")
  func fallbacks() {
    #expect(
      RequestAlertContent.body(for: openRequest("appr-1", "approval"), preview: true, copy: Self.english)
        == "Needs your approval")
    #expect(
      RequestAlertContent.body(for: openRequest("srq-1", "something.new", text: "x"), preview: true, copy: Self.english)
        == "Needs your attention")
  }

  // MARK: How it is named, grouped and acted on

  @Test("the data bag has ids and kinds only, in the contract's keys, and nothing the request said")
  func bagHasOnlyIds() {
    let request = openRequest("appr-1", "approval", text: "rm -rf /", level: nil, session: "rt-9")
    let bag = RequestAlertContent.bag(request, gatewayKey: PushGateways.one.key)

    #expect(Set(bag.keys).isSubset(of: PushPayload.readKeys))
    #expect(bag["type"] == "request")
    #expect(bag["bot"] == "scout")
    #expect(bag["method"] == "approval")
    #expect(bag["requestId"] == "appr-1")
    #expect(bag["sessionId"] == "rt-9")
    #expect(bag["gatewayKey"] == .string(PushGateways.one.key))
    #expect(!String(describing: bag).contains("rm -rf"))

    let confirm = RequestAlertContent.bag(
      openRequest("srq-2", "confirm", level: .passkey), gatewayKey: "not-a-key")
    #expect(confirm["level"] == "passkey")
    #expect(confirm["gatewayKey"] == nil, "a key that is not one is not written")
  }

  @Test("an approval with an id carries Allow and Deny; nothing else does")
  func categories() {
    func category(_ method: String, id: String = "x-1") -> String? {
      RequestAlertContent.make(
        openRequest(id, method), gatewayKey: PushGateways.one.key, preview: false, copy: Self.english,
        interruption: .active, badge: nil
      ).categoryIdentifier
    }

    #expect(category("approval") == PushContract.requestCategory)
    #expect(category("approval", id: "") == nil, "the actions need an id to answer")

    for method in PushRequestMethod.allCases where method != .approval {
      #expect(category(method.rawValue) == nil, "\(method)")
    }
  }

  @Test("the identifier is scoped to the gateway and built from the request id; the thread is the chat's")
  func identifiersAndThreads() {
    let one = RequestAlertContent.make(
      openRequest("srq-1", gateway: "g1"), gatewayKey: PushGateways.one.key, preview: false, copy: Self.english,
      interruption: .active, badge: nil)
    let again = RequestAlertContent.make(
      openRequest("srq-1", gateway: "g1"), gatewayKey: PushGateways.one.key, preview: true, copy: Self.english,
      interruption: .active, badge: nil)
    let other = RequestAlertContent.make(
      openRequest("srq-1", gateway: "g2"), gatewayKey: PushGateways.two.key, preview: false, copy: Self.english,
      interruption: .active, badge: nil)
    let sibling = RequestAlertContent.make(
      openRequest("srq-2", gateway: "g1"), gatewayKey: PushGateways.one.key, preview: false, copy: Self.english,
      interruption: .active, badge: nil)

    #expect(one.identifier == again.identifier)
    #expect(one.identifier != other.identifier, "the gateways count their ids from the start")
    #expect(one.identifier != sibling.identifier)
    #expect(one.threadIdentifier == sibling.threadIdentifier, "one thread per chat")
    #expect(one.threadIdentifier != other.threadIdentifier)
    #expect(one.title == "Scout")
    #expect(one.interruption == .active)
  }

  // MARK: Posting and taking away

  @Test("a request that arrives in the background is posted once, and the same request again is not a second one")
  func postsOnce() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1", "input.form")])
    await rig.update([openRequest("srq-1", "input.form")])

    #expect(rig.center.posted.count == 1)
    #expect(rig.center.posted[0].body == "Needs your attention")
    #expect(rig.alerts.postedIdentifiers == [rig.center.posted[0].identifier])
    #expect(rig.center.posted[0].badge == 1)
  }

  @Test("the same request in two lists (a card and a prompt) is one notification")
  func oneRequestOnce() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1"), openRequest("srq-1")])

    #expect(rig.center.posted.count == 1)
  }

  @Test("answered, cancelled, expired or answered elsewhere: the notification goes when the request does")
  func goesWhenOver() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1"), openRequest("srq-2", "confirm", level: .passkey)])
    let first = RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-1")
    let second = RequestAlertContent.identifier(gatewayId: "g1", requestId: "srq-2")
    #expect(Set(rig.center.delivered.keys) == [first, second])
    #expect(rig.center.posted.map(\.badge) == [1, 2])

    await rig.update([openRequest("srq-2", "confirm", level: .passkey)])
    #expect(Set(rig.center.delivered.keys) == [second], "the first is over")
    #expect(rig.center.removals == [[first]])
    #expect(rig.knobs.badges == [1], "the badge follows what is left, while in the background")

    await rig.update([])
    #expect(rig.center.delivered.isEmpty)
    #expect(rig.alerts.postedIdentifiers.isEmpty)
    #expect(rig.knobs.badges == [1, 0])
  }

  @Test("a list read while the connection is not ready does not take a notification away")
  func notAuthoritative() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1")])
    await rig.update([], authoritative: false)
    #expect(rig.center.removals.isEmpty)
    #expect(rig.center.delivered.count == 1)

    await rig.update([])
    #expect(rig.center.delivered.isEmpty)
  }

  @Test("a request that comes back after it was over is posted again")
  func comesBack() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1")])
    await rig.update([])
    await rig.update([openRequest("srq-1")])

    #expect(rig.center.posted.count == 2)
    #expect(rig.center.delivered.count == 1)
  }

  @Test("the session ending takes its notifications away, and another gateway's stay")
  func sessionEnds() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1", gateway: "g1")], gateway: "g1")
    await rig.update([openRequest("srq-1", gateway: "g2")], gateway: "g2", key: PushGateways.two.key)
    #expect(rig.center.delivered.count == 2, "the same request id on two gateways is two notifications")

    rig.alerts.sessionEnded(gatewayId: "g1")
    await rig.alerts.flush()

    #expect(Set(rig.center.delivered.keys) == [RequestAlertContent.identifier(gatewayId: "g2", requestId: "srq-1")])
  }

  @Test("an update of one gateway never takes another gateway's notification away")
  func gatewaysAreSeparate() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1", gateway: "g2")], gateway: "g2", key: PushGateways.two.key)
    await rig.update([], gateway: "g1")

    #expect(rig.center.delivered.count == 1)
  }

  @Test("in front the badge is left alone when a notification goes")
  func badgeInFront() async {
    let rig = AlertRig()
    rig.background()
    await rig.update([openRequest("srq-1")])

    rig.front()
    await rig.update([])

    #expect(rig.center.delivered.isEmpty)
    #expect(rig.knobs.badges.isEmpty, "the app zeroes the badge when it comes to the front")
  }

  @Test("a request that arrived while the person was looking is never posted afterwards")
  func notPostedLater() async {
    let rig = AlertRig()
    rig.front(showing: AppPresence.Chat(gatewayId: "g1", bot: "scout"))

    await rig.update([openRequest("srq-1", chat: "scout")])
    #expect(rig.center.posted.isEmpty)

    rig.background()
    await rig.update([openRequest("srq-1", chat: "scout")])
    #expect(rig.center.posted.isEmpty, "it was seen")

    // The next request is a new one.
    await rig.update([openRequest("srq-1", chat: "scout"), openRequest("srq-2", chat: "scout")])
    #expect(rig.center.posted.count == 1)
  }

  @Test("in front on another chat the request is posted; a window that is not key does not count as looking")
  func otherChatInFront() async {
    let rig = AlertRig()
    rig.front(showing: AppPresence.Chat(gatewayId: "g1", bot: "ops"))
    await rig.update([openRequest("srq-1", chat: "scout")])
    #expect(rig.center.posted.count == 1)

    rig.front(showing: AppPresence.Chat(gatewayId: "g1", bot: "scout"), key: false)
    await rig.update([openRequest("srq-1", chat: "scout"), openRequest("srq-2", chat: "scout")])
    #expect(rig.center.posted.count == 2, "the window showing it is not the one in use")
  }

  @Test("the reader's choices are read when the request arrives: off, no permission, no type")
  func settingsAreRead() async {
    let rig = AlertRig()
    rig.background()

    rig.knobs.settings.enabled = false
    await rig.update([openRequest("srq-1")])

    rig.knobs.settings.enabled = true
    rig.knobs.settings.permission = .denied
    await rig.update([openRequest("srq-1"), openRequest("srq-2")])

    rig.knobs.settings.permission = .undetermined
    await rig.update([openRequest("srq-1"), openRequest("srq-2"), openRequest("srq-3")])

    rig.knobs.settings.permission = .granted
    rig.knobs.settings.preferences = PushPreferences.standard.setting("request", false)
    await rig.update([openRequest("srq-1"), openRequest("srq-2"), openRequest("srq-3"), openRequest("srq-4")])

    #expect(rig.center.posted.isEmpty)
    #expect(rig.alerts.postedIdentifiers.isEmpty)

    rig.knobs.settings.preferences = .standard
    await rig.update([openRequest("srq-5")])
    #expect(rig.center.posted.map(\.body) == ["Needs your attention"])
  }

  @Test("a muted chat's request is still posted")
  func mutedChat() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.muted = ["g1/scout"]

    await rig.update([openRequest("srq-1", chat: "scout")])

    #expect(rig.center.posted.count == 1)
  }

  @Test("previews follow the reader's switch when the request arrives")
  func previewsFollowTheSwitch() async {
    let rig = AlertRig()
    rig.background()
    rig.knobs.settings.preferences = PushPreferences(types: PushRows.defaultTypes, preview: true)

    await rig.update([openRequest("appr-1", "approval", text: "Install the update")])

    #expect(rig.center.posted.first?.body == "Needs your approval: Install the update")
  }

  @Test("only a confirmation bounces the Dock icon, and only when it is posted")
  func dockBounce() async {
    let rig = AlertRig()
    rig.background()

    await rig.update([openRequest("srq-1", "input.form"), openRequest("srq-2", "sudo")])
    #expect(rig.knobs.bounces == 0)

    await rig.update(
      [openRequest("srq-1", "input.form"), openRequest("srq-2", "sudo"), openRequest("srq-3", "confirm", level: .passkey)])
    #expect(rig.knobs.bounces == 1)

    rig.knobs.settings.enabled = false
    await rig.update(
      [openRequest("srq-3", "confirm"), openRequest("srq-4", "confirm", level: .plain)])
    #expect(rig.knobs.bounces == 1, "a request that is not posted bounces nothing")
  }

  @Test("a notification for a request that is not urgent is posted at the active level")
  func interruptionLevel() async {
    #expect(RequestAlerts.timeSensitiveEntitled)

    let rig = AlertRig()
    rig.background()
    await rig.update([openRequest("srq-1")])

    #expect(rig.center.posted.first?.interruption == .active)

    let entitled = RequestAlertContent.make(
      openRequest(), gatewayKey: "", preview: false, copy: Self.english, interruption: .timeSensitive, badge: nil)
    #expect(entitled.interruption == .timeSensitive)
  }
}
