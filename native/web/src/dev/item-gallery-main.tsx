/**
 * Development only: mounts the transcript item gallery into `dev/items.html`.
 * Not imported by anything the build reaches.
 */
import { createRoot } from 'react-dom/client'

import '../ui/theme.css'
import '../ui/base.css'
import '../features/chat/chat.css'
import './item-gallery.css'
import { ItemGalleryPage } from './item-gallery'

const host = document.getElementById('root')

if (host) {
  createRoot(host).render(<ItemGalleryPage />)
}
