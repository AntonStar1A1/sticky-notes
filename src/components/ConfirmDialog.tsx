import { useEffect } from 'react'
import { TriangleAlert } from 'lucide-react'

export interface ConfirmOptions {
  title: string
  message: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
}

/** 磨砂玻璃确认弹窗。返回 Promise<boolean>。 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const evt = new CustomEvent('confirm-dialog', {
      detail: { ...opts, resolve },
    })
    window.dispatchEvent(evt)
  })
}

export function ConfirmDialogHost() {
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as ConfirmOptions & { resolve: (v: boolean) => void }
      const overlay = document.createElement('div')
      overlay.className = 'confirm-overlay'
      overlay.innerHTML = `
        <div class="confirm-box">
          <div class="confirm-title">${detail.title}</div>
          <div class="confirm-message">${detail.message}</div>
          <div class="confirm-actions">
            <button class="btn btn-ghost confirm-cancel">${detail.cancelText ?? '取消'}</button>
            <button class="btn ${detail.danger ? 'btn-danger' : 'btn-primary'} confirm-ok">${detail.confirmText ?? '确定'}</button>
          </div>
        </div>
      `
      const finish = (v: boolean) => {
        overlay.remove()
        window.removeEventListener('keydown', onKey)
        detail.resolve(v)
      }
      const onKey = (ke: KeyboardEvent) => {
        if (ke.key === 'Escape') finish(false)
        if (ke.key === 'Enter') finish(true)
      }
      overlay.addEventListener('click', (me) => {
        if (me.target === overlay) finish(false)
      })
      overlay.querySelector('.confirm-cancel')!.addEventListener('click', () => finish(false))
      overlay.querySelector('.confirm-ok')!.addEventListener('click', () => finish(true))
      window.addEventListener('keydown', onKey)
      document.body.appendChild(overlay)
    }
    window.addEventListener('confirm-dialog', onOpen)
    return () => window.removeEventListener('confirm-dialog', onOpen)
  }, [])

  return <TriangleAlert size={0} style={{ display: 'none' }} />
}
