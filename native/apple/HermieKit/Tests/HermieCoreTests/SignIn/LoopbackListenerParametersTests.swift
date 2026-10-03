import Foundation
import Network
import Testing

@testable import HermieCore

/// How the loopback listener binds, and whom it lets in. On iOS, `acceptLocalOnly` closed the system
/// browser's connection as "non-local" the moment it was accepted (Network logged "Ignoring non-local
/// connection from 127.0.0.1"), so the browser showed a lost connection and the sign-in never finished.
@Suite("Loopback listener parameters")
struct LoopbackListenerParametersTests {
  @Test("binds the IPv4 loopback address, without endpoint reuse, and without acceptLocalOnly")
  func parameters() throws {
    let parameters = LoopbackCallbackListener.parameters(port: 0)

    #expect(parameters.acceptLocalOnly == false)
    #expect(parameters.allowLocalEndpointReuse == false)
    #expect(parameters.includePeerToPeer == false)

    guard case .hostPort(let host, let port)? = parameters.requiredLocalEndpoint else {
      Issue.record("no required local endpoint")
      return
    }

    #expect(host == .ipv4(.loopback))
    #expect(port == .any)
    #expect(LoopbackCallbackListener.parameters(port: 41234).requiredLocalEndpoint == .hostPort(host: .ipv4(.loopback), port: 41234))
  }

  @Test("only a loopback peer is served")
  func loopbackPeers() {
    #expect(LoopbackCallbackListener.isLoopbackPeer(.hostPort(host: "127.0.0.1", port: 50000)))
    #expect(LoopbackCallbackListener.isLoopbackPeer(.hostPort(host: "::1", port: 50000)))
    #expect(!LoopbackCallbackListener.isLoopbackPeer(.hostPort(host: "192.168.1.20", port: 50000)))
    #expect(!LoopbackCallbackListener.isLoopbackPeer(.hostPort(host: "fe80::1", port: 50000)))
    #expect(!LoopbackCallbackListener.isLoopbackPeer(.hostPort(host: "example.com", port: 80)))
    #expect(!LoopbackCallbackListener.isLoopbackPeer(.service(name: "x", type: "_http._tcp", domain: "local", interface: nil)))
  }
}
