import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { Placeholder } from './Placeholder'
import './ui/base.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('index.html has no #root element')
}

createRoot(container).render(
  <StrictMode>
    <Placeholder />
  </StrictMode>
)
