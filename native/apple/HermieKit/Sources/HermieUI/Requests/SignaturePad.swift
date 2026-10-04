import HermieCore
import SwiftUI

#if os(iOS)
  import PencilKit
  import UIKit
#endif

/// The drawing area of a signature: a white sheet with a baseline, black ink, any input (a finger, a pen, a
/// pointer). It collects strokes into `SignatureInk`, which is what both files are made from; nothing it draws is a
/// file by itself.
///
/// iPhone and iPad use `PKCanvasView`, which brings palm rejection; the Mac draws with a plain view that follows
/// the pointer. Both always show black on white, whatever the appearance, since that is what the files show.
struct SignaturePad: View {
  @Binding var ink: SignatureInk
  /// The pad takes no more strokes (the files are being made or sent).
  let isLocked: Bool

  /// The height of the pad.
  static let height: CGFloat = 220

  var body: some View {
    ZStack {
      Color.white

      // The baseline and the cross a signature stands on.
      VStack {
        Spacer()
        HStack(alignment: .bottom, spacing: 8) {
          Image(systemName: "xmark")
            .font(.caption)
            .foregroundStyle(Color.black.opacity(0.35))
            .accessibilityHidden(true)
          Rectangle()
            .fill(Color.black.opacity(0.25))
            .frame(height: 1)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 36)
      }
      .allowsHitTesting(false)

      if ink.isEmpty {
        Text(NativeStrings.DeviceRequests.Signature.placeholder)
          .font(.title3)
          .foregroundStyle(Color.black.opacity(0.3))
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }

      #if os(iOS)
        PencilKitPad(ink: $ink, isLocked: isLocked)
      #else
        PointerPad(ink: $ink, isLocked: isLocked)
      #endif
    }
    .frame(height: Self.height)
    .clipShape(.rect(cornerRadius: 12))
    .overlay {
      RoundedRectangle(cornerRadius: 12)
        .stroke(Color.secondary.opacity(0.5), lineWidth: 1)
    }
    // Always paper: black ink on white, in dark mode too.
    .environment(\.colorScheme, .light)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(NativeStrings.DeviceRequests.Signature.padLabel)
    .accessibilityHint(NativeStrings.DeviceRequests.Signature.padHint)
    .accessibilityIdentifier("signature.pad")
  }
}

#if os(iOS)
  /// `PKCanvasView`, read back into `SignatureInk` as it changes.
  private struct PencilKitPad: UIViewRepresentable {
    @Binding var ink: SignatureInk
    let isLocked: Bool

    func makeCoordinator() -> Coordinator {
      Coordinator()
    }

    func makeUIView(context: Context) -> PKCanvasView {
      let canvas = PKCanvasView()
      canvas.drawingPolicy = .anyInput
      canvas.tool = PKInkingTool(.pen, color: .black, width: 3)
      canvas.backgroundColor = .clear
      canvas.isOpaque = false
      canvas.overrideUserInterfaceStyle = .light
      canvas.isScrollEnabled = false
      canvas.delegate = context.coordinator
      context.coordinator.parent = self
      return canvas
    }

    func updateUIView(_ canvas: PKCanvasView, context: Context) {
      context.coordinator.parent = self
      canvas.isUserInteractionEnabled = !isLocked

      // Clear and Undo come from the sheet: the canvas follows the ink.
      let drawn = canvas.drawing.strokes.count

      if ink.isEmpty, drawn > 0 {
        canvas.drawing = PKDrawing()
      } else if ink.strokes.count < drawn {
        var drawing = canvas.drawing
        drawing.strokes.removeLast(drawn - ink.strokes.count)
        canvas.drawing = drawing
      }
    }

    @MainActor
    final class Coordinator: NSObject, PKCanvasViewDelegate {
      var parent: PencilKitPad?

      func canvasViewDrawingDidChange(_ canvas: PKCanvasView) {
        guard let parent else {
          return
        }

        let strokes: [[SignaturePoint]] = canvas.drawing.strokes.map { stroke in
          stroke.path.interpolatedPoints(by: .distance(2)).map {
            let point = $0.location.applying(stroke.transform)
            return SignaturePoint(x: Double(point.x), y: Double(point.y))
          }
        }

        let next = SignatureInk(strokes: strokes)

        if next != parent.ink {
          parent.ink = next
        }
      }
    }
  }
#else
  /// The Mac: a view that follows the pointer.
  private struct PointerPad: View {
    @Binding var ink: SignatureInk
    let isLocked: Bool

    @State private var drawing = false

    var body: some View {
      Canvas { context, _ in
        for stroke in ink.strokes {
          var path = Path()
          let segments = SignatureArtwork.segments(of: stroke.points)

          for segment in segments {
            switch segment {
            case .move(let point): path.move(to: CGPoint(x: point.x, y: point.y))
            case .line(let point): path.addLine(to: CGPoint(x: point.x, y: point.y))
            case .quad(let control, let end):
              path.addQuadCurve(
                to: CGPoint(x: end.x, y: end.y), control: CGPoint(x: control.x, y: control.y))
            case .dot(let point):
              path.addEllipse(in: CGRect(x: point.x - 1.5, y: point.y - 1.5, width: 3, height: 3))
            }
          }

          context.stroke(path, with: .color(.black), style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round))
        }
      }
      .contentShape(.rect)
      .gesture(
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
          .onChanged { value in
            guard !isLocked else {
              return
            }

            let point = SignaturePoint(x: value.location.x, y: value.location.y)

            if !drawing {
              drawing = true
              ink.begin(at: SignaturePoint(x: value.startLocation.x, y: value.startLocation.y))
            }

            ink.extend(to: point)
          }
          .onEnded { _ in
            drawing = false
          }
      )
    }
  }
#endif
