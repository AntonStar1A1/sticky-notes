import { useMemo, useState, useCallback, useEffect } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ListTodo, CheckCircle2, Circle, Plus, Trash2, ExternalLink, Check, ChevronDown, ChevronRight } from 'lucide-react'
import type { Note, TodoItem } from '../types'
import { confirmDialog } from './ConfirmDialog'

interface Props {
  notes: Note[]
  todos: TodoItem[]
  privacyCategoryId: number | null
  search: string
  onOpenNote: (id: number) => void
  onError: (msg: string) => void
}

interface Row {
  item: TodoItem
  note: Note
}

/** 待办独立视图(spec 7.13):跨便签平铺,未完成在上按创建倒序,已完成在下按完成倒序 */
export default function TodoView({ notes, todos, privacyCategoryId, search, onOpenNote, onError }: Props) {
  const [adding, setAdding] = useState(false)
  const [newContent, setNewContent] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingContent, setEditingContent] = useState('')
  const [todoMenu, setTodoMenu] = useState<{ x: number; y: number; item: TodoItem } | null>(null)
  // spec 7.14:已完成分组可折叠
  const [doneCollapsed, setDoneCollapsed] = useState(false)

  // 点击任意处关闭待办右键菜单
  const closeTodoMenu = useCallback(() => setTodoMenu(null), [])
  useEffect(() => {
    if (!todoMenu) return
    const handler = () => closeTodoMenu()
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [todoMenu, closeTodoMenu])

  const openTodoMenu = useCallback((e: ReactMouseEvent, item: TodoItem) => {
    e.preventDefault()
    e.stopPropagation()
    setTodoMenu({ x: Math.min(e.clientX, window.innerWidth - 160), y: e.clientY, item })
  }, [])

  // 隐私分类的待办不显示在全局待办视图(spec 7.13)
  const noteById = useMemo(() => {
    const map = new Map<number, Note>()
    for (const n of notes) if (n.status === 'active' && n.category_id !== privacyCategoryId) map.set(n.id, n)
    return map
  }, [notes, privacyCategoryId])

  const rows = useMemo<Row[]>(() => {
    const kw = search.trim().toLowerCase()
    const list: Row[] = []
    for (const t of todos) {
      const note = noteById.get(t.note_id)
      if (!note) continue
      if (kw && !t.content.toLowerCase().includes(kw) && !(note.title ?? '').toLowerCase().includes(kw)) continue
      list.push({ item: t, note })
    }
    // 未完成在上按创建倒序(id 近似创建序),已完成在下按完成倒序
    list.sort((a, b) => {
      if (a.item.is_done !== b.item.is_done) return a.item.is_done ? 1 : -1
      if (a.item.is_done) return (b.item.completed_at ?? '').localeCompare(a.item.completed_at ?? '')
      return b.item.id - a.item.id
    })
    return list
  }, [todos, noteById, search])

  const pending = rows.filter((r) => !r.item.is_done)
  const doneRows = rows.filter((r) => r.item.is_done)

  const toggle = useCallback(async (item: TodoItem) => {
    try {
      await invoke('update_todo', { item: { ...item, is_done: !item.is_done } })
    } catch (e) {
      onError(`更新待办失败: ${e}`)
    }
  }, [onError])

  const remove = useCallback(async (item: TodoItem) => {
    if (!(await confirmDialog({ title: '删除待办', message: `删除「${item.content.slice(0, 20)}」?`, danger: true }))) return
    try {
      await invoke('delete_todo', { id: item.id })
    } catch (e) {
      onError(`删除待办失败: ${e}`)
    }
  }, [onError])

  const startEdit = useCallback((item: TodoItem) => {
    setEditingId(item.id)
    setEditingContent(item.content)
  }, [])

  const commitEdit = useCallback(async () => {
    const id = editingId
    const content = editingContent.trim()
    setEditingId(null)
    if (id === null || !content) return
    try {
      await invoke('update_todo', { item: { ...todos.find((t) => t.id === id)!, content } })
    } catch (e) {
      onError(`更新待办失败: ${e}`)
    }
  }, [editingId, editingContent, todos, onError])

  // 全局「+ 新增待办」(spec 7.13):无待办便签时自动创建一个
  const addGlobal = useCallback(async () => {
    const content = newContent.trim()
    if (!content) return
    try {
      const todoNotes = [...noteById.values()].filter((n) => n.note_type === 'todo')
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      let target = todoNotes[0]
      if (!target) {
        target = await invoke<Note>('add_note', { title: '待办', noteType: 'todo', categoryId: null })
      }
      await invoke('add_todo', { noteId: target.id, content })
      setNewContent('')
      setAdding(false)
    } catch (e) {
      onError(`添加待办失败: ${e}`)
    }
  }, [newContent, noteById, onError])

  const renderRow = (row: Row) => {
    const { item, note } = row
    return (
      <div
        key={item.id}
        className={`todo-row ${item.is_done ? 'done' : ''}`}
        onContextMenu={(e) => openTodoMenu(e, item)}
      >
        <button className="todo-check" title={item.is_done ? '取消完成' : '标记完成'} onClick={() => toggle(item)}>
          {item.is_done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        </button>
        {editingId === item.id ? (
          <input
            className="todo-edit-input"
            value={editingContent}
            autoFocus
            onChange={(e) => setEditingContent(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitEdit()
              if (e.key === 'Escape') setEditingId(null)
            }}
          />
        ) : (
          <span className="todo-content" onClick={() => startEdit(item)} title="点击编辑">
            {item.content}
          </span>
        )}
        {/* 来源标签,点击跳转所属便签(spec 7.13) */}
        <span
          className="todo-source"
          onClick={() => onOpenNote(note.id)}
          title="打开所属便签"
        >
          ({note.title || '未命名'})
        </span>
        <button className="icon-btn todo-del" title="删除" onClick={() => remove(item)}>
          <Trash2 size={12} />
        </button>
      </div>
    )
  }

  return (
    <div className="todo-view">
      <div className="view-toolbar">
        <span className="view-title">待办</span>
        <span className="view-meta">{doneRows.length}/{rows.length} 已完成</span>
      </div>
      <div className="todo-groups">
        {rows.length === 0 && search.trim() === '' ? (
          <div className="view-empty">
            <ListTodo size={24} />
            <div>暂无待办项</div>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <div className="todo-section">
                <div className="todo-section-title">未完成 ({pending.length})</div>
                {pending.map(renderRow)}
              </div>
            )}
            {doneRows.length > 0 && (
              <div className="todo-section">
                <div className="todo-section-title todo-done-title" onClick={() => setDoneCollapsed((c) => !c)}>
                  {doneCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  已完成 ({doneRows.length})
                </div>
                {!doneCollapsed && doneRows.map(renderRow)}
              </div>
            )}
            {rows.length === 0 && search.trim() !== '' && (
              <div className="view-empty">
                <ListTodo size={24} />
                <div>暂无结果</div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部全局「+ 新增待办」(spec 7.13) */}
      <div className="todo-global-add">
        {adding ? (
          <div className="todo-add-row">
            <input
              value={newContent}
              placeholder="新待办项"
              autoFocus
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addGlobal()
                if (e.key === 'Escape') setAdding(false)
              }}
            />
            <button className="icon-btn" onClick={addGlobal}><Check size={13} /></button>
          </div>
        ) : (
          <button className="todo-add-global" onClick={() => { setAdding(true); setNewContent('') }}>
            <Plus size={12} /> 新增待办
          </button>
        )}
      </div>

      {/* 待办右键菜单(spec 7.13:打开所属便签/删除) */}
      {todoMenu && (
        <div className="context-menu" style={{ left: todoMenu.x, top: todoMenu.y }}>
          <div className="menu-item" onClick={() => { onOpenNote(todoMenu.item.note_id); closeTodoMenu() }}>
            <ExternalLink size={12} /> 打开所属便签
          </div>
          <div className="menu-item danger" onClick={() => { remove(todoMenu.item); closeTodoMenu() }}>
            <Trash2 size={12} /> 删除
          </div>
        </div>
      )}
    </div>
  )
}
