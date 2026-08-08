import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import './App.css'
import type { Category, Note, TodoItem, ContextMenu } from './types'

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
  const errorTimerRef = useRef<number | null>(null)

  // —— 可见错误提示:console.error + 顶部横幅,4 秒自动消失 ——
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

  // —— 只读刷新:拉分类 + 便签列表 + 全部待办(绝不写回任何坐标) ——
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

  useEffect(() => {
    loadAll()
      .catch((e) => showError(`初始化失败: ${e}`))
      .finally(() => setLoaded(true))

    // 便签增删/置顶变化时广播 notes-updated → 刷新列表
    const unlisten = listen('notes-updated', () => {
      loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
    })

    // 管理器重新获得焦点时刷新列表(如从便签窗口切回)
    const unFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
    })

    return () => {
      unlisten.then((fn) => fn())
      unFocus.then((fn) => fn())
    }
  }, [loadAll, showError])

  const addNote = useCallback(async (type: 'text' | 'todo') => {
    try {
      const note = await invoke<Note>('add_note', {
        title: type === 'todo' ? '新建待办' : '新建便签',
        noteType: type,
        categoryId: activeCategoryId,
      })
      // Rust 已创建独立窗口并广播 notes-updated;本地先补上保证即时可见
      setNotes((prev) => [...prev, note])
    } catch (e) {
      showError(`新建便签失败: ${e}`)
    }
  }, [activeCategoryId, showError])

  const deleteNote = useCallback(async (id: number) => {
    try {
      // Rust 侧会先销毁 note-<id> 窗口、删行并广播 notes-updated
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

  // 置顶切换:先取 DB 最新记录再翻 is_pinned,其余字段(含 x/y)以最新值为准回写,
  // 避免用过期的本地快照整行覆盖便签窗口已静默落库的编辑(便签窗口编辑不广播)
  const togglePin = useCallback(async (note: Note) => {
    try {
      const latest = await invoke<Note>('get_note', { id: note.id })
      const updated = { ...latest, is_pinned: !latest.is_pinned }
      setNotes((prev) => prev.map((n) => (n.id === note.id ? updated : n)))
      // Rust 侧仅在置顶状态变化时广播 notes-updated,列表随后刷新确认
      await invoke('update_note', { note: updated })
    } catch (e) {
      showError(`切换置顶失败: ${e}`)
    }
  }, [showError])

  const openNote = useCallback(async (id: number) => {
    try {
      // 已有窗口则复用并高亮,没有则新建
      await invoke('open_note', { id })
    } catch (e) {
      showError(`打开便签失败: ${e}`)
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
      // 数据库外键 SET NULL,同步本地状态
      setNotes((prev) =>
        prev.map((n) => (n.category_id === id ? { ...n, category_id: null } : n))
      )
      if (activeCategoryId === id) setActiveCategoryId(null)
    } catch (e) {
      showError(`删除分类失败: ${e}`)
    }
  }, [activeCategoryId, showError])

  const handleContextMenu = useCallback((e: React.MouseEvent, noteId: number | null = null) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, noteId })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  useEffect(() => {
    const handleClick = () => closeContextMenu()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [closeContextMenu])

  const formatTime = (value: string): string => {
    // SQLite 默认 "YYYY-MM-DD HH:MM:SS",统一展示到分钟
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) return value.slice(0, 16)
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    return value
  }

  const summaryOf = (note: Note): string => {
    if (note.note_type === 'todo') {
      const items = todos[note.id] || []
      if (items.length > 0) return items[0].content
      return '（暂无待办项）'
    }
    return note.content.split('\n').find((line) => line.trim().length > 0) || '（空白便签）'
  }

  const categoryNameOf = (id: number | null): string => {
    if (id === null) return '无分类'
    return categories.find((c) => c.id === id)?.name ?? '无分类'
  }

  // 分类过滤 + 搜索过滤(标题/内容 includes,不区分大小写)+ 排序(置顶优先,再按更新时间倒序)
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
      <aside className="sidebar">
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
          <div className="add-note-buttons">
            <button className="add-btn text" onClick={() => addNote('text')}>
              + 文字便签
            </button>
            <button className="add-btn todo" onClick={() => addNote('todo')}>
              + 待办清单
            </button>
          </div>
        </div>
      </aside>

      <main className="manager-main">
        <div className="manager-toolbar">
          <input
            className="search-box"
            type="text"
            placeholder="搜索便签标题或内容..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="note-count">{filteredNotes.length} 条便签</span>
        </div>

        {errorMsg && <div className="error-banner">{errorMsg}</div>}

        <div className="note-list">
          {filteredNotes.length === 0 ? (
            <div className="list-empty">
              暂无便签,点击左侧「+ 文字便签」或「+ 待办清单」创建
            </div>
          ) : (
            filteredNotes.map((note) => (
              <div
                key={note.id}
                data-id={note.id}
                className={`note-row ${note.is_pinned ? 'pinned' : ''}`}
                onDoubleClick={(e) => {
                  // 行内按钮(置顶/删除)上的双击不打开便签,避免误开
                  if ((e.target as HTMLElement).closest('button')) return
                  openNote(note.id)
                }}
                onContextMenu={(e) => {
                  e.stopPropagation()
                  handleContextMenu(e, note.id)
                }}
              >
                <div className="row-type">{note.note_type === 'todo' ? '☑' : '📝'}</div>
                <div className="row-main">
                  <div className="row-title">
                    {note.is_pinned && <span className="pin-icon">📌</span>}
                    <span className="title-text">{note.title || '（未命名）'}</span>
                  </div>
                  <div className="row-summary">{summaryOf(note)}</div>
                </div>
                <div className="row-meta">
                  <span className="row-category">{categoryNameOf(note.category_id)}</span>
                  <span className="row-time">{formatTime(note.updated_at)}</span>
                </div>
                <div className="row-actions">
                  <button
                    className="row-btn pin"
                    title={note.is_pinned ? '取消置顶' : '置顶'}
                    onClick={(e) => {
                      e.stopPropagation()
                      togglePin(note)
                    }}
                  >
                    {note.is_pinned ? '取消置顶' : '置顶'}
                  </button>
                  <button
                    className="row-btn delete"
                    title="删除便签及其窗口"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteNote(note.id)
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </main>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          {contextMenu.noteId !== null ? (
            <>
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
    </div>
  )
}

export default App
