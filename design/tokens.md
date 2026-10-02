# Hermie design tokens — Messenger direction

> **The app background is not in this table.** It was, as `#F2F2F7` / `#000000`,
> and neither string appears anywhere in `expo/hermie/src` any more. The floor is
> a property of the THEME PRESET, of which there are three in two schemes, and
> `expo/hermie/src/ui/themes.ts` is the only place it is written down:
>
> | Preset   | Light     | Dark      |
> | -------- | --------- | --------- |
> | Blue     | `#EAF3FF` | `#070F1D` |
> | Graphite | `#F0F1F3` | `#2E3138` |
> | Lime     | `#F3FAE4` | `#0B1206` |
>
> A reader can also make one, so even those six are the shipped set rather than
> the possible set. Blue is the default, and it is what the browser build's
> document template and `app.config.ts`'s splash colours are painting before the
> app boots — which is why a stale pair here was worth more than a stale table
> usually is.

| Role                            | Light     | Dark      |
| ------------------------------- | --------- | --------- |
| surface                         | `#FFFFFF` | `#111113` |
| surfaceRaised / received bubble | `#E9E9ED` | `#28282C` |
| text                            | `#17171B` | `#F5F5F7` |
| textMuted                       | `#5C5C65` | `#B0B0BA` |
| accent / links / focus          | `#0063CC` | `#62ACFF` |
| bubbleBlue / primary action     | `#006BDC` | `#0874DE` |
| onAccent / outgoing text        | `#FFFFFF` | `#FFFFFF` |
| danger                          | `#B42332` | `#FF9AA4` |
| success                         | `#217844` | `#76D995` |
| switchGreen                     | `#238548` | `#238548` |
| border                          | `#D5D5DC` | `#3C3C43` |
| incoming / bot DM bubble        | `#EEE8F7` | `#30253F` |
| incomingText / sender chip      | `#61428B` | `#D1B6F5` |

**Typography:** Offline system sans-serif (`-apple-system`, BlinkMacSystemFont, Segoe UI, sans-serif). Body and chat 17/25, app titles 24/28, sheet titles 22/26, conversation names 17 bold, preview lines 15/21, secondary metadata 12/17. Timestamps, delivery receipts, queued pills, and footer tabs use 11px. Board title 42–48px. Monospace is reserved for commands, arguments/results, and diffs.

**Spacing:** 4, 8, 12, 16, 24, 32, 48. Bubble padding 12–14px vertically and 16px horizontally. Conversation avatars 58px, sidebar avatars 48px, chat avatars 40px. Main controls are 44px or taller; round composer controls are 38–40px, with separate targets. Fixed-scale specimens retain their requested dimensions in horizontally scrollable rows on small screens.

**Radii:** 20px bubbles with a 5px sender-side bottom corner; outgoing bubbles have a tail. 12px inset controls, 16px tool attachments, 28px sheets and composer, circular avatars and send/stop controls. Phone frame 36px; split frame 22px.

**States:** Human messages are right-aligned blue with white text and a Read receipt below. Bot replies are left-aligned grey; incoming bot DMs use violet and an explicit sender chip. Bot-to-bot messages use forwarded quote blocks with Sending, Queued, Delivered, or Failed labels and nested replies. Tool attachments disclose arguments/results; diff lines use green/red plus addition/deletion symbols. Errors pair red with explanatory text. A collapsible pinned agents bar sits below the chat header; the queued pill sits below the composer. The running composer has a stop square, and idle sheet backgrounds show a blue send arrow. Switches use green plus knob position; segmented controls use fill plus weight. Inputs include focus and invalid styles, buttons include hover/pressed/disabled/focus states, and motion respects reduced-motion preferences. These remain static specimens, with native disclosure and form interactions.

**Contrast:** The blue bubble shades are deliberately deeper than `#0A84FF` to retain AA contrast with white body text. Minimum measured text-role contrast across background roles is 4.52:1 light and 4.60:1 dark, including bubble and sender-chip pairs. Subtle separators are decorative; input boundaries use the stronger muted role. No external font or image requests are needed.
