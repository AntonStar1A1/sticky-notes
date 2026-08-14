import { useEffect, useRef, useState } from 'react'

/**
 * 快捷键录入框:点击后按组合键完成录入。
 * 输出格式与 tauri-plugin-global-shortcut 一致,如 "Ctrl+Shift+N"。
 */
export function ShortcutInput({
  value,
  onChange,
  onFocus,
}: {
  value: string
  onChange: (keys: string) => void
  onFocus?: () => void
}) {
  const [recording, setRecording] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setRecording(false)
        return
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.shiftKey) parts.push('Shift')
      if (e.altKey) parts.push('Alt')
      if (e.metaKey) parts.push('Super')
      const key = e.key.toUpperCase()
      if (!parts.length) return // 必须包含修饰键,避免误占单键
      parts.push(key)
      onChange(parts.join('+'))
      setRecording(false)
    }
    const onBlur = () => setRecording(false)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [recording, onChange])

  return (
    <button
      ref={ref}
      type="button"
      className={`shortcut-input ${recording ? 'recording' : ''}`}
      onClick={() => {
        onFocus?.()
        setRecording(true)
      }}
      title="点击后按下新的快捷键组合,Esc 取消"
    >
      {recording ? '请按键…' : value}
    </button>
  )
}
