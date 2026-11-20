// 番茄钟时间格式化:全部基于毫秒,不引入日期库(与项目其余部分保持一致)

export const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))

/** 05:12 / 1:05:12 —— 用于计时数字、单节点用时、会话时长 */
export function fmtSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`
}

/** 14:07:32 —— 当前时间(墙上时钟) */
export function fmtClock(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 14:07 —— 节点发生的时刻 */
export function fmtHm(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 11月20日 周五 */
export function fmtDateLine(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`
}

/** 本地日期键 YYYY-MM-DD(与 SQLite date(...,'localtime') 口径一致) */
export function fmtDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 今天 / 昨天 / 11月18日 */
export function fmtDayLabel(day: string): string {
  const now = Date.now()
  if (day === fmtDayKey(now)) return '今天'
  if (day === fmtDayKey(now - 86_400_000)) return '昨天'
  const parts = day.split('-')
  if (parts.length !== 3) return day
  return `${Number(parts[1])}月${Number(parts[2])}日`
}

/** 紧凑人读时长:1h24m / 24m / 38s —— 用于统计行 */
export function fmtHuman(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** 14:05 – 14:32 */
export function fmtRange(startMs: number, endMs: number | null): string {
  const start = fmtHm(startMs)
  return endMs ? `${start} – ${fmtHm(endMs)}` : start
}
