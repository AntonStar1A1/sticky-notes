import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import {
  Plus, Pencil, Trash2, RotateCcw, Pin, PinOff, FolderInput, CheckCircle2,
  Circle, Paperclip, Unlink, History, Search, Eye, Filter, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp,
} from 'lucide-react'
import type { TimelineEntry } from '../types'

interface Props {
  entries: TimelineEntry[]
  onOpenNote: (id: number) => void
  /** 返回便签列表视图 */
  onBack: () => void
}

type Range = 'today' | 'week' | 'month' | 'all'
const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
]

/** 筛选面板选项(spec 7.13:新建/修改/删除,可多选) */
const FILTER_OPTIONS: { key: string; label: string; actions: string[] }[] = [
  { key: 'create', label: '新建', actions: ['create'] },
  { key: 'update', label: '修改', actions: ['update'] },
  { key: 'delete', label: '删除', actions: ['delete'] },
  { key: 'restore', label: '恢复', actions: ['restore'] },
  { key: 'pin', label: '置顶', actions: ['pin', 'unpin'] },
  { key: 'move', label: '移动', actions: ['move'] },
  { key: 'complete', label: '完成', actions: ['complete', 'uncomplete'] },
  { key: 'attach', label: '附件', actions: ['attach', 'detach'] },
]

const ACTION_META: Record<string, { icon: ReactNode; label: string }> = {
  create: { icon: <Plus size={11} />, label: '新建便签' },
  update: { icon: <Pencil size={11} />, label: '编辑便签' },
  delete: { icon: <Trash2 size={11} />, label: '删除便签' },
  restore: { icon: <RotateCcw size={11} />, label: '恢复便签' },
  pin: { icon: <Pin size={11} />, label: '置顶' },
  unpin: { icon: <PinOff size={11} />, label: '取消置顶' },
  move: { icon: <FolderInput size={11} />, label: '移动到分类' },
  complete: { icon: <CheckCircle2 size={11} />, label: '完成待办' },
  uncomplete: { icon: <Circle size={11} />, label: '取消完成待办' },
  attach: { icon: <Paperclip size={11} />, label: '添加附件' },
  detach: { icon: <Unlink size={11} />, label: '移除附件' },
}

function fmtTime(iso: string): string {
  const normalized = iso.replace(' ', 'T') + 'Z'
  const d = new Date(normalized)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 日分组标签(spec 7.13:今天/昨天/M月D日) */
function dayLabel(iso: string): string {
  const normalized = iso.replace(' ', 'T') + 'Z'
  const d = new Date(normalized)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfToday - startOfDay) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

interface Snapshot {
  title: string
  content: string
  category_id: number | null
  deleted_by: string | null
  created_at: string
  updated_at: string
}

/** 时间轴视图(spec 7.13):记录便签创建/编辑/删除/置顶/移动/完成/附件等操作 */
export default function TimelineView({ entries, onOpenNote, onBack }: Props) {
  const [range, setRange] = useState<Range>('all')
  const [selected, setSelected] = useState<string[]>([])
  const [filterOpen, setFilterOpen] = useState(false)
  const [search, setSearch] = useState('')
  // 每页条数设置保存在本地,默认 50(spec 7.13)
  const [pageSize, setPageSize] = useState(() => {
    const saved = localStorage.getItem('timelinePageSize')
    const n = saved ? Number(saved) : 50
    return [20, 50, 100].includes(n) ? n : 50
  })
  const [page, setPage] = useState(0)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  // spec 7.13:勾选/取消待办项的时间轴条目默认折叠,点击展开
  const [expandedTodoIds, setExpandedTodoIds] = useState<Set<string>>(new Set())
  const filterRef = useRef<HTMLDivElement>(null)

  const toggleExpandedTodo = useCallback((id: string) => {
    setExpandedTodoIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // 点击筛选面板外关闭
  useEffect(() => {
    if (!filterOpen) return
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) setFilterOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [filterOpen])

  const filtered = useMemo(() => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    const dayMs = 86400000
    const weekStart = startOfToday - ((now.getDay() + 6) % 7) * dayMs // 周一
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

    const kw = search.trim().toLowerCase()
    const inRange = (t: number) => {
      switch (range) {
        case 'today': return t >= startOfToday
        case 'week': return t >= weekStart
        case 'month': return t >= monthStart
        default: return true
      }
    }
    // 多选筛选:所选类型映射为具体 action 集合
    const allowed = selected.length === 0
      ? null
      : new Set(selected.flatMap((key) => FILTER_OPTIONS.find((o) => o.key === key)?.actions ?? []))
    return entries.filter((e) => {
      const t = new Date(e.created_at.replace(' ', 'T') + 'Z').getTime()
      if (!inRange(t)) return false
      if (allowed && !allowed.has(e.action)) return false
      if (kw) {
        const hay = [
          e.note_title ?? '',
          e.category_name ?? '',
          e.attachment_name ?? '',
          e.todo_content ?? '',
          e.action,
        ].join(' ').toLowerCase()
        if (!hay.includes(kw)) return false
      }
      return true
    })
  }, [entries, range, selected, search])

  // 分页后按天分组(spec 7.13:今天/昨天分组头)
  const grouped = useMemo(() => {
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
    const pageClamped = Math.min(page, pages - 1)
    const paged = filtered.slice(pageClamped * pageSize, (pageClamped + 1) * pageSize)
    const groups: { label: string; items: TimelineEntry[] }[] = []
    for (const e of paged) {
      const label = dayLabel(e.created_at)
      const last = groups[groups.length - 1]
      if (last && last.label === label) last.items.push(e)
      else groups.push({ label, items: [e] })
    }
    return groups
  }, [filtered, pageSize, page])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageClamped = Math.min(page, pages - 1)

  const changeRange = useCallback((r: Range) => {
    setRange(r)
    setPage(0)
  }, [])
  const toggleAction = useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    setPage(0)
  }, [])
  const changePageSize = useCallback((n: number) => {
    setPageSize(n)
    localStorage.setItem('timelinePageSize', String(n))
    setPage(0)
  }, [])

  // 分页导航: 1 2 3 ... N(spec 7.13)
  const pageButtons = useMemo(() => {
    const nums: (number | '...')[] = []
    for (let i = 1; i <= pages; i++) {
      if (pages <= 7 || i === 1 || i === pages || Math.abs(i - (pageClamped + 1)) <= 1) nums.push(i)
      else if (nums[nums.length - 1] !== '...') nums.push('...')
    }
    return nums
  }, [pages, pageClamped])

  const detail = (e: TimelineEntry): string[] => {
    const parts: string[] = []
    if (e.field_changes) {
      try {
        const changes = JSON.parse(e.field_changes)
        for (const [k, v] of Object.entries(changes)) {
          const { old: o, new: n } = v as { old: unknown; new: unknown }
          const label = k === 'title' ? '标题' : k === 'content' ? '内容' : k === 'category' ? '分类' : k
          parts.push(`${label}: ${o} → ${n}`)
        }
      } catch {
        /* 忽略损坏的 JSON */
      }
    }
    if (e.todo_content) parts.push(`待办: ${e.todo_content}`)
    if (e.attachment_name) parts.push(`文件: ${e.attachment_name}`)
    if (e.category_name && e.action === 'create') parts.push(`分类: ${e.category_name}`)
    return parts
  }

  const openSnapshot = (e: TimelineEntry) => {
    if (!e.note_snapshot) return
    try {
      setSnapshot(JSON.parse(e.note_snapshot))
    } catch {
      /* 忽略 */
    }
  }

  // 待办勾选/取消:主文案为「完成了/取消完成待办内容」(spec 7.13)
  const isTodoAction = (e: TimelineEntry) => e.action === 'complete' || e.action === 'uncomplete'

  return (
    <div className="timeline-view">
      <div className="view-toolbar">
        <div className="view-toolbar-left">
          <button className="back-btn" onClick={onBack} title="返回便签列表">
            <ChevronLeft size={12} /> 返回
          </button>
          <span className="view-title">时间轴</span>
        </div>
        <span className="view-meta">{filtered.length} 条记录</span>
      </div>

      <div className="timeline-filters">
        <div className="timeline-range">
          {RANGES.map((r) => (
            <button key={r.key} className={`chip ${range === r.key ? 'active' : ''}`} onClick={() => changeRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="timeline-second">
          <div className="timeline-filter" ref={filterRef}>
            <button
              className={`filter-btn ${selected.length > 0 ? 'active' : ''}`}
              onClick={() => setFilterOpen((o) => !o)}
              title="按操作类型筛选"
            >
              <Filter size={11} /> 筛选{selected.length > 0 ? `(${selected.length})` : ''}
            </button>
            {filterOpen && (
              <div className="filter-panel">
                {FILTER_OPTIONS.map((o) => (
                  <label key={o.key} className="filter-option">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.key)}
                      onChange={() => toggleAction(o.key)}
                    />
                    {o.label}
                  </label>
                ))}
                {selected.length > 0 && (
                  <div className="filter-clear" onClick={() => { setSelected([]); setPage(0) }}>清除筛选</div>
                )}
              </div>
            )}
          </div>
          <div className="timeline-search">
            <Search size={11} />
            <input
              placeholder="搜索…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(0)
              }}
            />
          </div>
        </div>
      </div>

      <div className="timeline-list">
        {grouped.length === 0 ? (
          <div className="view-empty">
            <History size={24} />
            <div>暂无记录</div>
          </div>
        ) : (
          grouped.map((g) => (
            <div key={g.label} className="timeline-day">
              <div className="timeline-day-label">{g.label}</div>
              {g.items.map((e) => {
                const meta = ACTION_META[e.action] ?? { icon: <Pencil size={11} />, label: e.action }
                const details = detail(e)
                return (
                  <div key={e.id} className="timeline-entry">
                    <div className="timeline-icon">{meta.icon}</div>
                    <div className="timeline-body">
                      <div className="timeline-row1">
                        {isTodoAction(e) && e.todo_content ? (
                          <span className="timeline-title">
                            {meta.label.replace('待办', '')}「{e.todo_content}」
                            {e.note_title && (
                              <span
                                className="timeline-note-link"
                                onClick={() => e.note_id && onOpenNote(Number(e.note_id))}
                                title="打开所属便签"
                              >
                                ({e.note_title})
                              </span>
                            )}
                          </span>
                        ) : (
                          <span
                            className={`timeline-title ${e.note_id ? 'link' : ''}`}
                            onClick={() => e.note_id && onOpenNote(Number(e.note_id))}
                            title={e.note_id ? '打开便签窗口' : undefined}
                          >
                            {e.note_title ?? meta.label}
                          </span>
                        )}
                        <span className="timeline-time">{fmtTime(e.created_at)}</span>
                        {e.device_id && (
                          <span className="timeline-device" title={`操作设备: ${e.device_id}`}>
                            #{e.device_id.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      {!isTodoAction(e) && <div className="timeline-action">{meta.label}</div>}
                      {details.length > 0 && isTodoAction(e) && (
                        <button className="timeline-detail-toggle" onClick={() => toggleExpandedTodo(e.id)}>
                          {expandedTodoIds.has(e.id) ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          {expandedTodoIds.has(e.id) ? '收起详情' : '详情'}
                        </button>
                      )}
                      {details.length > 0 && (!isTodoAction(e) || expandedTodoIds.has(e.id)) && (
                        <div className="timeline-details">
                          {details.map((d, i) => (
                            <div key={i} className="timeline-detail">{d}</div>
                          ))}
                        </div>
                      )}
                      {e.note_snapshot && (
                        <button className="timeline-snapshot-btn" onClick={() => openSnapshot(e)}>
                          <Eye size={10} /> 查看删除时快照
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>

      {filtered.length > 0 && (
        <div className="timeline-pager">
          <select className="select" value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
            {[20, 50, 100].map((s) => (
              <option key={s} value={s}>每页 {s} 条</option>
            ))}
          </select>
          <div className="pager-nav">
            <button className="pager-btn" disabled={pageClamped <= 0} onClick={() => setPage(pageClamped - 1)}>
              <ChevronLeft size={12} />
            </button>
            {pageButtons.map((n, i) => (
              n === '...' ? (
                <span key={`e${i}`} className="pager-ellipsis">…</span>
              ) : (
                <button
                  key={n}
                  className={`pager-btn num ${n === pageClamped + 1 ? 'active' : ''}`}
                  onClick={() => setPage(n - 1)}
                >
                  {n}
                </button>
              )
            ))}
            <button className="pager-btn" disabled={pageClamped >= pages - 1} onClick={() => setPage(pageClamped + 1)}>
              <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}

      {snapshot && (
        <div className="modal-overlay" onClick={() => setSnapshot(null)}>
          <div className="snapshot-box" onClick={(e) => e.stopPropagation()}>
            <div className="snapshot-header">
              <span>删除时快照</span>
              <button className="icon-btn" onClick={() => setSnapshot(null)}>✕</button>
            </div>
            <div className="snapshot-title">{snapshot.title || '（未命名）'}</div>
            <div className="snapshot-content">{snapshot.content || '（空白便签）'}</div>
            <div className="snapshot-meta">
              创建: {snapshot.created_at.replace('T', ' ').slice(0, 16)}
              {snapshot.deleted_by && <span className="trash-auto">· {snapshot.deleted_by === 'auto_clean' ? '自动清理' : '手动删除'}</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
