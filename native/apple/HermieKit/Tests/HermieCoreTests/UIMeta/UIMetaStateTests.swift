import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// The pure parts: the bookkeeping between round trips and the local copy's
/// rules, with no gateway at all.
@Suite struct UIMetaStateTests {
  private func roster(_ rows: JSONValue...) -> JSONValue {
    ["profiles": .array(rows)]
  }

  private func named(_ user: String = owner) -> UIMetaState {
    var state = UIMetaState()
    state.setUser(user)
    return state
  }

  // MARK: Reading the roster

  @Test func readsRevisionsDefensivelyAndLearnsTheDefaultProfile() {
    var state = named()
    let snapshot = state.ingest(roster: roster(
      ["name": "writer", "ui_meta": ["hermie": ["v": 1, "archived": true]], "ui_meta_revisions": ["hermie": "3"]],
      ["name": "researcher", "is_default": true, "ui_meta_revisions": [ownerKey: 4, "hermie": 2, "hermie-app": 7]],
      ["name": "", "ui_meta": ["hermie": ["v": 1]]],
      ["ui_meta": ["hermie": ["v": 1]]]
    ))

    #expect(state.mode == .synced)
    #expect(state.defaultProfile == "researcher")
    #expect(state.revision(profile: "writer", key: UIMeta.botKey) == 0)
    #expect(state.revision(profile: "researcher", key: UIMeta.botKey) == 2)
    #expect(state.revision(profile: "researcher", key: ownerKey) == 4)
    #expect(state.revision(profile: "researcher", key: UIMeta.legacyAppKey) == 7)
    #expect(snapshot.bots == ["writer": ["v": 1, "archived": true]])
    #expect(snapshot.plugin == .absent)
    #expect(!state.perUser)
  }

  @Test func takesTheDefaultProfilesAdvertOverAnyOther() {
    var state = named()
    let snapshot = state.ingest(roster: roster(
      ["name": "writer", "ui_meta": ["hermie-plugin": ["v": 1, "capabilities": ["push.expo"]]]],
      ["name": "researcher", "is_default": true, "ui_meta": ["hermie-plugin": ["v": 1, "capabilities": ["ui_meta.per_user"]]]]
    ))

    #expect(state.perUser)
    #expect(snapshot.plugin == .advert(["v": 1, "capabilities": ["ui_meta.per_user"]]))
  }

  @Test func anAdvertOfAnotherContractVersionIsNoAdvert() {
    var state = named()
    let snapshot = state.ingest(roster: roster(
      ["name": "researcher", "is_default": true, "ui_meta": ["hermie-plugin": ["v": 2, "capabilities": ["ui_meta.per_user"]]]]
    ))

    #expect(!state.perUser)
    #expect(snapshot.plugin == .absent)
  }

  @Test func readsNoAppSectionForAnUnnamedReader() {
    var state = UIMetaState()
    let snapshot = state.ingest(roster: roster(
      ["name": "researcher", "is_default": true, "ui_meta": ["hermie-app": ["v": 1, "themeChoice": "x"]]]
    ))

    #expect(snapshot.app == nil)
    #expect(!snapshot.migrated)
    #expect(state.appKey == nil)
  }

  @Test func anUnreadableAnswerIsAnEmptyRosterNotAFailure() {
    var state = named()
    let snapshot = state.ingest(roster: "nonsense")

    #expect(state.mode == .synced)
    #expect(snapshot == UIMetaSnapshot(plugin: .absent))
  }

  // MARK: Whose copy wins

  @Test func theDatesDecideTheAppSection() {
    var state = named()
    let dated: (Double) -> JSONObject = { ["v": 1, "updatedAt": .number($0)] }
    let undated: JSONObject = ["v": 1]

    // Not dirty: the gateway's, always.
    #expect(!state.appLocalWins(local: dated(2), remote: dated(1)))

    state.markApp()
    #expect(state.appLocalWins(local: dated(2), remote: dated(1)))
    #expect(!state.appLocalWins(local: dated(1), remote: dated(2)))
    #expect(!state.appLocalWins(local: dated(1), remote: dated(1)))
    #expect(state.appLocalWins(local: undated, remote: undated))
    #expect(!state.appLocalWins(local: undated, remote: dated(1)))
    #expect(state.appLocalWins(local: dated(1), remote: undated))
    #expect(state.appLocalWins(local: undated, remote: nil))
    #expect(!state.appLocalWins(local: nil, remote: undated))
  }

  @Test func aNewerLocalDateIsAnUnsentChangeExceptOnTheInheritancePull() {
    var state = named()
    let local = UIMetaSnapshot(app: ["v": 1, "updatedAt": 5])

    state.noteNewerLocalApp(remote: UIMetaSnapshot(app: ["v": 1, "updatedAt": 5]), local: local)
    #expect(!state.dirtyApp)

    state.noteNewerLocalApp(remote: UIMetaSnapshot(app: ["v": 1, "updatedAt": 4], migrated: true), local: local)
    #expect(!state.dirtyApp)

    state.noteNewerLocalApp(remote: UIMetaSnapshot(app: ["v": 1, "updatedAt": 4]), local: local)
    #expect(state.dirtyApp)
  }

  @Test func aDirtyBotSectionIsKeptAndADirtyRemovalStaysRemoved() {
    var state = named()
    state.markBot("writer")
    state.markBot("notes")

    let remote = UIMetaSnapshot(
      app: ["v": 1, "themeChoice": "remote"],
      bots: ["writer": ["v": 1, "colour": "teal"], "notes": ["v": 1, "archived": true], "other": ["v": 1]],
      plugin: .advert(["v": 1]),
      remote: ["v": 1, "themeChoice": "remote"],
      pushHome: ["v": 1, "push": [:]]
    )
    let local = UIMetaSnapshot(app: ["v": 1, "themeChoice": "local"], bots: ["writer": ["v": 1, "colour": "lime"]])
    let kept = state.withPendingKept(remote: remote, local: local)

    #expect(kept.bots == ["writer": ["v": 1, "colour": "lime"], "other": ["v": 1]])
    // The app section was not dirty: the gateway's.
    #expect(kept.app == ["v": 1, "themeChoice": "remote"])
    #expect(kept.remote == remote.app)
    #expect(kept.pushHome == remote.pushHome)
    #expect(kept.plugin == .advert(["v": 1]))
  }

  @Test func seedsWhatTheGatewayLacks() {
    var state = named()

    state.seedWhatTheGatewayLacks(
      remote: UIMetaSnapshot(bots: ["writer": ["v": 1]]),
      local: UIMetaSnapshot(app: ["v": 1], bots: ["writer": ["v": 1, "colour": "x"], "notes": ["v": 1]])
    )

    #expect(state.dirtyApp)
    #expect(state.dirtyBots == ["notes"])
  }

  // MARK: Writing

  private func ready(perUser: Bool, user: String = owner) -> UIMetaState {
    var state = named(user)
    let capabilities: JSONValue = perUser ? ["ui_meta.per_user"] : ["push.expo"]

    _ = state.ingest(roster: roster(
      ["name": "researcher", "is_default": true, "ui_meta": ["hermie-plugin": ["v": 1, "capabilities": capabilities]]],
      ["name": "writer"]
    ))
    return state
  }

  @Test func groupsTheOutboxByProfileInTheOrderItWasMarked() {
    var state = ready(perUser: true)
    state.markBot("writer")
    state.markApp()
    state.markBot("researcher")

    #expect(state.outbox().map { [$0.profile] + $0.keys } == [
      ["writer", UIMeta.botKey],
      ["researcher", UIMeta.botKey, ownerKey]
    ])
    #expect(state.outbox().allSatisfy { $0.epoch == state.epoch })

    var split = ready(perUser: false)
    split.markApp()
    #expect(split.outbox().map { [$0.profile] + $0.keys } == [["researcher", ownerKey, UIMeta.legacyAppKey]])

    var nobody = ready(perUser: true, user: "")
    nobody.markApp()
    #expect(nobody.outbox().isEmpty)
  }

  @Test func buildsTheSectionsFromTheLocalCopyAtTheMomentOfTheAttempt() {
    var state = ready(perUser: false)
    state.markApp()
    state.markBot("writer")

    let local = UIMetaSnapshot(
      app: ["v": 1, "themeChoice": "sand", "push": ["registrations": ["i": ["v": 1]]]],
      bots: [:]
    )
    let params = state.configureParams(for: UIMetaWrite(profile: "researcher", keys: [ownerKey, UIMeta.legacyAppKey]), local: local)

    #expect(params["name"] == "researcher")
    #expect(params["ui_meta"]?[ownerKey] == ["v": 1, "themeChoice": "sand"])
    #expect(params["ui_meta"]?[UIMeta.legacyAppKey] == ["v": 1, "push": ["registrations": ["i": ["v": 1]]]])
    #expect(params["ui_meta_expected_revisions"] == [ownerKey: 0, UIMeta.legacyAppKey: 0])

    let removal = state.sections(for: UIMetaWrite(profile: "writer", keys: [UIMeta.botKey]), local: local)
    #expect(removal == [UIMeta.botKey: .null])
  }

  @Test func aLegacySectionWithNothingToSayIsRemoved() {
    let state = ready(perUser: false)
    let sections = state.sections(
      for: UIMetaWrite(profile: "researcher", keys: [UIMeta.legacyAppKey]),
      local: UIMetaSnapshot(app: ["v": 1, "push": nil])
    )

    #expect(sections == [UIMeta.legacyAppKey: .null])
  }

  @Test func absorbsRevisionsAndConflicts() {
    var state = ready(perUser: true)
    state.markBot("researcher")
    state.markApp()
    let write = state.stamped(UIMetaWrite(profile: "researcher", keys: [UIMeta.botKey, ownerKey], epoch: state.epoch))

    let refused = state.absorb([
      "applied": [
        "ui_meta_revisions": ["hermie": 3, ownerKey: 1],
        "ui_meta_conflicts": [ownerKey: ["expected": 0, "actual": 5], "ignored": ["expected": 0]]
      ]
    ], for: write)

    #expect(refused == .conflicted)
    #expect(state.revision(profile: "researcher", key: UIMeta.botKey) == 3)
    #expect(state.revision(profile: "researcher", key: ownerKey) == 5)
    // Nothing is clean until the whole write lands.
    #expect(state.pending)

    let landed = state.absorb(["applied": ["ui_meta_revisions": [ownerKey: 6]]], for: state.stamped(write))
    #expect(landed == .landed)
    #expect(!state.pending)
  }

  @Test func resetForgetsEverythingButMovesTheEpochOn() {
    var state = ready(perUser: true)
    state.markApp()
    let epoch = state.epoch
    state.reset()

    #expect(!state.pending)
    #expect(state.userID.isEmpty)
    #expect(state.defaultProfile == nil)
    #expect(state.revision(profile: "researcher", key: ownerKey) == 0)
    #expect(state.epoch == epoch + 1)
  }

  // MARK: Marks and epochs

  @Test func aWriteCleansOnlyWhatItCarried() {
    var state = ready(perUser: true)
    state.markBot("writer")
    state.markApp()

    let botWrite = state.stamped(UIMetaWrite(profile: "writer", keys: [UIMeta.botKey], epoch: state.epoch))
    let appWrite = state.stamped(UIMetaWrite(profile: "researcher", keys: [ownerKey], epoch: state.epoch))

    // Edited again while both were out.
    state.markBot("writer")
    state.markApp()

    #expect(state.absorb(["applied": [:]], for: botWrite) == .landed)
    #expect(state.absorb(["applied": [:]], for: appWrite) == .landed)
    #expect(state.dirtyBots == ["writer"])
    #expect(state.dirtyApp)

    let again = state.stamped(UIMetaWrite(profile: "writer", keys: [UIMeta.botKey], epoch: state.epoch))
    #expect(state.absorb(["applied": [:]], for: again) == .landed)
    #expect(state.dirtyBots.isEmpty)
  }

  @Test func aWriteFromAnEarlierEpochChangesNothing() {
    var state = ready(perUser: true, user: "alice")
    state.markApp()

    let write = state.stamped(UIMetaWrite(profile: "researcher", keys: [UIMeta.appKey(for: "alice")], epoch: state.epoch))

    state.setUser("bob")
    state.markApp()

    let before = state
    #expect(!state.isCurrent(write))
    #expect(state.absorb(["applied": ["ui_meta_revisions": ["hermie-app:alice": 9]]], for: write) == .stale)
    #expect(state == before)
  }

  // MARK: The local copy

  @Test func anArrivingSectionLeavesTheKnownAbsentFieldsAloneAndAdoptsItsDate() {
    var documents = UIMetaDocuments(
      app: ["v": 1, "pinned": ["writer"], "labels": ["writer": "W"], "mutes": ["a": 1], "themeChoice": "old", "updatedAt": 9],
      bots: ["writer": ["v": 1, "archived": true]]
    )

    documents.take(UIMetaSnapshot(
      app: ["v": 1, "themeChoice": "new", "labels": [:], "mutes": nil],
      bots: ["notes": ["v": 1, "colour": "teal"]]
    ))

    #expect(documents.app == ["v": 1, "pinned": ["writer"], "labels": [:], "mutes": ["a": 1], "themeChoice": "new"])
    #expect(documents.bots == ["notes": ["v": 1, "colour": "teal"]])
  }

  /// Unknown fields mirror the arriving section: carried while it carries them,
  /// gone once it does not, so a client can remove a field a device here holds.
  @Test func aFieldTheArrivingSectionDroppedIsGoneAndARetiredOneIsNeverHeld() {
    var documents = UIMetaDocuments(app: ["v": 1, "fromTheFuture": 1, "themeChoice": "a"])

    documents.take(UIMetaSnapshot(app: ["v": 1, "themeChoice": "b", "context": ["users": [:]], "other": true]))
    #expect(documents.app == ["v": 1, "themeChoice": "b", "other": true])

    // Nothing arrived: the held section stays, still without the retired field.
    documents.app?["context"] = ["users": [:]]
    documents.take(UIMetaSnapshot())
    #expect(documents.app == ["v": 1, "themeChoice": "b", "other": true])
  }

  @Test func aWinningLocalCopyTakesTheGatewaysValueForAKnownFieldItNeverSet() {
    let local: JSONObject = ["v": 1, "textSize": "large", "updatedAt": 9]
    var documents = UIMetaDocuments(app: local)

    documents.take(UIMetaSnapshot(app: local, remote: ["v": 1, "themeChoice": "lime", "unknown": 1, "updatedAt": 8]))

    // Known and silent here: the gateway's. Unknown: the winner's (none).
    #expect(documents.app == ["v": 1, "textSize": "large", "themeChoice": "lime", "updatedAt": 9])
  }

  @Test func theDevicesOwnPushCopyIsNeverAFallback() {
    // Local wins (the snapshot's app IS the local copy) on a gateway with no
    // section: the stale foreign rows the device held must not go back out.
    let local: JSONObject = ["v": 1, "themeChoice": "a", "push": ["registrations": ["gone": ["v": 1]]]]
    var documents = UIMetaDocuments(app: local)

    documents.take(UIMetaSnapshot(app: local, remote: nil, pushHome: nil))

    #expect(documents.app == ["v": 1, "themeChoice": "a"])
  }

  @Test func thePersistedCopyHasNoPushRows() {
    let documents = UIMetaDocuments(app: ["v": 1, "push": ["registrations": ["i": ["sendSecret": "s"]]], "textSize": "large"])

    #expect(documents.persistable.app == ["v": 1, "textSize": "large"])
  }

  @Test func thePushRowsComeFromWhereTheNotifierLooks() {
    var documents = UIMetaDocuments(app: ["v": 1, "push": ["registrations": ["stale": [:]]]])

    documents.take(UIMetaSnapshot(
      app: ["v": 1, "push": ["registrations": ["merged": [:]]]],
      remote: ["v": 1, "push": ["registrations": ["remote": [:]]]],
      pushHome: ["v": 1, "push": ["registrations": ["home": [:]]]]
    ))
    #expect(documents.app?["push"] == ["registrations": ["home": [:]]])

    documents.take(UIMetaSnapshot(app: ["v": 1], remote: ["v": 1, "push": ["registrations": ["remote": [:]]]]))
    #expect(documents.app?["push"] == ["registrations": ["remote": [:]]])

    // No section anywhere: the held arrangement stays, without rows nobody holds.
    documents.take(UIMetaSnapshot())
    #expect(documents.app == ["v": 1])
  }

  @Test func aChoiceIsDatedAndAChoreOrAPushRowIsNot() {
    var documents = UIMetaDocuments(app: ["v": 1, "themeChoice": "a", "updatedAt": .number(noon + 10)])

    // Never earlier than the date held: a clock that runs behind still moves it on.
    let changed1 = documents.editApp(.choice, now: noon) { $0["themeChoice"] = "b" }
    #expect(changed1)
    #expect(documents.app?["updatedAt"] == .number(noon + 11))

    let changed2 = documents.editApp(.choice, now: noon + 100) { $0["themeChoice"] = "c" }
    #expect(changed2)
    #expect(documents.app?["updatedAt"] == .number(noon + 100))

    let changed3 = documents.editApp(.chore, now: noon + 200) { $0["entries"] = ["x"] }
    #expect(changed3)
    #expect(documents.app?["updatedAt"] == .number(noon + 100))

    let changed4 = documents.editApp(.choice, now: noon + 300) { $0["push"] = ["registrations": [:]] }
    #expect(changed4)
    #expect(documents.app?["updatedAt"] == .number(noon + 100))

    // The same value again changes nothing and dates nothing.
    let changed5 = documents.editApp(.choice, now: noon + 400) { $0["themeChoice"] = "c" }
    #expect(!changed5)
  }

  @Test func aBotSectionKeepsWhatItCarriedAndGoesWhenEmpty() {
    var documents = UIMetaDocuments(bots: ["writer": ["v": 1, "colour": "teal", "pattern": "dots"]])

    let changed6 = documents.editBot("writer") { $0.removeValue(forKey: "colour") }
    #expect(changed6)
    #expect(documents.bots["writer"] == ["v": 1, "pattern": "dots"])

    let changed7 = documents.editBot("writer") { $0.removeValue(forKey: "pattern") }
    #expect(changed7)
    #expect(documents.bots["writer"] == nil)

    let changed8 = documents.editBot("writer") { _ in }
    #expect(!changed8)
  }
}
