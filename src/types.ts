export interface Category {
  id: number
  name: string
  created_at: string
}

export interface Note {
  id: number
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
  created_at: string
  updated_at: string
}

export interface TodoItem {
  id: number
  note_id: number
  content: string
  is_done: boolean
  sort_order: number
}

export interface ContextMenu {
  x: number
  y: number
  noteId: number | null
}
