import { useEffect, useState, useCallback } from 'react'

export interface ToastItem {
  id: number
  message: string
  kind: 'info' | 'success' | 'error'
}

let toastSeq = 1

/** 全局 Toast:showToast() 静态调用,多窗口各自渲染 */
export function showToast(message: string, kind: ToastItem['kind'] = 'info') {
  window.dispatchEvent(
    new CustomEvent('toast', { detail: { id: toastSeq++, message, kind } }),
  )
}

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent).detail as ToastItem
      setToasts((prev) => [...prev, detail])
      // spec 7.14:1.5 秒后自动消失
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== detail.id))
      }, 1500)
    }
    window.addEventListener('toast', onToast)
    return () => window.removeEventListener('toast', onToast)
  }, [])

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  if (toasts.length === 0) return null
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
