import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Zap, X } from 'lucide-react'
import type { Category } from './types'
import { loadTheme } from './theme'
import './CaptureApp.css'

loadTheme()

const win = getCurrentWindow()
const MAX_CHARS = 500

/** 闪电捕获栏(spec 7.12):全局快捷键唤起,Enter 快速保存到上次使用的分类 */
function CaptureApp() {
  const [content, setContent] = useState('')
  const [category, setCategory] = useState<Category | null>(null)
  const [saved, setSaved] = useState(false)
  const savingRef = useRef(false)

  useEffect(() => {
    // 上次使用的分类(管理器切换分类时写入 localStorage)
    const raw = localStorage.getItem('lastActiveCategoryId')
    const catId = raw ? Number(raw) : null
    invoke<Category[]>('get_categories').then((cats) => {
      setCategory(cats.find((c) => c.id === catId) ?? null)
    }).catch(() => {})
  }, [])

  // 主题实时跟随
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'sticky-theme') loadTheme()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // 按下 Esc 的瞬间取消(可能丢失输入内容,由保存流程之外的独立监听处理)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !savingRef.current) win.hide().catch(() => {})
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const save = async () => {
    const text = content.trim()
    if (!text || savingRef.current) return
    savingRef.current = true
    try {
      await invoke('save_capture', {
        content: text,
        categoryId: category ? category.id : null,
      })
      setSaved(true)
      // 保存成功:淡出动画后由 Rust 侧隐藏窗口(save_capture 成功后即 hide)
      window.setTimeout(() => {
        savingRef.current = false
        setSaved(false)
        setContent('')
      }, 350)
    } catch (e) {
      savingRef.current = false
      console.error('保存失败:', e)
    }
  }

  const cancel = () => {
    if (!savingRef.current) win.hide().catch(() => {})
  }

  return (
    <div className={`capture-root ${saved ? 'saved' : ''}`}>
      <div className="capture-panel">
        <div className="capture-header">
          <span className="capture-icon"><Zap size={12} /></span>
          <span className="capture-title">快速便签</span>
          <span className="capture-category">
            {category ? `保存到: ${category.name}` : '保存到: 全部'}
          </span>
          <button className="capture-close" onClick={cancel} title="取消 (Esc)">
            <X size={13} />
          </button>
        </div>
        <textarea
          className="capture-input"
          placeholder="输入内容,Enter 保存,Shift+Enter 换行,Esc 取消"
          value={content}
          maxLength={MAX_CHARS}
          autoFocus
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              save()
            }
          }}
        />
        <div className="capture-footer">
          <span className="capture-hint">Enter 保存 · Shift+Enter 换行 · Esc 取消</span>
          <span className="capture-count">{content.length}/{MAX_CHARS}</span>
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <CaptureApp />
  </StrictMode>,
)

export default CaptureApp
