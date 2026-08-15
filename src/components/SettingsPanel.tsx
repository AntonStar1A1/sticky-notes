import { useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { Wrench, ShieldCheck, Palette, Keyboard, Info, X, Check } from 'lucide-react'
import type { PrivacyStatus, ShortcutInfo } from '../types'
import { THEME_PRESETS, saveTheme, type ThemeName } from '../theme'
import { ShortcutInput } from './ShortcutInput'
import PrivacyLock, { type PrivacyMode } from './PrivacyLock'
import { showToast } from './Toast'

const EDGE_DOCK_KEY = 'edgeDock'

export function isEdgeDockEnabled(): boolean {
  const val = localStorage.getItem(EDGE_DOCK_KEY)
  return val === null ? true : val === 'true'
}

export function setEdgeDockEnabled(value: boolean) {
  localStorage.setItem(EDGE_DOCK_KEY, String(value))
}

interface Props {
  onClose: () => void
}

type Section = 'basic' | 'security' | 'appearance' | 'shortcut' | 'about'

const SECTIONS: { key: Section; label: string; icon: ReactNode }[] = [
  { key: 'basic', label: '基本', icon: <Wrench size={13} /> },
  { key: 'security', label: '安全', icon: <ShieldCheck size={13} /> },
  { key: 'appearance', label: '外观', icon: <Palette size={13} /> },
  { key: 'shortcut', label: '快捷键', icon: <Keyboard size={13} /> },
  { key: 'about', label: '关于', icon: <Info size={13} /> },
]

const SHORTCUT_LABELS: Record<string, string> = {
  new_note: '新建便签',
  clipboard_note: '剪贴板创建便签',
  capture: '闪电捕获',
}

/** 设置面板(spec 7.14):基本/安全/外观/快捷键/关于 分组 */
export default function SettingsPanel({ onClose }: Props) {
  const [section, setSection] = useState<Section>('basic')
  const [edgeDock, setEdgeDock] = useState(isEdgeDockEnabled())
  const [theme, setTheme] = useState<ThemeName>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('sticky-theme') ?? '{}')
      return (parsed.name as ThemeName) ?? 'dark'
    } catch {
      return 'dark'
    }
  })
  const [customColor, setCustomColor] = useState<string>(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('sticky-theme') ?? '{}')
      return (parsed.customColor as string) ?? '#4C9EEB'
    } catch {
      return '#4C9EEB'
    }
  })
  const [shortcuts, setShortcuts] = useState<ShortcutInfo[]>([])
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>({ has_password: false, questions: [] })
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode | null>(null)
  const [showCharCount, setShowCharCount] = useState(() => {
    // spec 7.11:默认关闭
    return localStorage.getItem('showCharCount') === 'true'
  })
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    setEdgeDockEnabled(edgeDock)
    window.dispatchEvent(new CustomEvent('edge-dock-changed', { detail: edgeDock }))
  }, [edgeDock])

  useEffect(() => {
    // 便签窗口经 storage 事件实时跟随
    localStorage.setItem('showCharCount', String(showCharCount))
    window.dispatchEvent(new CustomEvent('show-char-count-changed', { detail: showCharCount }))
  }, [showCharCount])

  useEffect(() => {
    invoke<ShortcutInfo[]>('get_shortcuts').then(setShortcuts).catch((e) => console.error(e))
    invoke<PrivacyStatus>('get_privacy_status').then(setPrivacyStatus).catch((e) => console.error(e))
    // 版本号读取编译进二进制的 tauri.conf.json,升级后自动一致,无需手工同步
    getVersion().then(setAppVersion).catch((e) => console.error(e))
  }, [])

  const pickTheme = useCallback((name: ThemeName) => {
    setTheme(name)
    saveTheme(name, customColor)
  }, [customColor])

  const applyCustomColor = useCallback(() => {
    if (/^#[0-9a-fA-F]{6}$/.test(customColor)) {
      saveTheme('custom', customColor)
      setTheme('custom')
    }
  }, [customColor])

  const changeShortcut = useCallback(async (kind: string, keys: string) => {
    const prev = shortcuts.find((s) => s.kind === kind)
    try {
      await invoke('set_shortcut', { kind, keys })
      showToast(`${SHORTCUT_LABELS[kind] ?? kind}: ${keys}`, 'success')
      setShortcuts(await invoke<ShortcutInfo[]>('get_shortcuts'))
    } catch (e) {
      showToast(String(e), 'error')
      // 恢复显示原快捷键
      setShortcuts(await invoke<ShortcutInfo[]>('get_shortcuts').catch(() => shortcuts))
      if (prev) showToast(`保留原快捷键 ${prev.keys}`, 'info')
    }
  }, [shortcuts])

  const onPrivacyUnlocked = useCallback(() => {
    setPrivacyMode(null)
    invoke<PrivacyStatus>('get_privacy_status').then(setPrivacyStatus)
    window.dispatchEvent(new CustomEvent('privacy-changed'))
  }, [])

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-title">设置</span>
        <button className="icon-btn" onClick={onClose} title="关闭">
          <X size={14} />
        </button>
      </div>

      <div className="settings-tabs">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`settings-tab ${section === s.key ? 'active' : ''}`}
            onClick={() => setSection(s.key)}
            title={s.label}
          >
            {s.icon}
          </button>
        ))}
      </div>

      <div className="settings-body">
        {section === 'basic' && (
          <div className="settings-section">
            <div className="settings-group-title">基本设置</div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">边缘吸附</span>
                <span className="settings-item-desc">拖到屏幕边缘自动隐藏</span>
              </div>
              <button
                className={`toggle-btn ${edgeDock ? 'on' : 'off'}`}
                onClick={() => setEdgeDock(!edgeDock)}
              >
                <span className="toggle-thumb" />
              </button>
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">字数统计</span>
                <span className="settings-item-desc">便签窗口底部状态栏显示字数</span>
              </div>
              <button
                className={`toggle-btn ${showCharCount ? 'on' : 'off'}`}
                onClick={() => setShowCharCount(!showCharCount)}
              >
                <span className="toggle-thumb" />
              </button>
            </div>
          </div>
        )}

        {section === 'security' && (
          <div className="settings-section">
            <div className="settings-group-title">隐私分类</div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">分类密码</span>
                <span className="settings-item-desc">
                  {privacyStatus.has_password
                    ? '已设置。切换视图或最小化后自动重新锁定'
                    : '未设置。设置后查看隐私分类需输入密码'}
                </span>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setPrivacyMode(privacyStatus.has_password ? 'change' : 'setup')}
              >
                {privacyStatus.has_password ? '修改密码' : '设置密码'}
              </button>
            </div>
            {privacyStatus.has_password && privacyStatus.questions.length > 0 && (
              <div className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-label">忘记密码</span>
                  <span className="settings-item-desc">回答两个安全问题后重置密码</span>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => setPrivacyMode('forgot')}>
                  找回密码
                </button>
              </div>
            )}
            <div className="settings-note">
              隐私分类仅做查看入口锁定,便签内容以明文存储于本地数据库;锁定后已打开的隐私便签窗口会自动关闭。
            </div>
          </div>
        )}

        {section === 'appearance' && (
          <div className="settings-section">
            <div className="settings-group-title">主题</div>
            <div className="theme-grid">
              {THEME_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={`theme-swatch ${theme === p.name ? 'active' : ''}`}
                  style={{ background: p.color }}
                  title={p.label}
                  onClick={() => pickTheme(p.name)}
                >
                  {theme === p.name && <Check size={13} />}
                </button>
              ))}
            </div>
            <div className="settings-item">
              <div className="settings-item-info">
                <span className="settings-item-label">自定义颜色</span>
                <span className="settings-item-desc">选择颜色后自动应用为自定义主题</span>
              </div>
              <div className="custom-color-row">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(customColor) ? customColor : '#4C9EEB'}
                  onChange={(e) => {
                    setCustomColor(e.target.value)
                    saveTheme('custom', e.target.value)
                    setTheme('custom')
                  }}
                />
                <input
                  className="color-hex"
                  type="text"
                  value={customColor}
                  onChange={(e) => setCustomColor(e.target.value)}
                  onBlur={applyCustomColor}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') applyCustomColor()
                  }}
                />
              </div>
            </div>
            <div className="settings-note">主题在所有窗口间同步生效。</div>
          </div>
        )}

        {section === 'shortcut' && (
          <div className="settings-section">
            <div className="settings-group-title">全局快捷键</div>
            {shortcuts.map((s) => (
              <div key={s.kind} className="settings-item">
                <div className="settings-item-info">
                  <span className="settings-item-label">{SHORTCUT_LABELS[s.kind] ?? s.kind}</span>
                  <span className="settings-item-desc">
                    {s.registered ? '任意应用中均可触发' : '注册失败:与其他应用冲突,请更换'}
                  </span>
                </div>
                <ShortcutInput
                  value={s.keys}
                  onChange={(keys) => changeShortcut(s.kind, keys)}
                />
              </div>
            ))}
            <div className="settings-note">
              修改时先尝试注册新组合,成功才替换;失败保留原快捷键(被动冲突检测)。
            </div>
          </div>
        )}

        {section === 'about' && (
          <div className="settings-section">
            <div className="settings-group-title">关于</div>
            <div className="about-row"><span>版本</span><span>{appVersion || '…'}</span></div>
            <div className="about-row"><span>数据存储</span><span>本机应用数据目录(sticky_notes.db)</span></div>
            <div className="settings-note">
              数据仅保存在本机。升级前建议先导出备份(工具栏导出全部);回收站中的便签保留 30 天后自动清理。
            </div>
          </div>
        )}
      </div>

      {privacyMode && (
        <PrivacyLock
          mode={privacyMode}
          status={privacyStatus}
          onCancel={() => setPrivacyMode(null)}
          onUnlocked={onPrivacyUnlocked}
          onSwitchMode={(m) => setPrivacyMode(m)}
        />
      )}
    </div>
  )
}
