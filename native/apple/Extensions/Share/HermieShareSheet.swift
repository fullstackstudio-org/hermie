import SwiftUI

/**
 The sheet somebody sees inside another application's share menu.

 It is small on purpose. A share extension is a modal interruption of whatever
 the person was actually doing, it has a few seconds of attention and a strict
 memory budget, and everything it can offer has to be decided from one JSON file
 — so this is a list, a note field and a button, and nothing that needs a round
 trip to exist.

 ## What it says when it has finished

 Since ADR-0026 the extension attempts the delivery itself, so this sheet has a
 second half: one line, in the reader's own language, saying which of the two
 things happened. "Sent to Ada" or "Will send when Hermie opens", and nothing in
 between — a share sheet has one line of attention and the difference between
 nine reasons is not what anybody is standing there wondering about.

 Those sentences are written by the app into `share-targets.json`, already
 translated — see `HermieShareTargets`.

 ## The list is the roster the app last saw

 Most recently active first, which is the order the snapshot is already in —
 see `HermieShareRoster`. A share sheet is a glance, and the chat somebody is
 sharing INTO is very often the one they were just in.
 */
struct HermieShareSheet: View {
  let session: HermieShareSession

  @State private var note = ""
  @State private var selected: String?

  var body: some View {
    NavigationStack {
      Group {
        if let status = session.status {
          outcome(status)
        } else if session.bots.isEmpty {
          empty
        } else {
          list
        }
      }
      .navigationTitle(Text("Send to Hermie"))
      #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        // Both buttons go the moment an attempt starts. There is nothing left to
        // cancel — the entry is already on disk and the share has HAPPENED,
        // whichever way the attempt ends — and a "Cancel" that could not undo
        // anything would be a button that lies.
        if session.status == nil {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel") { session.cancel() }
          }

          ToolbarItem(placement: .confirmationAction) {
            Button("Send") {
              if let bot = session.bots.first(where: { $0.name == selected }) {
                session.send(to: bot, note: note)
              }
            }
            // Both conditions, and the second is the one that is easy to forget:
            // a share of four photographs is still copying bytes for a moment
            // after the sheet appears, and an entry written before the loads
            // finish is an entry with fewer files than the person selected.
            .disabled(selected == nil || session.loading)
          }
        }
      }
    }
  }

  /**
   The finished state: a spinner or a tick, and one sentence.

   No colour distinction between the two outcomes and no icon for the queued one.
   Both are successes from where the person is standing — they shared something
   and it is going to arrive — and painting the second one as a warning would
   invite them to share it again, which is the one thing that produces a duplicate
   in somebody's chat.
   */
  private func outcome(_ line: String) -> some View {
    VStack(spacing: 12) {
      if session.busy {
        ProgressView()
      } else {
        Image(systemName: "checkmark.circle")
          .font(.system(size: 28))
          .foregroundStyle(Color.accentColor)
          .accessibilityHidden(true)
      }

      Text(verbatim: line)
        .font(.headline)
        .multilineTextAlignment(.center)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var empty: some View {
    VStack(spacing: 12) {
      Text("No chats yet")
        .font(.headline)
      // The actionable half. The commonest cause by far is the first one, and
      // it is not an error — it is an app that has not been opened since the
      // extension was installed.
      Text("Open Hermie once so it can tell this sheet which bots your gateway has.")
        .font(.footnote)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var list: some View {
    List {
      Section {
        ForEach(session.bots) { bot in
          Button {
            selected = bot.name
          } label: {
            HStack(spacing: 12) {
              HermieShareAvatar(bot: bot)

              Text(verbatim: bot.displayName)
                .foregroundStyle(.primary)
                .lineLimit(1)

              Spacer()

              if selected == bot.name {
                Image(systemName: "checkmark")
                  .foregroundStyle(Color.accentColor)
                  .accessibilityHidden(true)
              }
            }
            .contentShape(Rectangle())
          }
          #if os(macOS)
            .buttonStyle(.plain)
          #endif
          .accessibilityAddTraits(selected == bot.name ? .isSelected : [])
        }
      } header: {
        Text(verbatim: session.summary)
      }

      Section {
        TextField("Add a note (optional)", text: $note, axis: .vertical)
          .lineLimit(1...4)
      }
    }
    #if os(iOS)
      .listStyle(.insetGrouped)
    #else
      .listStyle(.inset)
    #endif
  }
}

/**
 The circle beside a name: the bot's own picture, or its initial on the colour
 the app chose.

 The colour is NOT decided here. It arrives as hex in the snapshot, from the
 app's accent table — a second palette in a second language is a palette that
 drifts. White on it is measured at AA by `npm run contrast:check` on the app
 side, which is the only place anything can be measured.
 */
private struct HermieShareAvatar: View {
  let bot: HermieShareBot

  var body: some View {
    Group {
      if let image = ContainerImage.load(bot.avatarPath) {
        image
          .resizable()
          .aspectRatio(contentMode: .fill)
          .frame(width: 32, height: 32)
          .clipShape(Circle())
      } else {
        ZStack {
          Circle()
            .fill(Color(hexString: bot.colour, fallback: 0x1668E3))
          Text(verbatim: bot.initials)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.white)
        }
        .frame(width: 32, height: 32)
      }
    }
    .accessibilityHidden(true)
  }
}
