export interface Category {
  id: number
  name: string
  is_system: boolean
  sort_order: number
  created_at: string
}

export type NoteStatus = 'active' | 'trashed' | 'permanently_deleted'
export type WindowStyle = 'glass' | 'solid' | 'gradient'

export interface Note {
  id: number
  uuid: string
  title: string
  content: string
  note_type: string
  category_id: number | null
  x: number
  y: number
  width: number
  height: number
  opacity: number
  is_pinned: boolean
  color: string
  sort_order: number
  window_style: WindowStyle
  status: NoteStatus
  deleted_by: string | null
  trashed_at: string | null
  created_at: string
  updated_at: string
}

export interface TodoItem {
  id: number
  note_id: number
  content: string
  is_done: boolean
  sort_order: number
  completed_at: string | null
}

export interface TimelineEntry {
  id: string
  note_id: string | null
  note_title: string | null
  action: string
  field_changes: string | null
  note_snapshot: string | null
  category_id: number | null
  category_name: string | null
  attachment_name: string | null
  todo_content: string | null
  device_id: string | null
  created_at: string
}

export interface Attachment {
  id: number
  note_id: number
  file_name: string
  file_path: string
  file_size: number
  file_type: string
  created_at: string
}

export interface ShortcutInfo {
  kind: string
  keys: string
  registered: boolean
}

export interface PrivacyStatus {
  has_password: boolean
  questions: string[]
}

export interface ContextMenu {
  x: number
  y: number
  noteId: number | null
  categoryId: number | null
  // 下方放不下时底部锚定:菜单底边贴鼠标,展开分组列表向上生长不溢出
  fromBottom: boolean
}

export type SortMode = 'updated' | 'created' | 'title' | 'custom'

// ============ 番茄钟 ============

/** 计时模式:up 正计时(秒表) / down 倒计时(番茄) */
export type PomodoroMode = 'up' | 'down'

export interface PomodoroSession {
  id: number
  uuid: string
  title: string
  mode: PomodoroMode
  /** 倒计时目标毫秒数;正计时为 0 */
  target_ms: number
  /** 已累计毫秒(不含当前运行段) */
  elapsed_ms: number
  /** 当前运行段起点(墙上时钟毫秒);暂停时为 null */
  run_since_ms: number | null
  status: 'active' | 'done'
  /** 倒计时是否走完 */
  completed: boolean
  lap_count: number
  /** 本地日期 YYYY-MM-DD,用于按天分组统计 */
  day: string
  started_at_ms: number
  finished_at_ms: number | null
}

export interface PomodoroLap {
  id: number
  session_id: number
  idx: number
  label: string
  /** 距上一节点的用时 */
  lap_ms: number
  /** 打点瞬间的会话累计用时 */
  total_ms: number
  /** 打点瞬间的墙上时钟 */
  at_ms: number
}

export interface PomodoroStats {
  today_ms: number
  today_sessions: number
  today_completed: number
  today_laps: number
  week_ms: number
  total_ms: number
  total_sessions: number
}
