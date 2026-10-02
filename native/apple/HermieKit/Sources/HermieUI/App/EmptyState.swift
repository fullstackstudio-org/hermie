import SwiftUI

/**
 A quiet full-screen state: a symbol, a title, a sentence and optional buttons, centred.

 Used instead of `ContentUnavailableView`, which caps Dynamic Type and fails the accessibility
 audit. This follows every text size up to AX5 and scrolls once the text no longer fits.
 */
struct EmptyState<Actions: View>: View {
  let title: String
  let systemImage: String
  let message: Text?
  let actions: Actions

  init(
    _ title: String,
    systemImage: String,
    message: Text? = nil,
    @ViewBuilder actions: () -> Actions = { EmptyView() }
  ) {
    self.title = title
    self.systemImage = systemImage
    self.message = message
    self.actions = actions()
  }

  var body: some View {
    GeometryReader { proxy in
      ScrollView {
        VStack(spacing: 16) {
          Image(systemName: systemImage)
            .font(.largeTitle)
            .imageScale(.large)
            .foregroundStyle(.tint)
            .accessibilityHidden(true)

          Text(title)
            .font(.title2.bold())
            .multilineTextAlignment(.center)
            .accessibilityAddTraits(.isHeader)

          if let message {
            message
              .multilineTextAlignment(.center)
          }

          actions
        }
        .padding(32)
        .frame(maxWidth: 560)
        .frame(maxWidth: .infinity, minHeight: proxy.size.height)
      }
      .scrollBounceBehavior(.basedOnSize)
    }
  }
}
