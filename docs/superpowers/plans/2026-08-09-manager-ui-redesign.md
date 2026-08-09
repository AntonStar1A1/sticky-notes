# Manager UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the main manager window from 1200×800 two-column layout to a minimal 280px-wide bookmark-style interface with transparent background, frosted glass cards, and inline editing.

**Architecture:** Single-column layout with 36px vertical category sidebar on left and 244px note list on right. Tauri window set to transparent + frameless. CSS uses backdrop-filter for frosted glass effect on note cards.

**Tech Stack:** React 18, TypeScript, Tauri 2, CSS3 (backdrop-filter), rusqlite

## Global Constraints

- Window width: 280px (fixed)
- Category sidebar: 36px wide
- Note list: 244px wide (280 - 36)
- Tauri window: decorations=false, transparent=true
- Font: 11px for categories, 13px for note titles
- Frosted glass: `backdrop-filter: blur(12px); background: rgba(255, 255, 255, 0.15)`
- Auto-save debounce: 300ms (existing)

---

### Task 1: Update Tauri Window Configuration

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: Window size 280×600, decorations=false, transparent=true

- [ ] **Step 1: Update tauri.conf.json window settings**

```json
{
  "productName": "Sticky Notes",
  "version": "0.1.0",
  "identifier": "com.stickynotes.app",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "windows": [
      {
        "title": "Sticky Notes",
        "width": 280,
        "height": 600,
        "decorations": false,
        "transparent": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"
    },
    "withGlobalTauri": false
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.ico"
    ]
  }
}
```

- [ ] **Step 2: Verify window configuration**

Run: `cd src-tauri && cargo check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat: update window config for bookmark-style layout"
```

---

### Task 2: Rewrite CSS for New Layout

**Files:**
- Modify: `src/App.css` (complete rewrite)

**Interfaces:**
- Produces: `.app-root` (transparent), `.category-bar` (36px), `.note-card` (frosted glass)

- [ ] **Step 1: Rewrite App.css**

```css
*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body, #root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  font-family: 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif;
}

/* ========== 主框架(透明背景) ========== */
.app-root {
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  display: flex;
  position: relative;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  cursor: default;
  user-select: none;
}

/* ========== 分类栏(36px) ========== */
.category-bar {
  width: 36px;
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 2px;
  flex-shrink: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.category-item {
  width: 100%;
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s;
  color: rgba(255, 255, 255, 0.6);
  font-size: 11px;
  line-height: 1.2;
  text-align: center;
  position: relative;
  min-height: 36px;
}

.category-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
}

.category-item.active {
  color: #fff;
}

.category-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: #4a9eff;
  border-radius: 1px;
}

.category-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28px;
}

.category-count {
  font-size: 9px;
  opacity: 0.5;
  margin-top: 2px;
}

.category-add {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  margin-top: auto;
  transition: all 0.15s;
}

.category-add:hover {
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.9);
}

/* ========== 便签列表(244px) ========== */
.note-list-container {
  flex: 1;
  min-width: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
}

.note-toolbar {
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.search-box {
  flex: 1;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  outline: none;
  user-select: text;
  transition: border-color 0.15s;
}

.search-box:focus {
  border-color: rgba(74, 158, 255, 0.6);
}

.search-box::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.note-count {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.4);
  flex-shrink: 0;
}

.note-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ========== 便签卡片(毛玻璃) ========== */
.note-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  transition: all 0.15s;
}

.note-card:hover {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(255, 255, 255, 0.2);
}

.note-card.pinned {
  border-color: rgba(245, 230, 99, 0.3);
}

.note-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}

.note-card-icon {
  font-size: 14px;
  flex-shrink: 0;
  opacity: 0.8;
}

.note-card-title {
  font-size: 13px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.note-card-pin {
  font-size: 10px;
  flex-shrink: 0;
}

.note-card-summary {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-left: 20px;
}

/* ========== 内联编辑状态 ========== */
.note-card.editing {
  background: rgba(255, 255, 255, 0.18);
  border-color: rgba(74, 158, 255, 0.5);
}

.note-card-title-input {
  width: 100%;
  padding: 2px 4px;
  border: 1px solid rgba(74, 158, 255, 0.4);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.95);
  font-size: 13px;
  font-weight: 600;
  outline: none;
  font-family: inherit;
  user-select: text;
}

.note-card-content-input {
  width: 100%;
  padding: 4px;
  border: 1px solid rgba(74, 158, 255, 0.4);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
  font-size: 11px;
  outline: none;
  resize: none;
  min-height: 40px;
  font-family: inherit;
  user-select: text;
}

/* ========== 错误提示 ========== */
.error-banner {
  margin: 4px 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.3);
  color: #ff9d9d;
  font-size: 11px;
  flex-shrink: 0;
}

/* ========== 空状态 ========== */
.list-empty {
  margin: 48px auto;
  color: rgba(255, 255, 255, 0.35);
  font-size: 12px;
  text-align: center;
  max-width: 200px;
  line-height: 1.6;
}

/* ========== 右键菜单 ========== */
.context-menu {
  position: fixed;
  background: rgba(30, 32, 38, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  padding: 4px 0;
  min-width: 140px;
  z-index: 10000;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.menu-item {
  padding: 7px 12px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  transition: all 0.15s;
  font-size: 12px;
}

.menu-item:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
}

.menu-separator {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 4px 0;
}

/* ========== 滚动条 ========== */
.category-list::-webkit-scrollbar,
.note-list::-webkit-scrollbar {
  width: 3px;
}

.category-list::-webkit-scrollbar-track,
.note-list::-webkit-scrollbar-track {
  background: transparent;
}

.category-list::-webkit-scrollbar-thumb,
.note-list::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
}

/* ========== 添加分类表单 ========== */
.add-category-form {
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.add-category-form input {
  width: 100%;
  padding: 4px 6px;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: #fff;
  outline: none;
  font-size: 11px;
  text-align: center;
}

.add-category-form button {
  padding: 3px 6px;
  border: none;
  border-radius: 4px;
  background: #4a9eff;
  color: #fff;
  cursor: pointer;
  font-size: 10px;
}

/* ========== 便签操作按钮(悬浮显示) ========== */
.note-card-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.note-card:hover .note-card-actions {
  opacity: 1;
}

.note-action-btn {
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
  font-size: 10px;
  cursor: pointer;
  transition: all 0.15s;
}

.note-action-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}

.note-action-btn.pin:hover {
  border-color: rgba(245, 230, 99, 0.5);
  background: rgba(245, 230, 99, 0.08);
  color: #ffe75e;
}

.note-action-btn.delete:hover {
  border-color: rgba(255, 107, 107, 0.5);
  background: rgba(255, 107, 107, 0.1);
  color: #ff8a8a;
}
```

- [ ] **Step 2: Verify CSS syntax**

Run: `npm run build`
Expected: No CSS errors

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat: rewrite CSS for bookmark-style layout"
```

---

### Task 3: Rewrite App.tsx for New Layout

**Files:**
- Modify: `src/App.tsx` (complete rewrite)

**Interfaces:**
- Consumes: `get_categories`, `get_notes`, `get_all_todos`, `add_note`, `update_note`, `set_note_pinned`, `delete_note`, `add_category`, `delete_category` (existing Rust commands)
- Produces: Vertical category sidebar + note list with inline editing

- [ ] **Step 1: Rewrite App.tsx**

```tsx
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
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null)
  const [editingField, setEditingField] = useState<'title' | 'content' | null>(null)
  const errorTimerRef = useRef<number | null>(null)
  const editTimerRef = useRef<number | null>(null)

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

  // 内联编辑:防抖保存
  const saveNote = useCallback((note: Note) => {
    if (editTimerRef.current) window.clearTimeout(editTimerRef.current)
    editTimerRef.current = window.setTimeout(async () => {
      try {
        await invoke('update_note', { note })
      } catch (e) {
        showError(`保存失败: ${e}`)
      }
    }, 300)
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
    const d = new Date(value.replace(' ', 'T') + 'Z')
    if (!Number.isNaN(d.getTime())) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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
                    onChange={(e) => updateNoteInline(note.id, { content: e.target.value })}
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
              </div>
            ))
          )}
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
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat: rewrite App.tsx for bookmark-style layout with inline editing"
```

---

### Task 4: Update index.css for Transparent Background

**Files:**
- Modify: `src/index.css`

**Interfaces:**
- Produces: Transparent body/root background

- [ ] **Step 1: Update index.css**

```css
html, body, #root {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: transparent;
}
```

- [ ] **Step 2: Verify transparency**

Run: `npm run dev`
Expected: Window background is transparent

- [ ] **Step 3: Commit**

```bash
git add src/index.css
git commit -m "feat: set transparent background for frameless window"
```

---

### Task 5: Integration Test and Cleanup

**Files:**
- Verify: All modified files work together

**Interfaces:**
- Consumes: All previous task outputs

- [ ] **Step 1: Run full build**

Run: `npm run build`
Expected: No errors

- [ ] **Step 2: Run Tauri dev**

Run: `cargo tauri dev`
Expected: Window displays at 280px width with transparent background

- [ ] **Step 3: Test core functionality**

1. Verify category sidebar displays vertically (36px)
2. Verify note cards have frosted glass effect
3. Click note card → title becomes editable
4. Click summary → content becomes editable
5. Add new note → appears in list
6. Delete note → removed from list
7. Pin/unpin note → border color changes
8. Search → filters notes
9. Switch category → filters notes

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete manager UI redesign - bookmark-style layout"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Update Tauri window config | tauri.conf.json |
| 2 | Rewrite CSS for new layout | App.css |
| 3 | Rewrite App.tsx component | App.tsx |
| 4 | Update index.css | index.css |
| 5 | Integration test | All files |
