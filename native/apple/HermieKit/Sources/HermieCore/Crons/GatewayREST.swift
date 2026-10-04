import Foundation
import HermieGateway
import HermieProtocol

/// The JSON side of a gateway's REST API, as a feature that has no typed route of its own reads it.
///
/// `GatewayLink` is the socket plus the handful of REST reads the chat needs; the crons are mostly
/// REST (`/api/cron/*`), and giving every route a method on the link would grow it for one feature.
/// The production link (`ConnectionLink`) answers through its `HTTPClient`, so a call goes out with
/// the same credentials, the same 401 handling and the same front-door headers as every other one.
/// A link without a REST side (a test's scripted one) simply is not one, and a feature that needs it
/// says so (`GatewaySession.cronService` is nil).
public protocol GatewayREST: Sendable {
  /// One JSON call: `GET`, `POST`, `PUT` or `DELETE`. `nil` for an empty body; throws `GatewayError`
  /// for a refusal, with the gateway's own `detail` as its message.
  func restJSON(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue?
}

extension ConnectionLink: GatewayREST {
  public func restJSON(_ method: String, _ path: String, body: JSONValue?) async throws -> JSONValue? {
    switch method {
    case "GET": try await http.get(path)
    case "POST": try await http.post(path, body: body)
    case "PUT": try await http.put(path, body: body)
    case "DELETE": try await http.delete(path)
    default: throw GatewayError(.config, "This connection cannot send a \(method) request.")
    }
  }
}
