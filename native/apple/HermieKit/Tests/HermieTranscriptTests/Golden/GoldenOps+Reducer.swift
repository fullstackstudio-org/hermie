import HermieProtocol
import HermieTranscript

// Task 11's operations: the reducer (`reducer.ts`). Each entry decodes the
// recorded arguments, calls the Swift function (the pure `(state, …, now) -> state`
// wrapper over the `inout` core) and encodes what it returns. `now` is always an
// explicit argument in these calls.

extension GoldenOps {
  static let reducer: [String: GoldenOperation] = [
    "applyEvent": { args in
      applyEvent(try args.decode(0, as: ChatState.self), try args.view(1, as: GatewayEvent.self), try args.number(2))
        .jsonValue
    },
    "applyServerRequest": { args in
      applyServerRequest(try args.decode(0, as: ChatState.self), try args.view(1, as: ServerRequest.self), try args.number(2))
        .jsonValue
    },
    "answerRequest": { args in
      answerRequest(try args.decode(0, as: ChatState.self), try args.string(1), try args.decode(2, as: RequestAnswer.self))
        .jsonValue
    },
    "applyResumeSnapshot": { args in
      applyResumeSnapshot(
        try args.decode(0, as: ChatState.self),
        try args.view(1, as: SessionResumeResult.self),
        try args.number(2)
      ).jsonValue
    },
    "beginLocalTurn": { args in
      beginLocalTurn(
        try args.decode(0, as: ChatState.self),
        try args.string(1),
        try stringArray(args, 2),
        try args.number(3),
        try args.decodeIfPresent(4, as: MessageAuthor.self)
      ).jsonValue
    },
    "beginSteer": { args in
      beginSteer(try args.decode(0, as: ChatState.self), try args.string(1), try stringArray(args, 2), try args.number(3))
        .jsonValue
    },
    "dropSteer": { args in
      dropSteer(try args.decode(0, as: ChatState.self), try args.string(1)).jsonValue
    },
    "confirmSubmit": { args in
      confirmSubmit(try args.decode(0, as: ChatState.self), try args.view(1, as: PromptSubmitResult.self), try args.number(2))
        .jsonValue
    },
    "markInterrupted": { args in
      markInterrupted(try args.decode(0, as: ChatState.self), try args.number(1)).jsonValue
    },
    "applyProcessCompletion": { args in
      applyProcessCompletion(try args.decode(0, as: ChatState.self), try args.string(1), try args.number(2)).jsonValue
    },
    "applySubagentSnapshot": { args in
      guard case .array(let rows)? = args.raw(1) else { throw GoldenHarnessError("argument 1 is not an array") }
      return applySubagentSnapshot(
        try args.decode(0, as: ChatState.self),
        try rows.enumerated().map { index, row in
          guard let object = row.objectValue else { throw GoldenHarnessError("argument 1[\(index)] is not an object") }
          return SubagentSnapshotRow(json: object)
        },
        try args.number(2)
      ).jsonValue
    }
  ]

  /// An optional `string[]` argument (`attachments?`).
  private static func stringArray(_ args: GoldenArgs, _ index: Int) throws -> [String]? {
    guard let value = args.raw(index) else { return nil }
    guard case .array(let values) = value else { throw GoldenHarnessError("argument \(index) is not an array") }
    return try values.enumerated().map { offset, element in
      guard let string = element.stringValue else { throw GoldenHarnessError("argument \(index)[\(offset)] is not a string") }
      return string
    }
  }
}
