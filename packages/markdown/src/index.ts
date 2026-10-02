/**
 * The Markdown core behind Hermie: text in, a block model and layout data out.
 *
 * Nothing here knows about React, a DOM or a screen. A renderer hands text to
 * `preprocessMarkdown`, cuts it with `splitBlocks`, lexes each block with the
 * shared `marked` instance and draws the tokens; highlighting, math and
 * Mermaid arrive as plain data (spans, a node tree, a layout) for the renderer
 * to paint however it likes.
 *
 * Every module is also reachable on its own, as `@hermie/markdown/<module>`.
 */
export { runsToPlainText, selectableRuns, type RunBlock, type SelectableRun } from './attributed'
export { blockModelOf, type Block, type BlockModel, type Mark, type Run } from './block-model'
export { resetBlockCache, splitBlocks } from './blocks'
export { codeScopeColor, type CodeScheme } from './code-theme'
export { highlightToLines, isKnownLanguage, type CodeSpan } from './highlight'
export { marked, type Token, type Tokens } from './marked-compat'
export { containsGrid, mathRuns, mathToPlainText, type MathRun } from './math/linear'
export { isMathToken, MATH_BLOCK_TOKEN, MATH_INLINE_TOKEN, type MathToken } from './math/marked-math'
export { gridColumns, gridHeights, mathHeight, mathLineHeight } from './math/metrics'
export { parseMath, type MathNode, type MathStyle } from './math/parse'
export {
  CHARACTER_EM,
  cleanLabel,
  diagramFontSize,
  diagramLineHeight,
  labelBoxWidth,
  textWidth,
  widestWidth,
  wrapToWidth,
  type DiagramText
} from './mermaid/labels'
export { layoutMermaid, type MermaidLayout, type PlacedEdge, type PlacedNode } from './mermaid/layout'
export {
  parseMermaid,
  type Direction,
  type EdgeStroke,
  type MermaidEdge,
  type MermaidGraph,
  type MermaidNode,
  type NodeShape
} from './mermaid/parse'
export { parsePie, type PieChart, type PieSlice } from './mermaid/pie'
export {
  formatPieShare,
  formatPieValue,
  layoutPie,
  type PieArc,
  type PieLayout,
  type PieSwatch
} from './mermaid/pie-layout'
export {
  parseSequence,
  type SequenceBranch,
  type SequenceDiagram,
  type SequenceFrame,
  type SequenceFrameWord,
  type SequenceHead,
  type SequenceMessage,
  type SequenceNote,
  type SequenceParticipant,
  type SequenceStep
} from './mermaid/sequence'
export {
  layoutSequence,
  type SequenceArrow,
  type SequenceFrameBox,
  type SequenceHeadBox,
  type SequenceLayout,
  type SequenceLifeline,
  type SequenceRect
} from './mermaid/sequence-layout'
export { plainTextBlock, plainTextPreview } from './plain-text'
export {
  mediaTagValues,
  preprocessMarkdown,
  renderMediaTags,
  repairStrayEmphasisSpaces,
  trimUrlTail
} from './preprocess'
