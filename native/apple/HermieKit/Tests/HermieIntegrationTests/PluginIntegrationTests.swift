#if os(macOS)
import HermieGateway
import HermieProtocol
import Testing

extension Integration {
  /// What `--no-plugin` changes on the REST surface. The `hermie-plugin`
  /// advert itself is in `ui_meta`, which only the socket reads; that half
  /// waits for the connection tests.
  @Suite("Gateway plugin routes")
  enum PluginIntegrationTests {
    static let memoryList = "/api/plugins/hermie/memory/list?profile=researcher"

    @Suite("with the Hermie plugin", .fakeGateway())
    struct WithPlugin {
      @Test("the plugin's memory route answers")
      func memoryRoute() async throws {
        let http = try HTTPClient(baseURL: try FakeGateway.shared.baseURL, credentials: SessionTokenCredentials(token: ""))
        let body = try #require(try await http.get(PluginIntegrationTests.memoryList))

        #expect(body["targets"]?.arrayValue?.isEmpty == false)
      }
    }

    @Suite("without the Hermie plugin", .fakeGateway(FakeGateway.Options(plugin: false)))
    struct WithoutPlugin {
      @Test("the plugin's routes are not mounted: a 404, read as a protocol failure")
      func memoryRoute() async throws {
        let http = try HTTPClient(baseURL: try FakeGateway.shared.baseURL, credentials: SessionTokenCredentials(token: ""))
        let error = await #expect(throws: GatewayError.self) {
          try await http.get(PluginIntegrationTests.memoryList)
        }

        #expect(error?.kind == .protocol)
        #expect(error?.status == 404)
      }

      @Test("the core routes are untouched")
      func coreRoutes() async throws {
        let http = try HTTPClient(baseURL: try FakeGateway.shared.baseURL, credentials: SessionTokenCredentials(token: ""))
        let probe = try await Probe.probeGateway(try FakeGateway.shared.baseURL)

        #expect(!probe.authRequired)
        #expect(try await http.get(RESTPath.profiles)?["profiles"]?.arrayValue?.isEmpty == false)
      }
    }
  }
}
#endif
