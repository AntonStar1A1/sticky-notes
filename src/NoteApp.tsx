import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { listen, emit } from '@tauri-apps/api/event'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Pin, X, Check, Square, Paperclip, Plus, Trash2, FileText, FileImage, FileArchive, File } from 'lucide-react'
import type { Note, TodoItem, Attachment, WindowStyle } from './types'
import { loadTheme } from './theme'
import { ToastHost, showToast } from './components/Toast'
import { ConfirmDialogHost, confirmDialog } from './components/ConfirmDialog'
import './note.css'

loadTheme()

const SAVE_DEBOUNCE_MS = 300
const EXPANDED_MIN_WIDTH = 320 // 窗口宽度 ≥320 视为展开态
const id = Number(new URL(window.location.href).searchParams.get('id'))
const win = getCurrentWindow()

// 拖窗排除区:这些区域的 mousedown 不应触发 startDragging(交互元素 / 正文区)
const DRAG_EXCLUDE = '.note-body, .note-context-menu, .note-resize-handle, .note-attachments, button, input, textarea'

// —— 主题颜色工具:把 CSS 变量颜色字符串按透明度重建 ——
function parseColor(c: string): [number, number, number, number] | null {
  const s = c.trim()
  let m = s.match(/^#([0-9a-f]{3})$/i)
  if (m) return [parseInt(m[1][0], 16) * 17, parseInt(m[1][1], 16) * 17, parseInt(m[1][2], 16) * 17, 1]
  m = s.match(/^#([0-9a-f]{6})$/i)
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1]
  m = s.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\)$/i)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])]
  return null
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** 按便签窗口样式 + 主题 + 透明度计算卡片背景(实色不透明,渐变使用便签颜色,毛玻璃半透明) */
function noteBackground(style: WindowStyle, color: string, opacity: number): string {
  const solid = cssVar('--bg-solid') || '#141419'
  if (style === 'solid') return solid
  const glass = parseColor(cssVar('--bg-glass')) ?? [20, 20, 25, 0.55]
  if (style === 'gradient') {
    const c = parseColor(color) ?? [255, 224, 102, 1]
    return `linear-gradient(135deg, rgba(${c[0]},${c[1]},${c[2]},${(0.92 * opacity).toFixed(3)}), rgba(${glass[0]},${glass[1]},${glass[2]},${(glass[3] * opacity).toFixed(3)}))`
  }
  // glass:继承主题玻璃底色,再乘便签透明度
  return `rgba(${glass[0]},${glass[1]},${glass[2]},${(glass[3] * opacity).toFixed(3)})`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function fileIcon(ext: string) {
  const e = ext.toLowerCase()
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(e)) return <FileImage size={13} />
  if (['pdf', 'doc', 'docx', 'txt', 'md'].includes(e)) return <FileText size={13} />
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return <FileArchive size={13} />
  return <File size={13} />
}

const URL_RE = /^(https?:\/\/|www\.|mailto:)[^\s]+$/i
// spec 7.12 内容感知:邮箱地址 → 发送邮件
const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
// 从全文提取首个 URL / 邮箱(选中文本不含链接时回退,spec 7.12 全内容检测)
const URL_IN_TEXT_RE = /(https?:\/\/|www\.|mailto:)[^\s]+/i
const EMAIL_IN_TEXT_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/

function NoteApp() {
  const [note, setNote] = useState<Note | null>(null)
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [expanded, setExpanded] = useState(true)
  const [error, setError] = useState(false)
  const [highlight, setHighlight] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [selectedText, setSelectedText] = useState('')
  const [attachmentsOpen, setAttachmentsOpen] = useState(true)
  const [showCharCount, setShowCharCount] = useState(() => {
    // spec 7.11:默认关闭
    return localStorage.getItem('showCharCount') === 'true'
  })

  // 最新 note 快照,供回调读取(避免依赖 state 导致回调身份频繁变化)
  const noteRef = useRef<Note | null>(null)
  const pendingRef = useRef<{ note?: Note; todos: Map<number, TodoItem> }>({ note: undefined, todos: new Map() })
  const timerRef = useRef<number | null>(null)
  // 高亮闪烁去重:Rust 侧为兜底慢加载会重试多次 emit,一次打开只闪一轮
  const lastHlRef = useRef(0)

  // —— 防抖落库:编辑静默保存,不触发任何事件 ——
  const flush = useCallback(async () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = { note: undefined, todos: new Map() }
    let saved = false
    try {
      if (pending.note) {
        await invoke('update_note', { note: pending.note })
        saved = true
      }
      const items = Array.from(pending.todos.values())
      if (items.length) {
        await Promise.all(items.map((it) => invoke('update_todo', { item: it })))
        saved = true
      }
      // 保存后从数据库重新拉取,确保 updated_at 等字段与数据库一致
      if (saved) {
        const n = await invoke<Note>('get_note', { id })
        noteRef.current = n
        setNote(n)
        setSaveState('saved')
        // spec 7.11:绿色圆点 1 秒后消失
        window.setTimeout(() => {
          setSaveState((prev) => (prev === 'saved' ? 'idle' : prev))
        }, 1000)
      }
    } catch (e) {
      console.error('保存便签失败:', e)
      setSaveState('error')
    }
  }, [])

  const schedule = useCallback((updater: () => void) => {
    updater()
    setSaveState('saving')
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

  // 主题/字数开关实时跟随:管理器修改 → localStorage 跨窗口 storage 事件
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'sticky-theme') loadTheme()
      if (e.key === 'showCharCount') setShowCharCount(e.newValue !== 'false')
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

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

  // —— 附件(spec 7.13) ——
  const loadAttachments = useCallback(async () => {
    try {
      setAttachments(await invoke<Attachment[]>('get_attachments', { noteId: id }))
    } catch (e) {
      console.error('加载附件失败:', e)
    }
  }, [])

  const addAttachmentPath = useCallback(async (path: string) => {
    try {
      await invoke('add_attachment_path', { noteId: id, path })
      loadAttachments()
    } catch (e) {
      showToast(`添加附件失败: ${e}`, 'error')
    }
  }, [loadAttachments])

  const pickAttachment = useCallback(async () => {
    try {
      await invoke('pick_attachment', { noteId: id })
      loadAttachments()
    } catch (e) {
      showToast(`添加附件失败: ${e}`, 'error')
    }
  }, [loadAttachments])

  const openAttachment = useCallback(async (att: Attachment) => {
    try {
      await invoke('open_attachment', { path: att.file_path })
    } catch (e) {
      showToast(`打开失败: ${e}`, 'error')
    }
  }, [])

  const deleteAttachment = useCallback(async (att: Attachment) => {
    if (!(await confirmDialog({
      title: '移除附件',
      message: `从便签移除「${att.file_name}」?不会删除原文件。`,
      danger: true,
      confirmText: '移除',
    }))) return
    try {
      await invoke('delete_attachment', { id: att.id })
      loadAttachments()
    } catch (e) {
      showToast(`移除失败: ${e}`, 'error')
    }
  }, [loadAttachments])

  // 最新附件列表快照,供事件回调读取
  const attachmentsRef = useRef<Attachment[]>([])
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // 文件拖入便签窗口 → 添加附件(Rust 侧自动转发 tauri://drag-drop)
  useEffect(() => {
    let unlistenDnd: (() => void) | undefined
    listen<{ paths: string[] | null }>('tauri://drag-drop', (event) => {
      const paths = event.payload.paths ?? []
      const existing = new Set(attachmentsRef.current.map((a) => a.file_path))
      for (const p of paths) {
        if (!existing.has(p)) addAttachmentPath(p)
      }
    }).then((fn) => {
      unlistenDnd = fn
    })
    return () => unlistenDnd?.()
  }, [addAttachmentPath])

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
  const startResize = useCallback((e: ReactMouseEvent) => {
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

  // 置顶:先落库未防抖改动,再经专用 set_note_pinned 原子命令(单字段 UPDATE,
  // 不整行回写 —— update_note 已不写置顶,陈旧 is_pinned 快照不可能再覆盖管理器置顶)。
  // Rust 侧置顶变化即广播 notes-updated → 本窗口 refresh 重拉确认 + setAlwaysOnTop 同步。
  const togglePin = useCallback(async () => {
    await flush()
    const current = noteRef.current
    if (!current) return
    const next = { ...current, is_pinned: !current.is_pinned }
    noteRef.current = next
    setNote(next)
    try {
      await invoke('set_note_pinned', { id, pinned: next.is_pinned })
      await win.setAlwaysOnTop(next.is_pinned)
    } catch (e) {
      console.error('置顶切换失败:', e)
    }
  }, [flush])

  // 窗口样式切换(毛玻璃/实色/渐变):专用原子命令,不经 update_note
  const changeStyle = useCallback((style: WindowStyle) => {
    invoke('set_note_style', { id, style }).catch((e) => console.error('切换样式失败:', e))
    setNote((prev) => {
      if (!prev) return prev
      const next = { ...prev, window_style: style }
      noteRef.current = next
      return next
    })
  }, [])

  const deleteNote = useCallback(() => {
    // Rust 侧会销毁本窗口并软删除
    invoke('delete_note', { id }).catch((e) => console.error('删除便签失败:', e))
  }, [])

  const closeNote = useCallback(async () => {
    await flush()
    // 新建后未填写任何内容(标题/内容/待办/附件全空)则彻底删除,不留空便签
    const n = noteRef.current
    const isEmpty = !!n && !n.title.trim() && !n.content.trim() && todos.length === 0 && attachments.length === 0
    if (isEmpty) {
      try { await invoke('discard_empty_note', { id }) } catch (e) { console.error('丢弃空便签失败:', e) }
    }
    // 先隐藏再通知,避免管理器在窗口仍可见时刷新导致列表不更新
    const ok = await win.hide().then(() => true).catch((e) => { console.error('隐藏便签失败:', e); return false })
    if (ok) emit('note-window-hidden', { id }).catch(() => {})
  }, [flush, id, todos, attachments])

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
      loadAttachments()
    } catch (e) {
      console.error('同步便签数据失败:', e)
    }
  }, [flush, loadAttachments])

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
        loadAttachments()
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
      const now = Date.now()
      if (now - lastHlRef.current < 1200) return
      lastHlRef.current = now
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const openMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    setSelectedText(window.getSelection()?.toString() ?? '')
    setMenu({
      x: Math.max(0, Math.min(e.clientX, window.innerWidth - 170)),
      y: Math.max(0, Math.min(e.clientY, window.innerHeight - 300)),
    })
  }, [])

  const copySelection = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast('已复制', 'success')
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      showToast('已复制', 'success')
    }
  }, [])

  // 双击卡片切换紧凑/展开;在输入控件上的双击保留文本选择
  const handleDoubleClick = useCallback((e: ReactMouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('textarea, input, .todo-checkbox, .todo-delete, .note-attachments')) return
    setWindowState(!expanded)
  }, [expanded, setWindowState])

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
    const m = date.getMonth() + 1
    const d = date.getDate()
    return `${m}月${d}日`
  }

  // 滚轮调节透明度(spec 7.x:展开/收起统一支持,用原生监听以支持 preventDefault)
  // 展开态下正文/待办/附件列表保留原生滚动,其余区域(头部/状态栏/空白)滚轮调透明度
  useEffect(() => {
    const el = document.querySelector('.note-root')
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const t = e.target as HTMLElement
      if (expanded && t.closest('textarea, input, .todo-list, .attachment-list')) return
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.05 : 0.05
      const newOpacity = Math.min(1, Math.max(0.15, noteRef.current!.opacity + delta))
      updateNote({ opacity: newOpacity })
    }
    const elHtml = el as HTMLElement
    elHtml.addEventListener('wheel', onWheel, { passive: false })
    return () => elHtml.removeEventListener('wheel', onWheel)
  }, [expanded, updateNote])

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

  // 优先选中文本,无链接时回退全文提取(spec 7.12 全内容检测)
  const selText = selectedText.trim()
  const selectedLink = selText.match(URL_RE)
  const selectedEmail = selText.match(EMAIL_RE)
  const fallbackLink = selectedLink ? null : note.content.match(URL_IN_TEXT_RE)
  const fallbackEmail = selectedEmail ? null : note.content.match(EMAIL_IN_TEXT_RE)
  const linkMatch = selectedLink ?? fallbackLink
  const mailMatch = selectedEmail ?? fallbackEmail
  const normalizedLink = linkMatch
    ? (linkMatch[0].startsWith('www.') ? `https://${linkMatch[0]}` : linkMatch[0])
    : null
  const normalizedMail = mailMatch ? `mailto:${mailMatch[0]}` : null
  const doneCount = todos.filter((t) => t.is_done).length
  const isGlass = note.window_style === 'glass'

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
      <div
        className={`note-card style-${note.window_style} ${isGlass ? 'glass' : ''}`}
        style={{ background: noteBackground(note.window_style, note.color, note.opacity) }}
      >
        <div className="note-header">
          <span className="note-title-text">{note.title || '无标题'}</span>
          {saveState !== 'idle' && (
            <span
              className={`save-dot ${saveState}`}
              title={saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : '已保存'}
            />
          )}
          {expanded && <span className="note-time-text">{formatTime(note.updated_at)}</span>}
          <div className="note-actions">
            <button
              className={`pin-btn ${note.is_pinned ? 'pinned' : ''}`}
              title={note.is_pinned ? '取消置顶' : '置顶'}
              onClick={togglePin}
            >
              <Pin size={13} />
            </button>
            <button title={expanded ? '收起' : '展开'} onClick={() => setWindowState(!expanded)}>
              {expanded ? '收起' : '展开'}
            </button>
            <button className="close-btn" title="隐藏" onClick={closeNote}>
              <X size={14} />
            </button>
          </div>
        </div>

        {expanded ? (
          <div className="note-body expanded" onDoubleClick={handleDoubleClick}>
            <input
              className="note-title-input"
              value={note.title}
              placeholder={note.note_type === 'todo' ? '新建待办' : '新建便签'}
              onChange={(e) => updateNote({ title: e.target.value })}
            />
            {note.note_type === 'todo' ? (
              <div className="todo-list">
                {todos.map((t) => (
                  <div key={t.id} className={`todo-item ${t.is_done ? 'done' : ''}`}>
                    <span className="todo-checkbox" onClick={() => toggleTodo(t)} title="勾选">
                      {t.is_done ? <Check size={14} /> : <Square size={13} />}
                    </span>
                    <input
                      className="todo-text"
                      value={t.content}
                      onChange={(e) => updateTodoContent(t, e.target.value)}
                    />
                    <button className="todo-delete" onClick={() => deleteTodo(t)} title="删除">
                      <X size={13} />
                    </button>
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

            {/* 附件区 */}
            <div className="note-attachments">
              <div className="attachments-header" onClick={() => setAttachmentsOpen(!attachmentsOpen)}>
                <Paperclip size={11} />
                <span>附件 {attachments.length > 0 && `(${attachments.length})`}</span>
                <button
                  className="attach-add"
                  title="添加附件"
                  onClick={(e) => {
                    e.stopPropagation()
                    pickAttachment()
                  }}
                >
                  <Plus size={11} />
                </button>
                <span className="attach-chevron">{attachmentsOpen ? '▾' : '▸'}</span>
              </div>
              {attachmentsOpen && attachments.length > 0 && (
                <div className="attachment-list">
                  {attachments.map((a) => (
                    <div
                      key={a.id}
                      className="attachment-row"
                      title={`双击打开: ${a.file_name}`}
                      onDoubleClick={() => openAttachment(a)}
                      onContextMenu={(e) => {
                        // spec 7.13:右键附件可删除
                        e.preventDefault()
                        e.stopPropagation()
                        deleteAttachment(a)
                      }}
                    >
                      {fileIcon(a.file_type)}
                      <span className="attachment-name">{a.file_name}</span>
                      <span className="attachment-size">{fmtSize(a.file_size)}</span>
                      <button className="attachment-del" title="移除" onClick={() => deleteAttachment(a)}>
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {attachmentsOpen && attachments.length === 0 && (
                <div className="attachment-empty">拖入文件或点击 + 添加附件</div>
              )}
            </div>

            {/* 底部状态栏:字数/待办进度 + 保存状态(spec 7.11 字数统计默认关闭) */}
            <div className="note-statusbar">
              <span>
                {note.note_type === 'todo'
                  ? `${doneCount}/${todos.length} 已完成`
                  : showCharCount ? `${note.content.replace(/\s/g, '').length} 字 · ${note.content.length} 字符` : ''}
              </span>
              <span className={`statusbar-save ${saveState}`}>
                {saveState === 'saving' ? '保存中…' : saveState === 'error' ? '保存失败' : saveState === 'saved' ? '已保存' : ''}
              </span>
            </div>
          </div>
        ) : (
          <div className="note-body compact" onDoubleClick={handleDoubleClick} title="双击切换">
            {note.note_type === 'todo' ? (
              <>
                <div className="compact-todos">
                  {todos.slice(0, 3).map((t) => (
                    <div key={t.id} className={`compact-todo ${t.is_done ? 'done' : ''}`}>
                      <span>{t.is_done ? <Check size={11} /> : <Square size={10} />}</span>
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
            {attachments.length > 0 && (
              <div className="compact-attachments">
                <Paperclip size={10} /> {attachments.length} 个附件
              </div>
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
          {normalizedLink && (
            <>
              <div
                className="menu-item"
                onClick={() => {
                  invoke('open_url', { url: normalizedLink }).catch((e) => showToast(`打开失败: ${e}`, 'error'))
                  setMenu(null)
                }}
              >
                在浏览器中打开
              </div>
              <div className="menu-separator" />
            </>
          )}
          {normalizedMail && (
            <>
              <div
                className="menu-item"
                onClick={() => {
                  invoke('open_url', { url: normalizedMail }).catch((e) => showToast(`打开失败: ${e}`, 'error'))
                  setMenu(null)
                }}
              >
                发送邮件
              </div>
              <div className="menu-separator" />
            </>
          )}
          {selectedText.trim() && (
            <>
              <div className="menu-item" onClick={() => { copySelection(selectedText); setMenu(null) }}>
                复制选中文本
              </div>
              <div className="menu-separator" />
            </>
          )}
          <div className="menu-item" onClick={() => { togglePin(); setMenu(null) }}>
            {note.is_pinned ? '取消置顶' : '置顶'}
          </div>
          <div className="menu-item" onClick={() => { changeStyle('glass'); setMenu(null) }}>
            毛玻璃 {note.window_style === 'glass' ? '✓' : ''}
          </div>
          <div className="menu-item" onClick={() => { changeStyle('solid'); setMenu(null) }}>
            纯色 {note.window_style === 'solid' ? '✓' : ''}
          </div>
          <div className="menu-item" onClick={() => { changeStyle('gradient'); setMenu(null) }}>
            渐变 {note.window_style === 'gradient' ? '✓' : ''}
          </div>
          <div className="menu-item danger" onClick={() => { deleteNote(); setMenu(null) }}>删除</div>
          <div className="menu-separator" />
          <div className="menu-label">透明度</div>
          <input
            type="range"
            className="menu-opacity"
            min="15"
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

      <ToastHost />
      <ConfirmDialogHost />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <NoteApp />
  </StrictMode>,
)

export default NoteApp
