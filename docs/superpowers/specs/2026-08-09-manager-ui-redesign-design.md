# Manager UI Redesign: Minimal Bookmark-Style Layout

**Date:** 2026-08-09
**Status:** Draft

## Overview

Redesign the main manager window from a 1200×800 two-column layout to a minimal 280px-wide bookmark-style interface with transparent background and frosted glass cards.

## Goals

1. Narrow bookmark-width window (~280px)
2. Pure transparent window background
3. Frosted glass effect on each note card
4. Inline editing in collapsed state (no expand required)

## Design

### Layout

```
┌──┬────────────────────┐
│全│ 📝 会议记录      ● │  ← ● = sync status (future)
│部│   明天下午3点...    │
│  │                    │
│工├────────────────────┤
│作│ ☑ 待办清单         │
│  │   买菜、做饭...    │
│个├────────────────────┤
│人│ 📝 读书笔记         │
│  │   第三章...        │
│学├────────────────────┤
│习│ 📝 旅行计划         │
│  │   下周去上海...    │
│  │                    │
│＋│                    │
└──┴────────────────────┘
 ↑          ↑
36px       244px
```

- **Window width:** 280px
- **Category sidebar:** 36px wide (left)
- **Note list:** 244px wide (right)

### Category Sidebar (36px)

- Width: 36px, full height
- Font: 11px, vertical text layout
- Selected item: 2px left color bar + subtle background highlight
- No border, blends with transparent background
- Bottom: `+` button (small, minimal) to add category
- Scrollable if many categories

### Note List (244px)

- Each card: frosted glass effect
  - `backdrop-filter: blur(12px)`
  - `background: rgba(255, 255, 255, 0.15)`
  - Border-radius: 8px
  - Subtle border: `1px solid rgba(255, 255, 255, 0.1)`
- Card content:
  - Icon (📝 or ☑) + Title (13px, bold)
  - Summary line (11px, semi-transparent)
- Hover: subtle glow effect
- Scrollbar: 3px thin

### Window Background

- Pure transparent (Tauri window decorations off)
- No background color on root element
- Cards float on transparent surface

### Inline Editing (Collapsed State)

- Click on card → title becomes editable input
- Click on summary → content becomes editable textarea
- Auto-save on blur or after 300ms debounce
- Visual feedback: border highlight on focus

### Tauri Window Configuration

- Window size: 280×600 (width×height)
- Decorations: false (frameless)
- Transparent: true
- Always on top: optional (user toggle)

## Implementation Notes

### Files to Modify

1. **src-tauri/tauri.conf.json** - Window dimensions, transparency
2. **src/App.css** - Complete rewrite for new layout
3. **src/App.tsx** - Remove sidebar, add top/side category selector, inline editing
4. **src/index.css** - Transparent background base

### CSS Changes

- Remove: `.sidebar` (200px), `.manager-main` flex layout
- Add: `.category-bar` (36px vertical), `.note-card` frosted glass
- Update: `.note-row` → `.note-card` with backdrop-filter
- Add: `.editing` state styles for inline edit mode

### Component Changes

- App.tsx: Remove sidebar JSX, add vertical category bar
- Add inline edit state management (editingNoteId, editingField)
- Update note click handler to enter edit mode

### Rust Changes

- tauri.conf.json: Set window to transparent, smaller size
- May need to update window creation in main.rs for transparency

## Success Criteria

- [ ] Window displays at 280px width
- [ ] Background is fully transparent
- [ ] Note cards have visible frosted glass effect
- [ ] Categories display vertically in 36px sidebar
- [ ] Click on note card enables inline editing
- [ ] All existing functionality preserved (add, delete, pin, search)

## Future Considerations: Server-Side Sync

The UI should accommodate a planned server-side sync feature:

**Architecture (Planned):**
- Self-built account system
- Real-time synchronization
- Alibaba Cloud lightweight server with BaoTa panel (Linux)
- Last-write-wins conflict resolution

**UI Implications (Reserve Space For):**
- Sync status indicator (top-right corner): synced / syncing / offline
- Login/logout button in settings or sidebar
- Account avatar or initial in header
- "Last synced" timestamp

**Design Note:** Current implementation is local-only. The UI layout should reserve a small area (top-right or bottom) for future sync status without requiring major redesign.

## Out of Scope

- Note window (individual sticky notes) - unchanged
- Category reordering
- Drag-and-drop notes between categories
- Custom themes or colors
- Server-side sync (future feature, UI reserved only)
