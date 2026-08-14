import { useState, useEffect } from 'react'

// spec 7.10 预设:黄 / 绿 / 蓝 / 粉 / 紫 / 橙
export const NOTE_COLOR_PRESETS = ['#FFE066', '#A8E6CF', '#66D9EF', '#FFB3BA', '#D4A5FF', '#FFB86C']

interface Props {
  x: number
  y: number
  current: string
  onPick: (color: string) => void
  onClose: () => void
}

/** 便签颜色选择:6 种预设 + 自定义取色(spec 7.10) */
export default function ColorPicker({ x, y, current, onPick, onClose }: Props) {
  const [custom, setCustom] = useState(current)

  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [onClose])

  // 弹出位置:贴边不越界
  const left = Math.min(x, window.innerWidth - 210)
  const top = Math.min(y, window.innerHeight - 190)

  return (
    <div className="color-picker" style={{ left, top }} onClick={(e) => e.stopPropagation()}>
      <div className="color-presets">
        {NOTE_COLOR_PRESETS.map((c) => (
          <button
            key={c}
            className={`color-swatch ${current.toLowerCase() === c.toLowerCase() ? 'active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => {
              onPick(c)
              onClose()
            }}
          />
        ))}
      </div>
      <div className="color-custom">
        <input
          type="color"
          value={/^#[0-9a-fA-F]{6}$/.test(custom) ? custom : '#FFE066'}
          onChange={(e) => setCustom(e.target.value)}
        />
        <input
          className="color-hex"
          type="text"
          value={custom}
          placeholder="#FFE066"
          onChange={(e) => setCustom(e.target.value)}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={() => {
            if (/^#[0-9a-fA-F]{6}$/.test(custom)) {
              onPick(custom.toUpperCase())
              onClose()
            }
          }}
        >
          应用
        </button>
      </div>
    </div>
  )
}
