import Foundation
import HermieCore
import Synchronization
import Testing

@testable import HermieUI

// The Permissions page's parts: the revoke question's two ends in the order SwiftUI calls them, what the
// question says, the words for each failure and the sentences in three languages. (The page itself is not hosted
// or driven.)

/// A gateway that revokes what it is asked to and records it.
private final class RecordingPermissions: PermissionsBackend, Sendable {
  private let revoked = Mutex<[String]>([])

  var calls: [String] { revoked.withLock { $0 } }

  func grants(profile: String) async throws -> PermissionsSnapshot {
    PermissionsSnapshot(permanent: [PermissionGrant(id: "perm:1", label: "podman *")])
  }

  func revoke(profile: String, scope: PermissionScope, target: PermissionTarget) async throws -> Int {
    revoked.withLock { $0.append("\(profile) \(scope) \(target)") }
    return 1
  }
}

private let podman = PermissionGrant(id: "perm:1", kind: .glob, label: "podman *")

@MainActor
@Suite("Permissions: the revoke question and the words")
struct PermissionsViewTests {
  /// The dialog's two ends in the order SwiftUI calls them for its Revoke button: the dismissal (the
  /// `isPresented` setter, with `false`) first, then the button's action.
  @Test func theDialogRevokesWhenItDismissesItselfBeforeTheYes() async {
    let backend = RecordingPermissions()
    let model = PermissionsModel(bot: "researcher", backend: backend)
    let question = PermissionRevocation(scope: .permanent, grant: podman)

    model.ask(question)
    PermissionRevokeDialog.dismissed(model)
    let revoked = await PermissionRevokeDialog.confirmed(model, question).value

    #expect(revoked)
    #expect(backend.calls.count == 1)
    #expect(model.pending == nil)
  }

  @Test func theDialogsCancelRevokesNothing() async {
    let backend = RecordingPermissions()
    let model = PermissionsModel(bot: "researcher", backend: backend)

    model.ask(PermissionRevocation(scope: .permanent, grant: nil))
    PermissionRevokeDialog.dismissed(model)
    await Task.yield()

    #expect(model.pending == nil)
    #expect(backend.calls.isEmpty)
  }

  @Test func theQuestionNamesWhatIsRevokedAndWhoWillAsk() {
    let one = PermissionRevocation(scope: .permanent, grant: podman)
    let all = PermissionRevocation(scope: .permanent, grant: nil)
    let session = PermissionRevocation(scope: .session("rt-1"), grant: podman)
    let sessionAll = PermissionRevocation(scope: .session("rt-1"), grant: nil)

    #expect(PermissionDialogWords.title(one).contains("podman *"))
    #expect(PermissionDialogWords.title(all) == NativeStrings.Permissions.revokeAllTitle)
    #expect(PermissionDialogWords.title(session).contains("podman *"))
    #expect(PermissionDialogWords.title(sessionAll) == NativeStrings.Permissions.revokeAllSessionTitle)
    #expect(PermissionDialogWords.message(one, bot: "Researcher").contains("Researcher"))
    #expect(PermissionDialogWords.message(all, bot: "Researcher").contains("Researcher"))
    #expect(PermissionDialogWords.message(session, bot: "Researcher").contains("Researcher"))
    #expect(Set([all, sessionAll, one, session].map(\.id)).count == 4, "each question is its own revocation")
  }

  @Test func eachFailureHasItsOwnSentenceAndTheGatewaysWordsAreKept() {
    let loads = [
      PermissionWords.load(.unsupported), PermissionWords.load(.offline), PermissionWords.load(.refused),
      PermissionWords.load(.timedOut), PermissionWords.load(.unknownProfile), PermissionWords.load(.sessionGone)
    ]

    #expect(Set(loads).count == 6)
    #expect(PermissionWords.action(.timedOut) == NativeStrings.Permissions.timedOut)
    #expect(PermissionWords.action(.refused) == NativeStrings.Permissions.refused)
    #expect(PermissionWords.action(.unknownProfile) == NativeStrings.Permissions.unknownProfile)
    #expect(PermissionWords.load(.failed("disk full")).contains("disk full"))
    #expect(PermissionWords.action(.failed("disk full")).contains("disk full"))
    #expect(PermissionWords.action(.failed("")) == NativeStrings.Permissions.actionFailedNoReason)
  }

  @Test func theModesAreNamedAndExplained() {
    let modes: [ApprovalMode] = [.manual, .smart, .off, .other("odd")]

    #expect(Set(modes.map(NativeStrings.Permissions.modeName)).count == 4)
    #expect(Set(modes.map(NativeStrings.Permissions.modeNote)).count == 4)
    #expect(NativeStrings.Permissions.modeName(.other("odd")) == "odd")
  }

  @Test func theScopeNoteSaysWhereARevokeAppliesAtOnce() {
    let note = NativeStrings.Permissions.scopeNote

    #expect(note.contains("at once") && note.contains("next reload"))
  }

  @Test func theBotIsNamedWhereTheApprovalsAreDescribed() {
    #expect(NativeStrings.Permissions.about("Researcher").contains("Researcher"))
    #expect(NativeStrings.Permissions.alwaysNote("Researcher").contains("Researcher"))
    #expect(NativeStrings.Permissions.revokeSessionMessage("Researcher").contains("Researcher"))
  }

  @Test(arguments: [
    "native.permissions.title", "native.permissions.about", "native.permissions.loading",
    "native.permissions.unsupported", "native.permissions.offline", "native.permissions.refused",
    "native.permissions.loadTimedOut", "native.permissions.timedOut", "native.permissions.unknownProfile",
    "native.permissions.sessionGone", "native.permissions.failed", "native.permissions.actionFailed",
    "native.permissions.actionFailedNoReason", "native.permissions.mode", "native.permissions.mode.manual",
    "native.permissions.mode.smart", "native.permissions.mode.off", "native.permissions.mode.manualNote",
    "native.permissions.mode.smartNote", "native.permissions.mode.offNote", "native.permissions.mode.otherNote",
    "native.permissions.mode.footer", "native.permissions.always", "native.permissions.alwaysNote",
    "native.permissions.alwaysEmpty", "native.permissions.revoke", "native.permissions.revokeAll",
    "native.permissions.revokeTitle", "native.permissions.revokeMessage", "native.permissions.revokeAllTitle",
    "native.permissions.revokeAllMessage", "native.permissions.revokeAllSessionTitle",
    "native.permissions.revokeSessionMessage", "native.permissions.sessionThis", "native.permissions.sessionOther",
    "native.permissions.sessionsFooter", "native.permissions.sessionsEmpty", "native.permissions.sessionEmpty",
    "native.permissions.on", "native.permissions.off", "native.permissions.yoloNote", "native.permissions.tirith",
    "native.permissions.scopeNote", "native.decisions.kind.permissionRevoked", "native.decisions.outcome.revoked"
  ])
  func everySentenceIsTranslated(_ key: String) throws {
    try expectTranslated(key)
  }

  @Test func yoloIsTheSameWordInEveryLanguage() throws {
    try expectTranslated("native.permissions.yolo", sameIn: ["nl", "de"])
  }

  @Test func theDecisionLogNamesARevoke() {
    #expect(NativeStrings.Decisions.kind(.permissionRevoked) == NativeStrings.Decisions.kind(.permissionRevoked))
    #expect(NativeStrings.Decisions.kind(.permissionRevoked) != NativeStrings.Decisions.kind(.approval))
    #expect(NativeStrings.Decisions.outcome(.revoked) != NativeStrings.Decisions.outcome(.denied))
  }
}
