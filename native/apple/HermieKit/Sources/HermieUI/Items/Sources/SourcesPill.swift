import HermieCore
import HermieTranscript
import SwiftUI

/// The pill at the end of the row under a reply that used the web, like ChatGPT's "Sources": up to three
/// monograms stacked, the word, and a tap that lists the pages (`SourcesSheet`).
///
/// A source's picture is a monogram (the first letter of its domain on a colour that is the same for the same
/// domain on every device): nothing is fetched for a source, so showing the list tells no site and no third
/// party what the person is reading (`contract/sources/`, section 4).
struct SourcesPill: View {
  let sources: [ReplySource]

  @State private var isPresented = false
  @ScaledMetric(relativeTo: .subheadline) private var height: CGFloat = 32
  #if DEBUG
    @Environment(AppLaunch.self) private var launch: AppLaunch?
  #endif

  var body: some View {
    Button {
      isPresented = true
    } label: {
      HStack(spacing: 8) {
        StackedMonograms(sources: sources)
        Text(NativeStrings.Sources.pill)
          .font(.subheadline)
      }
      .padding(.leading, 6)
      .padding(.trailing, 12)
      .frame(minHeight: height)
      .background(.quaternary.opacity(0.5), in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(NativeStrings.Sources.pillAccessibility(sources.count))
    .accessibilityIdentifier("reply.sources")
    .sourcesPresentation(isPresented: $isPresented, sources: sources)
    #if DEBUG
      // `-HermieOpenSources YES`: a screenshot run opens the list without a finger.
      .task {
        if launch?.environment.testHooks?.openSources == true {
          try? await Task.sleep(for: .seconds(1))
          isPresented = true
        }
      }
    #endif
  }
}

/// Up to three monograms of different sites, overlapping, each ringed in the page's colour.
struct StackedMonograms: View {
  let sources: [ReplySource]

  @ScaledMetric(relativeTo: .subheadline) private var size: CGFloat = 22

  /// The first source of each of the first three different sites.
  var shown: [ReplySource] {
    var seen = Set<String>()
    var out: [ReplySource] = []

    for source in sources where seen.insert(ReplySource.siteKey(of: source.domain)).inserted {
      out.append(source)
      if out.count == 3 { break }
    }

    return out
  }

  var body: some View {
    HStack(spacing: -size * 0.35) {
      ForEach(Array(shown.enumerated()), id: \.element.id) { index, source in
        SourceMonogram(source: source, size: size)
          .overlay(Circle().strokeBorder(.background, lineWidth: 1.5))
          .zIndex(Double(shown.count - index))
      }
    }
    .accessibilityHidden(true)
  }
}

/// The first letter of a source's domain on a colour that belongs to that domain.
struct SourceMonogram: View {
  let source: ReplySource
  let size: CGFloat

  var body: some View {
    Text(String(source.monogram))
      .font(.system(size: size * 0.5, weight: .semibold, design: .rounded))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      // Dark enough for white letters on every hue, in light and dark.
      .background(Color(hue: source.hue, saturation: 0.55, brightness: 0.5), in: Circle())
      .accessibilityHidden(true)
  }
}

extension View {
  /// The sources list over this view: a sheet on the phone, a popover on the Mac.
  func sourcesPresentation(isPresented: Binding<Bool>, sources: [ReplySource]) -> some View {
    #if os(macOS)
      popover(isPresented: isPresented, arrowEdge: .bottom) {
        SourcesSheet(sources: sources)
          .frame(width: 380, height: 420)
      }
    #else
      sheet(isPresented: isPresented) {
        SourcesSheet(sources: sources)
      }
    #endif
  }
}
