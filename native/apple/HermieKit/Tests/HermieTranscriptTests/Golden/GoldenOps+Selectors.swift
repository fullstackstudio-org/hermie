import HermieProtocol
import HermieTranscript

// Task 13 (selectors and derived views) fills this table: `visibleItems`,
// `isBusy`, `runningSubagents`, `subagentTree`, `openRequests`, `itemsVersion`,
// `unreadCountSince`, `lastMessageAt`, `unreadBadgeLabel`, `latestStatus`,
// `previewFromChat`, `previewFromGatewayText`, `chatRowPreview`,
// `activityEntries`, `findDmCounterpart`, `exportTranscript`,
// `transcriptFileName`, `transcriptDiagnostics`, `formatTranscriptDiagnostics`.
// Until an entry is here its calls are counted as pending. `visibleItems` also
// turns on the checkpoint comparisons of the stream scenarios. See
// `GoldenOps+Reducer.swift` for the shape of an entry; `activityEntries` should
// read `args.now` should a recorded call ever carry one.
//
// The calls the corpus could not record (a callback or a non-finite number in
// the arguments) are hand-ported in `SelectorsHandPortedTests.swift`.

/// The instant the corpus was recorded at (`contract/README.md`, "The clock").
private let recordedClock: Double = 1_790_000_000_000

extension GoldenOps {
  static let selectors: [String: GoldenOperation] = [
    // selectors.ts
    "visibleItems": { args in
      let options = try args.object(1)
      guard let level = options["level"]?.stringValue,
        let showBotToBot = options["showBotToBot"]?.boolValue,
        let showThinking = options["showThinking"]?.boolValue
      else { throw GoldenHarnessError("argument 1 is not a VisibilityOptions") }
      let visible = visibleItems(
        try args.decode(0, as: ChatState.self),
        level: Verbosity(rawValue: level),
        showBotToBot: showBotToBot,
        showThinking: showThinking
      )
      return .array(visible.map(\.jsonValue))
    },
    "itemsVersion": { args in .number(Double(itemsVersion(try args.decode(0, as: ChatState.self)))) },
    "hasOpenRequest": { args in .bool(hasOpenRequest(try args.decode(0, as: ChatState.self))) },
    "openRequests": { args in .array(openRequests(try args.decode(0, as: ChatState.self)).map(\.jsonValue)) },
    "runningSubagents": { args in .array(runningSubagents(try args.decode(0, as: ChatState.self)).map(\.jsonValue)) },
    "subagentTree": { args in .array(subagentTree(try args.decode(0, as: ChatState.self)).map(\.jsonValue)) },
    "latestStatus": { args in latestStatus(try args.decode(0, as: ChatState.self))?.jsonValue },
    "isBusy": { args in .bool(isBusy(try args.decode(0, as: ChatState.self))) },

    // selectors.ts, the unread rules (Unread.swift)
    "unreadCountSince": { args in
      .number(Double(unreadCountSince(try args.decode(0, as: ChatState.self), try args.number(1))))
    },
    "lastMessageAt": { args in .number(lastMessageAt(try args.decode(0, as: ChatState.self))) },
    "unreadBadgeLabel": { args in
      guard let count = args.raw(0)?.intValue else { throw GoldenHarnessError("argument 0 is not an integer") }
      return .string(unreadBadgeLabel(count))
    },

    // preview.ts
    "previewFromChat": { args in
      previewFromChat(try args.decodeIfPresent(0, as: ChatState.self), try previewOptions(args, 1))?.jsonValue
    },
    "previewFromGatewayText": { args in previewFromGatewayText(args.stringIfString(0))?.jsonValue },
    "chatRowPreview": { args in
      chatRowPreview(
        try args.decodeIfPresent(0, as: ChatState.self),
        args.stringIfString(1),
        try previewOptions(args, 2)
      )?.jsonValue
    },

    // activity.ts
    "activityEntries": { args in
      let chats = try args.object(0)
      // `Object.values` of a record decoded from canonical JSON: its keys in
      // UTF-16 order (every key here is a bot name, never an array index).
      let states = try chats.keys
        .sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        .map { key in
          do {
            return try ChatState(decoding: chats[key]!, at: "args[0].\(key)")
          } catch {
            throw GoldenHarnessError("argument 0.\(key) is not a ChatState: \(error)")
          }
        }
      let options = try args.objectIfPresent(1)
      return .array(
        activityEntries(
          states,
          ActivityOptions(sinceSeconds: options?["sinceSeconds"]?.doubleValue),
          now: args.now ?? recordedClock
        ).map(\.jsonValue)
      )
    },
    "findDmCounterpart": { args in
      let query = try args.object(1)
      guard let kindName = query["kind"]?.stringValue, let kind = DmCounterpartKind(rawValue: kindName),
        let handle = query["handle"]?.stringValue
      else { throw GoldenHarnessError("argument 1 is not a counterpart query") }
      let found = findDmCounterpart(
        try args.decodeIfPresent(0, as: ChatState.self),
        DmCounterpartQuery(kind: kind, handle: handle, at: query["at"]?.doubleValue, text: query["text"]?.stringValue)
      )
      return found.map(JSONValue.string)
    },

    // export.ts
    "exportTranscript": { args in
      let options = try args.object(1)
      guard let botName = options["botName"]?.stringValue else {
        throw GoldenHarnessError("argument 1 has no botName")
      }
      let exported = exportTranscript(
        try args.decodeArray(0, of: TranscriptItem.self),
        TranscriptExportOptions(
          botName: botName,
          selfName: options["selfName"]?.stringValue,
          exportedAt: options["exportedAt"]?.doubleValue,
          groupChat: options["groupChat"]?.boolValue,
          ownAuthorID: options["ownAuthorId"]?.stringValue
        )
      )
      return exported.jsonValue
    },
    "transcriptFileName": { args in
      guard let fileExtension = TranscriptFileExtension(rawValue: try args.string(1)) else {
        throw GoldenHarnessError("argument 1 is not md or txt")
      }
      return .string(transcriptFileName(try args.string(0), fileExtension, try args.string(2)))
    },

    // diagnostics.ts
    "transcriptDiagnostics": { args in transcriptDiagnostics(try args.decode(0, as: ChatState.self)).jsonValue },
    "formatTranscriptDiagnostics": { args in
      .array(formatTranscriptDiagnostics(try args.string(0), try args.decode(1, as: ChatState.self)).map(JSONValue.string))
    },
    "textFingerprint": { args in .string(textFingerprint(try args.string(0))) }
  ]
}

/// `ChatPreviewOptions` as the corpus can carry them: without the resolver.
private func previewOptions(_ args: GoldenArgs, _ index: Int) throws -> ChatPreviewOptions {
  guard let options = try args.objectIfPresent(index) else { return ChatPreviewOptions() }
  return ChatPreviewOptions(groupChat: options["groupChat"]?.boolValue, ownAuthorID: options["ownAuthorId"]?.stringValue)
}
