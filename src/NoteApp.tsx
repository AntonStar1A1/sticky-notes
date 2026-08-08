import { useEffect, useState } from 'react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Note } from './types'
import './note.css'

const id = Number(new URL(window.location.href).searchParams.get('id'))

function NoteApp() {
  const [note, setNote] = useState<Note | null>(null)

  useEffect(() => {
    invoke<Note>('get_note', { id }).then(setNote).catch(console.error)
  }, [])

  if (!note) return <div className="note-root">加载中…</div>

  return (
    <div className="note-root" onMouseDown={(e) => {
      if (e.button === 0 && !(e.target as HTMLElement).closest('.note-body')) {
        getCurrentWindow().startDragging().catch(() => {})
      }
    }}>
      <div className="note-header">
        <span className="note-title-text">{note.title || '无标题'}</span>
        <button onClick={() => getCurrentWindow().hide()}>×</button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NoteApp />
  </StrictMode>,
)

export default NoteApp
