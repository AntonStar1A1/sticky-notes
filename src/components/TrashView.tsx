import { useMemo, useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Trash2, RotateCcw, XCircle, Sparkles, Info } from 'lucide-react'
import type { Note } from '../types'
import { showToast } from './Toast'
import { confirmDialog } from './ConfirmDialog'

interface Props {
  notes: Note[]
  onError: (msg: string) => void
  onRefresh: () => void
}

function relative(iso: string): string {
  if (!iso) return ''
  const normalized = iso.replace(' ', 'T') + 'Z'
  const date = new Date(normalized)
  const now = new Date()
  const diffMin = Math.floor((now.getTime() - date.getTime()) / 60000)
  if (diffMin < 1) return '刚刚'
  if (diffMin < 60) return `${diffMin}分钟前`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}小时前`
  const diffDay = Math.floor(diffHour / 24)
  if (diffDay === 1) return '昨天'
  if (diffDay < 30) return `${diffDay}天前`
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

/** 回收站(spec 7.10):软删除的便签保留 30 天,可恢复/彻底删除 */
export default function TrashView({ notes, onError, onRefresh }: Props) {
  const trashed = useMemo(
    () => notes.filter((n) => n.status === 'trashed').sort((a, b) => (b.trashed_at ?? '').localeCompare(a.trashed_at ?? '')),
    [notes],
  )

  // spec 7.11:首次进入回收站弹出提示,带「不再提示」复选框(记录在本地设置)
  const [showFirstHint, setShowFirstHint] = useState(false)
  const [neverAgain, setNeverAgain] = useState(false)
  useEffect(() => {
    if (localStorage.getItem('trashHintDismissed') !== 'true') {
      setShowFirstHint(true)
    }
  }, [])
  const dismissHint = useCallback(() => {
    if (neverAgain) localStorage.setItem('trashHintDismissed', 'true')
    setShowFirstHint(false)
  }, [neverAgain])

  const restore = useCallback(async (id: number) => {
    try {
      await invoke('restore_note', { id })
      showToast('已恢复便签', 'success')
    } catch (e) {
      onError(`恢复失败: ${e}`)
    }
  }, [onError])

  const purge = useCallback(async (note: Note) => {
    if (!(await confirmDialog({
      title: '彻底删除',
      message: `「${note.title || '（未命名）'}」将被永久删除,无法恢复。`,
      danger: true,
      confirmText: '彻底删除',
    }))) return
    try {
      await invoke('delete_note_forever', { id: note.id })
      showToast('已彻底删除', 'success')
    } catch (e) {
      onError(`删除失败: ${e}`)
    }
  }, [onError])

  const cleanExpired = useCallback(async () => {
    try {
      const n = await invoke<number>('auto_clean_trash')
      if (n > 0) {
        showToast(`已清理 ${n} 条超期便签`, 'success')
        onRefresh()
      } else {
        showToast('没有超期便签', 'info')
      }
    } catch (e) {
      onError(`清理失败: ${e}`)
    }
  }, [onError, onRefresh])

  return (
    <div className="trash-view">
      <div className="view-toolbar">
        <span className="view-title">回收站</span>
        <span className="view-meta">{trashed.length} 条</span>
      </div>
      <div className="trash-hint">
        <Info size={12} />
        删除的便签在此保留 30 天,到期自动清理
        <button className="btn btn-ghost btn-sm" onClick={cleanExpired} title="立即清理超过 30 天的便签">
          立即清理超期
        </button>
      </div>
      {trashed.length === 0 ? (
        <div className="view-empty">
          <Sparkles size={24} />
          <div>回收站为空</div>
          <div className="view-empty-sub">删除的便签会在这里保留 30 天,期间可随时恢复</div>
        </div>
      ) : (
        <div className="trash-list">

          {trashed.map((note) => (
            <div key={note.id} className="trash-card">
              <div className="trash-card-main">
                <div className="trash-card-title">{note.title || '（未命名）'}</div>
                <div className="trash-card-summary">
                  {note.content.split('\n').find((l) => l.trim()) || '（空白便签）'}
                </div>
                <div className="trash-card-meta">
                  <Trash2 size={10} /> {relative(note.trashed_at ?? '')}删除
                  {note.deleted_by === 'auto_clean' && <span className="trash-auto">· 自动清理</span>}
                </div>
              </div>
              <div className="trash-card-actions">
                <button className="icon-btn" title="恢复" onClick={() => restore(note.id)}>
                  <RotateCcw size={13} />
                </button>
                <button className="icon-btn danger" title="彻底删除" onClick={() => purge(note)}>
                  <XCircle size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showFirstHint && (
        <div className="confirm-overlay" onClick={dismissHint}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">回收站提示</div>
            <div className="confirm-message">回收站中的便签将在 30 天后自动彻底删除,删除后无法恢复。</div>
            <label className="hint-checkbox">
              <input
                type="checkbox"
                checked={neverAgain}
                onChange={(e) => setNeverAgain(e.target.checked)}
              />
              不再提示
            </label>
            <div className="confirm-actions">
              <button className="btn btn-primary" onClick={dismissHint}>知道了</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
