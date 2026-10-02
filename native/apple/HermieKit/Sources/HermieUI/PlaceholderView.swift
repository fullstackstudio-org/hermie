import HermieCore
import HermieMarkdown
import SwiftUI

/// Marks the `HermieUI` module until it holds the feature views.
public enum HermieUIModule {
  public static let name = "HermieUI"
  public static let dependencies = [HermieCoreModule.name, HermieMarkdownModule.name]
}

/// What both app shells show until the first feature lands: the app's name and
/// exactly which build is running.
public struct PlaceholderView: View {
  private let info: BuildInfo

  public init(info: BuildInfo = .main) {
    self.info = info
  }

  public var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "bubble.left.and.bubble.right.fill")
        .font(.system(size: 56))
        .foregroundStyle(.tint)
        .accessibilityHidden(true)
      Text("Hermie")
        .font(.largeTitle.bold())
      Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
        row("Version", info.version)
        row("Build", info.build)
        row("Commit", info.commit)
      }
      .font(.callout)
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func row(_ label: LocalizedStringKey, _ value: String) -> some View {
    GridRow {
      Text(label)
        .foregroundStyle(.secondary)
      Text(value)
        .monospaced()
        .textSelection(.enabled)
    }
    .accessibilityElement(children: .combine)
  }
}

#Preview {
  PlaceholderView(info: BuildInfo(version: "0.2.0", build: "512", commit: "1a2b3c4"))
}
