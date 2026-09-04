import { Fragment, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  StickyNote, ListTodo, Trash2, Clock, Plus, Search, Settings, Pin, PinOff,
  ExternalLink, Palette, Copy, Download, ArrowUpDown, Lock, LockOpen, Text, ListChecks,
  LayoutGrid, Folder,
} from 'lucide-react'
import './App.css'
import type { Category, Note, TodoItem, TimelineEntry, ContextMenu, SortMode, PrivacyStatus } from './types'
import SettingsPanel, { isEdgeDockEnabled } from './components/SettingsPanel'
import PinToggleIcon from './components/PinToggleIcon'
import { isManagerPinned, setManagerPinned, MANAGER_PIN_EVENT } from './managerPin'
import { useEdgeDock } from './hooks/useEdgeDock'
import { DragProvider, useDragContext, useReorderDrag } from './hooks/useDragContext'
import { ToastHost, showToast } from './components/Toast'
import { ConfirmDialogHost, confirmDialog } from './components/ConfirmDialog'
import { loadTheme, saveTheme, THEME_PRESETS } from './theme'
import PrivacyLock, { type PrivacyMode } from './components/PrivacyLock'
import ColorPicker from './components/ColorPicker'
import TodoView from './components/TodoView'
import TrashView from './components/TrashView'
import TimelineView from './components/TimelineView'
import { DragIndicator } from './components/DragIndicator'

loadTheme()

type View = 'notes' | 'todos' | 'trash' | 'timeline'

const SORT_OPTIONS: { key: SortMode; label: string }[] = [
  { key: 'updated', label: '按更新时间' },
  { key: 'created', label: '按创建时间' },
  { key: 'title', label: '按标题' },
  { key: 'custom', label: '自定义(拖拽)' },
]

export default function App() {
  return (
    <DragProvider>
      <AppInner />
    </DragProvider>
  )
}

function AppInner() {
  const [notes, setNotes] = useState<Note[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [todos, setTodos] = useState<Record<number, TodoItem[]>>({})
  const [timeline, setTimeline] = useState<TimelineEntry[]>([])
  const [view, setView] = useState<View>('notes')
  const [activeCategoryId, setActiveCategoryId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('updated')
  const [loaded, setLoaded] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  // 「移动到分组」就地展开(窄管理台放不下侧边飞层,展开在菜单内部紧贴父级)
  const [moveMenuOpen, setMoveMenuOpen] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [newCategoryName, setNewCategoryName] = useState('')
  const [isAddingCategory, setIsAddingCategory] = useState(false)
  const [renamingCategoryId, setRenamingCategoryId] = useState<number | null>(null)
  const [renamingName, setRenamingName] = useState('')
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number; noteId: number } | null>(null)
  const [openNoteIds, setOpenNoteIds] = useState<number[]>([])
  const [edgeDockEnabled, setEdgeDockEnabled] = useState(isEdgeDockEnabled())
  const [managerPinned, setManagerPinnedState] = useState(isManagerPinned())
  const [dragOverWindow, setDragOverWindow] = useState(false)

  const { isDragging } = useDragContext()
  // 内部排序拖拽标记(供窗口级外部拖放监听同步读取,避免依赖 dataTransfer.types 探测)
  const isDraggingRef = useRef(false)
  useEffect(() => {
    isDraggingRef.current = isDragging
  }, [isDragging])
  const categoryBarRef = useRef<HTMLDivElement>(null)
  const noteListRef = useRef<HTMLDivElement>(null)

  // 标题栏主题切换(spec 8.6):按预设顺序循环
  const cycleTheme = useCallback(() => {
    const { name, customColor } = loadTheme()
    const idx = THEME_PRESETS.findIndex((p) => p.name === name)
    const next = THEME_PRESETS[(idx + 1 + THEME_PRESETS.length) % THEME_PRESETS.length]
    saveTheme(next.name, customColor)
  }, [])
  // 管理台窗口置顶:持久化 + 应用窗口属性 + 广播(与便签逐条置顶 DB 链路完全独立)
  const toggleManagerPin = useCallback(() => {
    const next = !managerPinned
    setManagerPinned(next)
    setManagerPinnedState(next)
    window.dispatchEvent(new CustomEvent(MANAGER_PIN_EVENT, { detail: next }))
  }, [managerPinned])
  // 隐私分类(spec 7.11)
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>({ has_password: false, questions: [] })
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode | null>(null)
  const [privacyUnlocked, setPrivacyUnlocked] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)

  const { undock } = useEdgeDock(edgeDockEnabled)

  const showError = useCallback((msg: string) => {
    console.error(msg)
    showToast(msg, 'error')
  }, [])

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

  const loadTimeline = useCallback(async () => {
    try {
      setTimeline(await invoke<TimelineEntry[]>('get_all_timeline'))
    } catch (e) {
      showError(`加载时间轴失败: ${e}`)
    }
  }, [showError])

  const loadPrivacyStatus = useCallback(async () => {
    try {
      setPrivacyStatus(await invoke<PrivacyStatus>('get_privacy_status'))
    } catch (e) {
      showError(`读取隐私设置失败: ${e}`)
    }
  }, [showError])

  const loadOpenNotes = useCallback(async () => {
    try {
      setOpenNoteIds(await invoke<number[]>('get_open_note_ids'))
    } catch {
      /* 忽略 */
    }
  }, [])

  // 时间轴视图进入时加载
  const viewRef = useRef<View>('notes')
  useEffect(() => {
    viewRef.current = view
  }, [view])
  useEffect(() => {
    if (view === 'timeline') loadTimeline()
  }, [view, loadTimeline])

  // 隐私锁定引用(供 focus 事件使用)
  const lockPrivacyRef = useRef<() => void>(() => {})

  useEffect(() => {
    loadAll()
      .catch((e) => showError(`初始化失败: ${e}`))
      .finally(() => setLoaded(true))
    loadPrivacyStatus()
    loadOpenNotes()

    const unlisten = listen('notes-updated', () => {
      loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
      loadOpenNotes()
      if (viewRef.current === 'timeline') loadTimeline()
    })

    const unFocus = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        loadAll().catch((e) => showError(`刷新列表失败: ${e}`))
        loadOpenNotes()
      }
      // spec 7.13:失焦不锁定(否则打开隐私便签窗口后管理器失焦会立即销毁该窗口)
    })

    // 最小化才锁定(Rust 侧检测最小化事件后广播)
    const unMin = listen('main-minimized', () => {
      lockPrivacyRef.current()
    })

    // 便签窗口被隐藏/关闭时刷新「已打开」列表(关闭按钮隐藏窗口,窗口仍存在)
    const unNoteHidden = listen('note-window-hidden', () => {
      loadOpenNotes()
    })

    // 便签窗口显示后刷新(Rust 侧 show 派发延迟,立即刷新会漏掉刚打开的窗口)
    const unNoteShown = listen('note-window-shown', () => {
      loadOpenNotes()
    })

    return () => {
      unlisten.then((fn) => fn())
      unFocus.then((fn) => fn())
      unMin.then((fn) => fn())
      unNoteHidden.then((fn) => fn())
      unNoteShown.then((fn) => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAll, loadPrivacyStatus, loadOpenNotes, loadTimeline, showError])

  // 边缘吸附设置联动
  useEffect(() => {
    const handler = (e: CustomEvent) => setEdgeDockEnabled(e.detail)
    window.addEventListener('edge-dock-changed', handler as EventListener)
    return () => window.removeEventListener('edge-dock-changed', handler as EventListener)
  }, [])

  // 管理台置顶:挂载时应用初始状态,后续经 manager-pin-changed 事件实时同步窗口属性
  useEffect(() => {
    const applyPin = (pinned: boolean) => {
      getCurrentWindow().setAlwaysOnTop(pinned).catch((e) => console.error('设置窗口置顶失败:', e))
    }
    applyPin(isManagerPinned())
    const handler = (e: CustomEvent) => applyPin(e.detail)
    window.addEventListener(MANAGER_PIN_EVENT, handler as EventListener)
    return () => window.removeEventListener(MANAGER_PIN_EVENT, handler as EventListener)
  }, [])

  // 设置面板中隐私密码变化
  useEffect(() => {
    const handler = () => loadPrivacyStatus()
    window.addEventListener('privacy-changed', handler)
    return () => window.removeEventListener('privacy-changed', handler)
  }, [loadPrivacyStatus])

  // 拖拽创建便签(spec 7.10/7.12):
  // 文件拖放 → Rust 侧自动转发 tauri://drag-drop(含路径);
  // HTML5 文本/URL 拖放 → dataTransfer(Windows 下 wry 仅放行文件拖放,文本拖放由平台限制)。
  // URL 拖放标题取域名;创建后自动打开便签窗口(spec 7.12)。
  useEffect(() => {
    const titleForDrag = (text: string): string => {
      const first = text.split('\n').find((l) => l.trim())?.trim() ?? ''
      const m = first.match(/^https?:\/\/([^/\s]+)/i)
      if (m) return m[1]
      return first.slice(0, 30)
    }
    const openCreated = (note: Note) => {
      invoke('open_note', { id: note.id }).catch((e) => console.error('打开便签窗口失败:', e))
    }
    let disposed = false
    let unlistenDnd: (() => void) | undefined
    listen<{ paths: string[] | null }>('tauri://drag-drop', (event) => {
      const paths = event.payload.paths ?? []
      if (paths.length > 0) {
        const content = paths.join('\n')
        invoke<Note>('add_note', {
          title: '拖入的文件',
          noteType: 'text',
          categoryId: activeCatRef.current,
        }).then((note) => invoke('update_note', { note: { ...note, content } }).then(() => openCreated(note)))
          .catch((e) => showError(`拖拽创建失败: ${e}`))
      }
    }).then((fn) => {
      // 清理先于注册完成时(如 StrictMode 双挂载)立即反注册,避免重复监听
      if (disposed) fn()
      else unlistenDnd = fn
    })

    const onDragOver = (e: DragEvent) => {
      // 内部分类/卡片排序拖拽不触发「松开创建便签」提示
      if (isDraggingRef.current) return
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (types.some(t => t.startsWith('application/x-sticky-'))) return
      e.preventDefault()
      setDragOverWindow(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOverWindow(false)
    }
    const onDrop = (e: DragEvent) => {
      // 内部拖拽(分类排序/卡片排序)不创建便签
      if (isDraggingRef.current) return
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (types.some(t => t.startsWith('application/x-sticky-'))) return
      e.preventDefault()
      setDragOverWindow(false)
      const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain')
      if (text && text.trim()) {
        invoke<Note>('add_note', {
          title: titleForDrag(text),
          noteType: 'text',
          categoryId: activeCatRef.current,
        }).then((note) => invoke('update_note', { note: { ...note, content: text } }).then(() => openCreated(note)))
          .catch((e) => showError(`拖拽创建失败: ${e}`))
      }
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      unlistenDnd?.()
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showError])

  const activeCatRef = useRef<number | null>(null)
  useEffect(() => {
    activeCatRef.current = activeCategoryId
  }, [activeCategoryId])

  // 应用内快捷键:Ctrl+N 新建 / Ctrl+T 新建待办 / Ctrl+F 搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      const target = e.target as HTMLElement
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
        if (e.key.toLowerCase() === 'f' && target.tagName !== 'INPUT') {
          /* Ctrl+F 在输入框内不拦截 */
        }
        return
      }
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault()
        addNote('text')
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        addNote('todo')
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategoryId])

  // ===== 隐私分类 =====
  const privacyCat = useMemo(
    () => categories.find((c) => c.name === '隐私' && c.is_system),
    [categories],
  )
  const inPrivacy = privacyCat !== undefined && activeCategoryId === privacyCat.id
  const privacyActive = inPrivacy && privacyStatus.has_password && !privacyUnlocked

  const lockPrivacy = useCallback(() => {
    setPrivacyUnlocked(false)
    // 关闭已打开的隐私便签窗口
    const privacyNoteIds = new Set(notes.filter((n) => n.category_id === privacyCat?.id).map((n) => n.id))
    for (const id of openNoteIds) {
      if (privacyNoteIds.has(id)) {
        invoke('close_note_window', { id }).catch(() => {})
      }
    }
    loadOpenNotes()
  }, [notes, privacyCat, openNoteIds, loadOpenNotes])

  useEffect(() => {
    lockPrivacyRef.current = lockPrivacy
  }, [lockPrivacy])

  const selectCategory = useCallback(async (id: number | null) => {
    if (id !== null && privacyCat && id === privacyCat.id) {
      if (privacyStatus.has_password && !privacyUnlocked) {
        setPrivacyMode('unlock')
        return
      }
      if (!privacyStatus.has_password) {
        // spec 7.13:首次点击隐私分类,引导设置密码
        setPrivacyMode('setup')
        return
      }
    }
    if (activeCategoryId === privacyCat?.id && id !== activeCategoryId) {
      // 离开隐私分类 → 重新锁定
      await lockPrivacy()
    }
    // 记录最后使用的分类,供闪电捕获栏复用
    if (id === null) {
      localStorage.removeItem('lastActiveCategoryId')
    } else {
      localStorage.setItem('lastActiveCategoryId', String(id))
    }
    setActiveCategoryId(id)
  }, [privacyCat, privacyStatus, privacyUnlocked, activeCategoryId, lockPrivacy])

  // 分类拖拽排序(spec 7.14):按可见落点重排 + 一次性持久化;隐私系统分类固定末尾不参与
  // insertIndex 为相对可见分类的插入索引(useReorderDrag 已排除原位落下)
  const commitCategoryOrder = useCallback((insertIndex: number, sourceId: number) => {
    const src = categories.find((c) => c.id === sourceId)
    if (!src || src.is_system) return
    const systemCats = categories.filter((c) => c.is_system)
    const movable = categories.filter((c) => !c.is_system && c.id !== sourceId)
    // insertIndex 相对完整可见列表(含源项);用落点锚定项在「移除源项后的 movable」
    // 中的位置换算,向下拖时源项移除引起的左移被自动抵消(与 commitNoteOrder 同思路)
    const anchor = categories[insertIndex]
    let insertAt = anchor ? movable.findIndex((c) => c.id === anchor.id) : movable.length
    if (insertAt < 0) insertAt = movable.length // 锚定项是系统分类(固定末尾)→ 插到它前面
    movable.splice(insertAt, 0, src)
    setCategories([...movable, ...systemCats])
    invoke('reorder_categories', { ids: movable.map((c) => c.id) }).catch((e) => {
      showError(`分类排序失败: ${e}`)
      loadAll()
    })
  }, [categories, showError, loadAll])

  const categoryDrag = useReorderDrag({
    enabled: true,
    kind: 'category',
    containerRef: categoryBarRef,
    isMovable: (id) => {
      const c = categories.find((x) => x.id === id)
      return c !== undefined && !c.is_system
    },
    onDropAt: commitCategoryOrder,
  })

  const onPrivacyUnlocked = useCallback(() => {
    setPrivacyUnlocked(true)
    setPrivacyMode(null)
    if (privacyCat) setActiveCategoryId(privacyCat.id)
  }, [privacyCat])

  // ===== 便签操作 =====
  // 管理台不再内联编辑(spec 7.10 保持独立窗口编辑),便签修改统一走便签窗口自身的防抖保存。
  const addNote = useCallback(async (type: 'text' | 'todo') => {
    try {
      await invoke<Note>('add_note', {
        title: '', // 标题留空:窗口内显示浅色占位符,未填写关闭时不保存
        noteType: type,
        categoryId: activeCategoryId,
      })
      loadOpenNotes()
    } catch (e) {
      showError(`新建便签失败: ${e}`)
    }
  }, [activeCategoryId, showError, loadOpenNotes])

  const deleteNote = useCallback(async (id: number) => {
    if (!(await confirmDialog({
      title: '删除便签',
      message: '便签将移入回收站,30 天内可恢复。',
      confirmText: '删除',
    }))) return
    try {
      await invoke('delete_note', { id })
      showToast('已移入回收站', 'success')
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

  // 移动分组:走原子 set_note_category(后端单字段 UPDATE),便签窗口的整行回写不会覆盖移动
  const moveNoteToCategory = useCallback(async (noteId: number, categoryId: number | null) => {
    setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, category_id: categoryId } : n)))
    try {
      await invoke('set_note_category', { id: noteId, categoryId })
    } catch (e) {
      showError(`移动分组失败: ${e}`)
    }
  }, [showError])

  const duplicate = useCallback(async (id: number) => {
    try {
      await invoke('duplicate_note', { id })
      showToast('已创建副本', 'success')
    } catch (e) {
      showError(`复制便签失败: ${e}`)
    }
  }, [showError])

  const exportSingle = useCallback(async (id: number) => {
    try {
      await invoke('export_note', { id })
    } catch (e) {
      showError(`导出失败: ${e}`)
    }
  }, [showError])

  const exportAll = useCallback(async () => {
    try {
      await invoke('export_all')
      showToast('导出完成', 'success')
    } catch (e) {
      showError(`导出失败: ${e}`)
    }
  }, [showError])

  // ===== 分类操作 =====
  const addCategory = useCallback(async () => {
    if (!newCategoryName.trim()) return
    try {
      await invoke<Category>('add_category', { name: newCategoryName.trim() })
      setNewCategoryName('')
      setIsAddingCategory(false)
    } catch (e) {
      showError(`新增分类失败: ${e}`)
    }
  }, [newCategoryName, showError])

  const renameCategory = useCallback(async (id: number) => {
    if (!renamingName.trim()) return
    try {
      await invoke('rename_category', { id, name: renamingName.trim() })
      setRenamingCategoryId(null)
    } catch (e) {
      showError(`重命名失败: ${e}`)
    }
  }, [renamingName, showError])

  const deleteCategory = useCallback(async (id: number) => {
    if (!(await confirmDialog({
      title: '删除分类',
      message: '分类中的便签会移到「未分类」,确定删除?',
      danger: true,
      confirmText: '删除',
    }))) return
    try {
      await invoke('delete_category', { id })
      if (activeCategoryId === id) setActiveCategoryId(null)
    } catch (e) {
      showError(`删除分类失败: ${e}`)
    }
  }, [activeCategoryId, showError])

  const openNoteInWindow = useCallback(async (id: number) => {
    try {
      await invoke('open_note', { id })
      loadOpenNotes()
    } catch (e) {
      showError(`打开便签窗口失败: ${e}`)
    }
  }, [showError, loadOpenNotes])

  // ===== 右键菜单 =====
  const handleContextMenu = useCallback((e: React.MouseEvent, noteId: number | null = null, categoryId: number | null = null) => {
    e.preventDefault()
    e.stopPropagation()
    setMoveMenuOpen(false)
    // 下方放不下时改底部锚定(CSS bottom,菜单底边精确贴鼠标,展开向上生长);其余顶部锚定精确跟随
    const estH = noteId !== null ? 270 : categoryId !== null ? 90 : 80
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 160),
      y: e.clientY,
      fromBottom: e.clientY + estH > window.innerHeight - 8,
      noteId,
      categoryId,
    })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
    setMoveMenuOpen(false)
  }, [])

  useEffect(() => {
    const handleClick = () => closeContextMenu()
    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [closeContextMenu])

  // 搜索关键词高亮:命中片段用 <mark> 包裹(spec 8.5 搜索高亮)
  const highlightKw = (text: string, kw: string): ReactNode => {
    if (!kw) return text
    const lower = text.toLowerCase()
    const k = kw.toLowerCase()
    const parts: ReactNode[] = []
    let i = 0
    let j = lower.indexOf(k)
    let key = 0
    while (j >= 0) {
      if (j > i) parts.push(text.slice(i, j))
      parts.push(<mark key={key++} className="search-mark">{text.slice(j, j + k.length)}</mark>)
      i = j + k.length
      j = lower.indexOf(k, i)
    }
    if (i < text.length) parts.push(text.slice(i))
    return parts
  }

  const summaryOf = (note: Note): string => {
    if (note.note_type === 'todo') {
      const items = todos[note.id] || []
      if (items.length > 0) return items[0].content
      return '（暂无待办项）'
    }
    return note.content.split('\n').find((line) => line.trim().length > 0) || '（空白便签）'
  }

  const formatTime = (isoStr: string): string => {
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
    const m = date.getMonth() + 1
    const d = date.getDate()
    return `${m}月${d}日`
  }

  const activeNotes = useMemo(() => notes.filter((n) => n.status === 'active'), [notes])

  const filteredNotes = useMemo(() => {
    const kw = search.trim().toLowerCase()
    const byCategory = activeCategoryId === null
      ? activeNotes
      : activeNotes.filter((n) => n.category_id === activeCategoryId)
    const bySearch = kw
      ? byCategory.filter(
          (n) => n.title.toLowerCase().includes(kw) || n.content.toLowerCase().includes(kw),
        )
      : byCategory
    return [...bySearch].sort((a, b) => {
      if (sortMode === 'custom') {
        return a.sort_order - b.sort_order
      }
      if (sortMode === 'title') return a.title.localeCompare(b.title, 'zh-CN')
      if (sortMode === 'created') return b.created_at.localeCompare(a.created_at)
      if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
      return b.updated_at.localeCompare(a.updated_at)
    })
  }, [activeNotes, activeCategoryId, search, sortMode])

  // 自定义排序:全量 active id 落库,过滤/搜索视图下隐藏便签的相对顺序不受影响
  const customOrderedNotes = useMemo(
    () => [...activeNotes].sort((a, b) => a.sort_order - b.sort_order),
    [activeNotes],
  )

  const commitNoteOrder = useCallback((insertIndex: number, sourceId: number) => {
    const filteredIds = filteredNotes.map((n) => n.id)
    const arr = customOrderedNotes.map((n) => n.id).filter((id) => id !== sourceId)
    let insertAt: number
    if (insertIndex < filteredIds.length) {
      // 落在可见项上:插入到该项在全局顺序中的位置之前
      insertAt = arr.indexOf(filteredIds[insertIndex])
    } else {
      // 落在列表末尾:插入到最后一个可见项之后
      const last = filteredIds[filteredIds.length - 1]
      insertAt = arr.indexOf(last) + 1
    }
    if (insertAt < 0) return
    arr.splice(insertAt, 0, sourceId)
    // 乐观更新:先本地重排,保存失败再回读
    const rank = new Map(arr.map((id, i) => [id, i] as const))
    setNotes((prev) => prev.map((n) => (rank.has(n.id) ? { ...n, sort_order: rank.get(n.id)! } : n)))
    invoke('reorder_notes', { ids: arr }).catch((err) => {
      showError(`排序保存失败: ${err}`)
      loadAll()
    })
  }, [filteredNotes, customOrderedNotes, showError, loadAll])

  const noteDrag = useReorderDrag({
    enabled: sortMode === 'custom',
    kind: 'note',
    containerRef: noteListRef,
    isMovable: () => true,
    onDropAt: commitNoteOrder,
  })

  const openNoteTitles = useMemo(() => {
    const map = new Map<number, string>()
    for (const n of notes) map.set(n.id, n.title)
    return map
  }, [notes])

  // 加载状态(spec 8.6):旋转图标
  if (!loaded) {
    return (
      <div className="app-loading">
        <div className="spinner" />
      </div>
    )
  }

  return (
    <div className="app-root" onContextMenu={handleContextMenu}>
      {/* 标题栏 */}
      <div className="title-bar" data-tauri-drag-region>
        <span className="title-text">便签</span>
        <div className="title-controls">
          <button
            className={`title-btn ${managerPinned ? 'pinned' : ''}`}
            onClick={toggleManagerPin}
            title={managerPinned ? '取消置顶' : '置顶'}
            aria-pressed={managerPinned}
          >
            <PinToggleIcon pinned={managerPinned} />
          </button>
          <button
            className="title-btn"
            onClick={cycleTheme}
            title="切换主题"
          >
            <Palette size={13} />
          </button>
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
          <button className="title-btn close" onClick={() => getCurrentWindow().hide()} title="关闭">
            ✕
          </button>
        </div>
      </div>

      {/* 视图切换(顶部标签:便签/待办;spec 7.14 纯文字,选中态品牌色下划线) */}
      <div className="view-tabs">
        {([{ key: 'notes', label: '便签' }, { key: 'todos', label: '待办' }] as { key: View; label: string }[]).map((tab) => (
          <button
            key={tab.key}
            className={`view-tab ${view === tab.key ? 'active' : ''}`}
            onClick={() => {
              if (tab.key !== 'notes' && inPrivacy) lockPrivacy()
              setView(tab.key)
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 主内容区 */}
      <div className="main-content">
        {view === 'notes' && (
          <>
            <div className="category-bar" ref={categoryBarRef}>
              <div
                className={`category-item ${activeCategoryId === null ? 'active' : ''}`}
                onClick={() => selectCategory(null)}
                title="全部"
              >
                <LayoutGrid size={13} className="category-icon" />
                <span className="category-name">全部</span>
                <span className="category-count">{activeNotes.length}</span>
              </div>

              {categories.map((cat) => {
                const isPrivacy = privacyCat?.id === cat.id
                const locked = isPrivacy && privacyStatus.has_password && !privacyUnlocked
                const indicator = categoryDrag.indicatorFor(cat.id)
                const isDragTarget = indicator !== null && !isPrivacy
                return renamingCategoryId === cat.id ? (
                  <div key={cat.id} className="add-category-form">
                    <input
                      value={renamingName}
                      onChange={(e) => setRenamingName(e.target.value)}
                      placeholder="名称"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') renameCategory(cat.id)
                        if (e.key === 'Escape') setRenamingCategoryId(null)
                      }}
                    />
                    <button onClick={() => renameCategory(cat.id)}>✓</button>
                  </div>
                ) : (
                  <div
                    key={cat.id}
                    {...categoryDrag.itemProps(cat.id)}
                    className={`category-item ${activeCategoryId === cat.id ? 'active' : ''} ${isDragTarget ? 'drag-over' : ''}`}
                    onClick={() => selectCategory(cat.id)}
                    onContextMenu={(e) => {
                      e.stopPropagation()
                      handleContextMenu(e, null, cat.id)
                    }}
                    title={cat.name}
                    onDoubleClick={() => {
                      if (isPrivacy) return
                      setRenamingName(cat.name)
                      setRenamingCategoryId(cat.id)
                    }}
                    role="listitem"
                  >
                    <DragIndicator position={indicator?.position ?? 'top'} visible={isDragTarget} />
                    <span className="category-name">
                      {isPrivacy ? (
                        locked ? <Lock size={10} /> : <LockOpen size={10} />
                      ) : (
                        <Folder size={10} />
                      )}
                      {cat.name}
                    </span>
                    <span className="category-count">
                      {activeNotes.filter((n) => n.category_id === cat.id).length}
                    </span>
                  </div>
                )
              })}

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
                <button className="category-add" onClick={() => setIsAddingCategory(true)} title="新增分类">
                  <Plus size={12} />
                </button>
              )}
              {/* 时间轴入口(分隔线 + 图标) */}
              <div className="category-sep" />
              <button
                className="category-tool"
                onClick={() => {
                  if (inPrivacy) lockPrivacy()
                  setView('timeline')
                }}
                title="时间轴"
              >
                <Clock size={13} />
              </button>
              {/* 回收站入口(分隔线 + 图标,设置按钮上方) */}
              <div className="category-sep" />
              <button
                className="category-tool"
                onClick={() => {
                  if (inPrivacy) lockPrivacy()
                  setView('trash')
                }}
                title="回收站"
              >
                <Trash2 size={13} />
              </button>
              <button
                className="category-settings"
                onClick={() => setShowSettings(true)}
                title="设置"
              >
                <Settings size={12} />
              </button>
            </div>

            <div className="note-list-container">
              <div className="note-toolbar">
                <div className="search-box-wrap">
                  <Search size={11} />
                  <input
                    ref={searchRef}
                    className="search-box"
                    type="text"
                    placeholder="搜索..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <button
                  className={`toolbar-btn ${sortMenuOpen ? 'active' : ''}`}
                  title="排序"
                  onClick={() => { setSortMenuOpen(!sortMenuOpen); setAddMenuOpen(false) }}
                >
                  <ArrowUpDown size={13} />
                </button>
                <button
                  className={`toolbar-btn ${addMenuOpen ? 'active' : ''}`}
                  title="新建"
                  onClick={() => { setAddMenuOpen(!addMenuOpen); setSortMenuOpen(false) }}
                >
                  <Plus size={13} />
                </button>
                <button className="toolbar-btn" title="导出全部(JSON/CSV)" onClick={exportAll}>
                  <Download size={13} />
                </button>
              </div>

              {sortMenuOpen && (
                <div className="popover-menu sort-menu">
                  {SORT_OPTIONS.map((opt) => (
                    <div
                      key={opt.key}
                      className={`popover-item ${sortMode === opt.key ? 'active' : ''}`}
                      onClick={() => {
                        setSortMode(opt.key)
                        setSortMenuOpen(false)
                      }}
                    >
                      {opt.label}
                    </div>
                  ))}
                </div>
              )}
              {addMenuOpen && (
                <div className="popover-menu add-menu">
                  <div className="popover-item" onClick={() => { addNote('text'); setAddMenuOpen(false) }}>
                    <Text size={12} /> 文字便签
                  </div>
                  <div className="popover-item" onClick={() => { addNote('todo'); setAddMenuOpen(false) }}>
                    <ListChecks size={12} /> 待办清单
                  </div>
                </div>
              )}

              {inPrivacy && !privacyActive && (
                <div className="privacy-hint">
                  {privacyStatus.has_password ? (
                    <>
                      <span>隐私分类仅用于视觉隐藏,请勿存放敏感信息</span>
                      <button className="btn btn-ghost btn-sm" onClick={lockPrivacy}>
                        <Lock size={10} /> 锁定
                      </button>
                    </>
                  ) : (
                    <>
                      <span>此分类未设密码</span>
                      <button className="btn btn-ghost btn-sm" onClick={() => setPrivacyMode('setup')}>
                        <Lock size={10} /> 设置密码
                      </button>
                    </>
                  )}
                </div>
              )}
              {privacyActive ? (
                <div className="privacy-locked-view">
                  <Lock size={28} />
                  <div>隐私分类已锁定</div>
                  <button className="btn btn-primary btn-sm" onClick={() => setPrivacyMode('unlock')}>
                    解锁
                  </button>
                </div>
              ) : (
                <div className={`note-list ${sortMode === 'custom' ? 'drag-enabled' : ''}`} ref={noteListRef}>
                  {filteredNotes.length === 0 ? (
                    <div className="list-empty">{search.trim() ? '暂无结果' : '暂无便签'}</div>
                  ) : (
                    filteredNotes.map((note, i) => {
                      const isDragSource = noteDrag.isSource(note.id)
                      const indicator = noteDrag.indicatorFor(note.id)
                      return (
                        <Fragment key={note.id}>
                        {i > 0 && filteredNotes[i - 1].is_pinned && !note.is_pinned && (
                          <div className="pinned-sep" />
                        )}
                        <div
                          {...noteDrag.itemProps(note.id)}
                          className={`note-card ${note.is_pinned ? 'pinned' : ''} ${isDragSource ? 'dragging' : ''} ${indicator ? 'drag-over' : ''}`}
                          style={{ ['--note-color' as string]: note.color }}
                          onClick={() => openNoteInWindow(note.id)}
                          onContextMenu={(e) => {
                            e.stopPropagation()
                            handleContextMenu(e, note.id)
                          }}
                          role="listitem"
                        >
                          <DragIndicator position={indicator?.position ?? 'top'} visible={indicator !== null} />
                          <div className="note-card-colorbar" />
                          <div className="note-card-header">
                            <span className="note-card-icon">
                              {note.note_type === 'todo' ? <ListTodo size={12} /> : <StickyNote size={12} />}
                            </span>
                            <span className="note-card-title">{note.title ? highlightKw(note.title, search.trim()) : '（未命名）'}</span>
                            {note.is_pinned && <Pin size={10} className="note-card-pin" />}
                          </div>
                          <div className="note-card-summary">
                            {highlightKw(summaryOf(note), search.trim())}
                          </div>
                          <div className="note-card-footer">
                            <span className="note-card-time">{formatTime(note.updated_at)}</span>
                            {(() => {
                              const c = categories.find((x) => x.id === note.category_id)
                              return c ? <span className="note-card-cat">{c.name}</span> : null
                            })()}
                            <div className="note-card-actions">
                              <button
                                className="icon-btn"
                                title="在窗口中打开"
                                onClick={(e) => { e.stopPropagation(); openNoteInWindow(note.id) }}
                              >
                                <ExternalLink size={11} />
                              </button>
                              <button
                                className="icon-btn"
                                title={note.is_pinned ? '取消置顶' : '置顶'}
                                onClick={(e) => { e.stopPropagation(); togglePin(note) }}
                              >
                                {note.is_pinned ? <PinOff size={11} /> : <Pin size={11} />}
                              </button>
                              <button
                                className="icon-btn"
                                title="颜色"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setColorPicker({ x: e.clientX, y: e.clientY, noteId: note.id })
                                }}
                              >
                                <Palette size={11} />
                              </button>
                              <button
                                className="icon-btn"
                                title="创建副本"
                                onClick={(e) => { e.stopPropagation(); duplicate(note.id) }}
                              >
                                <Copy size={11} />
                              </button>
                              <button
                                className="icon-btn danger"
                                title="删除(移入回收站)"
                                onClick={(e) => { e.stopPropagation(); deleteNote(note.id) }}
                              >
                                <Trash2 size={11} />
                              </button>
                            </div>
                          </div>
                        </div>
                        </Fragment>
                      )
                    })
                  )}
                </div>
              )}

              {/* 已打开的便签 */}
              {openNoteIds.length > 0 && (
                <div className="open-notes-strip">
                  <span className="open-notes-label">已打开</span>
                  {openNoteIds.map((id) => (
                    <button
                      key={id}
                      className="open-note-chip"
                      title="聚焦窗口"
                      onClick={() => openNoteInWindow(id)}
                    >
                      {openNoteTitles.get(id)?.slice(0, 8) || `#${id}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {view === 'todos' && (
          <TodoView notes={notes} todos={Object.values(todos).flat()} privacyCategoryId={privacyCat?.id ?? null} search={search} onOpenNote={openNoteInWindow} onError={showError} />
        )}
        {view === 'trash' && (
          <TrashView notes={notes} onError={showError} onRefresh={loadAll} onBack={() => setView('notes')} />
        )}
        {view === 'timeline' && (
          <TimelineView entries={timeline} onOpenNote={openNoteInWindow} onBack={() => setView('notes')} />
        )}
      </div>

      {/* 拖拽悬停提示 */}
      {dragOverWindow && (
        <div className="drop-hint">
          <StickyNote size={20} />
          <div>松开创建便签</div>
        </div>
      )}

      {/* 右键菜单 */}
      {contextMenu && (
        <>
        <div
          className="context-menu"
          style={contextMenu.fromBottom
            ? { left: contextMenu.x, bottom: window.innerHeight - contextMenu.y + 4 }
            : { left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.noteId !== null ? (
            <>
              <div className="menu-item" onClick={() => { openNoteInWindow(contextMenu.noteId!); closeContextMenu() }}>
                在窗口中打开
              </div>
              <div className="menu-item" onClick={() => { const n = notes.find((x) => x.id === contextMenu.noteId); if (n) togglePin(n); closeContextMenu() }}>
                {notes.find((n) => n.id === contextMenu.noteId)?.is_pinned ? '取消置顶' : '置顶'}
              </div>
              <div className="menu-item" onClick={() => { duplicate(contextMenu.noteId!); closeContextMenu() }}>
                复制便签
              </div>
              <div className="menu-item" onClick={() => { exportSingle(contextMenu.noteId!); closeContextMenu() }}>
                导出
              </div>
              <div className="menu-separator" />
              <div
                className="menu-item has-submenu"
                onClick={(e) => {
                  // 就地展开,不触发 window 点击关闭
                  e.stopPropagation()
                  if (!moveMenuOpen && !contextMenu.fromBottom) {
                    // 顶部锚定展开后分组列表可能超高:上移菜单贴住底部(底部锚定的向上生长,无需处理)
                    setContextMenu((m) => (m && !m.fromBottom && m.y + 308 > window.innerHeight ? { ...m, y: Math.max(8, window.innerHeight - 308) } : m))
                  }
                  setMoveMenuOpen(!moveMenuOpen)
                }}
              >
                <span className="menu-item-text">移动到分组</span>
                <span className="submenu-arrow">{moveMenuOpen ? '▾' : '▸'}</span>
              </div>
              {moveMenuOpen && (
                <>
                  <div className="menu-item sub-item" onClick={() => { moveNoteToCategory(contextMenu.noteId!, null); closeContextMenu() }}>
                    <span className="menu-item-text">未分类{notes.find((n) => n.id === contextMenu.noteId)?.category_id == null ? ' ✓' : ''}</span>
                  </div>
                  {categories.map((cat) => (
                    <div
                      key={cat.id}
                      className="menu-item sub-item"
                      onClick={() => { moveNoteToCategory(contextMenu.noteId!, cat.id); closeContextMenu() }}
                    >
                      <span className="menu-item-text">{cat.name}{notes.find((n) => n.id === contextMenu.noteId)?.category_id === cat.id ? ' ✓' : ''}</span>
                    </div>
                  ))}
                </>
              )}
              <div className="menu-separator" />
              <div className="menu-item danger" onClick={() => { deleteNote(contextMenu.noteId!); closeContextMenu() }}>
                删除
              </div>
            </>
          ) : contextMenu.categoryId !== null ? (
            (() => {
              const cat = categories.find((c) => c.id === contextMenu.categoryId)
              const isSystem = cat?.is_system ?? false
              return (
                <>
                  {!isSystem && (
                    <div className="menu-item" onClick={() => { setRenamingCategoryId(contextMenu.categoryId!); setRenamingName(cat?.name ?? ''); closeContextMenu() }}>
                      重命名
                    </div>
                  )}
                  {!isSystem && (
                    <div className="menu-item danger" onClick={() => { deleteCategory(contextMenu.categoryId!); closeContextMenu() }}>
                      删除分类
                    </div>
                  )}
                  {isSystem && <div className="menu-item disabled">系统分类不可修改</div>}
                </>
              )
            })()
          ) : (
            <>
              <div className="menu-item" onClick={() => { addNote('text'); closeContextMenu() }}>
                新建文字便签
              </div>
              <div className="menu-item" onClick={() => { addNote('todo'); closeContextMenu() }}>
                新建待办清单
              </div>
            </>
          )}
        </div>
        </>
      )}

      {/* 颜色选择 */}
      {colorPicker && (
        <ColorPicker
          x={colorPicker.x}
          y={colorPicker.y}
          current={notes.find((n) => n.id === colorPicker.noteId)?.color ?? '#FFE066'}
          onPick={(color) => {
            setNotes((prev) => prev.map((n) => (n.id === colorPicker.noteId ? { ...n, color } : n)))
            invoke('set_note_color', { id: colorPicker.noteId, color }).catch((e) => showError(`设置颜色失败: ${e}`))
          }}
          onClose={() => setColorPicker(null)}
        />
      )}

      {/* 隐私锁弹窗 */}
      {privacyMode && (
        <PrivacyLock
          mode={privacyMode}
          status={privacyStatus}
          onCancel={() => setPrivacyMode(null)}
          onUnlocked={onPrivacyUnlocked}
          onSwitchMode={(m) => setPrivacyMode(m)}
        />
      )}

      {/* 设置面板 */}
      {showSettings && (
        <SettingsPanel
          onClose={() => {
            setShowSettings(false)
            loadPrivacyStatus()
          }}
        />
      )}

      <ToastHost />
      <ConfirmDialogHost />
    </div>
  )
}
