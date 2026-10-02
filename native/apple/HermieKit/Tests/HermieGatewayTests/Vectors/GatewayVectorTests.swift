import Foundation
import Testing

@testable import HermieGateway

/// Every vector in the ten `contract/gateway/vectors` files this target ports,
/// replayed against the Swift functions. A failure names the file, the entry
/// index, the function and both answers.
@Suite struct GatewayVectorTests {
  @Test(arguments: VectorLoader.files)
  func vectorFile(_ file: String) throws {
    let vectors = try VectorLoader.load(file)
    var failures: [String] = []

    #expect(!vectors.isEmpty, "\(file).json has no vectors")

    for vector in vectors {
      if let failure = check(vector) {
        failures.append("\(file)[\(vector.index)] \(vector.fn)(\(vector.args.map(\.description).joined(separator: ", "))): \(failure)")
      }
    }

    print("gateway vectors \(file).json: \(vectors.count - failures.count)/\(vectors.count) passed")

    for failure in failures {
      Issue.record(Comment(rawValue: failure))
    }
  }

  /// `nil` when the port agrees with the vector, else what differed.
  private func check(_ vector: Vector) -> String? {
    switch VectorDispatch.run(vector) {
    case .unsupported(let reason):
      return reason
    case .threw(let error):
      guard vector.throwsError else {
        return "threw \(error.kind.rawValue): \(error.message), expected \(vector.result?.description ?? "undefined")"
      }

      if let kind = vector.errorKind, kind != error.kind.rawValue {
        return "threw kind \(error.kind.rawValue), expected \(kind)"
      }

      if let message = vector.errorMessage, !message.unicodeScalars.elementsEqual(error.message.unicodeScalars) {
        return "threw \"\(error.message)\", expected \"\(message)\""
      }

      return nil
    case .value(let value):
      if vector.throwsError {
        return "returned \(value), expected a throw"
      }

      let expected = vector.result ?? .null
      return value == expected ? nil : "returned \(value), expected \(expected)"
    }
  }

  @Test func theVectorFilesTheLaterTasksOwnAreStillThere() throws {
    let directory = try #require(VectorLoader.vectorsDirectory())
    let present = try FileManager.default.contentsOfDirectory(atPath: directory.path)
      .filter { $0.hasSuffix(".json") }
      .map { String($0.dropLast(5)) }
    let later = Set(present).subtracting(VectorLoader.files)

    // plugin, push, session-search: replayed by the tasks that port them. ui-meta is
    // replayed by HermieCoreTests (UIMetaVectorTests), where the port lives.
    #expect(later == ["plugin", "push", "session-search", "ui-meta"])
  }
}
