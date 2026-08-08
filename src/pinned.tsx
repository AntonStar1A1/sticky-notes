import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './pinned.css'
import App from './PinnedApp.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
