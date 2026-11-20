// 番茄钟数据接口:全部走 Rust 命令落 SQLite。
// 非 Tauri 环境(浏览器里直接打开 pomodoro.html 做界面预览)退回内存实现,便于调样式。
import { invoke } from '@tauri-apps/api/core'
import type { PomodoroLap, PomodoroMode, PomodoroSession, PomodoroStats } from '../types'

export interface PomoApi {
  /** 打开/唤起独立的番茄钟窗口(主界面与托盘入口用) */
  open(): Promise<void>
  /** 当前进行中的会话(重开窗口/重启应用后恢复计时) */
  active(): Promise<PomodoroSession | null>
  start(mode: PomodoroMode, targetMs: number, day: string, startedAtMs: number): Promise<PomodoroSession>
  pause(id: number, accruedMs: number): Promise<void>
  resume(id: number, runSinceMs: number): Promise<void>
  addLap(sessionId: number, label: string, lapMs: number, totalMs: number, atMs: number): Promise<PomodoroLap>
  renameLap(id: number, label: string): Promise<void>
  deleteLap(id: number): Promise<void>
  finish(id: number, elapsedMs: number, completed: boolean, finishedAtMs: number): Promise<void>
  discard(id: number): Promise<void>
  laps(sessionId: number): Promise<PomodoroLap[]>
  history(limit: number): Promise<PomodoroSession[]>
  deleteSession(id: number): Promise<void>
  stats(): Promise<PomodoroStats>
}

export const isTauriRuntime =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const tauriApi: PomoApi = {
  open: () => invoke('open_pomodoro'),
  active: () => invoke('pomodoro_active'),
  start: (mode, targetMs, day, startedAtMs) =>
    invoke('pomodoro_start', { mode, targetMs, day, startedAtMs }),
  pause: (id, accruedMs) => invoke('pomodoro_pause', { id, accruedMs }),
  resume: (id, runSinceMs) => invoke('pomodoro_resume', { id, runSinceMs }),
  addLap: (sessionId, label, lapMs, totalMs, atMs) =>
    invoke('pomodoro_add_lap', { sessionId, label, lapMs, totalMs, atMs }),
  renameLap: (id, label) => invoke('pomodoro_rename_lap', { id, label }),
  deleteLap: (id) => invoke('pomodoro_delete_lap', { id }),
  finish: (id, elapsedMs, completed, finishedAtMs) =>
    invoke('pomodoro_finish', { id, elapsedMs, completed, finishedAtMs }),
  discard: (id) => invoke('pomodoro_discard', { id }),
  laps: (sessionId) => invoke('pomodoro_laps', { sessionId }),
  history: (limit) => invoke('pomodoro_history', { limit }),
  deleteSession: (id) => invoke('pomodoro_delete_session', { id }),
  stats: () => invoke('pomodoro_stats'),
}

let implPromise: Promise<PomoApi> | null = null

function resolveApi(): Promise<PomoApi> {
  if (!implPromise) {
    // 生产构建或 Tauri 运行时:只用真实命令;仅 DEV 浏览器预览才加载内存实现
    implPromise =
      isTauriRuntime || !import.meta.env.DEV
        ? Promise.resolve(tauriApi)
        : import('./mockBackend').then((m) => m.createMockApi())
  }
  return implPromise
}

/**
 * 延迟解析的接口代理:调用点可以直接 `pomo.start(...)`,
 * 首个调用时才决定走 Tauri 命令还是浏览器预览实现。
 */
export const pomo: PomoApi = new Proxy({} as PomoApi, {
  get(_target, key) {
    if (key === 'then') return undefined // 别让 Promise 链把代理当 thenable
    return async (...args: unknown[]) => {
      const api = await resolveApi()
      const fn = (api as unknown as Record<string, unknown>)[String(key)]
      if (typeof fn !== 'function') throw new Error(`番茄钟接口不存在: ${String(key)}`)
      return (fn as (...a: unknown[]) => Promise<unknown>).apply(api, args)
    }
  },
})
