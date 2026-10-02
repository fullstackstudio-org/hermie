import HermieProtocol
import HermieTranscript

// Task 12's operations (history, reconcile, cache): `rowsToItems`, `reconcile`,
// `reconcileTail`, `snapshotForCache`, `stateFromCache`, `classifyUserRow`,
// `stripUserText`, `attachmentRefName`, `attachmentsMatchKey`,
// `normalizedItemText`. See `GoldenOps+Reducer.swift` for the shape of an entry.
//
// Every runtime export of `rows-to-items.ts`, `reconcile.ts` and `cache.ts` is
// registered, including the ones no test records (`prependHistory`,
// `attributeBotReplies`, `itemMatchKey`, `isMatchable`, `normalizeMatchText`), so a
// call the corpus gains later is judged at once. The two constants
// (`CACHE_ITEM_LIMIT`, `CACHE_FORMAT`) are values, which the recorder never wraps.

extension GoldenOps {
  static let history: [String: GoldenOperation] = [
    // rows-to-items
    "rowsToItems": { args in
      .array(rowsToItems(try historyRows(args, 0), historyShape(args, 1), try historyOptions(args, 2)).map(\.jsonValue))
    },
    "attributeBotReplies": { args in
      // Mutates its argument and returns `undefined`.
      var items = try args.decodeArray(0, of: TranscriptItem.self)
      attributeBotReplies(&items)
      return nil
    },
    "classifyUserRow": { args in
      // `options.labelled === true`: only a real `true` labels the row.
      let labelled = try args.objectIfPresent(1)?["labelled"] == .bool(true)
      return classifyUserRow(try args.string(0), labelled: labelled).jsonValue
    },
    "stripUserText": { args in stripUserText(try args.string(0)).jsonValue },
    "normalizeMatchText": { args in .string(normalizeMatchText(try args.string(0))) },
    "attachmentRefName": { args in .string(attachmentRefName(try args.string(0))) },
    "attachmentsMatchKey": { args in
      guard let raw = args.raw(0) else { return .string(attachmentsMatchKey(nil)) }
      guard case .array(let values) = raw else { throw GoldenHarnessError("argument 0 is not an array") }
      let references = try values.map { value in
        guard let reference = value.stringValue else { throw GoldenHarnessError("argument 0 holds a non-string") }
        return reference
      }
      return .string(attachmentsMatchKey(references))
    },
    "normalizedItemText": { args in .string(normalizedItemText(try args.decode(0, as: TranscriptItem.self))) },
    "itemMatchKey": { args in .string(itemMatchKey(try args.decode(0, as: TranscriptItem.self))) },
    "isMatchable": { args in .bool(isMatchable(try args.decode(0, as: TranscriptItem.self))) },

    // reconcile
    "reconcile": { args in
      reconcile(try args.decode(0, as: ChatState.self), try args.decodeArray(1, of: TranscriptItem.self)).jsonValue
    },
    "prependHistory": { args in
      prependHistory(try args.decode(0, as: ChatState.self), try args.decodeArray(1, of: TranscriptItem.self)).jsonValue
    },
    "reconcileTail": { args in
      reconcileTail(try args.decode(0, as: ChatState.self), try args.decodeArray(1, of: TranscriptItem.self)).jsonValue
    },

    // cache
    "snapshotForCache": { args in
      snapshotForCache(try args.decode(0, as: ChatState.self), now: try args.number(1)).jsonValue
    },
    "stateFromCache": { args in
      stateFromCache(
        try args.string(0),
        try args.decode(1, as: SessionIDs.self),
        try args.decode(2, as: CachedTranscript.self)
      ).jsonValue
    }
  ]

  /// `rows: readonly TranscriptRow[]`: an array of row objects.
  private static func historyRows(_ args: GoldenArgs, _ index: Int) throws -> [TranscriptRow] {
    guard case .array(let values)? = args.raw(index) else { throw GoldenHarnessError("argument \(index) is not an array") }
    return try values.enumerated().map { offset, value in
      guard let object = value.objectValue else { throw GoldenHarnessError("argument \(index)[\(offset)] is not a row") }
      return TranscriptRow(json: object)
    }
  }

  /// `shape: RowShape`: the TypeScript only ever asks `shape === 'rest'`.
  private static func historyShape(_ args: GoldenArgs, _ index: Int) -> RowShape {
    args.stringIfString(index) == "rest" ? .rest : .rpc
  }

  /// `opts: RowsToItemsOptions = {}`.
  private static func historyOptions(_ args: GoldenArgs, _ index: Int) throws -> RowsToItemsOptions {
    guard let options = try args.objectIfPresent(index) else { return RowsToItemsOptions() }
    guard let origin = options["origin"], origin != .null else { return RowsToItemsOptions() }
    guard let raw = origin.stringValue else { throw GoldenHarnessError("argument \(index).origin is not a string") }
    return RowsToItemsOptions(origin: ItemOrigin(rawValue: raw))
  }
}
