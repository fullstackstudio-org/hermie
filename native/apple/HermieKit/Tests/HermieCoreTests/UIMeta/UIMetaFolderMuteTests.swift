import Foundation
import HermieProtocol
import Testing

@testable import HermieCore

/// A folder's mute is its chats': the row menu's spans applied to all of them at once, and "Unmute"
/// where every one is already silent.
@Suite struct UIMetaFolderMuteTests {
  private func layout(_ bots: [String]) -> ChatLayout {
    ChatLayout(
      entries: [.folder("f1"), .chat("alpha")],
      folders: [ChatFolder(id: "f1", name: "Work", bots: bots), ChatFolder(id: "f2", name: "Empty", bots: [])])
  }

  // MARK: Reading

  @Test func aFolderIsSilentUntilTheSoonestOfItsChatsWhenEveryOneIsSilent() {
    let arrangement = ChatListArrangement(
      mutes: ["writer": noon + 2 * hour, "scout": noon + hour], layout: layout(["writer", "scout"]))

    #expect(arrangement.folderMutedUntil("f1", now: noon) == noon + hour)
    // After the soonest lapses one chat is not silent, so the folder is not.
    #expect(arrangement.folderMutedUntil("f1", now: noon + hour) == nil)
  }

  @Test func aFolderWhoseChatsAreSilentForGoodIsSilentForGood() {
    let arrangement = ChatListArrangement(
      mutes: ["writer": 0, "scout": 0], layout: layout(["writer", "scout"]))

    #expect(arrangement.folderMutedUntil("f1", now: noon) == MuteDuration.foreverDeadline)
  }

  @Test func foreverAndADeadlineTogetherAreTheDeadline() {
    let arrangement = ChatListArrangement(
      mutes: ["writer": 0, "scout": noon + hour], layout: layout(["writer", "scout"]))

    #expect(arrangement.folderMutedUntil("f1", now: noon) == noon + hour)
  }

  @Test func oneChatThatIsNotSilentMakesTheFolderNotSilent() {
    let arrangement = ChatListArrangement(mutes: ["writer": 0], layout: layout(["writer", "scout"]))

    #expect(arrangement.folderMutedUntil("f1", now: noon) == nil)
  }

  @Test func aFolderWithNothingInItIsNotSilentAndNeitherIsOneThatDoesNotExist() {
    let arrangement = ChatListArrangement(mutes: ["writer": 0], layout: layout(["writer"]))

    #expect(arrangement.folderMutedUntil("f2", now: noon) == nil)
    #expect(arrangement.folderMutedUntil("gone", now: noon) == nil)
  }

  // MARK: Writing

  @Test func oneWriteMutesEveryChatAndLeavesTheRestAlone() {
    var app: JSONObject = ["v": 1, "mutes": ["scout": 5], "pinned": ["writer"]]

    ChatListArrangement.setMutes(["writer", "scout"], until: 1_789_953_600.9, in: &app)

    #expect(app["mutes"] == ["writer": 1_789_953_600, "scout": 1_789_953_600])
    #expect(app["pinned"] == ["writer"])

    ChatListArrangement.setMutes(["writer"], until: nil, in: &app)
    #expect(app["mutes"] == ["scout": 1_789_953_600])
  }

  @MainActor
  @Test func theMenusSpansReachEveryChatInTheFolderAndTheOtherDevice() async {
    let gateway = HoldingGateway()
    let phoneSync = UIMetaSync.device(gateway.gateway)
    let macSync = UIMetaSync.device(gateway.gateway)
    let phone = ChatArrangementModel(now: { noon })
    let mac = ChatArrangementModel(now: { noon })

    phone.attach(phoneSync)
    mac.attach(macSync)
    await phoneSync.reconcile()
    await macSync.reconcile()

    let roster = ["alpha", "writer", "scout"]
    let folder = phone.newFolder("Work", containing: "writer", roster: roster)
    let id = folder ?? ""
    phone.move("scout", toFolder: id, roster: roster)
    #expect(phone.arrangement.layout.folders.first?.bots == ["writer", "scout"])
    #expect(phone.folderMutedUntil(id) == nil)

    phone.muteFolder(id, for: .eightHours)

    #expect(phone.isMuted("writer"))
    #expect(phone.isMuted("scout"))
    #expect(!phone.isMuted("alpha"), "a chat outside the folder is not silenced")
    #expect(phone.folderMutedUntil(id) == noon + 8 * hour)

    await phoneSync.reconcile()
    await macSync.reconcile()
    await botSettingsEventually("the Mac to follow") { mac.isMuted("scout") && mac.isMuted("writer") }
    #expect(mac.folderMutedUntil(id) == noon + 8 * hour)

    mac.unmuteFolder(id)
    #expect(!mac.isMuted("writer"))
    #expect(!mac.isMuted("scout"))
    #expect(mac.folderMutedUntil(id) == nil)
  }

  @MainActor
  @Test func foreverIsForeverAndAChatMutedOnItsOwnIsPartOfTheFolder() async {
    let sync = UIMetaSync.device(HoldingGateway().gateway)
    let model = ChatArrangementModel(now: { noon })
    model.attach(sync)
    await sync.reconcile()

    let roster = ["writer", "scout"]
    let id = model.newFolder("Work", containing: "writer", roster: roster) ?? ""
    model.move("scout", toFolder: id, roster: roster)

    model.setMute("writer", until: noon + hour)
    #expect(model.folderMutedUntil(id) == nil, "scout is not silent")

    model.muteFolder(id, for: .forever)
    #expect(model.folderMutedUntil(id) == MuteDuration.foreverDeadline)
    #expect(model.mutedUntil("writer") == 0, "the folder's choice replaced the chat's own")
  }

  @MainActor
  @Test func aFolderWithNothingInItOrNoSyncWritesNothing() async {
    let model = ChatArrangementModel(now: { noon })

    model.muteFolder("f1", for: .oneHour)
    #expect(!model.isMuted("writer"))

    let sync = UIMetaSync.device(HoldingGateway().gateway)
    model.attach(sync)
    await sync.reconcile()
    let before = sync.app

    model.muteFolder("gone", for: .oneHour)
    model.unmuteFolder("gone")

    #expect(sync.app == before)
  }
}
