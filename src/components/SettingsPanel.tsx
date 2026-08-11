import { useState, useEffect } from 'react'

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

export default function SettingsPanel({ onClose }: Props) {
  const [edgeDock, setEdgeDock] = useState(isEdgeDockEnabled)

  useEffect(() => {
    setEdgeDockEnabled(edgeDock)
    // Dispatch custom event so useEdgeDock can react
    window.dispatchEvent(new CustomEvent('edge-dock-changed', { detail: edgeDock }))
  }, [edgeDock])

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <span className="settings-title">设置</span>
        <button className="settings-close" onClick={onClose}>✕</button>
      </div>

      <div className="settings-section">
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
      </div>
    </div>
  )
}
