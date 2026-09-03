import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react'

export type DragKind = 'category' | 'note' | 'external-file' | 'external-text' | null

export interface DragContextValue {
  kind: Exclude<DragKind, null> | null
  sourceId: number | null
  isDragging: boolean
  startDrag: (kind: Exclude<DragKind, null>, sourceId: number) => void
  endDrag: () => void
}

const DragContext = createContext<DragContextValue | null>(null)

export function useDragContext() {
  const ctx = useContext(DragContext)
  if (!ctx) {
    throw new Error('useDragContext must be used within DragProvider')
  }
  return ctx
}

interface DragProviderProps {
  children: ReactNode
}

export function DragProvider({ children }: DragProviderProps) {
  const [state, setState] = useState<{
    kind: Exclude<DragKind, null> | null
    sourceId: number | null
    isDragging: boolean
  }>({ kind: null, sourceId: null, isDragging: false })

  const startDrag = useCallback((kind: Exclude<DragKind, null>, sourceId: number) => {
    setState({ kind, sourceId, isDragging: true })
  }, [])

  const endDrag = useCallback(() => {
    setState({ kind: null, sourceId: null, isDragging: false })
  }, [])

  const value = useMemo<DragContextValue>(
    () => ({
      kind: state.kind,
      sourceId: state.sourceId,
      isDragging: state.isDragging,
      startDrag,
      endDrag,
    }),
    [state, startDrag, endDrag],
  )

  return <DragContext.Provider value={value}>{children}</DragContext.Provider>
}

// 拖拽自动滚动:update() 在指针进入边缘区时启动 rAF 循环、离开时自停,无需显式 start
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  options: { edge?: number; speed?: number } = {},
) {
  const { edge = 40, speed = 16 } = options
  const rafRef = useRef<number | null>(null)
  const directionRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const isActiveRef = useRef(false)

  const update = useCallback((clientX: number, clientY: number) => {
    const el = containerRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    let dirX = 0
    let dirY = 0
    if (clientX - rect.left < edge) dirX = -1
    else if (rect.right - clientX < edge) dirX = 1
    if (clientY - rect.top < edge) dirY = -1
    else if (rect.bottom - clientY < edge) dirY = 1

    directionRef.current = { x: dirX, y: dirY }
    const active = dirX !== 0 || dirY !== 0
    if (active === isActiveRef.current) return
    isActiveRef.current = active
    if (!active) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }
    const scroll = () => {
      if (!isActiveRef.current) return
      const el = containerRef.current
      if (el) el.scrollBy(directionRef.current.x * speed, directionRef.current.y * speed)
      rafRef.current = requestAnimationFrame(scroll)
    }
    rafRef.current = requestAnimationFrame(scroll)
  }, [containerRef, edge, speed])

  const stop = useCallback(() => {
    isActiveRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
  }, [])

  // 组件卸载时停止滚动循环
  useEffect(() => () => stop(), [stop])

  return { update, stop }
}

// ===== 拖拽重排 =====
// 分类栏与便签列表共用的重排 hook,基于 Pointer 事件而非 HTML5 DnD:
// Windows 下 Tauri 默认开启 dragDropEnabled(wry 的 IDropTarget 会把不含文件的
// 元素拖拽以 DROPEFFECT_NONE 拒绝),前端收不到 dragover/drop,表现为全程禁止光标、
// 无法落点;而文件拖放的路径转发(tauri://drag-drop)依赖该默认项,不能关闭。
// 因此内部排序改用 pointerdown/move/up 自实现,鼠标与触控(长按)均可用。
// - itemProps: 源项 pointerdown 记录候选,移动超过阈值后 startDrag
// - 窗口级 pointermove 实时计算插入索引(落点指示),pointerup 提交排序
// - indicatorFor: 按指针位置返回唯一目标项及其插入侧
export interface ReorderDragOptions {
  enabled: boolean
  kind: 'category' | 'note'
  containerRef: RefObject<HTMLElement | null>
  isMovable: (id: number) => boolean
  // insertIndex 为相对可见项的插入索引;源项原位落下(等于源索引或其后一位)不会触发
  onDropAt: (insertIndex: number, sourceId: number) => void
}

export function useReorderDrag({
  enabled,
  kind,
  containerRef,
  isMovable,
  onDropAt,
}: ReorderDragOptions) {
  const { kind: dragKind, sourceId, isDragging, startDrag, endDrag } = useDragContext()
  const { update: updateAutoScroll, stop: stopAutoScroll } = useAutoScroll(containerRef)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const active = enabled && dragKind === kind && sourceId !== null && isDragging

  // 可见拖拽项:仅带 data-drag-id 的 DOM 元素,与过滤后的渲染顺序一致
  const visibleItems = useCallback((): HTMLElement[] => {
    const el = containerRef.current
    if (!el) return []
    return Array.from(el.querySelectorAll<HTMLElement>('[data-drag-id]'))
  }, [containerRef])

  // 按指针 Y 计算插入索引:落在某项上半 → 插其前;下半 → 插其后
  const insertIndexAt = useCallback((clientY: number): number => {
    const items = visibleItems()
    let idx = items.length
    for (let i = 0; i < items.length; i++) {
      const rect = items[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        idx = i
        break
      }
    }
    return idx
  }, [visibleItems])

  // 拖拽会话状态用 ref 保存;窗口级监听只注册一次(每次渲染同步最新依赖到 apiRef),
  // 避免高频重渲染与监听器反复挂载
  const sessionRef = useRef<{ id: number; pointerId: number; started: boolean } | null>(null)
  const pendingRef = useRef<{ id: number; pointerId: number; startX: number; startY: number } | null>(null)
  const justDraggedRef = useRef(false)

  const apiRef = useRef({
    kind,
    insertIndexAt,
    visibleItems,
    onDropAt,
    updateAutoScroll,
    stopAutoScroll,
    startDrag,
    endDrag,
  })
  useEffect(() => {
    apiRef.current = {
      kind,
      insertIndexAt,
      visibleItems,
      onDropAt,
      updateAutoScroll,
      stopAutoScroll,
      startDrag,
      endDrag,
    }
  })

  // 结束会话:commit 时按指针位置提交排序;拖拽真正开始后拦截随后的 click(避免误打开/误选中)
  const finishDrag = useCallback((commit: boolean, clientY: number) => {
    const api = apiRef.current
    const session = sessionRef.current
    if (!session) return
    sessionRef.current = null
    api.stopAutoScroll()
    document.body.classList.remove('drag-sorting')
    if (session.started) justDraggedRef.current = true
    if (commit && session.started) {
      const k = api.insertIndexAt(clientY)
      const items = api.visibleItems()
      const srcIdx = items.findIndex((el) => Number(el.dataset.dragId) === session.id)
      // 原位落下(源位置或其紧后一位)视为无位移
      if (srcIdx >= 0 && k >= 0 && k !== srcIdx && k !== srcIdx + 1) {
        api.onDropAt(k, session.id)
      }
    }
    setOverIndex(null)
    api.endDrag()
  }, [])

  useEffect(() => {
    const THRESHOLD_PX = 6

    const onPointerMove = (e: PointerEvent) => {
      const api = apiRef.current
      const pending = pendingRef.current
      const session = sessionRef.current

      if (pending && pending.pointerId === e.pointerId && !session) {
        // 按钮已在窗口外松开(收不到 pointerup)时取消候选
        if (e.buttons === 0) {
          pendingRef.current = null
          return
        }
        const dx = e.clientX - pending.startX
        const dy = e.clientY - pending.startY
        if (dx * dx + dy * dy >= THRESHOLD_PX * THRESHOLD_PX) {
          pendingRef.current = null
          sessionRef.current = { id: pending.id, pointerId: pending.pointerId, started: true }
          api.startDrag(api.kind, pending.id)
          document.body.classList.add('drag-sorting')
          api.updateAutoScroll(e.clientX, e.clientY)
          setOverIndex(api.insertIndexAt(e.clientY))
        }
        return
      }

      if (session && session.started && session.pointerId === e.pointerId) {
        if (e.buttons === 0) {
          // 在窗口外松开了按钮(收不到 pointerup):放弃本次拖拽
          finishDrag(false, 0)
          return
        }
        e.preventDefault()
        api.updateAutoScroll(e.clientX, e.clientY)
        setOverIndex(api.insertIndexAt(e.clientY))
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const session = sessionRef.current
      if (session && session.started && session.pointerId === e.pointerId) {
        e.preventDefault() // 阻止拖拽后的 click 触发(与 capture click 拦截双保险)
        finishDrag(true, e.clientY)
      } else {
        pendingRef.current = null // 普通点击,未产生拖拽
      }
    }

    const onPointerCancel = (e: PointerEvent) => {
      if (sessionRef.current?.pointerId === e.pointerId) finishDrag(false, 0)
      pendingRef.current = null
    }

    const onBlur = () => {
      if (sessionRef.current) finishDrag(false, 0)
      pendingRef.current = null
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sessionRef.current) finishDrag(false, 0)
    }

    // 拖拽结束后的 click 在捕获阶段吞掉;下一次 pointerdown 时复位标记,
    // 防止在窗口外松开后标记残留、误吞下一次点击
    const onCaptureClick = (e: MouseEvent) => {
      if (justDraggedRef.current) {
        justDraggedRef.current = false
        e.stopPropagation()
        e.preventDefault()
      }
    }
    const onPointerDownReset = () => {
      justDraggedRef.current = false
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('click', onCaptureClick, true)
    window.addEventListener('pointerdown', onPointerDownReset, true)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('click', onCaptureClick, true)
      window.removeEventListener('pointerdown', onPointerDownReset, true)
    }
  }, [finishDrag])

  const itemProps = useCallback((id: number) => {
    const movable = enabled && isMovable(id)
    return {
      'data-drag-id': id,
      'aria-grabbed': dragKind === kind && sourceId === id && isDragging,
      onPointerDown: (e: ReactPointerEvent) => {
        if (!movable) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        if (sessionRef.current || pendingRef.current) return
        // 卡片内按钮(打开/置顶/删除等)不触发拖拽
        if ((e.target as Element).closest('button, a, input, textarea, select')) return
        pendingRef.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY }
      },
    }
  }, [enabled, kind, isMovable, dragKind, sourceId, isDragging])

  // 悬停指示:插入索引落在该项上沿 → top,落在下沿 → bottom
  const indicatorFor = useCallback((id: number): { position: 'top' | 'bottom' } | null => {
    if (!active || sourceId === null || overIndex === null || sourceId === id) return null
    const items = visibleItems()
    const idx = items.findIndex((el) => Number(el.dataset.dragId) === id)
    const srcIdx = items.findIndex((el) => Number(el.dataset.dragId) === sourceId)
    if (idx < 0 || srcIdx < 0) return null
    if (overIndex === idx && overIndex !== srcIdx) return { position: 'top' }
    if (overIndex === idx + 1 && overIndex !== srcIdx + 1) return { position: 'bottom' }
    return null
  }, [active, sourceId, overIndex, visibleItems])

  const isSource = useCallback(
    (id: number) => dragKind === kind && sourceId === id && isDragging,
    [dragKind, kind, sourceId, isDragging],
  )

  return { itemProps, indicatorFor, isSource }
}
