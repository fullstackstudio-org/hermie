import HermieProtocol
import HermieTranscript

// Task 10's operations: the state constructor and the leaf helper modules.

extension GoldenOps {
  /// `types.ts`.
  static let types: [String: GoldenOperation] = [
    "createChatState": { args in
      createChatState(try args.string(0), try args.string(1), try args.string(2)).jsonValue
    }
  ]

  /// `bot-dm.ts`, `cron-delivery.ts`, `injected.ts`, `model-name.ts`,
  /// `context-usage.ts`, `turn-activity.ts`.
  static let helpers: [String: GoldenOperation] = [
    // bot-dm
    "parseIncomingBotMessage": { args in GoldenResult.of(parseIncomingBotMessage(try args.string(0))) },
    "normalizeAgentTarget": { args in .string(normalizeAgentTarget(args.stringIfString(0))) },
    "parseMessageAgentResult": { args in parseMessageAgentResult(args.raw(0)).jsonValue },
    "parseProcessCompleteText": { args in GoldenResult.of(parseProcessCompleteText(try args.string(0))) },
    "isBotDmDeliveryCommand": { args in GoldenResult.of(isBotDmDeliveryCommand(try args.string(0))) },
    "deliveryTargetFromCommand": { args in GoldenResult.of(deliveryTargetFromCommand(try args.string(0))) },
    "replyFromDeliveryOutput": { args in replyFromDeliveryOutput(try args.string(0)).jsonValue },
    "dispatchedTo": { args in
      guard case .array(let sender)? = args.raw(1) else { throw GoldenHarnessError("argument 1 is not an array") }
      return GoldenResult.of(dispatchedTo(try args.decodeArray(0, of: TranscriptItem.self), sender.map(\.stringValue)))
    },
    "isBotToBotItem": { args in GoldenResult.of(isBotToBotItem(try args.decode(0, as: TranscriptItem.self))) },

    // cron-delivery
    "parseCronDelivery": { args in GoldenResult.of(parseCronDelivery(args.stringIfString(0))) },
    "isCronDelivery": { args in GoldenResult.of(isCronDelivery(args.stringIfString(0))) },

    // injected
    "parseInjectedRow": { args in GoldenResult.of(parseInjectedRow(args.stringIfString(0))) },
    "isInjectedRow": { args in GoldenResult.of(isInjectedRow(args.stringIfString(0))) },
    "stripSteerWrapper": { args in GoldenResult.of(stripSteerWrapper(args.stringIfString(0))) },
    "unwrapSystemNote": { args in GoldenResult.of(unwrapSystemNote(args.stringIfString(0))) },

    // author
    "authorViaOf": { args in GoldenResult.of(authorViaOf(args.raw(0))) },
    "authorLabel": { args in
      // The TypeScript takes any `{ via?: AuthorVia }`, not only a whole author.
      let via = args.raw(0)?.objectValue?["via"].flatMap { AuthorVia(jsonValue: $0) }
      return .string(authorLabel(via: via, try args.string(1)))
    },

    // model-name
    "prettyModelName": { args in .string(prettyModelName(try args.string(0))) },
    "parseModelId": { args in parseModelID(try args.string(0)).jsonValue },

    // context-usage: `if (!usage)` lets only an object through to a reading.
    "contextUsageOf": { args in GoldenResult.of(contextUsageOf(args.raw(0)?.objectValue.map(Usage.init(json:)))) },
    "contextUsageOfInfo": { args in
      GoldenResult.of(contextUsageOfInfo(args.raw(0)?.objectValue.map(SessionLiveInfo.init(json:))))
    },
    "chatContextUsage": { args in
      // The TypeScript takes any `{ usage?, info? }`, not only a whole state.
      let state = args.raw(0)?.objectValue
      return GoldenResult.of(
        chatContextUsage(
          usage: state?["usage"]?.objectValue.map(Usage.init(json:)),
          info: state?["info"]?.objectValue.map(SessionLiveInfo.init(json:))
        )
      )
    },

    // sources: `null` for an entry that is not one, as the TypeScript returns it.
    "parseSource": { args in (args.raw(0).flatMap(ReplySource.parse))?.jsonValue ?? .null },
    "parseSources": { args in .array(ReplySource.parseAll(args.raw(0)).map(\.jsonValue)) },
    "sourcesOfMetadata": { args in .array(ReplySource.parseAll(fromMetadata: args.raw(0)).map(\.jsonValue)) },

    // turn-activity
    "turnActivity": { args in turnActivity(try args.decode(0, as: ChatState.self)).jsonValue }
  ]
}
