// 番茄钟本地偏好(主题之外的用户设置):模式、目标时长、窗口置顶与上次尺寸。
// 存在 localStorage,与主题一致地按同源共享。
import type { PomodoroMode } from '../types'

export interface PomoPrefs {
  mode: PomodoroMode
  /** 倒计时目标毫秒;正计时模式下同时用作环形进度周期 */
  targetMs: number
  pinned: boolean
  width: number
  height: number
}

const KEY = 'pomodoro-prefs'

export const DEFAULT_PREFS: PomoPrefs = {
  mode: 'down',
  targetMs: 25 * 60_000,
  pinned: true,
  width: 344,
  height: 580,
}

export function loadPrefs(): PomoPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_PREFS }
    const parsed = JSON.parse(raw) as Partial<PomoPrefs>
    return {
      mode: parsed.mode === 'up' || parsed.mode === 'down' ? parsed.mode : DEFAULT_PREFS.mode,
      targetMs:
        typeof parsed.targetMs === 'number' && parsed.targetMs >= 60_000
          ? parsed.targetMs
          : DEFAULT_PREFS.targetMs,
      pinned: typeof parsed.pinned === 'boolean' ? parsed.pinned : DEFAULT_PREFS.pinned,
      width: typeof parsed.width === 'number' && parsed.width >= 260 ? parsed.width : DEFAULT_PREFS.width,
      height: typeof parsed.height === 'number' && parsed.height >= 260 ? parsed.height : DEFAULT_PREFS.height,
    }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

export function savePrefs(patch: Partial<PomoPrefs>) {
  const next = { ...loadPrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* 忽略配额错误 */
  }
}
