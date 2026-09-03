interface DragIndicatorProps {
  position: 'top' | 'bottom'
  visible: boolean
}

// 指示条画在目标元素边框内侧(顶部/底部),避免被 .note-card 的 overflow:hidden 裁掉。
// 样式整体提升为模块常量,避免每次渲染新建对象
const INDICATOR_STYLES: Record<'top' | 'bottom', React.CSSProperties> = {
  top: {
    position: 'absolute',
    top: 0,
    left: 4,
    right: 4,
    height: 2,
    background: 'var(--accent)',
    borderRadius: 2,
    boxShadow: '0 0 6px var(--accent)',
    pointerEvents: 'none',
    zIndex: 10,
  },
  bottom: {
    position: 'absolute',
    bottom: 0,
    left: 4,
    right: 4,
    height: 2,
    background: 'var(--accent)',
    borderRadius: 2,
    boxShadow: '0 0 6px var(--accent)',
    pointerEvents: 'none',
    zIndex: 10,
  },
}

export function DragIndicator({ position, visible }: DragIndicatorProps) {
  if (!visible) return null

  return (
    <div
      className="drag-indicator"
      style={INDICATOR_STYLES[position]}
      role="presentation"
      aria-hidden="true"
    />
  )
}
