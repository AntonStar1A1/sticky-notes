import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { PomodoroLap } from '../../types'
import type { PomoPhase } from '../../hooks/usePomodoro'
import { fmtHm, fmtSpan } from '../../pomodoro/format'

interface Props {
  laps: PomodoroLap[]
  /** 当前会话累计毫秒,用于算「正在进行的这一段」 */
  elapsedMs: number
  /**
   * 计时状态。running 时末行是「进行中」的实时节点;paused 时同一行冻结为「已暂停」,
   * 保证暂停后当前这一段仍然看得见(此前暂停会把未打点的这一段整行藏掉);idle 不显示。
   */
  phase: PomoPhase
  onRename: (id: number, label: string) => void
  onDelete: (id: number) => void
}

/** 节点列表:每打一次点记一段,显示段内用时 / 累计 / 打点时刻;末行是尚未打点的那一段 */
export default function LapList({ laps, elapsedMs, phase, onRename, onDelete }: Props) {
  const listRef = useRef<HTMLUListElement>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const showPending = phase !== 'idle'
  const pendingPaused = phase === 'paused'

  // 新节点出现 / 暂停态切换时滚到底部,始终能看到最新一段
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [laps.length, showPending, pendingPaused])

  useEffect(() => {
    if (editingId !== null) inputRef.current?.select()
  }, [editingId])

  const lastTotal = laps.length ? laps[laps.length - 1].total_ms : 0
  const liveMs = Math.max(0, elapsedMs - lastTotal)

  const commit = () => {
    if (editingId === null) return
    const text = draft.trim()
    if (text) onRename(editingId, text)
    setEditingId(null)
  }

  return (
    <ul className="lap-list" ref={listRef}>
      {laps.map((lap) => (
        <li key={lap.id} className="lap-row">
          <span className="lap-idx">{lap.idx}</span>
          <div className="lap-body">
            {editingId === lap.id ? (
              <input
                ref={inputRef}
                className="lap-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <button
                type="button"
                className="lap-label"
                onClick={() => {
                  setEditingId(lap.id)
                  setDraft(lap.label)
                }}
                title="点击重命名节点"
              >
                {lap.label || `节点 ${lap.idx}`}
              </button>
            )}
            <span className="lap-meta">
              {fmtHm(lap.at_ms)} 打点 · 累计 {fmtSpan(lap.total_ms)}
            </span>
          </div>
          <span className="lap-dur">{fmtSpan(lap.lap_ms)}</span>
          <button
            type="button"
            className="lap-del"
            onClick={() => onDelete(lap.id)}
            title="删除节点"
            aria-label={`删除节点 ${lap.idx}`}
          >
            <X size={11} />
          </button>
        </li>
      ))}

      {showPending && (
        <li className={`lap-row lap-live${pendingPaused ? ' lap-live-paused' : ''}`}>
          <span className="lap-idx">
            <span className="lap-live-dot" />
          </span>
          <div className="lap-body">
            <span className="lap-label">节点 {laps.length + 1}</span>
            <span className="lap-meta">
              {pendingPaused ? '已暂停' : '进行中'} · 累计 {fmtSpan(elapsedMs)}
            </span>
          </div>
          <span className="lap-dur">{fmtSpan(liveMs)}</span>
          <span className="lap-del lap-del-ghost" aria-hidden="true" />
        </li>
      )}
    </ul>
  )
}
