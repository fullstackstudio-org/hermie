import Foundation
import HermieProtocol

/**
 Device-only deletions that were committed but may not have happened yet (`hermie.sync.journal`
 in `kv`, not namespaced). It names gateway ids, keychain key names and keyed prints only, never a
 value.

 - `purge`: gateways whose every device-only item must go. Written in the same transaction as the
   purge that removed them from the registry (a plan's, "Remove", a rolled-back add): a purge also
   drops the gateway's sync entry, so the state alone could not name what is left.
 - `keys`: single items an intent committed to delete (signing out, clearing a credential,
   leaving `session_token`), each with the keyed print of the value it held then. The clean-up
   deletes an item only while it still holds that value: one entered again since is left alone.
 - `deleteEverything`: "Delete Everything from iCloud Keychain" committed and not yet finished:
   the accounts the store held at the request, each with the keyed print of its item. The next
   reconcile deletes those still holding that item before it reads the store, never one written
   since (by another device, say).

 Each entry is cleared once done. A crash in between leaves it, and the next reconcile finishes it
 before anything else. The credentials a plan writes need no journal of their own:
 `SyncPlan.provisionalState` marks them pending, and the merge redoes or keeps them.
 */
struct SyncJournal: Sendable, Equatable {
  static let storageKey = "hermie.sync.journal"

  var purge: Set<String> = []
  /// Keychain key → keyed print of the value to delete.
  var keys: [String: String] = [:]
  /// "Delete everything" in progress: account → keyed print of the item it held at the request.
  /// Only items still holding that value are deleted later; one another device wrote since stays.
  var deleteEverything: [String: String] = [:]

  var isEmpty: Bool { purge.isEmpty && keys.isEmpty && deleteEverything.isEmpty }

  static func decode(_ text: String?) -> SyncJournal {
    guard let text, let root = (try? JSONValue(parsing: text))?.objectValue else {
      return SyncJournal()
    }

    return SyncJournal(
      purge: Set((root["purge"]?.arrayValue ?? []).compactMap(\.stringValue)),
      keys: (root["keys"]?.objectValue ?? [:]).compactMapValues(\.stringValue),
      deleteEverything: (root["deleteEverything"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
    )
  }

  func encoded() throws -> String {
    var root: JSONObject = [
      "v": .number(1), "purge": .array(purge.sorted().map(JSONValue.string)),
      "keys": .object(keys.mapValues(JSONValue.string))
    ]
    if !deleteEverything.isEmpty { root["deleteEverything"] = .object(deleteEverything.mapValues(JSONValue.string)) }
    return try JSONValue.object(root).canonicalString()
  }

  /// The keyed print of an item's value, bound to its key so equal values under two keys differ.
  static func print(_ value: String, key: String, printer: SyncPrinter) -> String {
    printer.print(.string("hermie.sync.journal|\(key)|\(value)"))
  }
}

extension SyncJournal: CustomStringConvertible {
  var description: String {
    "SyncJournal(purge: \(purge.sorted()), keys: \(keys.count), deleteEverything: \(deleteEverything.keys.sorted()))"
  }
}
