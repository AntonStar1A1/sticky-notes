import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import type { PomodoroLap, PomodoroSession, PomodoroStats } from '../../types'
import { fmtDayLabel, fmtHm, fmtHuman, fmtRange, fmtSpan } from '../../pomodoro/format'

interface Props {
  history: PomodoroSession[]
  stats: PomodoroStats | null
  loading: boolean
  onBack: () => void
  onDelete: (id: number) => void
  loadLaps: (sessionId: number) => Promise<PomodoroLap[]>
}

/** 历史记录:按天分组,展开可看当次会话的每个节点 */
export default function HistoryPanel({ history, stats, loading, onBack, onDelete, loadLaps }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [lapsCache, setLapsCache] = useState<Record<number, PomodoroLap[]>>({})
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const confirmTimer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(confirmTimer.current), [])

  const groups = useMemo(() => {
    const map = new Map<string, PomodoroSession[]>()
    for (const s of history) {
      const list = map.get(s.day)
      if (list) list.push(s)
      else map.set(s.day, [s])
    }
    return [...map.entries()]
  }, [history])

  const toggle = (id: number) => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next !== null && !lapsCache[next]) {
      void loadLaps(next)
        .then((laps) => setLapsCache((prev) => ({ ...prev, [next]: laps })))
        .catch((e) => console.error('加载节点失败:', e))
    }
  }

  const askDelete = (id: number) => {
    if (confirmId === id) {
      window.clearTimeout(confirmTimer.current)
      setConfirmId(null)
      onDelete(id)
      return
    }
    setConfirmId(id)
    window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => setConfirmId(null), 3000)
  }

  return (
    <div className="pomo-history">
      <div className="pomo-history-head">
        <button type="button" className="pomo-back" onClick={onBack} title="返回计时">
          <ChevronLeft size={14} />
          <span>历史记录</span>
        </button>
        <span className="pomo-history-total">
          共 {stats?.total_sessions ?? history.length} 次 · {fmtHuman(stats?.total_ms ?? 0)}
        </span>
      </div>

      <div className="pomo-stats">
        <div className="pomo-stat">
          <span className="pomo-stat-num">{fmtHuman(stats?.today_ms ?? 0)}</span>
          <span className="pomo-stat-label">今日专注</span>
        </div>
        <div className="pomo-stat">
          <span className="pomo-stat-num">{stats?.today_completed ?? 0}</span>
          <span className="pomo-stat-label">完成番茄</span>
        </div>
        <div className="pomo-stat">
          <span className="pomo-stat-num">{stats?.today_laps ?? 0}</span>
          <span className="pomo-stat-label">今日节点</span>
        </div>
      </div>

      <div className="pomo-history-body">
        {loading && <div className="pomo-empty">加载中…</div>}
        {!loading && history.length === 0 && (
          <div className="pomo-empty">
            还没有记录
            <span className="pomo-empty-hint">结束一次计时后,这里会按天归档</span>
          </div>
        )}
        {groups.map(([day, sessions]) => {
          const dayMs = sessions.reduce((sum, s) => sum + s.elapsed_ms, 0)
          return (
            <section key={day} className="pomo-day">
              <div className="pomo-day-head">
                <span className="pomo-day-label">{fmtDayLabel(day)}</span>
                <span className="pomo-day-meta">
                  {sessions.length} 次 · {fmtHuman(dayMs)}
                </span>
              </div>
              {sessions.map((s) => {
                const open = expandedId === s.id
                const laps = lapsCache[s.id]
                return (
                  <div key={s.id} className={`pomo-session ${open ? 'open' : ''}`}>
                    <div className="pomo-session-row">
                      <button
                        type="button"
                        className="pomo-session-main"
                        onClick={() => toggle(s.id)}
                        title={open ? '收起节点' : '展开节点'}
                      >
                        <ChevronRight size={12} className="pomo-session-caret" />
                        <span className="pomo-session-time">{fmtRange(s.started_at_ms, s.finished_at_ms)}</span>
                        <span className={`pomo-session-tag ${s.mode}`}>
                          {s.mode === 'down' ? (s.completed ? '番茄' : '倒计时') : '正计时'}
                        </span>
                        <span className="pomo-session-laps">{s.lap_count} 节点</span>
                        <span className="pomo-session-dur">{fmtSpan(s.elapsed_ms)}</span>
                      </button>
                      <button
                        type="button"
                        className={`pomo-session-del ${confirmId === s.id ? 'confirm' : ''}`}
                        onClick={() => askDelete(s.id)}
                        title={confirmId === s.id ? '再点一次确认删除' : '删除这条记录'}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                    {open && (
                      <div className="pomo-session-laps-list">
                        {!laps && <div className="pomo-session-lap-line">加载中…</div>}
                        {laps && laps.length === 0 && (
                          <div className="pomo-session-lap-line">这次没有打点</div>
                        )}
                        {laps?.map((lap) => (
                          <div key={lap.id} className="pomo-session-lap-line">
                            <span className="pomo-session-lap-idx">{lap.idx}</span>
                            <span className="pomo-session-lap-label">{lap.label || `节点 ${lap.idx}`}</span>
                            <span className="pomo-session-lap-at">{fmtHm(lap.at_ms)}</span>
                            <span className="pomo-session-lap-dur">{fmtSpan(lap.lap_ms)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
