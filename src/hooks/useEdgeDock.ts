import { useEffect, useRef, useCallback } from 'react'
import { getCurrentWindow, currentMonitor, cursorPosition } from '@tauri-apps/api/window'
import { LogicalPosition } from '@tauri-apps/api/dpi'
import type { Monitor } from '@tauri-apps/api/window'

type Edge = 'left' | 'right' | 'top'
type State = 'normal' | 'docked' | 'revealed' | 'retracting'

const DOCK_THRESHOLD = 15
const STRIP_SIZE = 4
const RETRACT_DELAY = 300
const POLL_INTERVAL = 200
const POS_CHECK_INTERVAL = 100

export function useEdgeDock(enabled: boolean) {
  const stateRef = useRef<State>('normal')
  // 当前吸附的边 — dock 时设置, retract 时不清除(供 reveal→retract 使用)
  const edgeRef = useRef<Edge | null>(null)
  const preDockPosRef = useRef<{ x: number; y: number } | null>(null)
  const retractTimerRef = useRef<number | null>(null)
  const pollTimerRef = useRef<number | null>(null)
  const posCheckTimerRef = useRef<number | null>(null)
  const winSizeRef = useRef<{ w: number; h: number }>({ w: 280, h: 600 })
  const enabledRef = useRef(enabled)
  const lastKnownPosRef = useRef<{ x: number; y: number } | null>(null)
  const stableCountRef = useRef(0)
  const startPositionCheckRef = useRef<(() => void) | null>(null)
  // 冷却期:undock 后一段时间内禁止重新吸附
  const cooldownRef = useRef(false)

  enabledRef.current = enabled

  const clearAllTimers = useCallback(() => {
    if (retractTimerRef.current) {
      window.clearTimeout(retractTimerRef.current)
      retractTimerRef.current = null
    }
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    if (posCheckTimerRef.current) {
      window.clearInterval(posCheckTimerRef.current)
      posCheckTimerRef.current = null
    }
  }, [])

  const getDockPosition = useCallback((edge: Edge, monitor: Monitor, winW: number, winH: number) => {
    const wa = monitor.workArea
    const sf = monitor.scaleFactor
    const waX = wa.position.toLogical(sf).x
    const waY = wa.position.toLogical(sf).y
    const waW = wa.size.toLogical(sf).width

    switch (edge) {
      case 'left':
        return new LogicalPosition(waX - winW + STRIP_SIZE, waY)
      case 'right':
        return new LogicalPosition(waX + waW - STRIP_SIZE, waY)
      case 'top':
        return new LogicalPosition(waX, waY - winH + STRIP_SIZE)
    }
  }, [])

  const isCursorInStrip = useCallback(async (edge: Edge, monitor: Monitor): Promise<boolean> => {
    const cursor = await cursorPosition()
    const sf = monitor.scaleFactor
    const wa = monitor.workArea
    const waX = wa.position.toLogical(sf).x
    const waY = wa.position.toLogical(sf).y
    const waW = wa.size.toLogical(sf).width
    const waH = wa.size.toLogical(sf).height
    const cx = cursor.toLogical(sf).x
    const cy = cursor.toLogical(sf).y

    switch (edge) {
      case 'left':
        return cx >= waX - STRIP_SIZE && cx <= waX + STRIP_SIZE
            && cy >= waY && cy <= waY + waH
      case 'right':
        return cx >= waX + waW - STRIP_SIZE && cx <= waX + waW + STRIP_SIZE
            && cy >= waY && cy <= waY + waH
      case 'top':
        return cx >= waX && cx <= waX + waW
            && cy >= waY - STRIP_SIZE && cy <= waY + STRIP_SIZE
    }
  }, [])

  // ===== 吸附到边缘 =====
  const dock = useCallback(async (edge: Edge) => {
    if (!enabledRef.current) return
    if (stateRef.current !== 'normal') return

    const win = getCurrentWindow()
    const monitor = await currentMonitor()
    if (!monitor) return

    const pos = await win.outerPosition()
    const sf = monitor.scaleFactor
    const logicalPos = pos.toLogical(sf)
    console.log('[EdgeDock] dock called', edge, 'current pos:', logicalPos.x, logicalPos.y)

    const size = await win.outerSize()
    winSizeRef.current = {
      w: size.toLogical(sf).width,
      h: size.toLogical(sf).height,
    }

    // 计算弹出位置:确保窗口完全在屏幕内
    const wa = monitor.workArea
    const waX = wa.position.toLogical(sf).x
    const waY = wa.position.toLogical(sf).y
    const waW = wa.size.toLogical(sf).width
    const waH = wa.size.toLogical(sf).height
    const w = winSizeRef.current.w
    const h = winSizeRef.current.h

    // 基于当前窗口位置,但确保完全在工作区内
    let revealX = logicalPos.x
    let revealY = logicalPos.y
    if (revealX + w > waX + waW) revealX = waX + waW - w
    if (revealX < waX) revealX = waX
    if (revealY + h > waY + waH) revealY = waY + waH - h
    if (revealY < waY) revealY = waY
    preDockPosRef.current = { x: revealX, y: revealY }
    console.log('[EdgeDock] reveal pos set to:', revealX, revealY)

    const dockPos = getDockPosition(edge, monitor, w, h)
    await win.setPosition(dockPos)
    await win.setSkipTaskbar(true)

    stateRef.current = 'docked'
    edgeRef.current = edge
    stableCountRef.current = 0

    // 停止位置轮询,开始鼠标轮询
    if (posCheckTimerRef.current) {
      window.clearInterval(posCheckTimerRef.current)
      posCheckTimerRef.current = null
    }
    startCursorPolling()
  }, [getDockPosition])

  // ===== 轮询鼠标是否进入窄条 =====
  const startCursorPolling = useCallback(() => {
    if (pollTimerRef.current) return
    pollTimerRef.current = window.setInterval(async () => {
      if (stateRef.current !== 'docked' || !edgeRef.current) return
      const monitor = await currentMonitor()
      if (!monitor) return
      const inside = await isCursorInStrip(edgeRef.current, monitor)
      if (inside) {
        await reveal()
      }
    }, POLL_INTERVAL)
  }, [isCursorInStrip])

  // ===== 弹出窗口 =====
  const reveal = useCallback(async () => {
    if (stateRef.current !== 'docked') return
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    const win = getCurrentWindow()
    if (preDockPosRef.current) {
      await win.setPosition(
        new LogicalPosition(preDockPosRef.current.x, preDockPosRef.current.y)
      )
    }
    await win.setSkipTaskbar(false)

    // 注意: 不清除 edgeRef, retract 需要用它
    stateRef.current = 'revealed'

    // 开始监听鼠标离开
    startRetractWatch()
  }, [])

  // ===== 监听鼠标离开 / 窗口被拖走 =====
  const startRetractWatch = useCallback(() => {
    if (pollTimerRef.current) window.clearInterval(pollTimerRef.current)
    // 延迟一帧再记录基准位置,等 reveal() 的 setPosition 生效
    let baselinePos: { x: number; y: number } | null = null
    let pollCount = 0

    pollTimerRef.current = window.setInterval(async () => {
      if (stateRef.current !== 'revealed') return

      const win = getCurrentWindow()
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      const monitor = await currentMonitor()
      if (!monitor) return

      const sf = monitor.scaleFactor
      const wp = pos.toLogical(sf)
      const ws = size.toLogical(sf)

      pollCount++

      // 前3次轮询跳过拖动检测(等位置稳定),仅记录基准
      if (pollCount <= 3) {
        baselinePos = { x: wp.x, y: wp.y }
        return
      }

      // 检测窗口是否被拖走(位置与基准不同,阈值50px避免retract动画误触)
      if (baselinePos && stateRef.current === 'revealed') {
        const dx = Math.abs(wp.x - baselinePos.x)
        const dy = Math.abs(wp.y - baselinePos.y)
        if (dx > 50 || dy > 50) {
          console.log('[EdgeDock] drag detected! dx:', dx, 'dy:', dy, 'state:', stateRef.current)
          // 窗口被拖走了,回到 normal 状态
          if (pollTimerRef.current) {
            window.clearInterval(pollTimerRef.current)
            pollTimerRef.current = null
          }
          console.log('[EdgeDock] transitioning to normal, starting position check')
          stateRef.current = 'normal'
          edgeRef.current = null
          preDockPosRef.current = null
          stableCountRef.current = 0
          lastKnownPosRef.current = { x: wp.x, y: wp.y }
          await win.setSkipTaskbar(false)
          if (startPositionCheckRef.current) startPositionCheckRef.current()
          return
        }
      }

      // 检测鼠标是否离开窗口
      const cursor = await cursorPosition()
      const cp = cursor.toLogical(sf)

      const inside =
        cp.x >= wp.x && cp.x <= wp.x + ws.width &&
        cp.y >= wp.y && cp.y <= wp.y + ws.height

      if (!inside) {
        if (pollTimerRef.current) {
          window.clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        stateRef.current = 'retracting'
        retractTimerRef.current = window.setTimeout(async () => {
          const cursor2 = await cursorPosition()
          const cp2 = cursor2.toLogical(sf)
          const stillOutside =
            cp2.x < wp.x || cp2.x > wp.x + ws.width ||
            cp2.y < wp.y || cp2.y > wp.y + ws.height
          if (stillOutside && stateRef.current === 'retracting') {
            await retract()
          }
        }, RETRACT_DELAY)
      }
    }, POLL_INTERVAL)
  }, [])

  // ===== 缩回(用 edgeRef 直接获取目标边) =====
  const retract = useCallback(async () => {
    console.log('[EdgeDock] retract called, state:', stateRef.current, 'edge:', edgeRef.current)
    if (stateRef.current !== 'retracting') return

    // 清除所有定时器(包括 poll timer,防止 retract 动画被误判为拖动)
    if (retractTimerRef.current) {
      window.clearTimeout(retractTimerRef.current)
      retractTimerRef.current = null
    }
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }

    const edge = edgeRef.current
    if (!edge) return

    const monitor = await currentMonitor()
    if (!monitor) return

    const win = getCurrentWindow()
    const dockPos = getDockPosition(edge, monitor, winSizeRef.current.w, winSizeRef.current.h)
    await win.setPosition(dockPos)
    await win.setSkipTaskbar(true)

    stateRef.current = 'docked'
    stableCountRef.current = 0
    startCursorPolling()
  }, [getDockPosition, startCursorPolling])

  // ===== 完全取消吸附 =====
  const undock = useCallback(async () => {
    console.log('[EdgeDock] undock called, state:', stateRef.current)
    clearAllTimers()
    const win = getCurrentWindow()
    if (preDockPosRef.current) {
      await win.setPosition(
        new LogicalPosition(preDockPosRef.current.x, preDockPosRef.current.y)
      )
    }
    await win.setSkipTaskbar(false)
    stateRef.current = 'normal'
    edgeRef.current = null
    preDockPosRef.current = null
    stableCountRef.current = 0
    lastKnownPosRef.current = null
    // 设置冷却期,防止立即重新吸附
    cooldownRef.current = true
    window.setTimeout(() => {
      cooldownRef.current = false
    }, 3000)
    // 延迟重启位置轮询
    window.setTimeout(() => {
      if (enabledRef.current && startPositionCheckRef.current) startPositionCheckRef.current()
    }, 1500)
  }, [clearAllTimers])

  // ===== 启动位置轮询(检测拖动) =====
  const startPositionCheck = useCallback(() => {
    if (posCheckTimerRef.current) return
    console.log('[EdgeDock] startPositionCheck called')

    posCheckTimerRef.current = window.setInterval(async () => {
      if (!enabledRef.current) return
      if (stateRef.current !== 'normal') return
      // 每 10 次打印一次状态(避免日志过多)
      if (Math.random() < 0.05) console.log('[EdgeDock] pos check running, state:', stateRef.current)

      const win = getCurrentWindow()
      const monitor = await currentMonitor()
      if (!monitor) return

      const sf = monitor.scaleFactor
      const pos = await win.outerPosition()
      const lp = pos.toLogical(sf)
      // 跳过最小化状态（Windows 最小化位置为 -32000 左右）
      if (lp.x < -1000 || lp.y < -1000) return
      const size = await win.outerSize()
      winSizeRef.current = {
        w: size.toLogical(sf).width,
        h: size.toLogical(sf).height,
      }

      const last = lastKnownPosRef.current
      if (last && lp.x === last.x && lp.y === last.y) {
        stableCountRef.current++
        if (stableCountRef.current >= 3 && !cooldownRef.current) {
          const wa = monitor.workArea
          const waX = wa.position.toLogical(sf).x
          const waY = wa.position.toLogical(sf).y
          const waW = wa.size.toLogical(sf).width
          const w = winSizeRef.current.w

          if (lp.x <= waX + DOCK_THRESHOLD) {
            console.log('[EdgeDock] pos check: near left edge, docking')
            await dock('left')
          } else if (lp.x + w >= waX + waW - DOCK_THRESHOLD) {
            console.log('[EdgeDock] pos check: near right edge, docking')
            await dock('right')
          } else if (lp.y <= waY + DOCK_THRESHOLD) {
            console.log('[EdgeDock] pos check: near top edge, docking')
            await dock('top')
          }
        }
      } else {
        stableCountRef.current = 0
        lastKnownPosRef.current = { x: lp.x, y: lp.y }
      }
    }, POS_CHECK_INTERVAL)
  }, [dock])

  // 同步 ref,供 startRetractWatch 调用
  useEffect(() => {
    startPositionCheckRef.current = startPositionCheck
  }, [startPositionCheck])

  // ===== 主 effect =====
  useEffect(() => {
    const win = getCurrentWindow()
    let focusUnlisten: (() => void) | null = null

    if (!enabled) {
      if (stateRef.current !== 'normal') {
        undock()
      } else {
        if (posCheckTimerRef.current) {
          window.clearInterval(posCheckTimerRef.current)
          posCheckTimerRef.current = null
        }
      }
      return
    }

    // 启动延迟:等窗口完全就绪后再开始检测,避免启动时误吸附
    const initTimer = window.setTimeout(() => {
      startPositionCheck()
    }, 2000)

    // 监听焦点变化:Win+D 恢复后重启轮询
    win.onFocusChanged(({ payload: focused }) => {
      if (focused && stateRef.current === 'docked' && edgeRef.current) {
        // 窗口恢复焦点但仍在吸附态 → 重启鼠标轮询
        if (pollTimerRef.current) {
          window.clearInterval(pollTimerRef.current)
          pollTimerRef.current = null
        }
        startCursorPolling()
      }
    }).then(fn => { focusUnlisten = fn })

    return () => {
      window.clearTimeout(initTimer)
      clearAllTimers()
      if (focusUnlisten) focusUnlisten()
    }
  }, [enabled, undock, clearAllTimers, startPositionCheck, startCursorPolling])

  return { undock }
}
