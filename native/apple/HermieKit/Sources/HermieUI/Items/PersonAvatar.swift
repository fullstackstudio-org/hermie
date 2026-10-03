import HermieCore
import SwiftUI

/// A person's picture in a shared chat: the one the gateway serves (`PeoplePictures`), or their
/// initial on a colour picked from their author id until it arrives and wherever there is none (the
/// gateway holds none, it failed, or the bytes are no image). The picture only ever replaces a letter,
/// never the other way round, so a row does not change size or jump when it lands.
///
/// Decorative: the person's name is always in the row's text (the sender in the meta line, the
/// accessibility label), so this hides itself from VoiceOver.
struct PersonAvatar: View {
  /// `<provider>:<sub>`, as a message row's author carries it.
  let id: String
  /// What the person is called, for the initial.
  let name: String
  let size: CGFloat

  @Environment(\.transcriptPeoplePictures) private var people

  var body: some View {
    AvatarCircle(
      name: name, tint: ItemFormat.authorTint(id), dataURI: people?.slot(for: id).dataURI, size: size
    )
    .task(id: id) { people?.request(id) }
    .accessibilityHidden(true)
  }
}

/// The circle itself: the picture over the initial, so a picture that lands (or never does) changes
/// nothing about the layout. Not hidden from VoiceOver here; whoever places it says what it is.
struct AvatarCircle: View {
  let name: String
  let tint: Color
  /// The picture as a `data:` URI, when there is one; bytes that are no image fall back to the initial.
  let dataURI: String?
  let size: CGFloat

  var body: some View {
    let picture = AvatarImages.image(dataURI)

    ZStack {
      Text(ItemFormat.initial(name))
        .font(.caption.weight(.semibold))
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .background(tint, in: .circle)

      if let picture {
        picture
          .resizable()
          .scaledToFill()
          .frame(width: size, height: size)
          .clipShape(.circle)
      }
    }
    .frame(width: size, height: size)
  }
}

extension EnvironmentValues {
  /// The pictures of the people in the chat; `nil` draws everybody as an initial (a lab, a gallery).
  @Entry public var transcriptPeoplePictures: PeoplePictures? = nil
}
