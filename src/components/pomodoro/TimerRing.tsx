import type { ReactNode } from 'react'
import type { PomoPhase } from '../../hooks/usePomodoro'

const RADIUS = 90
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

interface Props {
  /** 0..1 */
  progress: number
  phase: PomoPhase
  /** 外框像素尺寸 */
  size: number
  children: ReactNode
}

/** 计时环:轨道 + 番茄渐变进度弧,中间放计时数字 */
export default function TimerRing({ progress, phase, size, children }: Props) {
  const value = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0))
  return (
    <div className={`timer-ring phase-${phase}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <defs>
          <linearGradient id="pomoRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--pomo-from)" />
            <stop offset="100%" stopColor="var(--pomo-to)" />
          </linearGradient>
        </defs>
        <circle className="timer-ring-track" cx="100" cy="100" r={RADIUS} />
        <circle
          className="timer-ring-arc"
          cx="100"
          cy="100"
          r={RADIUS}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - value)}
          transform="rotate(-90 100 100)"
        />
      </svg>
      <div className="timer-ring-center">{children}</div>
    </div>
  )
}
