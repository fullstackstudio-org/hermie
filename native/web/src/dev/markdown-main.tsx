/**
 * Development only: mounts the Markdown fixture page into `dev/markdown.html`.
 * Not imported by anything the build reaches.
 */
import { createRoot } from 'react-dom/client'

import '../ui/base.css'
import { MarkdownFixturesPage } from './markdown-fixtures'

const host = document.getElementById('root')

if (host) {
  createRoot(host).render(<MarkdownFixturesPage streaming />)
}
