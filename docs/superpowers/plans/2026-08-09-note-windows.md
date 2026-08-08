# 独立便签窗口重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"便签作为主窗口内 div"的架构重构为"每张便签 = 一个独立原生窗口",让便签散落桌面、独立存活、随手记录,管理器退为列表/分类/搜索入口。

**Architecture:** Tauri 多窗口模型。每张便签是一个 `note-<id>` 标签的无边框透明置顶小窗口,统一加载 `note.html?id=<id>`;管理器(main 窗口)改为普通窗口,主区域是便签列表。数据仍走 SQLite(db.rs 唯一出入口)+ `notes-updated` 事件广播(仅增/删/置顶变化时广播)。便签窗口内独立 300ms 防抖落库,不参与广播。紧凑/展开两态用 DB 里的 width 阈值判定(width ≥ 320 视为展开)。

**Tech Stack:** Tauri 2 / React 19 / TypeScript / Vite / rusqlite / tauri-plugin-global-shortcut

**设计文档:** `docs/superpowers/specs/2026-08-09-note-windows-design.md`(实现前必读,本计划是它的执行分解)

## Global Constraints

- 项目**不是 git 仓库**:所有任务不做 git commit 步骤(如需版本管理,先 `git init` + 首提交,但不属于本计划范围)
- 前端编译检查:`npx tsc -b`;lint:`npx oxlint src`;Rust 检查:在 `src-tauri/` 下 `cargo check`(首次移除依赖后全量编译约 2 分钟)
- 运行验证:`npm run tauri dev`(窗口直接出现在桌面);改 Rust 需重启 dev,改前端热更新
- UI 文案为中文;错误处理沿用现有模式:`Result<_, String>` + 前端 `console.error`
- 数据访问只允许通过 `src-tauri/src/db.rs` 的函数;前端只通过 `invoke` 调用 `src-tauri/src/main.rs` 里注册的 command
- 便签默认尺寸:紧凑 240×200、展开 360×420;最小 180×120
- 便签窗口标签一律 `note-<id>`;id 为 DB 主键
- 事件广播语义:**仅** `add_note` / `delete_note` / `update_note` 且置顶状态变化时发 `notes-updated`;便签编辑静默落库
- 新建便签:`is_pinned = true`、`opacity = 1`、初始展开态、落在光标所在显示器中央

---

### Task 1: 数据层 — meta 表与 v1→v2 迁移

**Files:**
- Modify: `src-tauri/src/db.rs`(init_db、新增 migrate 函数)

**Interfaces:**
- Produces: `db::migrate(conn: &Connection) -> Result<()>` — 在 `init_db` 之后、`app.manage` 之前调用;读 `meta` 表 `schema_version`,小于 2 时执行:所有便签 x/y 重置为屏幕级联位置(100 + 按 id 排序序号×40),width/height 重置为 240×200,然后写入 `schema_version = 2`。

- [ ] **Step 1: 在 `init_db` 的 execute_batch 中追加 meta 表**

```rust
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

- [ ] **Step 2: 新增 `migrate` 函数(放在 `init_db` 之后)**

```rust
pub fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get(0))
        .unwrap_or(0);

    if version < 2 {
        // v1 → v2:旧坐标是主窗口内相对坐标,无迁移价值,重置为屏幕级联位置
        conn.execute_batch(
            "UPDATE notes SET
                x = 100 + (id - (SELECT MIN(id) FROM notes)) * 40.0,
                y = 100 + (id - (SELECT MIN(id) FROM notes)) * 40.0,
                width = 240.0,
                height = 200.0;"
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')",
            [],
        )?;
    }
    Ok(())
}
```

- [ ] **Step 3: 在 `src-tauri/src/main.rs` 的 setup 里调用迁移**

在 `db::init_db(&conn).expect(...)` 之后加一行:

```rust
db::migrate(&conn).expect("failed to migrate database");
```

- [ ] **Step 4: 编译检查**

Run: `cd src-tauri && cargo check`
Expected: Finished,无错误

- [ ] **Step 5: 运行验证**

Run: `npm run tauri dev`
Expected: 应用启动正常;若 `%APPDATA%\com.stickynotes.app\sticky_notes.db` 里已有旧便签,位置变为斜向级联、尺寸 240×200;sqlite3 或再次重启后 meta 表有 `schema_version=2`(用 `SELECT * FROM meta;` 可查,无 sqlite3 则跳过)。

---

### Task 2: 窗口生命周期(Rust)+ note 页面骨架

**Files:**
- Modify: `src-tauri/src/main.rs`(窗口管理 helper、add_note/delete_note 改造、get_note 新 command)
- Modify: `src-tauri/capabilities/default.json`(note-* 通配 + 新权限)
- Modify: `vite.config.ts`(note 入口)
- Create: `note.html`、`src/NoteApp.tsx`(骨架版)、`src/note.css`(骨架版)

**Interfaces:**
- Produces:
  - `fn create_note_window(app: &tauri::AppHandle, note: &db::Note) -> tauri::Result<tauri::WebviewWindow>` — 标签 `note-<id>` 已存在则直接返回(幂等);否则按 note.width/height 建窗,无边框透明,`always_on_top(note.is_pinned)`,URL `note.html?id=<id>`
  - `fn centered_position(app: &tauri::AppHandle, w: f64, h: f64) -> (f64, f64)` — 光标所在显示器内居中,取不到光标/显示器时回退 (100.0, 100.0)
  - command `get_note(state, id: i64) -> Result<db::Note, String>`
  - command `add_note(...)` 改造:插入后建窗、把真实窗口位置写回 DB、show + set_focus
  - command `delete_note(...)` 改造:先销毁 `note-<id>` 窗口再删行
  - command `open_note(app, id: i64) -> Result<(), String>` — 窗口不存在则建,存在则 show + set_focus,然后给该窗口 emit `"highlight"` 事件

- [ ] **Step 1: capabilities 加 note-* 与窗口权限**

`src-tauri/capabilities/default.json`:
- `"windows"` 改为 `["main", "note-*"]`
- permissions 追加:`"core:window:allow-set-size"`、`"core:window:allow-set-always-on-top"`(其余权限现有列表已含:start-dragging/show/hide/close/set-focus/event:default)

- [ ] **Step 2: vite 增加 note 入口**

`vite.config.ts` 的 `input` 增加 `note: resolve(__dirname, 'note.html')`(pinned 入口本轮保留,Task 5 删除)。

- [ ] **Step 3: 根目录创建 `note.html`**

仿照 `index.html`(同构 title、`<div id="root">`、`<script type="module" src="/src/NoteApp.tsx">`),`<title>便签</title>`。

- [ ] **Step 4: main.rs 增加窗口管理 helper**

```rust
fn centered_position(app: &tauri::AppHandle, w: f64, h: f64) -> (f64, f64) {
    let Some(cursor) = app.cursor_position().ok() else {
        return (100.0, 100.0);
    };
    let Some(monitor) = app.monitor_from_point(cursor.x as i32, cursor.y as i32).ok().flatten() else {
        return (100.0, 100.0);
    };
    let msize = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let mpos = monitor.position().to_logical::<f64>(monitor.scale_factor());
    let x = mpos.x + ((msize.width - w) / 2.0).max(0.0);
    let y = mpos.y + ((msize.height - h) / 2.0).max(0.0);
    (x, y)
}

fn create_note_window(app: &tauri::AppHandle, note: &db::Note) -> tauri::Result<tauri::WebviewWindow> {
    let label = format!("note-{}", note.id);
    if let Some(w) = app.get_webview_window(&label) {
        return Ok(w);
    }
    let (x, y) = centered_position(app, note.width, note.height);
    tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App(format!("note.html?id={}", note.id).into()),
    )
    .title("便签")
    .inner_size(note.width, note.height)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(note.is_pinned)
    .build()
}
```

- [ ] **Step 5: 改造 `add_note` — 建窗 + 真实位置回写 + 聚焦**

```rust
#[tauri::command]
fn add_note(app: tauri::AppHandle, state: tauri::State<DbConn>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let conn = state.0.lock().unwrap();
    // 新建便签:展开态(360×420)、默认置顶、不透明
    let note = db::Note {
        id: 0,
        title,
        content: String::new(),
        note_type,
        category_id,
        x: 0.0,
        y: 0.0,
        width: 360.0,
        height: 420.0,
        opacity: 1.0,
        is_pinned: true,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut note = db::add_note(&conn, &note).map_err(|e| e.to_string())?;
    let window = create_note_window(&app, &note).map_err(|e| e.to_string())?;
    if let Ok(pos) = window.outer_position() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical = pos.to_logical::<f64>(scale);
        note.x = logical.x;
        note.y = logical.y;
        let _ = db::update_note(&conn, &note);
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("notes-updated", ());
    Ok(note)
}
```

- [ ] **Step 6: 改造 `delete_note` — 先销毁窗口**

```rust
#[tauri::command]
fn delete_note(app: tauri::AppHandle, state: tauri::State<DbConn>, id: i64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = window.destroy();
    }
    let conn = state.0.lock().unwrap();
    let result = db::delete_note(&conn, id).map_err(|e| e.to_string());
    let _ = app.emit("notes-updated", ());
    result
}
```

- [ ] **Step 7: 新增 `get_note` 与 `open_note` command,并注册**

```rust
#[tauri::command]
fn get_note(state: tauri::State<DbConn>, id: i64) -> Result<db::Note, String> {
    let conn = state.0.lock().unwrap();
    db::get_note_by_id(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_note(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = app.state::<DbConn>();
    let note = db::get_note_by_id(&conn.0.lock().unwrap(), id).map_err(|e| e.to_string())?;
    let window = create_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("highlight", ());
    Ok(())
}
```

`generate_handler!` 列表中加入 `get_note, open_note`。

- [ ] **Step 8: db.rs 增加 `get_note_by_id`**

```rust
pub fn get_note_by_id(conn: &Connection, id: i64) -> Result<Note> {
    conn.query_row(
        "SELECT id, title, content, note_type, category_id, x, y, width, height, opacity, is_pinned, created_at, updated_at FROM notes WHERE id = ?1",
        params![id],
        |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                note_type: row.get(3)?,
                category_id: row.get(4)?,
                x: row.get(5)?,
                y: row.get(6)?,
                width: row.get(7)?,
                height: row.get(8)?,
                opacity: row.get(9)?,
                is_pinned: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        },
    )
}
```

- [ ] **Step 9: 骨架版 `src/NoteApp.tsx`(窗口可打开、显示标题即可)**

```tsx
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Note } from './types'
import './note.css'

const id = Number(new URL(window.location.href).searchParams.get('id'))

function NoteApp() {
  const [note, setNote] = useState<Note | null>(null)

  useEffect(() => {
    invoke<Note>('get_note', { id }).then(setNote).catch(console.error)
  }, [])

  if (!note) return <div className="note-root">加载中…</div>

  return (
    <div className="note-root" onMouseDown={(e) => {
      if (e.button === 0 && !(e.target as HTMLElement).closest('.note-body')) {
        getCurrentWindow().startDragging().catch(() => {})
      }
    }}>
      <div className="note-header">
        <span className="note-title-text">{note.title || '无标题'}</span>
        <button onClick={() => getCurrentWindow().hide()}>×</button>
      </div>
    </div>
  )
}

export default NoteApp
```

`src/note.css` 骨架:`.note-root` 全屏透明背景、`.note-header` 顶部条、`.note-body` 预留。

- [ ] **Step 10: 编译 + 运行验证**

Run: `npx tsc -b && npx oxlint src`,再 `cd src-tauri && cargo check`
Expected: 全部通过

Run: `npm run tauri dev`,点管理器或托盘的新建按钮
Expected: 出现一个 360×420 的透明小窗口(标题显示"新建便签"),位于光标所在显示器中央,自动获得焦点;拖动标题区可移动;点 × 隐藏。**注意:此时 note 页面只有标题壳,完整交互是 Task 3。**

---

### Task 3: note 页面完整交互(紧凑/展开、编辑、防抖保存)

**Files:**
- Modify: `src/NoteApp.tsx`(完整实现)、`src/note.css`(完整样式)

**Interfaces:**
- Consumes: `get_note(id)`、`update_note(note)`、`delete_note(id)`、`get_all_todos()`、`update_todo(item)`、`add_todo(noteId, content)`、`delete_todo(id)`、`notes-updated` 事件(仅监听,用于高亮等)
- Produces: 便签窗口的完整 UX(本任务无下游依赖)

**实现要点(全部写入本任务代码,不引用其他任务):**

1. **状态判定**:窗口 `innerSize()` 的 width ≥ 320 → 展开态;否则紧凑态。加载后按此渲染初始态。
2. **防抖保存**(与旧 App.tsx 同模式,但只服务单张便签):`pendingRef: { note?: Note, todos: Map<number, TodoItem> }` + 300ms 定时器;`flush()` 把 pending 里的 note 与 todos 并行 invoke;`blur` / `beforeunload` / 卸载时 flush。
3. **紧凑态**:标题 + 摘要(文字:前 4 行;待办:前 3 条 + "还有 N 项");双击卡片任意处 → 展开。
4. **展开态**:标题 input + 内容 textarea(文字)或待办清单(勾选/编辑/删除/新增);收起按钮。
5. **展开/收起切换**:`setSize(360, 420)` / `setSize(240, 200)`,以左上角为锚点,并把 width/height 写库(防抖 flush 带上即可)。
6. **拖拽**:标题区 `startDragging`(仅左键);**缩放**:右下角 resize 手柄,onMouseUp 时 `setSize` 写回(最小 180×120)——resize 不写库每次 move,只写最终值。
7. **置顶按钮**:切换后 `invoke('update_note', {note: 全量最新})`(触发 Rust 置顶广播)+ `setAlwaysOnTop`。
8. **右键菜单**:置顶开关、删除、透明度滑块、收起/展开。
9. **删除**:`invoke('delete_note', {id})` → Rust 销毁窗口;前端不需要额外处理。
10. **高亮**:`listen('highlight', ...)` → root 加 1.5s CSS 高亮类(边框发光)。
11. 监听 `notes-updated` → 重拉 `get_note` + `get_all_todos`(另一窗口改了置顶/删除时同步)。

- [ ] **Step 1: 完整实现 `src/NoteApp.tsx`**

按上述要点实现(300 行以内,紧凑/展开渲染 + 防抖 flush + 右键菜单 + 事件监听)。核心防抖骨架:

```tsx
const pendingRef = useRef<{ note?: Note; todos: Map<number, TodoItem> }>({ note: undefined, todos: new Map() })
const timerRef = useRef<number | null>(null)

const flush = useCallback(async () => {
  if (timerRef.current) { window.clearTimeout(timerRef.current); timerRef.current = null }
  const pending = pendingRef.current
  pendingRef.current = { note: undefined, todos: new Map() }
  if (pending.note) await invoke('update_note', { note: pending.note })
  const items = Array.from(pending.todos.values())
  if (items.length) await Promise.all(items.map((it) => invoke('update_todo', { item: it })))
}, [])

const schedule = useCallback((updater: () => void) => {
  updater()
  if (timerRef.current) window.clearTimeout(timerRef.current)
  timerRef.current = window.setTimeout(flush, 300)
}, [flush])
```

**展开/收起切换(状态阈值 width ≥ 320,以左上角为锚点):**

```tsx
const win = getCurrentWindow()

const setWindowState = useCallback(async (expanded: boolean) => {
  const w = expanded ? 360 : 240
  const h = expanded ? 420 : 200
  await win.setSize(new LogicalSize(w, h))
  // 同步本地 note 的 width/height 进 pending,随防抖落库
  pendingRef.current.note = { ...pendingRef.current.note!, width: w, height: h }
  setExpanded(expanded)
  schedule(() => {})
}, [schedule])
```

(`LogicalSize` 从 `@tauri-apps/api/dpi` 导入;`setExpanded` 为本地 state,初始值由加载后 `win.innerSize()` 的 width ≥ 320 判定)

- [ ] **Step 2: 完整样式 `src/note.css`**

紧凑态:透明背景、圆角卡片、字号适中;展开态:白底/半透明白卡片、编辑控件排版;`.note-highlight` 高亮动画(1.5s 边框发光,`@keyframes`)。

- [ ] **Step 3: 编译检查**

Run: `npx tsc -b && npx oxlint src`
Expected: 全部通过

- [ ] **Step 4: 运行验证(对照设计文档第 8 节清单第 1/3/4/5/6/8/9 条)**

Run: `npm run tauri dev`(dev 热更新即可,不必重启)
Expected:
- 新建便签 → 展开态出现,可直接打字;失焦 300ms 内落库(杀进程重启数据在)
- 双击 → 收起到 240×200;再双击 → 展开,位置不跳
- 拖拽出屏幕边界自由、置顶开关生效(关掉后窗口沉到其他应用后)
- 待办:紧凑显示前 3 条 + 剩余计数,展开完整编辑
- 右键菜单:删除 → 窗口消失;透明度生效
- 重启 dev 后,便签按存储尺寸恢复紧凑/展开态

---

### Task 4: 管理器改造(main 窗口:画布 → 列表)

**Files:**
- Modify: `src/App.tsx`(主区域画布改列表,保留侧边栏分类)
- Modify: `src/App.css`(列表样式;删除便签卡片相关样式可留)
- Modify: `src-tauri/tauri.conf.json`(main 窗口去透明/去置顶/去无边框)

**Interfaces:**
- Consumes: `get_categories`/`add_category`/`delete_category`、`get_notes`、`get_all_todos`、`add_note`(Rust 已改为建窗)、`delete_note`、`update_note`、`open_note(id)`、`notes-updated`

- [ ] **Step 1: tauri.conf.json 的 main 窗口改为普通窗口**

`app.windows[0]` 改为:

```json
{
  "title": "便签管理器",
  "width": 1200,
  "height": 800
}
```

(删除 `decorations: false`、`transparent: true`、`alwaysOnTop: true`)

- [ ] **Step 2: 重写 `src/App.tsx` 主区域为便签列表**

保留:分类侧边栏(含新增分类)、置顶/删除逻辑的 command 调用、右键上下文、`notes-updated` 监听、加载函数。**删除**:notes 画布(绝对定位卡片、拖拽、缩放、z 轴、透明度滑块、note 内编辑 UI)。**新增**:

- 顶部搜索框:按标题/内容 `includes` 过滤(不区分大小写)
- 列表行:类型图标(📝/☑)、标题、内容摘要(首行)、`updated_at`(格式化 `YYYY-MM-DD HH:mm`)、📌 标记、所属分类名
- 双击行 → `invoke('open_note', { id })`
- 行内按钮:置顶开关(调 `update_note`)、删除(调 `delete_note`)
- 刷新:挂载时 + `notes-updated` 时 + 窗口 `focus` 时(tauri 的 `getCurrentWindow().onFocusChanged`)各拉一次 `get_notes` + `get_all_todos`
- 新建按钮:+ 文字便签 / + 待办(调 `add_note`,Rust 侧会建窗)

- [ ] **Step 3: 编译检查**

Run: `npx tsc -b && npx oxlint src`
Expected: 全部通过

- [ ] **Step 4: 运行验证(设计文档第 8 节第 2/3/10 条)**

Run: `npm run tauri dev`
Expected: 管理器是有边框的普通窗口;列表显示全部便签;双击某行 → 对应便签窗口浮现并高亮 1.5s;关闭管理器 → 便签仍在;托盘"显示管理器" → 回来;搜索/分类过滤生效;行内删除、置顶生效。

---

### Task 5: 托盘菜单重构 + 全局快捷键 + 移除置顶列表

**Files:**
- Modify: `src-tauri/src/main.rs`(托盘菜单、全局快捷键、删 show_pinned_window)
- Modify: `src-tauri/Cargo.toml`(加 tauri-plugin-global-shortcut)
- Modify: `vite.config.ts`(删 pinned 入口)
- Delete: `pinned.html`、`src/PinnedApp.tsx`、`src/pinned.tsx`、`src/pinned.css`

**Interfaces:**
- Consumes: `add_note`、`create_note_window`、main 窗口 show/focus

- [ ] **Step 1: Cargo.toml 加依赖**

```toml
tauri-plugin-global-shortcut = "2"
```

- [ ] **Step 2: 抽共享新建函数,托盘/快捷键/command 三路复用**

在 main.rs 新增(放在 `create_note_window` 之后),`add_note` command 改为薄包装调用它:

```rust
fn create_note(app: &tauri::AppHandle, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let conn = app.state::<DbConn>();
    let note = db::Note {
        id: 0,
        title,
        content: String::new(),
        note_type,
        category_id,
        x: 0.0,
        y: 0.0,
        width: 360.0,
        height: 420.0,
        opacity: 1.0,
        is_pinned: true,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let mut note = db::add_note(&conn.0.lock().unwrap(), &note).map_err(|e| e.to_string())?;
    let window = create_note_window(app, &note).map_err(|e| e.to_string())?;
    if let Ok(pos) = window.outer_position() {
        let scale = window.scale_factor().unwrap_or(1.0);
        let logical = pos.to_logical::<f64>(scale);
        note.x = logical.x;
        note.y = logical.y;
        let _ = db::update_note(&conn.0.lock().unwrap(), &note);
    }
    let _ = window.show();
    let _ = window.set_focus();
    let _ = app.emit("notes-updated", ());
    Ok(note)
}

#[tauri::command]
fn add_note(app: tauri::AppHandle, state: tauri::State<DbConn>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let _ = state;
    create_note(&app, title, note_type, category_id)
}
```

(Task 2 Step 5 的 add_note 原实现被此函数取代——实现 Task 5 时把 Task 2 写的 add_note 体替换为上面这个薄包装)

- [ ] **Step 3: 托盘菜单重构 + 注册全局快捷键**

menu items 改为:`show`(显示管理器)、`new_text`(新建文字便签)、`new_todo`(新建待办)、`quit`(退出)。`on_menu_event` 处理:

```rust
"new_text" | "new_todo" => {
    let note_type = if event.id().as_ref() == "new_text" { "text" } else { "todo" };
    let title = if note_type == "todo" { "新建待办" } else { "新建便签" };
    let _ = create_note(&app.clone(), title.to_string(), note_type.to_string(), None);
}
```

快捷键:

```rust
.plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

setup 里:

```rust
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

for (s, note_type) in [("Ctrl+Alt+N", "text"), ("Ctrl+Alt+T", "todo")] {
    let Ok(shortcut) = s.parse::<Shortcut>() else { continue };
    let nt = note_type.to_string();
    app.global_shortcut().on_shortcut(shortcut, move |_app, _shortcut, event| {
        if !event.state().is_pressed() { return; }
        let title = if nt == "todo" { "新建待办" } else { "新建便签" };
        let _ = create_note(_app, title.to_string(), nt.clone(), None);
    })?;
}
```

(快捷键与其他应用冲突时 `on_shortcut` 注册返回 Err——用 `let ... else { continue }` 跳过冲突项,不阻塞启动。注意 `GlobalShortcutExt`/`Shortcut` 的解析语法以实际 crate 版本为准,cargo check 会提示;此处是意图,编译报错时按 crate 文档微调)

- [ ] **Step 4: 删除 pinned 相关**

- main.rs:删 `show_pinned_window` 函数及其在 `generate_handler!` 与 `on_menu_event`("pinned" 分支)里的引用
- vite.config.ts:`input` 只留 `main` 与 `note`
- 删除 `pinned.html`、`src/PinnedApp.tsx`、`src/pinned.tsx`、`src/pinned.css`
- capabilities 的 `windows` 已在上轮改为 `["main", "note-*"]`(Task 2 Step 1),确认无 "pinned" 残留

- [ ] **Step 5: 编译检查**

Run: `cd src-tauri && cargo check`(新增依赖首次编译较慢),再 `npx tsc -b && npx oxlint src`
Expected: 全部通过

- [ ] **Step 6: 运行验证(设计文档第 8 节第 10/11 条)**

Run: `npm run tauri dev`
Expected: 托盘菜单四项可用;任意应用内按 Ctrl+Alt+N / Ctrl+Alt+T 弹出新建便签(展开态、焦点、光标所在显示器);旧"置顶列表"入口与文件全部消失。

---

### Task 6: 全量回归验证

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-note-windows-design.md`(若有实现偏差,记录决策并同步)

- [ ] **Step 1: 对照设计文档第 8 节 11 条清单逐项验证**

Run: `npm run tauri dev` 后逐条走查;第 7 条(升级迁移)用旧库验证,第 5 条(重启数据完整)杀进程重启验证。

- [ ] **Step 2: 编译与 lint 全绿**

Run: `cd src-tauri && cargo check && cd .. && npx tsc -b && npx oxlint src`
Expected: 全部通过,无 warning

- [ ] **Step 3: 记录实现偏差**

若实现与设计文档有出入(如快捷键 API 差异、状态判定细节),把最终行为补写进设计文档的相应小节,保持文档与代码一致。

---

## 执行顺序说明

任务间依赖:Task 1 → 2 → 3 → 4 → 5 → 6 严格串行(3 依赖 2 的 command 与骨架;4 依赖 2 的 `open_note`;5 依赖 2 的 `add_note` 改造)。每个任务结束时应用处于可运行、可验证状态。
