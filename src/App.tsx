import { useState, useEffect, useCallback, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import type { Category, Note, TodoItem, ContextMenu } from './types'

const SAVE_DEBOUNCE_MS = 300

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [todos, setTodos] = useState<Record<number, TodoItem[]>>({})
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null)
  const [activeId, setActiveId] = useState<number | null>(null)
  const [highestZ, setHighestZ] = useState(100)
  const [zMap, setZMap] = useState<Record<number, number>>({})
  const [loaded, setLoaded] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [isAddingCategory, setIsAddingCategory] = useState(false)

  // —— 防抖持久化:本地状态即时更新,落库统一延迟合并,避免每次按键都写库 + 全量广播 ——
  const notesRef = useRef<Note[]>([])
  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  const pendingIdsRef = useRef<Set<number>>(new Set())
  const flushTimerRef = useRef<number | null>(null)
  const pendingTodosRef = useRef<Map<number, TodoItem>>(new Map())
  const todoTimerRef = useRef<number | null>(null)

  const flushNotes = useCallback(async () => {
    if (flushTimerRef.current) {
      window.clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    const ids = Array.from(pendingIdsRef.current)
    pendingIdsRef.current.clear()
    const toSave = ids
      .map((id) => notesRef.current.find((n) => n.id === id))
      .filter((n): n is Note => !!n)
    if (toSave.length > 0) {
      await Promise.all(toSave.map((n) => invoke('update_note', { note: n })))
    }
  }, [])

  const scheduleFlush = useCallback((noteId: number) => {
    pendingIdsRef.current.add(noteId)
    if (flushTimerRef.current) window.clearTimeout(flushTimerRef.current)
    flushTimerRef.current = window.setTimeout(flushNotes, SAVE_DEBOUNCE_MS)
  }, [flushNotes])

  const flushTodos = useCallback(async () => {
    if (todoTimerRef.current) {
      window.clearTimeout(todoTimerRef.current)
      todoTimerRef.current = null
    }
    const items = Array.from(pendingTodosRef.current.values())
    pendingTodosRef.current.clear()
    if (items.length > 0) {
      await Promise.all(items.map((it) => invoke('update_todo', { item: it })))
    }
  }, [])

  const scheduleTodoFlush = useCallback((item: TodoItem) => {
    pendingTodosRef.current.set(item.id, item)
    if (todoTimerRef.current) window.clearTimeout(todoTimerRef.current)
    todoTimerRef.current = window.setTimeout(flushTodos, SAVE_DEBOUNCE_MS)
  }, [flushTodos])

  const groupTodos = (items: TodoItem[]): Record<number, TodoItem[]> => {
    const map: Record<number, TodoItem[]> = {}
    for (const item of items) {
      if (!map[item.note_id]) map[item.note_id] = []
      map[item.note_id].push(item)
    }
    return map
  }

  const loadAll = useCallback(async () => {
    const [cats, notesData, todosData] = await Promise.all([
      invoke<Category[]>('get_categories'),
      invoke<Note[]>('get_notes'),
      invoke<TodoItem[]>('get_all_todos'),
    ])
    setCategories(cats)
    setNotes(notesData)
    setTodos(groupTodos(todosData))
  }, [])

  const refreshFromEvent = useCallback(async () => {
    // 先落库本窗口未防抖完的改动,再拉全量,避免两个窗口互相覆盖
    await Promise.all([flushNotes(), flushTodos()])
    const [notesData, todosData] = await Promise.all([
      invoke<Note[]>('get_notes'),
      invoke<TodoItem[]>('get_all_todos'),
    ])
    setNotes(notesData)
    setTodos(groupTodos(todosData))
  }, [flushNotes, flushTodos])

  useEffect(() => {
    loadAll()
      .catch((e) => console.error('Failed to init:', e))
      .finally(() => setLoaded(true))

    const unlisten = listen('notes-updated', () => {
      refreshFromEvent().catch((e) => console.error('Failed to refresh:', e))
    })

    return () => {
      unlisten.then((fn) => fn())
    }
  }, [loadAll, refreshFromEvent])

  // 失焦 / 卸载 / 退出前落库,兜住防抖窗口内的改动
  useEffect(() => {
    const flushAll = () => {
      flushNotes()
      flushTodos()
    }
    window.addEventListener('blur', flushAll)
    window.addEventListener('beforeunload', flushAll)
    return () => {
      window.removeEventListener('blur', flushAll)
      window.removeEventListener('beforeunload', flushAll)
      flushAll()
    }
  }, [flushNotes, flushTodos])

  const bringToFront = useCallback((id: number) => {
    const newZ = highestZ + 1
    setHighestZ(newZ)
    setZMap((prev) => ({ ...prev, [id]: newZ }))
    setActiveId(id)
  }, [highestZ])

  const updateNoteField = useCallback((id: number, changes: Partial<Note>) => {
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, ...changes } : n))
      notesRef.current = next
      return next
    })
    scheduleFlush(id)
  }, [scheduleFlush])

  const addNote = useCallback(async (type: string = 'text') => {
    try {
      const note = await invoke<Note>('add_note', {
        title: type === 'todo' ? '新建待办' : '新建便签',
        noteType: type,
        categoryId: activeCategoryId,
      })
      setNotes((prev) => [...prev, note])
      bringToFront(note.id)
    } catch (e) {
      console.error('Failed to add note:', e)
    }
  }, [activeCategoryId, bringToFront])

  const deleteNote = useCallback(async (id: number) => {
    try {
      await invoke('delete_note', { id })
      pendingIdsRef.current.delete(id)
      Array.from(pendingTodosRef.current.keys()).forEach((tid) => {
        if (pendingTodosRef.current.get(tid)?.note_id === id) {
          pendingTodosRef.current.delete(tid)
        }
      })
      setNotes((prev) => prev.filter((n) => n.id !== id))
      setTodos((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (e) {
      console.error('Failed to delete note:', e)
    }
  }, [])

  const togglePin = useCallback(async (id: number) => {
    const note = notesRef.current.find((n) => n.id === id)
    if (!note) return
    await flushNotes()
    const updated = { ...note, is_pinned: !note.is_pinned }
    setNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? updated : n))
      notesRef.current = next
      return next
    })
    try {
      // 置顶变更需要立即落库并广播给置顶窗口
      await invoke('update_note', { note: updated })
    } catch (e) {
      console.error('Failed to toggle pin:', e)
    }
  }, [flushNotes])

  const updateOpacity = useCallback((id: number, opacity: number) => {
    updateNoteField(id, { opacity })
  }, [updateNoteField])

  const updateCategory = useCallback((id: number, categoryId: number | null) => {
    updateNoteField(id, { category_id: categoryId })
  }, [updateNoteField])

  const addCategory = useCallback(async () => {
    if (!newCategoryName.trim()) return
    try {
      const cat = await invoke<Category>('add_category', { name: newCategoryName.trim() })
      setCategories((prev) => [...prev, cat])
      setNewCategoryName('')
      setIsAddingCategory(false)
    } catch (e) {
      console.error('Failed to add category:', e)
    }
  }, [newCategoryName])

  const deleteCategory = useCallback(async (id: number) => {
    try {
      await invoke('delete_category', { id })
      setCategories((prev) => prev.filter((c) => c.id !== id))
      // 数据库外键会 SET NULL,同步本地状态并落库
      setNotes((prev) =>
        prev.map((n) => (n.category_id === id ? { ...n, category_id: null } : n))
      )
      notesRef.current.forEach((n) => {
        if (n.category_id === id) scheduleFlush(n.id)
      })
      if (activeCategoryId === id) {
        setActiveCategoryId(null)
      }
    } catch (e) {
      console.error('Failed to delete category:', e)
    }
  }, [activeCategoryId, scheduleFlush])

  const toggleTodo = useCallback(async (noteId: number, todoId: number) => {
    const items = todos[noteId] || []
    const item = items.find((t) => t.id === todoId)
    if (item) {
      const updatedItem = { ...item, is_done: !item.is_done }
      try {
        await invoke('update_todo', { item: updatedItem })
        setTodos((prev) => ({
          ...prev,
          [noteId]: items.map((t) => (t.id === todoId ? updatedItem : t)),
        }))
      } catch (e) {
        console.error('Failed to update todo:', e)
      }
    }
  }, [todos])

  const addTodoItem = useCallback(async (noteId: number, content: string) => {
    try {
      const item = await invoke<TodoItem>('add_todo', { noteId, content })
      setTodos((prev) => ({
        ...prev,
        [noteId]: [...(prev[noteId] || []), item],
      }))
    } catch (e) {
      console.error('Failed to add todo:', e)
    }
  }, [])

  const deleteTodoItem = useCallback(async (noteId: number, todoId: number) => {
    try {
      await invoke('delete_todo', { id: todoId })
      pendingTodosRef.current.delete(todoId)
      setTodos((prev) => ({
        ...prev,
        [noteId]: (prev[noteId] || []).filter((t) => t.id !== todoId),
      }))
    } catch (e) {
      console.error('Failed to delete todo:', e)
    }
  }, [])

  const startDrag = useCallback((e: React.MouseEvent, note: Note) => {
    if (e.button !== 0) return
    bringToFront(note.id)
    const startX = e.clientX
    const startY = e.clientY
    const origX = note.x
    const origY = note.y

    // 钳制在窗口范围内,避免便签被拖出屏幕外无法找回
    let maxX = Infinity
    let maxY = Infinity
    const win = getCurrentWindow()
    Promise.all([win.innerSize(), win.scaleFactor()])
      .then(([size, scale]) => {
        const logical = size.toLogical(scale)
        maxX = Math.max(0, logical.width - note.width)
        maxY = Math.max(0, logical.height - note.height)
      })
      .catch(() => {})

    const onMove = (me: MouseEvent) => {
      updateNoteField(note.id, {
        x: Math.min(Math.max(0, origX + (me.clientX - startX)), maxX),
        y: Math.min(Math.max(0, origY + (me.clientY - startY)), maxY),
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 推迟到下一次宏任务,确保最后一次 mousemove 的 state 已渲染完成
      window.setTimeout(flushNotes, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [bringToFront, updateNoteField, flushNotes])

  const startResize = useCallback((e: React.MouseEvent, note: Note) => {
    e.stopPropagation()
    bringToFront(note.id)
    const startX = e.clientX
    const startY = e.clientY
    const origW = note.width
    const origH = note.height

    const onMove = (me: MouseEvent) => {
      updateNoteField(note.id, {
        width: Math.max(180, origW + (me.clientX - startX)),
        height: Math.max(120, origH + (me.clientY - startY)),
      })
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // 推迟到下一次宏任务,确保最后一次 mousemove 的 state 已渲染完成
      window.setTimeout(flushNotes, 0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [bringToFront, updateNoteField, flushNotes])

  // 把便签重新排回可见区域
  const arrangeNotes = useCallback(() => {
    notesRef.current.forEach((note, i) => {
      updateNoteField(note.id, {
        x: 60 + (i % 4) * 280,
        y: 60 + Math.floor(i / 4) * 240,
      })
    })
  }, [updateNoteField])

  const handleContextMenu = useCallback((e: React.MouseEvent, noteId: number | null = null) => {
    e.preventDefault()
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      noteId,
    })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    const handleClick = () => closeContextMenu()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [closeContextMenu])

  const handleTitleBarDrag = useCallback(async (e: React.MouseEvent) => {
    // 仅左键拖动窗口,右键交给上下文菜单
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.sticky-note') || (e.target as HTMLElement).closest('.sidebar')) return
    try {
      const appWindow = getCurrentWindow()
      await appWindow.startDragging()
    } catch {
      // ignore
    }
  }, [])

  const filteredNotes = activeCategoryId === null
    ? notes
    : notes.filter((n) => n.category_id === activeCategoryId)

  if (!loaded) return null

  return (
    <div className="app-root" onMouseDown={handleTitleBarDrag} onContextMenu={(e) => handleContextMenu(e)}>
      <div className="sidebar">
        <div className="sidebar-header">
          <h3>分类</h3>
          <button className="sidebar-btn" onClick={() => setIsAddingCategory(true)}>+</button>
        </div>

        <div className="category-list">
          <div
            className={`category-item ${activeCategoryId === null ? 'active' : ''}`}
            onClick={() => setActiveCategoryId(null)}
          >
            <span>全部</span>
            <span className="count">{notes.length}</span>
          </div>

          {categories.map((cat) => (
            <div
              key={cat.id}
              className={`category-item ${activeCategoryId === cat.id ? 'active' : ''}`}
              onClick={() => setActiveCategoryId(cat.id)}
            >
              <span>{cat.name}</span>
              <span className="count">
                {notes.filter((n) => n.category_id === cat.id).length}
              </span>
              {cat.name !== '默认' && (
                <button
                  className="delete-cat"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteCategory(cat.id)
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {isAddingCategory && (
            <div className="add-category-form">
              <input
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="分类名称"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCategory()
                  if (e.key === 'Escape') setIsAddingCategory(false)
                }}
              />
              <button onClick={addCategory}>确定</button>
            </div>
          )}
        </div>

        <div className="sidebar-footer">
          <button className="pinned-btn" onClick={() => invoke('show_pinned_window')}>
            📌 置顶列表
          </button>
          <div className="add-note-buttons">
            <button className="add-btn text" onClick={() => addNote('text')}>
              + 文字便签
            </button>
            <button className="add-btn todo" onClick={() => addNote('todo')}>
              + 待办清单
            </button>
          </div>
        </div>
      </div>

      <div className="notes-area">
        {filteredNotes.map((note) => {
          const isActive = activeId === note.id
          const noteTodos = todos[note.id] || []

          return (
            <div
              key={note.id}
              className={`sticky-note ${isActive ? 'active' : ''} ${note.is_pinned ? 'pinned' : ''}`}
              onMouseDown={() => bringToFront(note.id)}
              onContextMenu={(e) => {
                e.stopPropagation()
                handleContextMenu(e, note.id)
              }}
              style={{
                left: note.x,
                top: note.y,
                width: note.width,
                minHeight: note.height,
                zIndex: zMap[note.id] || 10,
                opacity: note.opacity,
              }}
            >
              <div className="note-header" onMouseDown={(e) => startDrag(e, note)}>
                <div className="drag-handle">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="8" cy="4" r="2" /><circle cx="16" cy="4" r="2" />
                    <circle cx="8" cy="10" r="2" /><circle cx="16" cy="10" r="2" />
                    <circle cx="8" cy="16" r="2" /><circle cx="16" cy="16" r="2" />
                  </svg>
                </div>
                <div className="note-controls">
                  {note.is_pinned && <span className="pin-icon">📌</span>}
                  <select
                    className="category-select"
                    value={note.category_id || ''}
                    onChange={(e) => updateCategory(note.id, e.target.value ? Number(e.target.value) : null)}
                  >
                    <option value="">无分类</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="note-body">
                <input
                  className="note-title"
                  value={note.title}
                  onChange={(e) => updateNoteField(note.id, { title: e.target.value })}
                  onMouseDown={(e) => e.stopPropagation()}
                />
                {note.note_type === 'todo' ? (
                  <div className="todo-list">
                    {noteTodos.map((item) => (
                      <div key={item.id} className="todo-item">
                        <div
                          className={`todo-checkbox ${item.is_done ? 'checked' : ''}`}
                          onClick={() => toggleTodo(note.id, item.id)}
                        />
                        <input
                          className={`todo-text ${item.is_done ? 'done' : ''}`}
                          value={item.content}
                          onChange={(e) => {
                            const updated = { ...item, content: e.target.value }
                            setTodos((prev) => ({
                              ...prev,
                              [note.id]: (prev[note.id] || []).map((t) =>
                                t.id === item.id ? updated : t
                              ),
                            }))
                            scheduleTodoFlush(updated)
                          }}
                          onBlur={() => flushTodos()}
                        />
                        <button
                          className="todo-delete"
                          onClick={() => deleteTodoItem(note.id, item.id)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <div className="todo-add">
                      <input
                        placeholder="添加新任务..."
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.currentTarget.value.trim()) {
                            addTodoItem(note.id, e.currentTarget.value.trim())
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
                    onChange={(e) => updateNoteField(note.id, { content: e.target.value })}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                )}
              </div>

              <div className="note-footer">
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(note.opacity * 100)}
                  onChange={(e) => updateOpacity(note.id, Number(e.target.value) / 100)}
                  className="opacity-slider"
                />
                <span className="opacity-value">{Math.round(note.opacity * 100)}%</span>
              </div>

              <div className="resize-handle" onMouseDown={(e) => startResize(e, note)} />
            </div>
          )
        })}
      </div>

      {contextMenu && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.noteId ? (
            <>
              <div className="menu-item" onClick={() => {
                togglePin(contextMenu.noteId!)
                closeContextMenu()
              }}>
                {notes.find((n) => n.id === contextMenu.noteId)?.is_pinned ? '取消置顶' : '置顶'}
              </div>
              <div className="menu-item" onClick={() => {
                deleteNote(contextMenu.noteId!)
                closeContextMenu()
              }}>
                删除
              </div>
              <div className="menu-separator" />
              <div className="menu-label">透明度</div>
              <input
                type="range"
                min="0"
                max="100"
                value={Math.round((notes.find((n) => n.id === contextMenu.noteId)?.opacity || 0.8) * 100)}
                onChange={(e) => {
                  updateOpacity(contextMenu.noteId!, Number(e.target.value) / 100)
                }}
                className="menu-opacity"
              />
            </>
          ) : (
            <>
              <div className="menu-item" onClick={() => {
                addNote('text')
                closeContextMenu()
              }}>
                新建文字便签
              </div>
              <div className="menu-item" onClick={() => {
                addNote('todo')
                closeContextMenu()
              }}>
                新建待办清单
              </div>
              <div className="menu-separator" />
              <div className="menu-item" onClick={() => {
                arrangeNotes()
                closeContextMenu()
              }}>
                全部归位
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default App
