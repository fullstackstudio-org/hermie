import Foundation
import SwiftUI

/**
 The file the app writes, as the extension reads it.

 This is the whole of what a widget knows. There is no gateway here, no socket, no keychain and no
 store: the extension wakes up, reads one JSON file out of the App Group container, draws, and is
 killed again. Everything derived — presence, unread, the clipped last line, the colour initials are
 drawn on — was derived in `src/features/widgets/snapshot.ts` while the app still had the state to
 derive it from, which is why there is no logic in this file beyond decoding and defaulting.

 ## The version check is the point of the version field

 An old extension against a new snapshot is not an edge case, it is what every app update looks
 like for the few minutes before iOS reloads the installed extension. So a snapshot whose `version`
 is not the one this binary understands is treated as no snapshot at all, and the widget draws its
 empty state. Half a row drawn from fields that moved is worse than a line saying "Open Hermie".

 ## Everything optional, nothing fatal

 Each field has a default, and `bots` is the only one whose absence empties the widget. A snapshot
 written by a newer app with a field this binary has never heard of decodes fine and ignores it —
 which is why adding an optional field does not need a version bump, and changing what an existing
 one MEANS does.
 */
struct HermieSnapshot: Decodable {
  /** Bumped in `snapshot.ts`; anything else is drawn as "no snapshot". */
  static let supportedVersion = 1

  let version: Int
  let generatedAt: Double
  let bots: [HermieBot]
  /**
   The owner's folders, when the app that wrote this knew about them.

   Optional in the Swift sense as well as the format's, and that is the whole
   worked example of the paragraph above: a build of this extension that
   predates folders decodes a snapshot containing them and ignores the field,
   and this build decodes a snapshot written before folders existed and sees
   nil. Neither needed a version bump, because nothing that already existed
   changed meaning.
   */
  let folders: [HermieFolder]?

  /**
   Which gateway this roster came from, as `gatewayKeyOf` its origin.

   Sixteen lowercase hex digits, or nil from an app that predates two gateways
   on one device. Optional in both senses, so it needed no version bump: see the
   paragraph above about adding a field versus changing what one means.

   The key travels rather than the gateway's local id, because the id is minted
   on one device and means nothing anywhere else. `packages/gateway-client/src/
   gateway-key.ts` is where the algorithm is written down.
   */
  let gatewayKey: String?

  static let empty = HermieSnapshot(
    version: supportedVersion, generatedAt: 0, bots: [], folders: [], gatewayKey: nil)

  /**
   The same snapshot with every row told which gateway it belongs to.

   The key is a property of the SNAPSHOT and a tap is a property of a ROW, and
   the three widgets in between carry entry types that hold rows. Stamping the
   rows once, here, is what keeps `chatURL` a property of the thing being tapped
   instead of threading a second value through all three.

   A key that is not sixteen lowercase hex digits is dropped rather than passed
   on. `deep-link.ts` would ignore it anyway — `isGatewayKey` is the same check
   on the other side — and a URL carrying a malformed parameter is a worse thing
   to hand the system than one carrying none.
   */
  func stampingGatewayKey() -> HermieSnapshot {
    guard let key = gatewayKey, HermieSnapshot.isGatewayKey(key) else {
      return self
    }

    let stamped = bots.map { bot -> HermieBot in
      var copy = bot

      copy.gatewayKey = key

      return copy
    }

    return HermieSnapshot(
      version: version, generatedAt: generatedAt, bots: stamped, folders: folders, gatewayKey: key)
  }

  /** Sixteen lowercase hex digits, which is what `gatewayKeyOf` produces. */
  static func isGatewayKey(_ value: String) -> Bool {
    value.count == 16 && value.allSatisfy { $0.isHexDigit && !$0.isUppercase }
  }

  var isUsable: Bool {
    version == Self.supportedVersion
  }

  /** How many bots are waiting on a person — the whole content of the accessory widgets. */
  var needsInputCount: Int {
    bots.filter(\.needsInput).count
  }

  /** One folder by id, or nil for one that has been deleted or emptied. */
  func folder(id: String) -> HermieFolder? {
    (folders ?? []).first { $0.id == id }
  }

  /** The rows of one folder, in the snapshot's own recency order. */
  func bots(in folder: HermieFolder) -> [HermieBot] {
    folder.bots.compactMap { name in bots.first { $0.name == name } }
  }
}

/**
 One of the owner's folders.

 Everything here was derived by `snapshot.ts` while the app still had the state
 to derive it from — including the two counts, which follow the CHAT LIST's
 folder rules rather than the per-bot rules the rows above follow. That
 difference is deliberate and is explained at length on the TypeScript side:
 a row's badge is an interruption about one chat, a folder's is a summary, and a
 summary that drops part of what it is summarising removes information.

 Nothing in this file recomputes either number. A widget that added up the rows
 it happened to be drawing would answer a different question from the one the
 badge is asking, and would be wrong by exactly the muted chats.
 */
struct HermieFolder: Decodable, Identifiable, Hashable {
  let id: String
  let name: String
  /** Hex from the app's own accent table, or nil for the default tint. */
  let colour: String?
  /** The bots inside, most recently active first; every one is also in `bots`. */
  let bots: [String]
  /** Unread across the folder, muted chats INCLUDED. */
  let unread: Int
  /** How many inside are waiting on a person, muted chats excluded. */
  let needsInput: Int
  /** How many are inside in total, which is what "+N more" is counted from. */
  let size: Int

  /**
   Where a tap on the folder's header goes.

   `hermie://folder/<id>`, which opens the chat list with this folder expanded
   and scrolled to. The id is not escaped because it is not somebody else's
   string: `isSafeFolderId` on the other side accepts only a name, and the app
   mints these ids itself.
   */
  var listURL: URL? {
    URL(string: "hermie://folder/\(id)")
  }
}

struct HermieBot: Decodable, Identifiable, Hashable {
  /** The profile name, which is also what `hermie://chat/<bot>` carries. */
  let name: String
  let displayName: String
  /** Relative to the container, when the app has actually written the file. */
  let avatarPath: String?
  let initials: String
  /** Hex from the app's own accent table. White on it is AA; see `snapshot.ts`. */
  let colour: String
  let presence: String
  let lastLine: String
  /** Unix seconds, as the gateway reports `last_active`. */
  let lastAt: Double
  let unread: Int
  let needsInput: Bool

  /**
   Which gateway this row came from. NOT decoded from the row.

   It is a property of the snapshot around it, and `HermieWidgetStore.load()`
   stamps it on after decoding. Declared `var` and Optional for exactly that:
   absent from the JSON, it decodes to nil and is then filled in.
   */
  var gatewayKey: String?

  var id: String { name }

  /**
   Where a tap goes.

   The name is escaped because it is going into a URL path and a profile can be called anything.
   `snapshot.ts` refuses a link whose decoded name contains a slash, so a name that would need one
   simply never opens — which is the right failure for a surface with no way to report one.
   */
  var chatURL: URL? {
    let escaped = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/")))
    let path = "hermie://chat/\(escaped ?? name)"

    /*
     The gateway, when this device has more than one.

     Without it a tap opens the named bot on whichever gateway happens to be
     current, which on a device with two is a coin toss — and the two rosters
     routinely share names. The key is hex by the time it gets here, so it is
     appended unescaped; `HermieSnapshot.stampingGatewayKey()` is what refuses
     anything that is not.
     */
    guard let key = gatewayKey else {
      return URL(string: path)
    }

    return URL(string: "\(path)?gateway=\(key)")
  }
}

/**
 Reads the snapshot and the avatars out of the shared container.

 Every failure answers the empty snapshot rather than throwing: a timeline provider has nowhere to
 report an error to, and a widget with nothing in it is a widget that says "Open Hermie", which is
 both true and actionable. The three reasons it can be empty are worth keeping apart in your head,
 because only the first is a bug: the App Group entitlement did not make it onto one of the two
 signed binaries; the app has never run since the widget was added; or the version moved.
 */
enum HermieWidgetStore {
  /** Must match `HermieWidgetsModule.appGroup` and both entitlement files. */
  static let appGroup = "group.dev.hermie.app"

  static func load() -> HermieSnapshot {
    guard let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup),
      let data = try? Data(contentsOf: container.appendingPathComponent("widget-snapshot.json")),
      let snapshot = try? JSONDecoder().decode(HermieSnapshot.self, from: data),
      snapshot.isUsable else {
      return .empty
    }

    // Stamped here rather than at every call site: this is the one place a
    // snapshot enters the extension, so it is the one place that can be sure.
    return snapshot.stampingGatewayKey()
  }

  /**
   One bot's picture, or nil.

   Read every time it is drawn rather than cached: a widget process is short-lived and killed for
   memory before it is killed for anything else, so a cache would be a way to be killed rather
   than a saving. The path came out of the snapshot, so it is already escaped; it is appended
   rather than joined with the file system's own resolution, and a path that climbs out of the
   container answers nil at `standardized` below rather than reading something it should not.
   */
  static func avatar(at path: String?) -> UIImage? {
    guard let path,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) else {
      return nil
    }

    let url = container.appendingPathComponent(path).standardized

    guard url.path.hasPrefix(container.standardized.path) else {
      return nil
    }

    return UIImage(contentsOfFile: url.path)
  }
}
