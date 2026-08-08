import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Note, TodoItem } from './types'
import './note.css'

const SAVE_DEBOUNCE_MS = 300
const EXPANDED_MIN_WIDTH = 320 // 窗口宽度 ≥320 视为展开态
const id = Number(new URL(window.location.href).searchParams.get('id'))
const win = getCurrentWindow()

// 拖窗排除区:这些区域的 mousedown 不应触发 startDragging(交互元素 / 正文区)
const DRAG_EXCLUDE = '.note-body, .note-context-menu, .note-resize-handle, button, input, textarea'

function NoteApp() {
  const [note, setNote] = useState<Note | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState(false)
  const [highlight, setHighlight] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  // 最新 note 快照,供回调读取(避免依赖 state 导致回调身份频繁变化)
  const noteRef = useRef<Note | null>(null)
  const pendingRef = useRef<{ note?: Note; todos: Map<number, TodoItem> }>({ note: undefined, todos: new Map() })
  const timerRef = useRef<number | null>(null)

  // —— 防抖落库:编辑静默保存,不触发任何事件 ——
  const flush = useCallback(async () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = { note: undefined, todos: new Map() }
    try {
      if (pending.note) await invoke('update_note', { note: pending.note })
      const items = Array.from(pending.todos.values())
      if (items.length) await Promise.all(items.map((it) => invoke('update_todo', { item: it })))
    } catch (e) {
      console.error('保存便签失败:', e)
    }
  }, [])

  const schedule = useCallback((updater: () => void) => {
    updater()
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, SAVE_DEBOUNCE_MS)
  }, [flush])

  // 失焦 / 页面卸载前强制落库,兜住防抖窗口内的改动
  useEffect(() => {
    const flushAll = () => { flush() }
    window.addEventListener('blur', flushAll)
    window.addEventListener('beforeunload', flushAll)
    return () => {
      window.removeEventListener('blur', flushAll)
      window.removeEventListener('beforeunload', flushAll)
      flush()
    }
  }, [flush])

  // 字段级编辑(标题/正文/透明度)
  const updateNote = useCallback((changes: Partial<Note>) => {
    schedule(() => {
      setNote((prev) => {
        if (!prev) return prev
        const next = { ...prev, ...changes }
        noteRef.current = next
        pendingRef.current.note = next
        return next
      })
    })
  }, [schedule])

  // 待办:勾选 / 编辑内容(防抖落库)
  const toggleTodo = useCallback((item: TodoItem) => {
    const next = { ...item, is_done: !item.is_done }
    schedule(() => {
      setTodos((prev) => prev.map((t) => (t.id === item.id ? next : t)))
      pendingRef.current.todos.set(item.id, next)
    })
  }, [schedule])

  const updateTodoContent = useCallback((item: TodoItem, content: string) => {
    const next = { ...item, content }
    schedule(() => {
      setTodos((prev) => prev.map((t) => (t.id === item.id ? next : t)))
      pendingRef.current.todos.set(item.id, next)
    })
  }, [schedule])

  const addTodo = useCallback(async (content: string) => {
    try {
      const item = await invoke<TodoItem>('add_todo', { noteId: id, content })
      setTodos((prev) => [...prev, item])
    } catch (e) {
      console.error('新增待办失败:', e)
    }
  }, [])

  const deleteTodo = useCallback((item: TodoItem) => {
    pendingRef.current.todos.delete(item.id)
    setTodos((prev) => prev.filter((t) => t.id !== item.id))
    invoke('delete_todo', { id: item.id }).catch((e) => console.error('删除待办失败:', e))
  }, [])

  // 紧凑 ↔ 展开:固定尺寸 240×200 / 360×420,以左上角为锚点,尺寸随防抖写库
  const setWindowState = useCallback(async (expanded: boolean) => {
    const w = expanded ? 360 : 240
    const h = expanded ? 420 : 200
    await win.setSize(new LogicalSize(w, h))
    // 新尺寸必须同步进 noteRef / state,否则 300ms 防抖窗口内的字段编辑会以旧尺寸重建整条 note 覆盖(pending 整体替换)
    schedule(() => {
      setNote((prev) => {
        if (!prev) return prev
        const next = { ...prev, width: w, height: h }
        noteRef.current = next
        pendingRef.current.note = next
        return next
      })
    })
    setExpanded(expanded)
  }, [schedule])

  // 右下角缩放:拖动过程中只改窗口尺寸,松手时把最终尺寸写进 pending 落库
  const startResize = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const startW = window.innerWidth
    const startH = window.innerHeight
    let lastW = startW
    let lastH = startH
    const onMove = (me: MouseEvent) => {
      lastW = Math.max(180, startW + (me.clientX - startX))
      lastH = Math.max(120, startH + (me.clientY - startY))
      win.setSize(new LogicalSize(lastW, lastH)).catch(() => {})
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 同上:最终尺寸同步进 noteRef / state,防止防抖窗口内的编辑以旧尺寸重建
      schedule(() => {
        setNote((prev) => {
          if (!prev) return prev
          const next = { ...prev, width: lastW, height: lastH }
          noteRef.current = next
          pendingRef.current.note = next
          return next
        })
      })
      setExpanded(lastW >= EXPANDED_MIN_WIDTH)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [schedule])

  // 置顶:先落库未防抖改动,再带全量最新 note 立即写库(触发 Rust 置顶广播)+ 窗口置顶
  const togglePin = useCallback(async () => {
    await flush()
    const current = noteRef.current
    if (!current) return
    const next = { ...current, is_pinned: !current.is_pinned }
    noteRef.current = next
    setNote(next)
    try {
      await invoke('update_note', { note: next })
      await win.setAlwaysOnTop(next.is_pinned)
    } catch (e) {
      console.error('置顶切换失败:', e)
    }
  }, [flush])

  const deleteNote = useCallback(() => {
    // Rust 侧会销毁本窗口并删 DB 行
    invoke('delete_note', { id }).catch((e) => console.error('删除便签失败:', e))
  }, [])

  const closeNote = useCallback(async () => {
    await flush()
    win.hide().catch((e) => console.error('隐藏便签失败:', e))
  }, [flush])

  // 另一窗口改了置顶/删除时同步:先 flush 再重拉
  const refresh = useCallback(async () => {
    await flush()
    try {
      const [n, allTodos] = await Promise.all([
        invoke<Note>('get_note', { id }),
        invoke<TodoItem[]>('get_all_todos'),
      ])
      noteRef.current = n
      setNote(n)
      setTodos(allTodos.filter((t) => t.note_id === id))
      win.setAlwaysOnTop(n.is_pinned).catch(() => {})
    } catch (e) {
      console.error('同步便签数据失败:', e)
    }
  }, [flush])

  // 初始加载 + 事件监听(highlight 闪烁 / notes-updated 同步)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [n, allTodos] = await Promise.all([
          invoke<Note>('get_note', { id }),
          invoke<TodoItem[]>('get_all_todos'),
        ])
        if (cancelled) return
        noteRef.current = n
        setNote(n)
        setTodos(allTodos.filter((t) => t.note_id === id))
        // 按窗口逻辑宽度判定初始态(≥320 展开)
        const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()])
        if (!cancelled) setExpanded(size.toLogical(scale).width >= EXPANDED_MIN_WIDTH)
      } catch (e) {
        if (!cancelled) {
          setError(true)
          console.error('加载便签失败:', e)
        }
      }
    })()

    let hlTimer: number | undefined
    const unHighlight = listen('highlight', () => {
      setHighlight(false)
      requestAnimationFrame(() => setHighlight(true))
      if (hlTimer) window.clearTimeout(hlTimer)
      hlTimer = window.setTimeout(() => setHighlight(false), 1500)
    })
    const unUpdated = listen('notes-updated', () => {
      refresh().catch((e) => console.error('刷新便签失败:', e))
    })
    return () => {
      cancelled = true
      if (hlTimer) window.clearTimeout(hlTimer)
      unHighlight.then((fn) => fn())
      unUpdated.then((fn) => fn())
    }
  }, [refresh])

  // 右键菜单:点击空白处 / Esc 关闭
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - 170)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - 230)),
    })
  }, [])

  // 双击卡片切换紧凑/展开;在输入控件上的双击保留文本选择
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, .todo-checkbox, .todo-delete')) return
    setWindowState(!expanded)
  }, [expanded, setWindowState])

  const retry = useCallback(() => window.location.reload(), [])

  if (error) {
    return (
      <div className="note-root">
        <div className="note-card note-center-card">
          <p>便签加载失败</p>
          <button onClick={retry}>重试</button>
        </div>
      </div>
    )
  }

  if (!note) {
    return (
      <div className="note-root">
        <div className="note-card note-center-card">加载中…</div>
      </div>
    )
  }

  return (
    <div
      className={`note-root ${expanded ? 'expanded' : 'compact'} ${highlight ? 'note-highlight' : ''}`}
      onMouseDown={(e) => {
        // 标题区拖窗;正文与按钮等交互元素不触发拖拽(否则真实鼠标按下会被 drag 吞掉)
        if (e.button === 0 && !(e.target as HTMLElement).closest(DRAG_EXCLUDE)) {
          win.startDragging().catch(() => {})
        }
      }}
      onContextMenu={openMenu}
    >
      <div className="note-card" style={{ opacity: note.opacity }}>
        <div className="note-header">
          <span className="note-title-text">{note.title || '无标题'}</span>
          <div className="note-actions">
            <button
              className={`pin-btn ${note.is_pinned ? 'pinned' : ''}`}
              title={note.is_pinned ? '取消置顶' : '置顶'}
              onClick={togglePin}
            >
              📌
            </button>
            <button title={expanded ? '收起' : '展开'} onClick={() => setWindowState(!expanded)}>
              {expanded ? '收起' : '展开'}
            </button>
            <button className="close-btn" title="隐藏" onClick={closeNote}>×</button>
          </div>
        </div>

        {expanded ? (
          <div className="note-body expanded" onDoubleClick={handleDoubleClick}>
            <input
              className="note-title-input"
              value={note.title}
              placeholder="标题"
              onChange={(e) => updateNote({ title: e.target.value })}
            />
            {note.note_type === 'todo' ? (
              <div className="todo-list">
                {todos.map((t) => (
                  <div key={t.id} className={`todo-item ${t.is_done ? 'done' : ''}`}>
                    <span className="todo-checkbox" onClick={() => toggleTodo(t)} title="勾选">
                      {t.is_done ? '☑' : '☐'}
                    </span>
                    <input
                      className="todo-text"
                      value={t.content}
                      onChange={(e) => updateTodoContent(t, e.target.value)}
                    />
                    <button className="todo-delete" onClick={() => deleteTodo(t)} title="删除">×</button>
                  </div>
                ))}
                <div className="todo-add">
                  <input
                    placeholder="添加新任务…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                        addTodo(e.currentTarget.value.trim())
                        e.currentTarget.value = ''
                      }
                    }}
                  />
                </div>
              </div>
            ) : (
              <textarea
                className="note-content"
                value={note.content}
                placeholder="记点什么…"
                autoFocus
                onChange={(e) => updateNote({ content: e.target.value })}
              />
            )}
          </div>
        ) : (
          <div className="note-body compact" onDoubleClick={handleDoubleClick} title="双击切换">
            {note.note_type === 'todo' ? (
              <>
                <div className="compact-todos">
                  {todos.slice(0, 3).map((t) => (
                    <div key={t.id} className={`compact-todo ${t.is_done ? 'done' : ''}`}>
                      <span>{t.is_done ? '☑' : '☐'}</span>
                      <span className="compact-todo-text">{t.content}</span>
                    </div>
                  ))}
                </div>
                {todos.length > 3 && <div className="compact-more">还有 {todos.length - 3} 项</div>}
                {todos.length === 0 && <div className="compact-empty">空待办,双击展开编辑</div>}
              </>
            ) : (
              <div className="compact-summary">{note.content || note.title || '双击展开编辑'}</div>
            )}
          </div>
        )}

        <div className="note-resize-handle" onMouseDown={startResize} title="缩放" />
      </div>

      {menu && (
        <div
          className="note-context-menu"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="menu-item" onClick={() => { togglePin(); setMenu(null) }}>
            {note.is_pinned ? '取消置顶' : '置顶'}
          </div>
          <div className="menu-item danger" onClick={() => { deleteNote(); setMenu(null) }}>删除</div>
          <div className="menu-separator" />
          <div className="menu-label">透明度</div>
          <input
            type="range"
            className="menu-opacity"
            min="30"
            max="100"
            value={Math.round(note.opacity * 100)}
            onChange={(e) => updateNote({ opacity: Number(e.target.value) / 100 })}
          />
          <div className="menu-separator" />
          <div className="menu-item" onClick={() => { setWindowState(!expanded); setMenu(null) }}>
            {expanded ? '收起' : '展开'}
          </div>
        </div>
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NoteApp />
  </StrictMode>,
)

export default NoteApp
