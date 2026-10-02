import HermieProtocol

/// Marks the `HermieGateway` module until it holds the connection, so the
/// target compiles and its place in the dependency graph can be tested.
public enum HermieGatewayModule {
  public static let name = "HermieGateway"
  public static let dependencies = [HermieProtocolModule.name]
}
