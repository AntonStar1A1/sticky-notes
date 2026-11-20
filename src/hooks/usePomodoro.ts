// 番茄钟计时引擎:全部时间以毫秒墙上时钟计算,不使用「每秒自增」累加,
// 因此窗口隐藏、渲染节流、系统休眠都不会让计时漂移。
//
// 会话在 SQLite 里只存两个字段:
//   elapsed_ms   —— 之前各运行段的累计
//   run_since_ms —— 当前运行段的起点
// 实际用时 = elapsed_ms + (now - run_since_ms)。暂停时把累计写回并清空起点,
// 继续时重置起点。这样隐藏窗口、甚至重启应用后重开,计时都能无缝续上。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PomodoroLap, PomodoroMode, PomodoroSession } from '../types'
import { pomo } from '../pomodoro/api'
import { fmtDayKey } from '../pomodoro/format'

export type PomoPhase = 'idle' | 'running' | 'paused'

export interface PomoFinishInfo {
  sessionId: number
  /** 是否真的存了历史(过短且没有节点会被丢弃) */
  saved: boolean
  elapsedMs: number
  laps: number
  completed: boolean
}

export interface PomodoroEngine {
  phase: PomoPhase
  mode: PomodoroMode
  targetMs: number
  sessionId: number | null
  startedAtMs: number | null
  laps: PomodoroLap[]
  /** 当前会话累计毫秒(运行中含当前段) */
  elapsedMs: number
  /** 倒计时剩余毫秒;正计时返回 0 */
  remainingMs: number
  /** 环形进度 0..1 */
  progress: number
  ready: boolean
  start(opts?: { mode?: PomodoroMode; targetMs?: number }): void
  toggle(): void
  addLap(): Promise<PomodoroLap | null>
  finish(opts?: { completed?: boolean }): Promise<PomoFinishInfo | null>
  reset(): Promise<void>
  setMode(mode: PomodoroMode): void
  setTargetMs(ms: number): void
  renameLap(id: number, label: string): Promise<void>
  deleteLap(id: number): Promise<void>
}

/** 少于该时长且没有节点的会话视为空跑,结束时不落库(与「空便签关闭即删」同一原则) */
const EMPTY_THRESHOLD_MS = 30_000

export function usePomodoro(opts: { mode: PomodoroMode; targetMs: number }): PomodoroEngine {
  const initial = useRef(opts)
  const [phase, setPhase] = useState<PomoPhase>('idle')
  const [mode, setModeState] = useState<PomodoroMode>(opts.mode)
  const [targetMs, setTargetMsState] = useState(opts.targetMs)
  const [accruedMs, setAccruedMs] = useState(0)
  const [runSinceMs, setRunSinceMs] = useState<number | null>(null)
  const [tick, setTick] = useState(() => Date.now())
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null)
  const [laps, setLaps] = useState<PomodoroLap[]>([])
  const [ready, setReady] = useState(false)

  const elapsedMs =
    phase === 'running' && runSinceMs !== null
      ? accruedMs + Math.max(0, tick - runSinceMs)
      : accruedMs

  const elapsedRef = useRef(elapsedMs)
  elapsedRef.current = elapsedMs
  const lapsRef = useRef(laps)
  lapsRef.current = laps
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  const modeRef = useRef(mode)
  modeRef.current = mode
  const targetRef = useRef(targetMs)
  targetRef.current = targetMs
  // 连续点击「开始」时只认最后一次建会话结果,避免较早的响应把已作废的 id 写回来
  const startToken = useRef(0)

  // 运行中每 200ms 重算一次(只在 running 时开定时器,暂停/空闲零开销)
  useEffect(() => {
    if (phase !== 'running') return
    const id = window.setInterval(() => setTick(Date.now()), 200)
    return () => window.clearInterval(id)
  }, [phase])

  // 恢复上次未结束的会话(窗口重开、应用重启后接着计时)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const active: PomodoroSession | null = await pomo.active()
        if (!alive || !active) return
        const savedLaps = await pomo.laps(active.id)
        if (!alive) return
        setSessionId(active.id)
        setStartedAtMs(active.started_at_ms)
        setModeState(active.mode)
        setTargetMsState(active.target_ms || initial.current.targetMs)
        setAccruedMs(active.elapsed_ms)
        setLaps(savedLaps)
        if (active.run_since_ms !== null) {
          setRunSinceMs(active.run_since_ms)
          setTick(Date.now())
          setPhase('running')
        } else {
          setPhase('paused')
        }
      } catch (e) {
        console.error('恢复番茄钟会话失败:', e)
      } finally {
        if (alive) setReady(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const start = useCallback((options?: { mode?: PomodoroMode; targetMs?: number }) => {
    const nextMode = options?.mode ?? mode
    const nextTarget = options?.targetMs ?? targetMs
    const at = Date.now()
    // 先本地进入运行态(点击即响应),落库在后台完成
    setSessionId(null)
    setModeState(nextMode)
    setTargetMsState(nextTarget)
    setAccruedMs(0)
    setRunSinceMs(at)
    setStartedAtMs(at)
    setTick(at)
    setLaps([])
    setPhase('running')
    void (async () => {
      const token = ++startToken.current
      try {
        const session = await pomo.start(nextMode, nextMode === 'down' ? nextTarget : 0, fmtDayKey(at), at)
        if (token === startToken.current) setSessionId(session.id)
      } catch (e) {
        console.error('开始计时失败:', e)
        if (token === startToken.current) {
          setPhase('idle')
          setRunSinceMs(null)
        }
      }
    })()
  }, [mode, targetMs])

  const pause = useCallback(() => {
    const id = sessionRef.current
    const total = elapsedRef.current
    setAccruedMs(total)
    setRunSinceMs(null)
    setPhase('paused')
    if (id !== null) void pomo.pause(id, total).catch((e) => console.error('暂停落库失败:', e))
  }, [])

  const resume = useCallback(() => {
    const id = sessionRef.current
    const at = Date.now()
    setRunSinceMs(at)
    setTick(at)
    setPhase('running')
    if (id !== null) void pomo.resume(id, at).catch((e) => console.error('继续落库失败:', e))
  }, [])

  const toggle = useCallback(() => {
    if (phaseRef.current === 'running') pause()
    else if (phaseRef.current === 'paused') resume()
    else start()
  }, [pause, resume, start])

  const resetLocal = useCallback(() => {
    setPhase('idle')
    setSessionId(null)
    setStartedAtMs(null)
    setAccruedMs(0)
    setRunSinceMs(null)
    setLaps([])
  }, [])

  const finish = useCallback(
    async (options?: { completed?: boolean }): Promise<PomoFinishInfo | null> => {
      const id = sessionRef.current
      const raw = elapsedRef.current
      // 倒计时不会「超时计费」:窗口关掉很久再回来,归档按目标时长封顶
      const total = modeRef.current === 'down' ? Math.min(raw, Math.max(0, targetRef.current)) : raw
      const lapCount = lapsRef.current.length
      const finishedAt = Date.now()
      const completed = options?.completed ?? false
      const empty = total < EMPTY_THRESHOLD_MS && lapCount === 0
      resetLocal()
      if (id === null) return null
      try {
        if (empty) await pomo.discard(id)
        else await pomo.finish(id, total, completed, finishedAt)
      } catch (e) {
        console.error('结束计时失败:', e)
      }
      return { sessionId: id, saved: !empty, elapsedMs: total, laps: lapCount, completed }
    },
    [resetLocal],
  )

  const reset = useCallback(async () => {
    const id = sessionRef.current
    resetLocal()
    if (id !== null) {
      try {
        await pomo.discard(id)
      } catch (e) {
        console.error('重置会话失败:', e)
      }
    }
  }, [resetLocal])

  const addLap = useCallback(async (): Promise<PomodoroLap | null> => {
    const id = sessionRef.current
    if (id === null || phaseRef.current === 'idle') return null
    const total = elapsedRef.current
    const prevTotal = lapsRef.current.length ? lapsRef.current[lapsRef.current.length - 1].total_ms : 0
    const lapMs = Math.max(0, total - prevTotal)
    const at = Date.now()
    const label = `节点 ${lapsRef.current.length + 1}`
    try {
      const lap = await pomo.addLap(id, label, lapMs, total, at)
      setLaps((prev) => [...prev, lap])
      return lap
    } catch (e) {
      console.error('打点失败:', e)
      return null
    }
  }, [])

  const renameLap = useCallback(async (id: number, label: string) => {
    const text = label.trim()
    setLaps((prev) => prev.map((l) => (l.id === id ? { ...l, label: text } : l)))
    try {
      await pomo.renameLap(id, text)
    } catch (e) {
      console.error('重命名节点失败:', e)
    }
  }, [])

  const deleteLap = useCallback(async (id: number) => {
    setLaps((prev) => prev.filter((l) => l.id !== id).map((l, i) => ({ ...l, idx: i + 1 })))
    try {
      await pomo.deleteLap(id)
    } catch (e) {
      console.error('删除节点失败:', e)
    }
  }, [])

  const setMode = useCallback((next: PomodoroMode) => {
    if (phaseRef.current !== 'idle') return // 计时中切换模式会污染当前会话
    setModeState(next)
  }, [])

  const setTargetMs = useCallback((ms: number) => {
    setTargetMsState(Math.max(60_000, Math.round(ms)))
  }, [])

  const remainingMs = mode === 'down' ? Math.max(0, targetMs - elapsedMs) : 0
  // 正计时没有终点,环形进度用「以目标时长为周期的循环」表达,不额外引入概念
  const progress = useMemo(() => {
    const cycle = Math.max(60_000, mode === 'down' ? targetMs : targetMs || 25 * 60_000)
    if (mode === 'down') return Math.min(1, elapsedMs / cycle)
    return (elapsedMs % cycle) / cycle
  }, [mode, targetMs, elapsedMs])

  return {
    phase,
    mode,
    targetMs,
    sessionId,
    startedAtMs,
    laps,
    elapsedMs,
    remainingMs,
    progress,
    ready,
    start,
    toggle,
    addLap,
    finish,
    reset,
    setMode,
    setTargetMs,
    renameLap,
    deleteLap,
  }
}
