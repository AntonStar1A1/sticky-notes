import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import type { Category, Note, TodoItem, ContextMenu } from './types'
import SettingsPanel, { isEdgeDockEnabled } from './components/SettingsPanel'
import { useEdgeDock } from './hooks/useEdgeDock'

function App() {
  const [notes, setNotes] = useState<Note[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [todos, setTodos] = useState<Record<number, TodoItem[]>>({})
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [isAddingCategory, setIsAddingCategory] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null)
  const [editingField, setEditingField] = useState<'title' | 'content' | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [edgeDockEnabled, setEdgeDockEnabled] = useState(isEdgeDockEnabled())
  const errorTimerRef = useRef<number | null>(null)
  const editTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())
  const editDataRef = useRef<Map<number, Note>>(new Map())

  // 边缘吸附
  const { undock } = useEdgeDock(edgeDockEnabled)

  // 可见错误提示
  const showError = useCallback((msg: string) => {
    console.error(msg)
    setErrorMsg(msg)
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => setErrorMsg(null), 4000)
  }, [])

  const groupTodos = (items: TodoItem[]): Record<number, TodoItem[]> => {
    const map: Record<number, TodoItem[]> = {}
    for (const item of items) {
      if (!map[item.note_id]) map[item.note_id] = []
      map[item.note_id].push(item)
    }
    return map
  }

  // 只读刷新
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

  // 卸载时立即将所有待保存的便签数据发送到后端,避免丢失
  useEffect(() => {
    return () => {
      for (const timer of editTimersRef.current.values()) {
        window.clearTimeout(timer)
      }
      // 尝试保存所有尚未落库的编辑数据
      for (const note of editDataRef.current.values()) {
        invoke('update_note', { note }).catch(() => {})
      }
      editTimersRef.current.clear()
      editDataRef.current.clear()
    }
  }, [])

  useEffect(() => {
    loadAll()
      .catch((e) => showError(`初始化失败: ${e}`))
      .finally(() => setLoaded(true))

    const unlisten = listen('notes-updated', () => {
      loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
    })

    const unFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
    })

    return () => {
      unlisten.then((fn) => fn())
      unFocus.then((fn) => fn())
    }
  }, [loadAll, showError])

  // 监听边缘吸附设置变化
  useEffect(() => {
    const handler = (e: CustomEvent) => setEdgeDockEnabled(e.detail)
    window.addEventListener('edge-dock-changed', handler as EventListener)
    return () => window.removeEventListener('edge-dock-changed', handler as EventListener)
  }, [])

  // 内联编辑:防抖保存(按 note.id 独立计时,避免跨便签丢失)
  const saveNote = useCallback((note: Note) => {
    const timers = editTimersRef.current
    const data = editDataRef.current
    const existing = timers.get(note.id)
    if (existing) window.clearTimeout(existing)
    // 记录最新待保存数据,供卸载时 flush
    data.set(note.id, note)
    timers.set(note.id, window.setTimeout(async () => {
      timers.delete(note.id)
      data.delete(note.id)
      try {
        await invoke('update_note', { note })
      } catch (e) {
        showError(`保存失败: ${e}`)
      }
    }, 300))
  }, [showError])

  const updateNoteInline = useCallback((id: number, changes: Partial<Note>) => {
    setNotes((prev) => prev.map((n) => {
      if (n.id !== id) return n
      const updated = { ...n, ...changes }
      saveNote(updated)
      return updated
    }))
  }, [saveNote])

  const startEditing = useCallback((noteId: number, field: 'title' | 'content') => {
    setEditingNoteId(noteId)
    setEditingField(field)
  }, [])

  const stopEditing = useCallback(() => {
    setEditingNoteId(null)
    setEditingField(null)
  }, [])

  const addNote = useCallback(async (type: 'text' | 'todo') => {
    try {
      const note = await invoke<Note>('add_note', {
        title: type === 'todo' ? '新建待办' : '新建便签',
        noteType: type,
        categoryId: activeCategoryId,
      })
      setNotes((prev) => [...prev, note])
    } catch (e) {
      showError(`新建便签失败: ${e}`)
    }
  }, [activeCategoryId, showError])

  const deleteNote = useCallback(async (id: number) => {
    try {
      await invoke('delete_note', { id })
      setNotes((prev) => prev.filter((n) => n.id !== id))
      setTodos((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (e) {
      showError(`删除便签失败: ${e}`)
    }
  }, [showError])

  const togglePin = useCallback(async (note: Note) => {
    const pinned = !note.is_pinned
    setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, is_pinned: pinned } : n)))
    try {
      await invoke('set_note_pinned', { id: note.id, pinned })
    } catch (e) {
      showError(`切换置顶失败: ${e}`)
    }
  }, [showError])

  const addCategory = useCallback(async () => {
    if (!newCategoryName.trim()) return
    try {
      const cat = await invoke<Category>('add_category', { name: newCategoryName.trim() })
      setCategories((prev) => [...prev, cat])
      setNewCategoryName('')
      setIsAddingCategory(false)
    } catch (e) {
      showError(`新增分类失败: ${e}`)
    }
  }, [newCategoryName, showError])

  const deleteCategory = useCallback(async (id: number) => {
    try {
      await invoke('delete_category', { id })
      setCategories((prev) => prev.filter((c) => c.id !== id))
      // 若当前选中的是被删分类,切回"全部"
      if (activeCategoryId === id) setActiveCategoryId(null)
    } catch (e) {
      showError(`删除分类失败: ${e}`)
    }
  }, [activeCategoryId, showError])

  const openNoteInWindow = useCallback(async (id: number) => {
    try {
      await invoke('open_note', { id })
    } catch (e) {
      showError(`打开便签窗口失败: ${e}`)
    }
  }, [showError])

  const handleContextMenu = useCallback((e: React.MouseEvent, noteId: number | null = null, categoryId: number | null = null) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, noteId, categoryId })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    const handleClick = () => closeContextMenu()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [closeContextMenu])

  const summaryOf = (note: Note): string => {
    if (note.note_type === 'todo') {
      const items = todos[note.id] || []
      if (items.length > 0) return items[0].content
      return '（暂无待办项）'
    }
    return note.content.split('\n').find((line) => line.trim().length > 0) || '（空白便签）'
  }

  // 格式化时间为相对显示
  const formatTime = (isoStr: string): string => {
    // SQLite CURRENT_TIMESTAMP 返回 UTC 时间,加 Z 表示 UTC,JS 自动转本地时区
    const normalized = isoStr.replace(' ', 'T') + 'Z'
    const date = new Date(normalized)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    const diffHour = Math.floor(diffMs / 3600000)
    const diffDay = Math.floor(diffMs / 86400000)

    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin}分钟前`
    if (diffHour < 24) return `${diffHour}小时前`
    if (diffDay === 1) return '昨天'
    if (diffDay < 7) return `${diffDay}天前`
    // 超过7天显示具体日期
    const m = date.getMonth() + 1
    const d = date.getDate()
    return `${m}月${d}日`
  }

  // 分类过滤 + 搜索过滤 + 排序
  const filteredNotes = useMemo(() => {
    const kw = search.trim().toLowerCase()
    const byCategory = activeCategoryId === null
      ? notes
      : notes.filter((n) => n.category_id === activeCategoryId)
    const bySearch = kw
      ? byCategory.filter(
          (n) =>
            n.title.toLowerCase().includes(kw) || n.content.toLowerCase().includes(kw)
        )
      : byCategory
    return [...bySearch].sort((a, b) => {
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.updated_at.localeCompare(a.updated_at)
    })
  }, [notes, activeCategoryId, search])

  if (!loaded) return null

  return (
    <div className="app-root" onContextMenu={handleContextMenu}>
      {/* 标题栏 */}
      <div className="title-bar">
        <span className="title-text">便签管理</span>
        <div className="title-controls">
          <button
            className="title-btn"
            onClick={async () => {
              await undock()
              getCurrentWindow().minimize()
            }}
            title="最小化"
          >
            ─
          </button>
          <button
            className="title-btn close"
            onClick={() => getCurrentWindow().hide()}
            title="关闭"
          >
            ✕
          </button>
        </div>
      </div>

      {/* 主内容区 */}
      <div className="main-content">
      {/* 分类栏 */}
      <div className="category-bar">
        <div
          className={`category-item ${activeCategoryId === null ? 'active' : ''}`}
          onClick={() => setActiveCategoryId(null)}
        >
          <span className="category-name">全部</span>
          <span className="category-count">{notes.length}</span>
        </div>

        {categories.map((cat) => (
          <div
            key={cat.id}
            className={`category-item ${activeCategoryId === cat.id ? 'active' : ''}`}
            onClick={() => setActiveCategoryId(cat.id)}
            onContextMenu={(e) => {
              e.stopPropagation()
              handleContextMenu(e, null, cat.id)
            }}
          >
            <span className="category-name">{cat.name}</span>
            <span className="category-count">
              {notes.filter((n) => n.category_id === cat.id).length}
            </span>
          </div>
        ))}

        {isAddingCategory ? (
          <div className="add-category-form">
            <input
              value={newCategoryName}
              onChange={(e) => setNewCategoryName(e.target.value)}
              placeholder="名称"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') addCategory()
                if (e.key === 'Escape') setIsAddingCategory(false)
              }}
            />
            <button onClick={addCategory}>✓</button>
          </div>
        ) : (
          <button className="category-add" onClick={() => setIsAddingCategory(true)}>+</button>
        )}
        <button
          className="category-settings"
          onClick={() => setShowSettings(!showSettings)}
          title="设置"
        >
          ⚙
        </button>
      </div>

      {/* 便签列表 */}
      <div className="note-list-container">
        <div className="note-toolbar">
          <input
            className="search-box"
            type="text"
            placeholder="搜索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="note-count">{filteredNotes.length}</span>
        </div>

        {errorMsg && <div className="error-banner">{errorMsg}</div>}

        <div className="note-list">
          {filteredNotes.length === 0 ? (
            <div className="list-empty">
              暂无便签
            </div>
          ) : (
            filteredNotes.map((note) => (
              <div
                key={note.id}
                className={`note-card ${note.is_pinned ? 'pinned' : ''} ${editingNoteId === note.id ? 'editing' : ''}`}
                onClick={() => startEditing(note.id, 'title')}
                onContextMenu={(e) => {
                  e.stopPropagation()
                  handleContextMenu(e, note.id)
                }}
              >
                <div className="note-card-header">
                  <span className="note-card-icon">{note.note_type === 'todo' ? '☑' : '📝'}</span>
                  {editingNoteId === note.id && editingField === 'title' ? (
                    <input
                      className="note-card-title-input"
                      value={note.title}
                      placeholder="标题"
                      autoFocus
                      onChange={(e) => updateNoteInline(note.id, { title: e.target.value })}
                      onBlur={stopEditing}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') stopEditing()
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="note-card-title">{note.title || '（未命名）'}</span>
                  )}
                  {note.is_pinned && <span className="note-card-pin">📌</span>}
                  <div className="note-card-actions">
                    <button
                      className="note-action-btn open"
                      title="在窗口中打开"
                      onClick={(e) => {
                        e.stopPropagation()
                        openNoteInWindow(note.id)
                      }}
                    >
                      打开
                    </button>
                    <button
                      className="note-action-btn pin"
                      title={note.is_pinned ? '取消置顶' : '置顶'}
                      onClick={(e) => {
                        e.stopPropagation()
                        togglePin(note)
                      }}
                    >
                      {note.is_pinned ? '取消' : '置顶'}
                    </button>
                    <button
                      className="note-action-btn delete"
                      title="删除"
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteNote(note.id)
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                {editingNoteId === note.id && editingField === 'content' ? (
                  <textarea
                    className="note-card-content-input"
                    value={note.content}
                    placeholder="内容..."
                    autoFocus
                    ref={(el) => {
                      if (el) {
                        el.style.height = 'auto'
                        el.style.height = el.scrollHeight + 'px'
                      }
                    }}
                    onChange={(e) => {
                      updateNoteInline(note.id, { content: e.target.value })
                      // auto-grow
                      const el = e.target
                      el.style.height = 'auto'
                      el.style.height = el.scrollHeight + 'px'
                    }}
                    onBlur={stopEditing}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') stopEditing()
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    className="note-card-summary"
                    onClick={(e) => {
                      e.stopPropagation()
                      startEditing(note.id, 'content')
                    }}
                  >
                    {summaryOf(note)}
                  </div>
                )}
                <div className="note-card-time">
                  {formatTime(note.updated_at)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.noteId !== null ? (
            <>
              <div
                className="menu-item"
                onClick={() => {
                  openNoteInWindow(contextMenu.noteId!)
                  closeContextMenu()
                }}
              >
                在窗口中打开
              </div>
              <div
                className="menu-item"
                onClick={() => {
                  const note = notes.find((n) => n.id === contextMenu.noteId)
                  if (note) togglePin(note)
                  closeContextMenu()
                }}
              >
                {notes.find((n) => n.id === contextMenu.noteId)?.is_pinned ? '取消置顶' : '置顶'}
              </div>
              <div
                className="menu-item"
                onClick={() => {
                  deleteNote(contextMenu.noteId!)
                  closeContextMenu()
                }}
              >
                删除
              </div>
            </>
          ) : contextMenu.categoryId !== null ? (
            <div
              className="menu-item"
              onClick={() => {
                deleteCategory(contextMenu.categoryId!)
                closeContextMenu()
              }}
            >
              删除分类
            </div>
          ) : (
            <>
              <div
                className="menu-item"
                onClick={() => {
                  addNote('text')
                  closeContextMenu()
                }}
              >
                新建文字便签
              </div>
              <div
                className="menu-item"
                onClick={() => {
                  addNote('todo')
                  closeContextMenu()
                }}
              >
                新建待办清单
              </div>
            </>
          )}
        </div>
      )}

      {/* 设置面板 */}
      {showSettings && (
        <SettingsPanel onClose={() => setShowSettings(false)} />
      )}
    </div>
  )
}

export default App
