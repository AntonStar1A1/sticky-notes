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
}

export type SortMode = 'updated' | 'created' | 'title' | 'custom'
