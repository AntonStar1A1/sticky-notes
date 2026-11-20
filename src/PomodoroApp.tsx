import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getCurrentWindow, LogicalSize, UserAttentionType } from '@tauri-apps/api/window'
import type { Window } from '@tauri-apps/api/window'
import {
  Flag, History, Maximize2, Minimize2, Minus, Pause, Pin, Play, RotateCcw, Square, X,
} from 'lucide-react'
import type { PomodoroLap, PomodoroMode, PomodoroSession, PomodoroStats } from './types'
import { loadTheme } from './theme'
import { isTauriRuntime, pomo } from './pomodoro/api'
import { loadPrefs, savePrefs } from './pomodoro/prefs'
import { chime } from './pomodoro/sound'
import { fmtClock, fmtDateLine, fmtHuman, fmtSpan } from './pomodoro/format'
import { usePomodoro } from './hooks/usePomodoro'
import { useNow } from './hooks/useNow'
import TimerRing from './components/pomodoro/TimerRing'
import LapList from './components/pomodoro/LapList'
import HistoryPanel from './components/pomodoro/HistoryPanel'
import TomatoMark from './components/pomodoro/TomatoMark'
import './PomodoroApp.css'

loadTheme()

// 浏览器里直接打开时没有 Tauri 宿主,窗口操作全部跳过(界面照常可用,便于调样式)
const win: Window | null = isTauriRuntime ? getCurrentWindow() : null

const MINI_WIDTH = 300
const MINI_HEIGHT = 132
const MINUTE = 60_000
const PRESETS = [5, 15, 25, 45, 60]

type View = 'timer' | 'history'

/** 独立窗口的番茄钟:正计时 / 倒计时 + 打点记录节点 + 历史归档 */
function PomodoroApp() {
  const prefsRef = useRef(loadPrefs())
  const initialPrefs = prefsRef.current

  const {
    phase, mode, targetMs, laps, elapsedMs, remainingMs, progress, ready, sessionId,
    startedAtMs, toggle, addLap, finish, reset, setMode, setTargetMs, renameLap, deleteLap,
  } = usePomodoro({ mode: initialPrefs.mode, targetMs: initialPrefs.targetMs })

  const [view, setView] = useState<View>('timer')
  const [history, setHistory] = useState<PomodoroSession[]>([])
  const [stats, setStats] = useState<PomodoroStats | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [pinned, setPinned] = useState(initialPrefs.pinned)
  // ?mini=1 直接以迷你模式启动(设计预览与快捷启动用)
  const [mini, setMini] = useState(() => new URLSearchParams(window.location.search).get('mini') === '1')
  const [confirmReset, setConfirmReset] = useState(false)

  const now = useNow(1000)
  const toastTimer = useRef<number | undefined>(undefined)
  const miniRef = useRef(mini)
  const completedGuard = useRef(false)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  // ---------- 数据 ----------

  const refreshHistory = useCallback(async () => {
    try {
      const [list, summary] = await Promise.all([pomo.history(200), pomo.stats()])
      setHistory(list)
      setStats(summary)
    } catch (e) {
      console.error('加载番茄钟历史失败:', e)
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHistory()
  }, [refreshHistory])

  const loadSessionLaps = useCallback((id: number): Promise<PomodoroLap[]> => pomo.laps(id), [])

  const deleteSession = useCallback(
    async (id: number) => {
      try {
        await pomo.deleteSession(id)
        setHistory((prev) => prev.filter((s) => s.id !== id))
        setStats(await pomo.stats())
      } catch (e) {
        console.error('删除记录失败:', e)
        showToast('删除失败')
      }
    },
    [showToast],
  )

  // ---------- 窗口 ----------

  // 恢复上次尺寸与置顶(迷你模式启动时直接用迷你尺寸)
  useEffect(() => {
    if (!win) return
    const p = prefsRef.current
    const miniStart = miniRef.current
    const width = miniStart ? MINI_WIDTH : p.width
    const height = miniStart ? MINI_HEIGHT : p.height
    void win.setSize(new LogicalSize(width, height)).catch(() => {})
    void win.setAlwaysOnTop(p.pinned).catch(() => {})
  }, [])

  // 记住尺寸(迷你模式下的尺寸不覆盖正常尺寸;挂载时的程序化 setSize 也不写回)
  useEffect(() => {
    if (!win) return
    const mountedAt = Date.now()
    let timer: number | undefined
    let unlisten: (() => void) | undefined
    let disposed = false
    void win
      .onResized(({ payload }) => {
        if (miniRef.current || Date.now() - mountedAt < 1200) return
        window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          void (async () => {
            try {
              const scale = await win.scaleFactor()
              const size = payload.toLogical(scale)
              savePrefs({ width: Math.round(size.width), height: Math.round(size.height) })
            } catch {
              /* 忽略 */
            }
          })()
        }, 400)
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      .catch(() => {})
    return () => {
      disposed = true
      window.clearTimeout(timer)
      unlisten?.()
    }
  }, [])

  const togglePin = useCallback(() => {
    const next = !pinned
    setPinned(next)
    savePrefs({ pinned: next })
    void win?.setAlwaysOnTop(next).catch(() => {})
  }, [pinned])

  const applyMini = useCallback((next: boolean) => {
    miniRef.current = next
    setMini(next)
    setView('timer')
    if (!win) return
    const p = prefsRef.current
    const width = next ? MINI_WIDTH : p.width
    const height = next ? MINI_HEIGHT : p.height
    void win.setSize(new LogicalSize(width, height)).catch(() => {})
  }, [])

  const focusWindow = useCallback(async () => {
    if (!win) return
    try {
      await win.show()
      await win.setFocus()
      await win.requestUserAttention(UserAttentionType.Critical)
      window.setTimeout(() => {
        void win.requestUserAttention(null).catch(() => {})
      }, 6000)
    } catch {
      /* 忽略 */
    }
  }, [])

  // ---------- 计时动作 ----------

  const handleFinish = useCallback(
    async (completed: boolean) => {
      const info = await finish({ completed })
      if (!info) {
        showToast('已重置计时')
        return
      }
      if (!info.saved) {
        showToast('时长过短且没有节点,未记录')
        return
      }
      showToast(
        completed
          ? `倒计时完成 🍅 ${fmtSpan(info.elapsedMs)} · ${info.laps} 个节点`
          : `已记录 ${fmtSpan(info.elapsedMs)} · ${info.laps} 个节点`,
      )
      void refreshHistory()
    },
    [finish, refreshHistory, showToast],
  )

  // 倒计时归零:自动收尾并存档,提示音 + 任务栏闪烁
  useEffect(() => {
    if (phase !== 'running' || mode !== 'down') {
      completedGuard.current = false
      return
    }
    if (remainingMs > 0 || completedGuard.current) return
    completedGuard.current = true
    chime()
    void focusWindow()
    void handleFinish(true)
  }, [phase, mode, remainingMs, handleFinish, focusWindow])

  const handleReset = useCallback(async () => {
    if (!confirmReset) {
      setConfirmReset(true)
      return
    }
    setConfirmReset(false)
    await reset()
    showToast('已重置计时')
  }, [confirmReset, reset, showToast])

  useEffect(() => {
    if (!confirmReset) return
    const id = window.setTimeout(() => setConfirmReset(false), 3000)
    return () => window.clearTimeout(id)
  }, [confirmReset])

  // 空闲时把当前模式与目标时长写回偏好(恢复会话时也会跟随该会话的设置)
  useEffect(() => {
    if (phase !== 'idle') return
    savePrefs({ mode, targetMs })
    prefsRef.current = { ...prefsRef.current, mode, targetMs }
  }, [phase, mode, targetMs])

  // 键盘:空格 开始/暂停 · L 打点 · H 历史 · Esc 收起迷你/隐藏窗口
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      if (e.code === 'Space') {
        e.preventDefault()
        toggle()
        return
      }
      const key = e.key.toLowerCase()
      if (key === 'l') {
        e.preventDefault()
        if (phase !== 'idle') void addLap()
        return
      }
      if (key === 'h') {
        e.preventDefault()
        if (miniRef.current) applyMini(false)
        else setView((prev) => (prev === 'history' ? 'timer' : 'history'))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (miniRef.current) applyMini(false)
        else if (view === 'history') setView('timer')
        else void win?.hide().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle, phase, addLap, applyMini, view])

  // 主题实时跟随(与其他窗口共享 localStorage)
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'sticky-theme') loadTheme()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // ---------- 派生展示值 ----------

  const running = phase === 'running'
  const displayMs = mode === 'down' ? remainingMs : elapsedMs
  // 倒计时向上取整(开始那一刻显示 25:00 而不是 24:59),正计时向下取整(满 1 秒才跳)
  const digits = useMemo(
    () => fmtSpan((mode === 'down' ? Math.ceil(displayMs / 1000) : Math.floor(displayMs / 1000)) * 1000),
    [mode, displayMs],
  )

  const phaseText = phase === 'running' ? '计时中' : phase === 'paused' ? '已暂停' : '待开始'
  const primaryLabel = phase === 'running' ? '暂停' : phase === 'paused' ? '继续' : '开始'
  const modeText = mode === 'down' ? `倒计时 · ${Math.round(targetMs / MINUTE)} 分钟` : '正计时'
  const hasSession = sessionId !== null || elapsedMs > 0 || laps.length > 0

  const rootClass = `pomo-root${mini ? ' mini' : ''}${running ? ' running' : ''}${phase === 'paused' ? ' paused' : ''}`

  if (!ready) {
    return (
      <div className="pomo-root">
        <div className="pomo-boot">载入中…</div>
      </div>
    )
  }

  return (
    <div className={rootClass}>
      <header
        className="pomo-bar"
        data-tauri-drag-region
        onDoubleClick={() => applyMini(!miniRef.current)}
      >
        <span className="pomo-brand" data-tauri-drag-region>
          <TomatoMark size={13} />
          <span data-tauri-drag-region>番茄钟</span>
        </span>
        <span className="pomo-now" title="当前时间">{fmtClock(now)}</span>
        <div className="pomo-win">
          <button
            type="button"
            className={`pomo-win-btn ${pinned ? 'on' : ''}`}
            onClick={togglePin}
            title={pinned ? '取消置顶' : '置顶'}
          >
            <Pin size={12} />
          </button>
          <button
            type="button"
            className="pomo-win-btn"
            onClick={() => applyMini(!mini)}
            title={mini ? '展开' : '迷你模式'}
          >
            {mini ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
          </button>
          <button
            type="button"
            className="pomo-win-btn"
            onClick={() => void win?.minimize().catch(() => {})}
            title="最小化"
          >
            <Minus size={12} />
          </button>
          <button
            type="button"
            className="pomo-win-btn close"
            onClick={() => void win?.hide().catch(() => {})}
            title="关闭"
          >
            <X size={12} />
          </button>
        </div>
      </header>

      {view === 'history' && !mini ? (
        <HistoryPanel
          history={history}
          stats={stats}
          loading={historyLoading}
          onBack={() => setView('timer')}
          onDelete={(id) => void deleteSession(id)}
          loadLaps={loadSessionLaps}
        />
      ) : (
        <>
          <div className="pomo-stage">
            <TimerRing progress={progress} phase={phase} size={mini ? 74 : 196}>
              <span className={`pomo-digits${mini ? ' compact' : ''}`}>{digits}</span>
              {!mini && <span className="pomo-phase">{phaseText}</span>}
              {mini && <span className="pomo-phase">{mode === 'down' ? '倒计时' : '正计时'}</span>}
            </TimerRing>

            {mini ? (
              <div className="pomo-mini-actions">
                <button
                  type="button"
                  className="pomo-mini-btn primary"
                  onClick={toggle}
                  title={primaryLabel}
                >
                  {running ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <button
                  type="button"
                  className="pomo-mini-btn"
                  onClick={() => void addLap()}
                  disabled={phase === 'idle'}
                  title="打点"
                >
                  <Flag size={14} />
                </button>
                <button
                  type="button"
                  className="pomo-mini-btn"
                  onClick={() => void handleFinish(false)}
                  disabled={phase === 'idle'}
                  title="结束并记录"
                >
                  <Square size={13} />
                </button>
              </div>
            ) : null}
          </div>

          {!mini && (
            <>
              <div className="pomo-date">
                <span>{fmtDateLine(now)}</span>
                <span className="pomo-date-sep">·</span>
                <span className="pomo-date-mode">{modeText}</span>
                {startedAtMs !== null && (
                  <>
                    <span className="pomo-date-sep">·</span>
                    <span>始于 {fmtClock(startedAtMs).slice(0, 5)}</span>
                  </>
                )}
              </div>

              <div className="pomo-modes">
                {(['up', 'down'] as PomodoroMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`pomo-mode ${mode === m ? 'active' : ''}`}
                    onClick={() => setMode(m)}
                    disabled={phase !== 'idle'}
                    title={phase === 'idle' ? undefined : '计时中不可切换模式,先结束或重置'}
                  >
                    {m === 'up' ? '正计时' : '倒计时'}
                  </button>
                ))}
              </div>

              {mode === 'down' ? (
                <div className="pomo-presets">
                  {PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      className={`pomo-preset ${Math.round(targetMs / MINUTE) === minutes ? 'active' : ''}`}
                      onClick={() => setTargetMs(minutes * MINUTE)}
                      disabled={phase !== 'idle'}
                    >
                      {minutes}
                      <span>分</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="pomo-presets placeholder" aria-hidden="true" />
              )}

              <div className="pomo-actions">
                <button type="button" className="pomo-btn primary" onClick={toggle}>
                  {running ? <Pause size={13} /> : <Play size={13} />}
                  <span>{primaryLabel}</span>
                </button>
                <button
                  type="button"
                  className="pomo-btn"
                  onClick={() => void addLap()}
                  disabled={phase === 'idle'}
                  title="打点:记录这一段用了多久(快捷键 L)"
                >
                  <Flag size={12} />
                  <span>打点</span>
                </button>
                <button
                  type="button"
                  className="pomo-btn"
                  onClick={() => void handleFinish(false)}
                  disabled={phase === 'idle'}
                  title="结束并归档这次计时"
                >
                  <Square size={11} />
                  <span>结束</span>
                </button>
                <button
                  type="button"
                  className={`pomo-icon-btn ${confirmReset ? 'confirm' : ''}`}
                  onClick={() => void handleReset()}
                  disabled={!hasSession}
                  title={confirmReset ? '再点一次确认重置' : '重置(丢弃这次计时)'}
                >
                  <RotateCcw size={12} />
                </button>
              </div>

              <div className="pomo-laps">
                <div className="pomo-laps-head">
                  <span>
                    节点 <b>{laps.length}</b>
                  </span>
                  <span className="pomo-laps-sum">累计 {fmtSpan(elapsedMs)}</span>
                </div>
                {laps.length === 0 && phase === 'idle' ? (
                  <div className="pomo-laps-empty">
                    开始计时后,按「打点」把过程切成节点
                    <span>每个节点会记录段内用时与打点时刻</span>
                  </div>
                ) : (
                  <LapList
                    laps={laps}
                    elapsedMs={elapsedMs}
                    live={running}
                    onRename={(id, label) => void renameLap(id, label)}
                    onDelete={(id) => void deleteLap(id)}
                  />
                )}
              </div>

              <footer className="pomo-foot">
                <span className="pomo-foot-stats">
                  今日 {fmtHuman(stats?.today_ms ?? 0)} · 番茄 {stats?.today_completed ?? 0} · 节点{' '}
                  {stats?.today_laps ?? 0}
                </span>
                <button
                  type="button"
                  className="pomo-foot-link"
                  onClick={() => {
                    setView('history')
                    void refreshHistory()
                  }}
                >
                  <History size={11} />
                  历史
                </button>
              </footer>
            </>
          )}
        </>
      )}

      {toast && <div className="pomo-toast">{toast}</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PomodoroApp />
  </StrictMode>,
)

export default PomodoroApp
