import CoreSpotlight
import ExpoModulesCore
import UniformTypeIdentifiers

/**
 The app's half of Shortcuts, Siri and Spotlight.

 Two jobs that look unrelated and are the same one from the person's side: make
 Hermie's bots things the SYSTEM knows about.

  - `listIntents` / `completeIntent` are the queue an App Intent is sitting in a
    poll loop against. The intent wrote a request, opened the app, and is now
    waiting for a file to appear.
  - `indexBots` puts the roster in Spotlight, so typing a bot's name into search
    offers its chat.

 Deliberately the dumb half, like every other native module here. It decodes
 nothing: the JSON is produced and consumed by `src/features/intents/queue.ts`,
 which is pure and tested, and the file format is the contract.

 **Nothing here throws.** Every function answers a value, including the
 failures. A Shortcut that goes unanswered reports the system's own timeout,
 which is a bad outcome; an app that crashed on launch because a queue file was
 odd is a worse one.
 */
public class HermieIntentsModule: Module {
  /** Must match `HermieIntentsQueue.appGroup` and the app's entitlements. */
  private static let appGroup = "group.dev.hermie.app"

  /** Also spelled in `queue.ts` as `INTENT_QUEUE_DIRECTORY`. */
  private static let queueDirectory = "intents"

  private static let pendingDirectory = "pending"
  private static let resultsDirectory = "results"

  /** A request is a few hundred bytes; anything larger is not one of ours. */
  private static let maxRequestBytes = 64 * 1024

  /**
   The Spotlight domain every bot is indexed under.

   One domain, so `deleteSearchableItems(withDomainIdentifiers:)` can replace
   the whole roster in a single call. That matters more than it looks: a bot
   removed from the gateway has to LEAVE the index, and the alternative —
   remembering which ids were written last time — is a second piece of state to
   get out of step with the first.
   */
  private static let spotlightDomain = "dev.hermie.app.bots"

  public func definition() -> ModuleDefinition {
    Name("HermieIntents")

    /**
     Every request waiting, oldest last — the order is JavaScript's to decide.

     A file that cannot be read is skipped rather than deleted, for the reason
     the share module gives: it may be a request a newer build wrote, or one an
     intent is still writing. `completeIntent` is the only thing that removes
     anything.
     */
    AsyncFunction("listIntents") { () -> [[String: Any]] in
      guard let pending = Self.directory(Self.pendingDirectory, create: false) else {
        return []
      }

      let manager = FileManager.default

      guard let files = try? manager.contentsOfDirectory(
        at: pending,
        includingPropertiesForKeys: nil,
        options: [.skipsHiddenFiles]
      ) else {
        return []
      }

      var entries: [[String: Any]] = []

      for file in files where file.pathExtension == "json" {
        guard let attributes = try? manager.attributesOfItem(atPath: file.path),
          let size = (attributes[.size] as? NSNumber)?.intValue, size > 0, size <= Self.maxRequestBytes,
          let data = try? Data(contentsOf: file),
          let payload = String(data: data, encoding: .utf8) else {
          continue
        }

        entries.append(["id": file.deletingPathExtension().lastPathComponent, "payload": payload])
      }

      return entries
    }

    /**
     Write the answer, then drop the request.

     That order is the whole of it, and it is the reverse of the share outbox's
     for a reason worth keeping straight. A share clears LAST because the risk
     is losing somebody's file. A request clears last too — but the answer must
     be visible first, because the poll loop on the other side is watching for
     the result file and not for the request's absence. Written the other way
     round, an intent could see its request vanish with no result beside it and
     have nothing to report but a timeout.

     Written `.atomic`, because the reader may look at any moment: a result read
     halfway through a write decodes as nothing, and "nothing" is
     indistinguishable from "not finished yet".
     */
    AsyncFunction("completeIntent") { (id: String, result: String) -> Bool in
      guard let results = Self.directory(Self.resultsDirectory, create: true),
        let pending = Self.directory(Self.pendingDirectory, create: false),
        let data = result.data(using: .utf8) else {
        return false
      }

      let manager = FileManager.default
      let fileName = "\(id).json"

      // Matched against the directory's own listing rather than joined onto the
      // path: an id carrying a separator then simply matches nothing, which
      // makes the check total instead of a rule somebody has to keep in step.
      guard let request = (try? manager.contentsOfDirectory(at: pending, includingPropertiesForKeys: nil))?
        .first(where: { $0.lastPathComponent == fileName }) else {
        return false
      }

      guard (try? data.write(to: results.appendingPathComponent(fileName), options: .atomic)) != nil else {
        return false
      }

      try? manager.removeItem(at: request)

      return true
    }

    /**
     Replace the Spotlight index with this roster.

     Delete-then-index rather than a diff, and the whole roster rather than the
     change: the roster is at most a dozen rows (`WIDGET_BOT_LIMIT`), the call
     is made only when the drawn content actually changed (see `WidgetSync`),
     and a diff would be a second model of which bots exist — one that would go
     wrong exactly when a bot is removed, which is the case that matters.

     The identifier is `hermie://chat/<name>`, so the item and the tap are the
     same string: `CSSearchableItemActionType` hands that identifier back in a
     user activity, and the app opens it as an ordinary link.
     */
    AsyncFunction("indexBots") { (bots: [[String: String]]) -> Bool in
      let index = CSSearchableIndex.default()

      index.deleteSearchableItems(withDomainIdentifiers: [Self.spotlightDomain], completionHandler: nil)

      let items: [CSSearchableItem] = bots.compactMap { bot in
        guard let name = bot["name"], !name.isEmpty else {
          return nil
        }

        let attributes = CSSearchableItemAttributeSet(contentType: UTType.text)
        attributes.title = bot["label"] ?? name
        attributes.contentDescription = bot["subtitle"]
        // The handle as well as the label: somebody searching for `lance-vance`
        // is searching for the name the rest of the app addresses that bot by,
        // and it is not always the one on the row.
        attributes.keywords = [name, bot["label"] ?? name]

        let escaped = name.addingPercentEncoding(
          withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        ) ?? name

        let item = CSSearchableItem(
          uniqueIdentifier: "hermie://chat/\(escaped)",
          domainIdentifier: Self.spotlightDomain,
          attributeSet: attributes
        )
        // A month. Long enough that a roster nobody has opened in a while is
        // still searchable, short enough that a gateway somebody has stopped
        // using does not leave rows in their search results forever.
        item.expirationDate = Date().addingTimeInterval(30 * 24 * 60 * 60)

        return item
      }

      guard !items.isEmpty else {
        return true
      }

      index.indexSearchableItems(items, completionHandler: nil)

      return true
    }

    /**
     Whether a container was actually obtained. Reported on the developer screen.

     Same silent failure as the other two modules: the container is nil whenever
     the App Group entitlement did not make it onto the signed binary, and every
     function above then answers exactly as it would for an empty queue.
     */
    Function("hasSharedContainer") { () -> Bool in
      Self.container() != nil
    }
  }

  private static func container() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
  }

  private static func directory(_ name: String, create: Bool) -> URL? {
    guard let container = container() else {
      return nil
    }

    let url = container
      .appendingPathComponent(queueDirectory, isDirectory: true)
      .appendingPathComponent(name, isDirectory: true)

    if create {
      try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }
}
