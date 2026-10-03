import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// A bot's name and colour in `ui_meta`: the label is the person's own (the app section's
/// `labels`), the colour is the bot's (its `hermie` section's `colour`), and both are written the
/// way the Expo app writes them (`setLabel` and `setAccent` in `store/chat-layout.ts`).
@Suite(.timeLimit(.minutes(1))) struct UIMetaBotIdentityTests {
  // MARK: Reading

  @Test func readsLabelsAndColoursOffTheDevicesCopy() {
    let documents = UIMetaDocuments(
      app: ["v": 1, "labels": ["writer": "De Schrijver", "researcher": "", "scout": 7]],
      bots: [
        "writer": ["v": 1, "colour": "teal", "archived": true],
        "researcher": ["v": 1, "colour": "chartreuse"],
        "scout": ["v": 1, "colour": 4]
      ]
    )
    let arrangement = ChatListArrangement(documents: documents)

    // Only names that are text and not empty; only colours this build knows.
    #expect(arrangement.labels == ["writer": "De Schrijver"])
    #expect(arrangement.accents == ["writer": .teal])
    #expect(arrangement.label("writer") == "De Schrijver")
    #expect(arrangement.label("researcher") == nil)
    #expect(arrangement.accent("writer") == .teal)
    #expect(arrangement.accent("researcher") == .default)
  }

  // MARK: Writing

  @Test func aLabelIsTrimmedCutAndAnEmptyOneTakesTheNameBack() {
    var app: JSONObject = ["v": 1, "labels": ["scout": "Old"]]

    BotIdentity.setLabel("writer", "  De Schrijver \n", in: &app)
    #expect(app["labels"] == ["scout": "Old", "writer": "De Schrijver"])

    BotIdentity.setLabel("writer", String(repeating: "x", count: 100), in: &app)
    #expect(app["labels"]?["writer"]?.stringValue?.count == BotIdentity.labelLimit)

    BotIdentity.setLabel("writer", "   ", in: &app)
    // Kept as an empty map once the last is gone: an absent field would mean "this build
    // knows nothing about labels", and the name would stay on every other device.
    BotIdentity.setLabel("scout", "", in: &app)
    #expect(app["labels"] == [:])
  }

  @Test func theDefaultColourIsStoredAsNothing() {
    var section: JSONObject = ["v": 1, "archived": true, "colour": "teal"]

    BotIdentity.setAccent(.orange, in: &section)
    #expect(section["colour"] == "orange")

    BotIdentity.setAccent(.default, in: &section)
    #expect(section == ["v": 1, "archived": true])
  }

  @Test func everyColourHasASwatchAndAWhiteTextBackground() {
    #expect(BotAccent.allCases.count == 11)
    #expect(BotAccent.allCases.first == .default)

    for accent in BotAccent.allCases {
      #expect(accent.fillHex <= 0xFFFFFF)
      #expect(accent.bubbleHex <= 0xFFFFFF)
    }
  }

  // MARK: Round trip

  @MainActor
  @Test func aLabelAndAColourReachTheOtherDeviceAndLeaveTheRestOfTheSectionAlone() async {
    let gateway = HoldingGateway()
    gateway.write("writer", [UIMeta.botKey: ["v": 1, "archived": true]])

    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })

    phone.attach(phoneSync)
    mac.attach(macSync)
    await phoneSync.reconcile()
    await macSync.reconcile()

    phone.setLabel("writer", "  De Schrijver ")
    phone.setAccent("writer", .violet)

    // Painted at once, before anything is sent.
    #expect(phone.label("writer") == "De Schrijver")
    #expect(phone.accent("writer") == .violet)

    await phoneSync.reconcile()
    await macSync.reconcile()
    await botSettingsEventually("the Mac to follow") { mac.label("writer") == "De Schrijver" }
    #expect(mac.accent("writer") == .violet)

    // The label is the person's own section; the colour is the bot's, beside the flag already there.
    #expect(gateway.meta("researcher")[ownerKey]?["labels"] == ["writer": "De Schrijver"])
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true, "colour": "violet"])

    // Taking both back removes the choices, not the flag that was not ours.
    mac.setLabel("writer", "")
    mac.setAccent("writer", .default)
    await macSync.reconcile()
    await phoneSync.reconcile()
    await botSettingsEventually("the phone to follow") { phone.label("writer") == nil }
    #expect(phone.accent("writer") == .default)
    #expect(gateway.meta("writer")[UIMeta.botKey] == ["v": 1, "archived": true])
  }

  @MainActor
  @Test func withoutASyncNothingIsWritten() {
    let model = ChatArrangementModel(now: { noon })

    model.setLabel("writer", "x")
    model.setAccent("writer", .red)

    #expect(!model.canEdit)
    #expect(model.label("writer") == nil)
    #expect(model.accent("writer") == .default)
  }
}
