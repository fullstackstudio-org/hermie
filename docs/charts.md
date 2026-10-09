# Charts in a reply: the `hermie-chart` block

A bot can answer with numbers as a chart. It writes a fenced code block whose language is `hermie-chart` and
whose body is one JSON object. The native Apple apps draw it with Swift Charts and the browser client draws it
as SVG, in the reply, under the words around it. Anywhere else (the Android app, the terminal, a copy pasted
into a note) the block is an ordinary code block holding JSON, which reads fine as it is. So a bot can always write one: the
worst case is that a reader sees the data instead of the picture.

````
```hermie-chart
{
  "type": "bar",
  "title": "Sales per quarter",
  "unit": "EUR",
  "x": ["Q1", "Q2", "Q3", "Q4"],
  "series": [
    {"name": "2026", "values": [12, 15, 9, 20]},
    {"name": "2027", "values": [14, 18, 11, 24]}
  ]
}
```
````

## The format

| Key      | Required | What                                                                                         |
| -------- | -------- | -------------------------------------------------------------------------------------------- |
| `type`   | yes      | `bar`, `line` or `pie`.                                                                      |
| `x`      | yes      | The categories, in order: strings, or numbers (a year) that are written out as text. Unique. |
| `series` | yes      | One or more `{"name": "...", "values": [...]}`. `values[i]` belongs to `x[i]`.               |
| `title`  | no       | A line over the chart.                                                                       |
| `unit`   | no       | What the numbers are counted in (`EUR`, `%`, `ms`). Shown on the value axis, and read aloud. |

- **`bar`** draws the series side by side for each category. **`line`** draws one line per series, with a
  mark on every point. **`pie`** draws one series as slices of a ring: `x` names the slices.
- A **pie has exactly one series** and its values are not negative, with at least one above zero.
- Every series has exactly as many `values` as `x` has entries.
- Values are JSON numbers. Not strings (`"12"`), not booleans, not `null` (there is no gap: leave the category
  out), and finite (JSON has no `NaN` or infinity anyway).

## Limits

A block that goes past one of these is not drawn; it stays a code block.

| Limit                          | Value                            |
| ------------------------------ | -------------------------------- |
| The block's text               | 16 KiB (16 384 bytes of UTF-8)   |
| Series                         | 8                                |
| Categories (points per series) | 100; a pie 24                    |
| One category or series name    | 60 characters                    |
| `title`                        | 120 characters                   |
| `unit`                         | 12 characters                    |
| A value                        | no larger than 1e15 in magnitude |

## Strict on purpose

A block that is not exactly what this page says is shown as code, not repaired. That includes an unknown key
(at the top or inside a series), an unknown `type`, a missing `x` or `series`, a series of the wrong length, a
value that is not a number, a duplicate category or series name, an empty name, and JSON that does not
parse. The reason is the same as for a Mermaid diagram that is not a flowchart or a pie: a picture that quietly
leaves out or bends what the author sent is worse than the data it was made from.

This also covers a block that is still being written. While a reply streams, the fence is incomplete and the
reader sees the JSON growing; when the block closes and validates, it becomes the chart. The browser client
draws a chart only once its closing fence has arrived, so a fence that is never closed stays code.

## What the app does with it

- The chart is under the reply's words, as wide as the reply, with the title above it, a legend when there is
  more than one series (or for a pie), and the unit on the value axis. Colours are the system's and follow the
  light and dark appearance.
- The block has the buttons of any listing: **Copy** copies the JSON, and the eye switches between the picture
  and the data it was drawn from.
- VoiceOver reads the chart as a sentence: its kind, its title, the unit, and each series with its first twelve
  points (and "and N more").
- Read aloud (voice mode) treats it as a code block, which is summarised and not spoken digit by digit.
- A chart is drawn in a bot's reply, in a bot-to-bot message and in a cron's delivery. What the owner types
  stays as typed.

## For a bot's prompt

Paste this into a bot's instructions to have it use the block:

> When the answer is a set of numbers a person would rather see than read (a trend over time, a comparison, a
> share of a whole), also give it as a chart: a fenced code block with the language `hermie-chart` holding one
> JSON object `{"type": "bar" | "line" | "pie", "title"?, "unit"?, "x": [categories], "series": [{"name",
"values": [numbers]}]}`. At most 8 series and 100 points (a pie: one series, at most 24 slices). Every
> `values` list is as long as `x`. Numbers only: no strings, no `null`, no extra keys. Say in words what the
> chart shows too; not every reader sees it drawn.

## Where it lives

`HermieChart` (`native/apple/HermieKit/Sources/HermieMarkdown/HermieChart.swift`) is the validator and the one
decision the renderer makes (`HermieChart.decide`: a chart, or the code block it came from). `HermieChartView`
draws it. The block stays a `.code` block in the Markdown model, so the shared corpus under `contract/` is not
affected.

The web client has the same validator in `native/web/src/markdown/markup/chart-spec.ts` (one test per
refusal in `chart-spec.test.ts`), the layout in `chart-layout.ts` and the drawing in
`native/web/src/markdown/Chart.tsx`, a lazy chunk: bars, lines and a ring in hand-written SVG, no charting
library. The drawing is made in the width its box has, is one image named by the same spoken sentence as the
native apps', takes its series colours from tokens that follow the light and dark scheme, and gives a line chart
a different mark shape for each series. The Show source toggle and Copy work as above. What the owner typed is
not drawn.
