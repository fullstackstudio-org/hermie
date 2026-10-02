import HermieProtocol
import HermieTranscript

// Task 11 (the reducer) fills this table: `applyEvent`, `applyServerRequest`,
// `answerRequest`, `applyResumeSnapshot`, `beginLocalTurn`, `beginSteer`,
// `dropSteer`, `confirmSubmit`, `markInterrupted`, `applyProcessCompletion`,
// `applySubagentSnapshot`. Until an entry is here its calls are counted as pending,
// and every stream scenario that needs it is skipped.
//
// An entry decodes the recorded arguments, calls the Swift function and encodes
// what it returns; `now` is always an explicit argument in these calls:
//
//   "applyEvent": { args in
//     applyEvent(try args.decode(0, as: ChatState.self), try args.view(1, as: GatewayEvent.self),
//                try args.number(2)).jsonValue
//   },

extension GoldenOps {
  static let reducer: [String: GoldenOperation] = [:]
}
