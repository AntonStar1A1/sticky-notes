// 仅开发期使用:浏览器里直接打开 pomodoro.html 时的内存后端,
// 让界面/交互可以在没有 Tauri 宿主的场景下走查(数据存 localStorage,刷新不丢)。
import type { PomodoroLap, PomodoroMode, PomodoroSession, PomodoroStats } from '../types'
import type { PomoApi } from './api'
import { fmtDayKey } from './format'

interface MockDb {
  seq: number
  sessions: PomodoroSession[]
  laps: PomodoroLap[]
}

const KEY = 'pomodoro-mock-db'

function read(): MockDb {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb
      if (Array.isArray(parsed.sessions) && Array.isArray(parsed.laps)) return parsed
    }
  } catch {
    /* 损坏则重建 */
  }
  return { seq: 1, sessions: [], laps: [] }
}

function write(db: MockDb) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    /* 忽略配额错误 */
  }
}

function emptyStats(): PomodoroStats {
  return {
    today_ms: 0,
    today_sessions: 0,
    today_completed: 0,
    today_laps: 0,
    week_ms: 0,
    total_ms: 0,
    total_sessions: 0,
  }
}

export function createMockApi(): PomoApi {
  const db = read()

  const persist = () => write(db)
  const doneSessions = () => db.sessions.filter((s) => s.status === 'done')

  return {
    async open() {
      /* 浏览器预览没有独立窗口可开 */
    },

    async active() {
      return db.sessions.find((s) => s.status === 'active') ?? null
    },

    async start(mode: PomodoroMode, targetMs: number, day: string, startedAtMs: number) {
      db.sessions = db.sessions.filter((s) => s.status !== 'active')
      const session: PomodoroSession = {
        id: db.seq++,
        uuid: `mock-${db.seq}`,
        title: '',
        mode,
        target_ms: targetMs,
        elapsed_ms: 0,
        run_since_ms: startedAtMs,
        status: 'active',
        completed: false,
        lap_count: 0,
        day,
        started_at_ms: startedAtMs,
        finished_at_ms: null,
      }
      db.sessions.push(session)
      persist()
      return session
    },

    async pause(id, accruedMs) {
      const s = db.sessions.find((x) => x.id === id)
      if (s) {
        s.elapsed_ms = Math.max(0, accruedMs)
        s.run_since_ms = null
        persist()
      }
    },

    async resume(id, runSinceMs) {
      const s = db.sessions.find((x) => x.id === id)
      if (s) {
        s.run_since_ms = runSinceMs
        persist()
      }
    },

    async addLap(sessionId, label, lapMs, totalMs, atMs) {
      const idx = db.laps.filter((l) => l.session_id === sessionId).length + 1
      const lap: PomodoroLap = {
        id: db.seq++,
        session_id: sessionId,
        idx,
        label,
        lap_ms: Math.max(0, lapMs),
        total_ms: Math.max(0, totalMs),
        at_ms: atMs,
      }
      db.laps.push(lap)
      const s = db.sessions.find((x) => x.id === sessionId)
      if (s) s.lap_count = idx
      persist()
      return lap
    },

    async renameLap(id, label) {
      const lap = db.laps.find((l) => l.id === id)
      if (lap) {
        lap.label = label
        persist()
      }
    },

    async deleteLap(id) {
      const lap = db.laps.find((l) => l.id === id)
      db.laps = db.laps.filter((l) => l.id !== id)
      if (lap) {
        const rest = db.laps
          .filter((l) => l.session_id === lap.session_id)
          .sort((a, b) => a.idx - b.idx)
        rest.forEach((l, i) => (l.idx = i + 1))
        const s = db.sessions.find((x) => x.id === lap.session_id)
        if (s) s.lap_count = rest.length
      }
      persist()
    },

    async finish(id, elapsedMs, completed, finishedAtMs) {
      const s = db.sessions.find((x) => x.id === id)
      if (s) {
        s.status = 'done'
        s.elapsed_ms = Math.max(0, elapsedMs)
        s.run_since_ms = null
        s.completed = completed
        s.finished_at_ms = finishedAtMs
        persist()
      }
    },

    async discard(id) {
      db.sessions = db.sessions.filter((s) => s.id !== id)
      db.laps = db.laps.filter((l) => l.session_id !== id)
      persist()
    },

    async laps(sessionId) {
      return db.laps.filter((l) => l.session_id === sessionId).sort((a, b) => a.idx - b.idx)
    },

    async history(limit) {
      return doneSessions()
        .sort((a, b) => b.started_at_ms - a.started_at_ms)
        .slice(0, Math.max(0, limit))
    },

    async deleteSession(id) {
      db.sessions = db.sessions.filter((s) => s.id !== id)
      db.laps = db.laps.filter((l) => l.session_id !== id)
      persist()
    },

    async stats() {
      const today = fmtDayKey(Date.now())
      const weekAgo = Date.now() - 6 * 86_400_000
      const stats = emptyStats()
      for (const s of doneSessions()) {
        stats.total_ms += s.elapsed_ms
        stats.total_sessions += 1
        if (s.started_at_ms >= weekAgo) stats.week_ms += s.elapsed_ms
        if (fmtDayKey(s.started_at_ms) !== today) continue
        stats.today_ms += s.elapsed_ms
        stats.today_sessions += 1
        if (s.completed) stats.today_completed += 1
        stats.today_laps += db.laps.filter((l) => l.session_id === s.id).length
      }
      return stats
    },
  }
}
