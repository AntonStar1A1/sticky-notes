import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import type { Note } from './types'

function PinnedApp() {
  const [notes, setNotes] = useState<Note[]>([])

  const loadNotes = useCallback(async () => {
    try {
      const allNotes = await invoke<Note[]>('get_notes')
      setNotes(allNotes.filter((n) => n.is_pinned))
    } catch (e) {
      console.error('Failed to load pinned notes:', e)
    }
  }, [])

  useEffect(() => {
    loadNotes()

    const unlisten = listen('notes-updated', () => {
      loadNotes()
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [loadNotes])

  const unpinNote = useCallback(async (id: number) => {
    try {
      const note = notes.find((n) => n.id === id)
      if (note) {
        await invoke('update_note', {
          note: { ...note, is_pinned: false },
        })
        setNotes((prev) => prev.filter((n) => n.id !== id))
      }
    } catch (e) {
      console.error('Failed to unpin note:', e)
    }
  }, [notes])

  const handleTitleBarDrag = useCallback(async () => {
    try {
      const appWindow = getCurrentWindow()
      await appWindow.startDragging()
    } catch {
      // ignore
    }
  }, [])

  return (
    <div className="pinned-root" onMouseDown={handleTitleBarDrag}>
      <div className="pinned-header">
        <span>📌 置顶便签</span>
        <button
          className="close-btn"
          onClick={async () => {
            try {
              // 隐藏而非销毁,保留窗口位置,再次打开时直接 show 复用
              await getCurrentWindow().hide()
            } catch {}
          }}
        >
          ×
        </button>
      </div>
      <div className="pinned-content">
        {notes.length === 0 ? (
          <div className="empty-state">暂无置顶便签</div>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="pinned-card">
              <div className="pinned-card-header">
                <span className="pinned-card-title">{note.title || '无标题'}</span>
                <button className="unpin-btn" onClick={() => unpinNote(note.id)}>
                  取消置顶
                </button>
              </div>
              <div className="pinned-card-body">
                <p>{note.content || '暂无内容'}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default PinnedApp
