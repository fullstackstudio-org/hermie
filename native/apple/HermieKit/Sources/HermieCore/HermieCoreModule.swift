import HermieGateway
import HermieMarkdown
import HermieProtocol
import HermieShared
import HermieStore
import HermieTranscript

/// Marks the `HermieCore` module until it holds the session and the feature
/// models. `dependencies` names every module Core links, so a test can prove
/// the graph is the one the plan describes.
public enum HermieCoreModule {
  public static let name = "HermieCore"
  public static let dependencies = [
    HermieProtocolModule.name,
    HermieTranscriptModule.name,
    HermieGatewayModule.name,
    HermieStoreModule.name,
    HermieSharedModule.name,
    HermieMarkdownModule.name
  ]
}
