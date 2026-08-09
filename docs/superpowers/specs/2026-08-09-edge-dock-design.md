# Edge Docking Design

## Overview

QQ-style edge docking for the sticky notes manager window. When dragged to a screen edge, the window auto-hides to a 4px strip. Mouse hover reveals it, mouse leave auto-hides after 800ms. Toggleable via settings.

## Requirements

- Support left, right, and top screen edges
- Dock threshold: 15px from screen edge
- Docked strip: 4px visible
- Hide from taskbar when docked
- Mouse hover on strip reveals window
- Mouse leave retracts after 800ms delay (with cursor re-check)
- Toggle on/off, persisted in localStorage (default: on)
- Settings entry: gear icon at bottom of category sidebar

## Architecture

Pure frontend implementation using a `useEdgeDock` custom hook with Tauri JS window APIs.

### State Machine

```
normal → (drag near edge) → docked
docked → (mouse enters strip) → revealed
revealed → (mouse leaves) → retracting
retracting → (800ms expires, cursor outside) → docked
retracting → (cursor re-enters) → revealed
docked/revealed → (drag away) → normal
```

### Hook: `useEdgeDock(enabled: boolean)`

Responsibilities:
1. Listen to `onMoved` — detect edge proximity after drag ends
2. `dock(edge)` — move window off-screen, `setSkipTaskbar(true)`, start polling
3. `reveal()` — restore window position, stop polling, listen for `mouseleave`
4. `retract()` — 800ms delay, re-check cursor, move off-screen
5. Polling: `setInterval(200ms)` calling `cursorPosition()` while docked

Window size stays constant (280×600). Only position changes.

### Edge Detection

```
monitor = currentMonitor()
workArea = monitor.workArea  // excludes taskbar
winPos = outerPosition()
winSize = outerSize()

if (winPos.x <= workArea.x + 15)                    → dock left
if (winPos.x + winSize.w >= workArea.x + workArea.w - 15) → dock right
if (winPos.y <= workArea.y + 15)                    → dock top
```

### Dock Positions

- Left: `setPosition(workArea.x - winSize.w + 4, winPos.y)`
- Right: `setPosition(workArea.x + workArea.w - 4, winPos.y)`
- Top: `setPosition(winPos.x, workArea.y - winSize.h + 4)`

### Reveal/Retract

**Reveal**: `setPosition` to saved pre-dock position. Stop polling. Add `mouseleave` listener on window.

**Retract**: On `mouseleave`, start 800ms timer. After expiry, `cursorPosition()` check — if cursor is outside window bounds, `setPosition` back to docked position. If cursor re-entered, cancel timer.

### Drag from Docked State

When `startDragging()` is called while docked: first `reveal()` to restore position, then allow drag to proceed. Otherwise user drags an invisible window.

## Settings UI

### Entry Point

Gear icon (⚙) below the "+" add-category button in the category sidebar.

### Settings Panel

Replacing the note list area when activated:
- Edge docking toggle (default: on)
- Future: keyboard shortcuts, themes, etc.

Navigation: click ⚙ to show settings, click ⚙ again or any category to dismiss.

## Files to Change

| File | Action | Description |
|------|--------|-------------|
| `src/hooks/useEdgeDock.ts` | Create | Core hook with state machine, polling, edge detection |
| `src/components/SettingsPanel.tsx` | Create | Settings panel with toggle |
| `src/App.tsx` | Modify | Integrate useEdgeDock, add ⚙ button, settings panel switching |
| `src/App.css` | Modify | ⚙ button, settings panel styles |
| `src-tauri/capabilities/default.json` | Modify | Add window permissions |

No Rust backend changes. No changes to NoteApp.tsx or types.ts.

## Required Permissions

```json
"core:window:allow-set-position",
"core:window:allow-outer-position",
"core:window:allow-outer-size",
"core:window:allow-on-moved",
"core:window:allow-current-monitor",
"core:window:allow-cursor-position",
"core:window:allow-set-skip-taskbar"
```

## Edge Cases

- Multi-monitor: use `currentMonitor()` to get the monitor the window is currently on
- Window minimize/restore: if docked, restore to docked state (not revealed)
- Settings toggle off while docked: immediately `reveal()` then disable
- Startup with localStorage edgeDock=false: skip hook initialization entirely
