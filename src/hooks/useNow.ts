import { useEffect, useState } from 'react'

/**
 * 以固定间隔刷新的当前时间(毫秒)。
 * 只服务「现在几点」这类展示,不参与计时:计时引擎用 Date.now() 差值计算,不受渲染节流影响。
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
