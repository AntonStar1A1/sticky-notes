import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Lock, KeyRound, ShieldQuestion, Eye, EyeOff } from 'lucide-react'
import type { PrivacyStatus } from '../types'

export type PrivacyMode = 'unlock' | 'setup' | 'forgot' | 'change'

interface Props {
  mode: PrivacyMode
  status: PrivacyStatus
  onCancel: () => void
  onUnlocked: () => void
  onSwitchMode: (m: PrivacyMode) => void
}

/**
 * 隐私分类密码弹窗(spec 7.11):
 * - unlock: 输入密码解锁(会话内有效,切换视图/最小化后重新锁定)
 * - setup: 首次设置密码 + 两个安全问题(用于找回)
 * - forgot: 回答安全问题后重置密码
 */
export default function PrivacyLock({ mode, status, onCancel, onUnlocked, onSwitchMode }: Props) {
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [q1, setQ1] = useState('')
  const [a1, setA1] = useState('')
  const [q2, setQ2] = useState('')
  const [a2, setA2] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      if (mode === 'unlock') {
        const ok = await invoke<boolean>('verify_privacy_password', { password })
        if (ok) {
          onUnlocked()
        } else {
          setError('密码错误')
        }
      } else if (mode === 'setup') {
        await invoke('set_privacy_password', { req: { password, q1, a1, q2, a2 } })
        onUnlocked()
      } else if (mode === 'change') {
        await invoke('change_privacy_password', { oldPassword, newPassword })
        onUnlocked()
      } else {
        const ok = await invoke<boolean>('reset_privacy_password', { a1, a2, newPassword })
        if (ok) {
          onUnlocked()
        } else {
          setError('安全问题的答案不正确')
        }
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }, [mode, password, newPassword, oldPassword, q1, a1, q2, a2, onUnlocked])

  const input = (value: string, set: (v: string) => void, placeholder: string, isPw = false) => (
    <input
      className="privacy-input"
      type={isPw && !showPw ? 'password' : 'text'}
      value={value}
      placeholder={placeholder}
      autoFocus
      onChange={(e) => set(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') submit()
      }}
    />
  )

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="privacy-box" onClick={(e) => e.stopPropagation()}>
        <div className="privacy-header">
          {mode === 'unlock' ? <Lock size={20} /> : mode === 'setup' ? <KeyRound size={20} /> : <ShieldQuestion size={20} />}
          <span>
            {mode === 'unlock' ? '隐私分类已锁定' : mode === 'setup' ? '设置隐私密码' : mode === 'change' ? '修改密码' : '找回密码'}
          </span>
        </div>

        {mode === 'unlock' && (
          <>
            <div className="privacy-desc">输入密码以查看隐私分类中的便签</div>
            {input(password, setPassword, '密码')}
            <div className="privacy-actions">
              <button className="btn btn-ghost" onClick={onCancel}>取消</button>
              <button className="btn btn-primary" disabled={!password || busy} onClick={submit}>解锁</button>
            </div>
            {status.questions.length > 0 && (
              <div className="privacy-forgot" onClick={() => onSwitchMode('forgot')}>
                忘记密码?
              </div>
            )}
          </>
        )}

        {mode === 'setup' && (
          <>
            <div className="privacy-desc">设置密码保护隐私分类。安全问题用于忘记密码时找回。</div>
            <div className="privacy-input-row">
              {input(password, setPassword, '密码')}
              <button className="icon-btn" title={showPw ? '隐藏' : '显示'} onClick={() => setShowPw(!showPw)}>
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <div className="privacy-desc small">安全问题(请记住答案):</div>
            {input(q1, setQ1, '问题 1,如:我的小学名称')}
            {input(a1, setA1, '答案 1')}
            {input(q2, setQ2, '问题 2,如:我的第一只宠物名')}
            {input(a2, setA2, '答案 2')}
            <div className="privacy-actions">
              <button className="btn btn-ghost" onClick={onCancel}>稍后设置</button>
              <button
                className="btn btn-primary"
                disabled={!password || !q1.trim() || !a1.trim() || !q2.trim() || !a2.trim() || busy}
                onClick={submit}
              >
                设置
              </button>
            </div>
          </>
        )}

        {mode === 'change' && (
          <>
            <div className="privacy-desc">输入旧密码验证后设置新密码</div>
            {input(oldPassword, setOldPassword, '旧密码')}
            {input(newPassword, setNewPassword, '新密码')}
            <div className="privacy-actions">
              <button className="btn btn-ghost" onClick={onCancel}>取消</button>
              <button
                className="btn btn-primary"
                disabled={!oldPassword || !newPassword || busy}
                onClick={submit}
              >
                修改
              </button>
            </div>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <div className="privacy-desc">回答设置时的两个安全问题,验证通过后可重置密码</div>
            {status.questions[0] && <div className="privacy-question">{status.questions[0]}</div>}
            {input(a1, setA1, '答案 1')}
            {status.questions[1] && <div className="privacy-question">{status.questions[1]}</div>}
            {input(a2, setA2, '答案 2')}
            {input(newPassword, setNewPassword, '新密码')}
            <div className="privacy-actions">
              <button className="btn btn-ghost" onClick={onCancel}>取消</button>
              <button
                className="btn btn-primary"
                disabled={!a1.trim() || !a2.trim() || !newPassword || busy}
                onClick={submit}
              >
                重置密码
              </button>
            </div>
          </>
        )}

        {error && <div className="privacy-error">{error}</div>}
      </div>
    </div>
  )
}
