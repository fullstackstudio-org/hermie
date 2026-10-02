import HermieProtocol

/// Marks the `HermieTranscript` module until it holds the engine, so the target
/// compiles and its place in the dependency graph can be tested.
public enum HermieTranscriptModule {
  public static let name = "HermieTranscript"
  public static let dependencies = [HermieProtocolModule.name]
}
