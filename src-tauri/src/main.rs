#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use std::sync::{Mutex, mpsc};
use std::collections::HashMap;
use std::path::Path;
use rusqlite::Connection;
use serde_json::json;

mod db;

pub struct DbConn(pub Mutex<Connection>);

pub struct AppState {
    pub db: DbConn,
    pub device_id: String,
    pub shortcuts: Mutex<HashMap<String, Shortcut>>,
    pub queue_lock: Mutex<()>,
}

#[derive(serde::Serialize)]
struct ShortcutInfo {
    kind: String,
    keys: String,
    registered: bool,
}

#[derive(serde::Serialize)]
struct PrivacyStatus {
    has_password: bool,
    questions: Vec<String>,
}

#[derive(serde::Deserialize)]
struct SetPrivacyReq {
    password: String,
    q1: String,
    a1: String,
    q2: String,
    a2: String,
}

const DEFAULT_SHORTCUTS: [(&str, &str); 3] = [
    ("new_note", "Ctrl+Shift+N"),
    ("clipboard_note", "Ctrl+Shift+V"),
    ("capture", "Ctrl+Shift+Q"),
];

// ============ 数据目录解析(便携模式) ============

/// 纯逻辑:exe 目录下存在 portable.txt 标记文件时,数据存 exe 旁的 data\ 目录,
/// 否则回落系统 AppData。拆出纯函数便于单元测试。
fn resolve_data_dir(exe_dir: Option<&Path>, appdata: &Path) -> std::path::PathBuf {
    match exe_dir {
        Some(d) if d.join("portable.txt").exists() => d.join("data"),
        _ => appdata.to_path_buf(),
    }
}

/// 数据目录:便携模式(免安装 exe 旁放 portable.txt)→ exe\data\;
/// 否则 → 系统 AppData\com.stickynotes.app(与 exe 所在盘无关)。
fn data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    resolve_data_dir(exe_dir.as_deref(), &app.path().app_data_dir().unwrap())
}

// ============ 时间轴 / 离线队列 辅助 ============

fn log_timeline_in(conn: &Connection, device_id: &str, entry: db::TimelineEntry) {
    let mut e = entry;
    if e.id.is_empty() {
        e.id = db::new_uuid();
    }
    if e.device_id.is_none() {
        e.device_id = Some(device_id.to_string());
    }
    let _ = db::add_timeline(conn, &e);
}

fn snapshot_json(note: &db::Note) -> Option<String> {
    serde_json::to_string(note).ok()
}

/// 离线队列「写入侧」预埋(见 LOGIN_SYNC_SPEC §12.3):只记录,不上传。
fn queue_change(app: &tauri::AppHandle, entity: &str, id: i64, action: &str) {
    let state = app.state::<AppState>();
    let _guard = state.queue_lock.lock().unwrap();
    let path = data_dir(app).join("sync_queue.json");
    let mut queue: Vec<serde_json::Value> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    queue.push(json!({ "entity": entity, "id": id, "action": action, "timestamp": ts, "synced": false }));
    while queue.len() > 10000 {
        queue.remove(0);
    }
    let _ = std::fs::write(&path, serde_json::to_string(&queue).unwrap_or_default());
}

fn mark_unsynced(conn: &Connection, table: &str, id: i64) {
    let _ = conn.execute(&format!("UPDATE {} SET synced = 0 WHERE id = ?1", table), [id]);
}

// ============ 便签创建 ============

fn base_note(title: &str, note_type: &str, category_id: Option<i64>) -> db::Note {
    db::Note {
        id: 0,
        uuid: String::new(),
        title: title.to_string(),
        content: String::new(),
        note_type: note_type.to_string(),
        category_id,
        x: 0.0,
        y: 0.0,
        width: 360.0,
        height: 420.0,
        opacity: 1.0,
        is_pinned: false,
        color: "#FFE066".to_string(),
        sort_order: 0,
        window_style: "glass".to_string(),
        status: "active".to_string(),
        deleted_by: None,
        trashed_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn first_line_title(text: &str) -> String {
    let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    // 内容为空时标题也留空:空便签在关闭窗口时会被丢弃,不再以「新建便签」占位文字落库
    first.chars().take(30).collect()
}

/// 新建便签共享逻辑:command / 托盘 / 全局快捷键 / 闪电捕获 多路复用。
fn create_note(app: &tauri::AppHandle, note: db::Note, open_window: bool) -> Result<db::Note, String> {
    let state = app.state::<AppState>();
    let mut note = db::add_note(&state.db.0.lock().unwrap(), &note).map_err(|e| e.to_string())?;
    if open_window {
        let window = create_note_window(app, &note).map_err(|e| e.to_string())?;
        if let Ok(pos) = window.outer_position() {
            let scale = window.scale_factor().unwrap_or(1.0);
            let logical = pos.to_logical::<f64>(scale);
            note.x = logical.x;
            note.y = logical.y;
            let _ = db::update_note(&state.db.0.lock().unwrap(), &note);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
    {
        // 注意:此处已持有 db 锁,category_name_of 会再次加锁同一 Mutex(不可重入)导致死锁,
        // 必须直接用已持有的连接查询。
        let conn = state.db.0.lock().unwrap();
        let cat_name = note.category_id
            .and_then(|cid| db::get_category_name(&conn, cid).ok().flatten());
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: "create".to_string(),
            note_id: Some(note.id.to_string()),
            note_title: Some(note.title.clone()),
            category_id: note.category_id,
            category_name: cat_name,
            field_changes: None,
            note_snapshot: None,
            attachment_name: None,
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    queue_change(app, "note", note.id, "create");
    let _ = app.emit("notes-updated", ());
    Ok(note)
}

fn new_note_via(app: &tauri::AppHandle, note_type: &str) -> Result<db::Note, String> {
    // 标题留空:窗口内以浅色占位符「新建便签/新建待办」提示,未填写任何内容关闭时即删除(不落库)
    create_note(app, base_note("", note_type, None), true)
}

fn centered_position(app: &tauri::AppHandle, w: f64, h: f64) -> (f64, f64) {
    let Some(cursor) = app.cursor_position().ok() else {
        return (100.0, 100.0);
    };
    let Some(monitor) = app.monitor_from_point(cursor.x, cursor.y).ok().flatten() else {
        return (100.0, 100.0);
    };
    let msize = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let mpos = monitor.position().to_logical::<f64>(monitor.scale_factor());
    let x = mpos.x + ((msize.width - w) / 2.0).max(0.0);
    let y = mpos.y + ((msize.height - h) / 2.0).max(0.0);
    (x, y)
}

/// 光标所在显示器顶部居中(闪电捕获栏)
fn top_center_position(app: &tauri::AppHandle, w: f64) -> (f64, f64) {
    let Some(cursor) = app.cursor_position().ok() else {
        return (100.0, 100.0);
    };
    let Some(monitor) = app.monitor_from_point(cursor.x, cursor.y).ok().flatten() else {
        return (100.0, 100.0);
    };
    let msize = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let mpos = monitor.position().to_logical::<f64>(monitor.scale_factor());
    let x = mpos.x + ((msize.width - w) / 2.0).max(0.0);
    (x, mpos.y + 40.0)
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
    // 文件拖放:tauri 2.11 会自动把 Drop 事件(含路径)转发为前端 tauri://drag-drop 事件,
    // 无需 Rust 侧配置;NoteApp 监听该事件添加附件。
    .build()
}

// ============ commands: 分类 ============

#[tauri::command]
fn get_categories(state: tauri::State<AppState>) -> Result<Vec<db::Category>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_all_categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_category(app: tauri::AppHandle, state: tauri::State<AppState>, name: String) -> Result<db::Category, String> {
    let conn = state.db.0.lock().unwrap();
    let cat = db::add_category(&conn, &name).map_err(|e| e.to_string())?;
    drop(conn);
    queue_change(&app, "category", cat.id, "create");
    let _ = app.emit("notes-updated", ());
    Ok(cat)
}

#[tauri::command]
fn delete_category(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::delete_category(&conn, id).map_err(|e| e.to_string())?;
    drop(conn);
    queue_change(&app, "category", id, "delete");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn rename_category(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::rename_category(&conn, id, &name).map_err(|e| e.to_string())?;
    mark_unsynced(&conn, "categories", id);
    drop(conn);
    queue_change(&app, "category", id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn reorder_categories(app: tauri::AppHandle, state: tauri::State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::reorder_categories(&conn, &ids).map_err(|e| e.to_string())?;
    drop(conn);
    let _ = app.emit("notes-updated", ());
    Ok(())
}

// ============ commands: 便签 ============

#[tauri::command]
fn get_notes(state: tauri::State<AppState>) -> Result<Vec<db::Note>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_all_notes(&conn).map_err(|e| e.to_string())
}

// 注意:Windows 上在同步 command 里创建 WebviewWindow 会死锁(wry/WebView2 已知问题),
// 创建窗口的 command 必须声明为 async。
#[tauri::command]
async fn add_note(app: tauri::AppHandle, state: tauri::State<'_, AppState>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let _ = state;
    create_note(&app, base_note(&title, &note_type, category_id), true)
}

/// 闪电捕获保存:建便签但不打开窗口(spec 7.12)
#[tauri::command]
async fn save_capture(app: tauri::AppHandle, state: tauri::State<'_, AppState>, content: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let _ = state;
    let trimmed = content.trim().to_string();
    if trimmed.is_empty() {
        return Err("内容为空".to_string());
    }
    let mut note = base_note(&first_line_title(&trimmed), "text", category_id);
    note.content = trimmed;
    let created = create_note(&app, note, false)?;
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.hide();
    }
    Ok(created)
}

#[tauri::command]
fn update_note(app: tauri::AppHandle, state: tauri::State<AppState>, note: db::Note) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    let old = db::get_note_by_id(&conn, note.id).ok();
    db::update_note(&conn, &note).map_err(|e| e.to_string())?;
    if let Some(old) = &old {
        let cat_change = old.category_id != note.category_id;
        let text_change = old.title != note.title || old.content != note.content;
        if cat_change || text_change {
            // 位置/尺寸/透明度变化不记时间轴(拖窗/缩放会刷屏)
            let mut changes = serde_json::Map::new();
            if old.title != note.title {
                changes.insert("title".to_string(), json!({ "old": old.title, "new": note.title }));
            }
            if old.content != note.content {
                // 规格 7.13:内容变化不展示具体内容
                changes.insert("content".to_string(), json!({ "old": "内容已修改", "new": "内容已修改" }));
            }
            if cat_change {
                changes.insert("category".to_string(), json!({
                    "old": old.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
                    "new": note.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten())
                }));
            }
            let action = if !text_change && cat_change { "move" } else { "update" };
            log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
                id: db::new_uuid(),
                action: action.to_string(),
                note_id: Some(note.id.to_string()),
                note_title: Some(note.title.clone()),
                category_id: note.category_id,
                category_name: note.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
                field_changes: Some(json!(changes).to_string()),
                note_snapshot: None,
                attachment_name: None,
                todo_content: None,
                device_id: None,
                created_at: String::new(),
            });
        }
    }
    mark_unsynced(&conn, "notes", note.id);
    drop(conn);
    queue_change(&app, "note", note.id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn set_note_pinned(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64, pinned: bool) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::set_pinned(&conn, id, pinned).map_err(|e| e.to_string())?;
    let note = db::get_note_by_id(&conn, id).ok();
    if let Some(n) = &note {
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: if pinned { "pin" } else { "unpin" }.to_string(),
            note_id: Some(id.to_string()),
            note_title: Some(n.title.clone()),
            category_id: n.category_id,
            category_name: n.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
            field_changes: None,
            note_snapshot: None,
            attachment_name: None,
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    mark_unsynced(&conn, "notes", id);
    drop(conn);
    queue_change(&app, "note", id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn set_note_color(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64, color: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::set_note_color(&conn, id, &color).map_err(|e| e.to_string())?;
    mark_unsynced(&conn, "notes", id);
    drop(conn);
    queue_change(&app, "note", id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn set_note_style(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64, style: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::set_note_style(&conn, id, &style).map_err(|e| e.to_string())?;
    mark_unsynced(&conn, "notes", id);
    drop(conn);
    queue_change(&app, "note", id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// 软删除:进回收站(spec 7.10)
#[tauri::command]
fn delete_note(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = window.destroy();
    }
    let conn = state.db.0.lock().unwrap();
    let trashed = db::trash_note(&conn, id).map_err(|e| e.to_string())?;
    if let Some(n) = &trashed {
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: "delete".to_string(),
            note_id: Some(id.to_string()),
            note_title: Some(n.title.clone()),
            category_id: n.category_id,
            category_name: n.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
            field_changes: None,
            note_snapshot: snapshot_json(n),
            attachment_name: None,
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    mark_unsynced(&conn, "notes", id);
    drop(conn);
    queue_change(&app, "note", id, "delete");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn restore_note(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    let restored = db::restore_note(&conn, id).map_err(|e| e.to_string())?;
    if let Some(n) = &restored {
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: "restore".to_string(),
            note_id: Some(id.to_string()),
            note_title: Some(n.title.clone()),
            category_id: n.category_id,
            category_name: n.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
            field_changes: None,
            note_snapshot: None,
            attachment_name: None,
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    mark_unsynced(&conn, "notes", id);
    drop(conn);
    queue_change(&app, "note", id, "restore");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_note_forever(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = window.destroy();
    }
    let conn = state.db.0.lock().unwrap();
    let deleted = db::delete_note_forever(&conn, id).map_err(|e| e.to_string())?;
    if let Some(n) = &deleted {
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: "delete".to_string(),
            note_id: Some(id.to_string()),
            note_title: Some(n.title.clone()),
            category_id: n.category_id,
            category_name: n.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
            field_changes: None,
            note_snapshot: snapshot_json(n),
            attachment_name: None,
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    drop(conn);
    queue_change(&app, "note", id, "delete");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// 回收站自动清理:超过 30 天的便签标记 permanently_deleted(deleted_by = auto_clean 记入快照)
fn auto_clean_trash_impl(app: &tauri::AppHandle) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let conn = state.db.0.lock().unwrap();
    let expired = db::get_expired_trash_ids(&conn, 30).map_err(|e| e.to_string())?;
    let device = state.device_id.clone();
    for id in &expired {
        if let Some(n) = db::permanently_delete_note(&conn, *id, "auto_clean").map_err(|e| e.to_string())? {
            log_timeline_in(&conn, &device, db::TimelineEntry {
                id: db::new_uuid(),
                action: "delete".to_string(),
                note_id: Some(id.to_string()),
                note_title: Some(n.title.clone()),
                category_id: n.category_id,
                category_name: n.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
                field_changes: None,
                note_snapshot: snapshot_json(&n),
                attachment_name: None,
                todo_content: None,
                device_id: None,
                created_at: String::new(),
            });
        }
    }
    drop(conn);
    if !expired.is_empty() {
        let _ = app.emit("notes-updated", ());
    }
    Ok(expired.len())
}

#[tauri::command]
fn auto_clean_trash(app: tauri::AppHandle) -> Result<usize, String> {
    auto_clean_trash_impl(&app)
}

#[tauri::command]
fn get_note(state: tauri::State<AppState>, id: i64) -> Result<db::Note, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_note_by_id(&conn, id).map_err(|e| e.to_string())
}

/// 关闭便签窗口时调用:标题/内容/待办/附件全空视为「未填写」,彻底删除并清理其时间轴与离线队列记录;
/// 有任一内容则不动。返回是否已删除。
#[tauri::command]
fn discard_empty_note(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<bool, String> {
    let conn = state.db.0.lock().unwrap();
    let note = db::get_note_by_id(&conn, id).map_err(|e| e.to_string())?;
    let has_content = !note.title.trim().is_empty()
        || !note.content.trim().is_empty()
        || conn
            .query_row("SELECT COUNT(*) FROM todo_items WHERE note_id = ?1", [id], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            > 0
        || conn
            .query_row("SELECT COUNT(*) FROM sticky_note_attachment WHERE note_id = ?1", [id], |r| r.get::<_, i64>(0))
            .unwrap_or(0)
            > 0;
    if has_content {
        return Ok(false);
    }
    conn.execute("DELETE FROM notes WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    // 清除创建时记的时间轴条目(note_id 为 TEXT 存的是 id 字符串)
    conn.execute("DELETE FROM sticky_note_timeline WHERE note_id = ?1", [id.to_string()])
        .map_err(|e| e.to_string())?;
    drop(conn);
    // 清理离线队列中该便签的 create 记录,避免将来同步时产生幽灵便签
    let queue_path = data_dir(&app).join("sync_queue.json");
    if let Ok(s) = std::fs::read_to_string(&queue_path) {
        if let Ok(mut queue) = serde_json::from_str::<Vec<serde_json::Value>>(&s) {
            let before = queue.len();
            queue.retain(|e| !(e["entity"] == "note" && e["id"] == id));
            if queue.len() != before {
                let _ = std::fs::write(&queue_path, serde_json::to_string(&queue).unwrap_or_default());
            }
        }
    }
    let _ = app.emit("notes-updated", ());
    Ok(true)
}

// open_note 也会创建窗口,同样需要 async 避免 Windows 死锁
#[tauri::command]
async fn open_note(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = app.state::<AppState>();
    let note = db::get_note_by_id(&conn.db.0.lock().unwrap(), id).map_err(|e| e.to_string())?;
    if note.status != "active" {
        return Err("便签已在回收站".to_string());
    }
    let label = format!("note-{}", id);
    let is_new = app.get_webview_window(&label).is_none();
    let window = create_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    // show 在异步命令上下文中经主线程派发,管理器立即刷新可能读到「尚未可见」;
    // 延迟通知管理器刷新「已打开」列表(与 highlight 相同的重试思路)。
    let win_ = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let _ = win_.app_handle().emit_to("main", "note-window-shown", ());
    });
    if is_new {
        // 新建窗口:页面 JS 监听器尚未注册,立即 emit 会丢事件。延迟重试几次。
        let win = window.clone();
        std::thread::spawn(move || {
            for _ in 0..3u32 {
                std::thread::sleep(std::time::Duration::from_millis(400));
                let _ = win.emit("highlight", ());
            }
        });
    } else {
        let _ = window.emit("highlight", ());
    }
    Ok(())
}

/// 关闭指定便签窗口(隐私分类锁定时关闭已打开的隐私便签)
#[tauri::command]
fn close_note_window(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    // 管理器「已打开」关闭是直接销毁窗口,不触发 CloseRequested;
    // 这里同样执行空便签丢弃,保证三条关闭路径行为一致
    let _ = discard_empty_note(app.clone(), state, id);
    if let Some(w) = app.get_webview_window(&format!("note-{}", id)) {
        let _ = w.destroy();
    }
    Ok(())
}

/// 已打开的便签窗口 id 列表(管理器「已打开的便签」区域)
/// 只统计可见窗口:× 按钮是隐藏窗口而非销毁,隐藏后不应继续显示在列表里。
#[tauri::command]
fn get_open_note_ids(app: tauri::AppHandle) -> Result<Vec<i64>, String> {
    let mut ids: Vec<i64> = app
        .webview_windows()
        .iter()
        .filter(|(l, w)| l.starts_with("note-") && w.is_visible().unwrap_or(false))
        .filter_map(|(l, _)| l.strip_prefix("note-").and_then(|s| s.parse::<i64>().ok()))
        .collect();
    ids.sort_unstable();
    Ok(ids)
}

#[tauri::command]
fn duplicate_note(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<db::Note, String> {
    let conn = state.db.0.lock().unwrap();
    let copy = db::duplicate_note(&conn, id).map_err(|e| e.to_string())?;
    log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
        id: db::new_uuid(),
        action: "create".to_string(),
        note_id: Some(copy.id.to_string()),
        note_title: Some(copy.title.clone()),
        category_id: copy.category_id,
        category_name: copy.category_id.and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
        field_changes: None,
        note_snapshot: None,
        attachment_name: None,
        todo_content: None,
        device_id: None,
        created_at: String::new(),
    });
    drop(conn);
    queue_change(&app, "note", copy.id, "create");
    let _ = app.emit("notes-updated", ());
    Ok(copy)
}

#[tauri::command]
fn reorder_notes(app: tauri::AppHandle, state: tauri::State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::reorder_notes(&conn, &ids).map_err(|e| e.to_string())?;
    drop(conn);
    let _ = app.emit("notes-updated", ());
    Ok(())
}

// ============ commands: 待办 ============

#[tauri::command]
fn get_all_todos(state: tauri::State<AppState>) -> Result<Vec<db::TodoItem>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_all_todos(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_todo(app: tauri::AppHandle, state: tauri::State<AppState>, note_id: i64, content: String) -> Result<db::TodoItem, String> {
    let conn = state.db.0.lock().unwrap();
    let item = db::add_todo_item(&conn, note_id, &content).map_err(|e| e.to_string())?;
    drop(conn);
    queue_change(&app, "todo", item.id, "create");
    let _ = app.emit("notes-updated", ());
    Ok(item)
}

#[tauri::command]
fn update_todo(app: tauri::AppHandle, state: tauri::State<AppState>, item: db::TodoItem) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    let old = db::get_todo_item(&conn, item.id).ok();
    db::update_todo_item(&conn, &item).map_err(|e| e.to_string())?;
    if let Some(old) = &old {
        if old.is_done != item.is_done {
            // 勾选/取消勾选记时间轴(spec 7.13:默认折叠/隐藏)
            let note = db::get_note_by_id(&conn, item.note_id).ok();
            log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
                id: db::new_uuid(),
                action: if item.is_done { "complete" } else { "uncomplete" }.to_string(),
                note_id: Some(item.note_id.to_string()),
                note_title: note.as_ref().map(|n| n.title.clone()),
                category_id: note.as_ref().and_then(|n| n.category_id),
                category_name: note.as_ref().and_then(|n| n.category_id).and_then(|c| db::get_category_name(&conn, c).ok().flatten()),
                field_changes: None,
                note_snapshot: None,
                attachment_name: None,
                todo_content: Some(item.content.clone()),
                device_id: None,
                created_at: String::new(),
            });
        }
    }
    mark_unsynced(&conn, "todo_items", item.id);
    drop(conn);
    queue_change(&app, "todo", item.id, "update");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

#[tauri::command]
fn delete_todo(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    db::delete_todo_item(&conn, id).map_err(|e| e.to_string())?;
    drop(conn);
    queue_change(&app, "todo", id, "delete");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

// ============ commands: 时间轴 ============

#[tauri::command]
fn get_all_timeline(state: tauri::State<AppState>) -> Result<Vec<db::TimelineEntry>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_all_timeline(&conn).map_err(|e| e.to_string())
}

// ============ commands: 附件 ============

#[tauri::command]
fn get_attachments(state: tauri::State<AppState>, note_id: i64) -> Result<Vec<db::Attachment>, String> {
    let conn = state.db.0.lock().unwrap();
    db::get_attachments(&conn, note_id).map_err(|e| e.to_string())
}

fn attach_path(app: &tauri::AppHandle, state: &tauri::State<AppState>, note_id: i64, path: &Path) -> Result<(), String> {
    let file_name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if file_name.is_empty() {
        return Err("无效的文件路径".to_string());
    }
    let file_size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);
    let file_type = path.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let path_str = path.to_string_lossy().to_string();
    let conn = state.db.0.lock().unwrap();
    let att = db::add_attachment(&conn, note_id, &file_name, &path_str, file_size, &file_type)
        .map_err(|e| e.to_string())?;
    log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
        id: db::new_uuid(),
        action: "attach".to_string(),
        note_id: Some(note_id.to_string()),
        note_title: db::get_note_by_id(&conn, note_id).ok().map(|n| n.title),
        category_id: None,
        category_name: None,
        field_changes: None,
        note_snapshot: None,
        attachment_name: Some(file_name.clone()),
        todo_content: None,
        device_id: None,
        created_at: String::new(),
    });
    drop(conn);
    queue_change(app, "attachment", att.id, "attach");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// 按钮选择文件添加附件
#[tauri::command]
async fn pick_attachment(app: tauri::AppHandle, state: tauri::State<'_, AppState>, note_id: i64) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_file(move |p| {
        let _ = tx.send(p);
    });
    match rx.recv().map_err(|_| "未选择文件".to_string())? {
        Some(path) => {
            let p = path.as_path().ok_or("无效的文件路径".to_string())?;
            attach_path(&app, &state, note_id, p)
        }
        None => Ok(()),
    }
}

/// 拖拽文件添加附件(Rust 侧 drag-drop 事件转发)
#[tauri::command]
fn add_attachment_path(app: tauri::AppHandle, state: tauri::State<AppState>, note_id: i64, path: String) -> Result<(), String> {
    attach_path(&app, &state, note_id, Path::new(&path))
}

#[tauri::command]
fn delete_attachment(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    let removed = db::delete_attachment(&conn, id).map_err(|e| e.to_string())?;
    if let Some(att) = &removed {
        log_timeline_in(&conn, &state.device_id, db::TimelineEntry {
            id: db::new_uuid(),
            action: "detach".to_string(),
            note_id: Some(att.note_id.to_string()),
            note_title: db::get_note_by_id(&conn, att.note_id).ok().map(|n| n.title),
            category_id: None,
            category_name: None,
            field_changes: None,
            note_snapshot: None,
            attachment_name: Some(att.file_name.clone()),
            todo_content: None,
            device_id: None,
            created_at: String::new(),
        });
    }
    drop(conn);
    queue_change(&app, "attachment", id, "detach");
    let _ = app.emit("notes-updated", ());
    Ok(())
}

/// 双击附件:用系统默认程序打开(仅单设备可用,spec 7.13)
#[tauri::command]
fn open_attachment(app: tauri::AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// ============ commands: 导出 ============

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() { "便签".to_string() } else { cleaned }
}

fn note_to_txt(note: &db::Note, todos: &[db::TodoItem]) -> String {
    let mut out = format!("{}\n创建时间: {}\n更新时间: {}\n\n{}\n", note.title, note.created_at, note.updated_at, note.content);
    if !todos.is_empty() {
        out.push_str("\n待办:\n");
        for t in todos {
            out.push_str(&format!("  [{}] {}\n", if t.is_done { "x" } else { " " }, t.content));
        }
    }
    out
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

#[tauri::command]
async fn export_note(app: tauri::AppHandle, state: tauri::State<'_, AppState>, id: i64) -> Result<(), String> {
    let (note, todos) = {
        let conn = state.db.0.lock().unwrap();
        let n = db::get_note_by_id(&conn, id).map_err(|e| e.to_string())?;
        let all = db::get_all_todos(&conn).map_err(|e| e.to_string())?;
        let ts: Vec<db::TodoItem> = all.into_iter().filter(|t| t.note_id == id).collect();
        (n, ts)
    };
    let (tx, rx) = mpsc::channel();
    app.dialog().file()
        .set_file_name(format!("{}.txt", sanitize_filename(&note.title)))
        .add_filter("文本文件", &["txt"])
        .save_file(move |p| { let _ = tx.send(p); });
    let picked = rx.recv().map_err(|_| "未选择保存位置".to_string())?;
    if let Some(path) = picked {
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, note_to_txt(&note, &todos)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn export_all(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<(), String> {
    let (notes, categories, todos) = {
        let conn = state.db.0.lock().unwrap();
        (
            db::get_all_notes(&conn).map_err(|e| e.to_string())?,
            db::get_all_categories(&conn).map_err(|e| e.to_string())?,
            db::get_all_todos(&conn).map_err(|e| e.to_string())?,
        )
    };
    let (tx, rx) = mpsc::channel();
    app.dialog().file()
        .set_file_name("便签导出.json")
        .add_filter("JSON", &["json"])
        .add_filter("CSV", &["csv"])
        .save_file(move |p| { let _ = tx.send(p); });
    let picked = rx.recv().map_err(|_| "未选择保存位置".to_string())?;
    if let Some(path) = picked {
        let path = path.into_path().map_err(|e| e.to_string())?;
        let content = if path.extension().and_then(|e| e.to_str()) == Some("csv") {
            let mut csv = String::from("标题,内容,类型,分类,颜色,置顶,创建时间,更新时间,待办\n");
            for n in &notes {
                let cat = n.category_id.and_then(|c| categories.iter().find(|x| x.id == c).map(|x| x.name.clone())).unwrap_or_default();
                let ts: Vec<String> = todos.iter().filter(|t| t.note_id == n.id).map(|t| {
                    format!("[{}] {}", if t.is_done { "x" } else { " " }, t.content)
                }).collect();
                csv.push_str(&format!("{},{},{},{},{},{},{},{},{}\n",
                    csv_escape(&n.title), csv_escape(&n.content), n.note_type, csv_escape(&cat),
                    n.color, if n.is_pinned { "是" } else { "否" },
                    csv_escape(&n.created_at), csv_escape(&n.updated_at), csv_escape(&ts.join(" | "))));
            }
            csv
        } else {
            serde_json::to_string_pretty(&json!({
                "exportedAt": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
                "notes": notes,
                "categories": categories,
                "todos": todos,
            })).map_err(|e| e.to_string())?
        };
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ============ commands: 隐私分类 ============

#[tauri::command]
fn get_privacy_status(state: tauri::State<AppState>) -> Result<PrivacyStatus, String> {
    let conn = state.db.0.lock().unwrap();
    let has_password = db::get_meta(&conn, "privacy_password_hash").map_err(|e| e.to_string())?.is_some();
    let questions: Vec<String> = db::get_meta(&conn, "privacy_questions")
        .ok().flatten()
        .and_then(|s| serde_json::from_str::<Vec<serde_json::Value>>(&s).ok())
        .map(|qs| qs.iter().filter_map(|q| q.get("q").and_then(|v| v.as_str()).map(|s| s.to_string())).collect())
        .unwrap_or_default();
    Ok(PrivacyStatus { has_password, questions })
}

#[tauri::command]
fn set_privacy_password(state: tauri::State<AppState>, req: SetPrivacyReq) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    if db::get_meta(&conn, "privacy_password_hash").map_err(|e| e.to_string())?.is_some() {
        return Err("隐私密码已设置".to_string());
    }
    if req.password.is_empty() || req.q1.trim().is_empty() || req.q2.trim().is_empty() || req.a1.trim().is_empty() || req.a2.trim().is_empty() {
        return Err("密码与安全问题不能为空".to_string());
    }
    let salt = db::new_uuid();
    db::set_meta(&conn, "privacy_salt", &salt).map_err(|e| e.to_string())?;
    db::set_meta(&conn, "privacy_password_hash", &db::hash_password(&salt, &req.password)).map_err(|e| e.to_string())?;
    let questions = json!([
        { "q": req.q1, "a": db::hash_password(&salt, &req.a1) },
        { "q": req.q2, "a": db::hash_password(&salt, &req.a2) }
    ]);
    db::set_meta(&conn, "privacy_questions", &questions.to_string()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn verify_privacy_password(state: tauri::State<AppState>, password: String) -> Result<bool, String> {
    let conn = state.db.0.lock().unwrap();
    let salt = db::get_meta(&conn, "privacy_salt").map_err(|e| e.to_string())?.unwrap_or_default();
    let hash = db::get_meta(&conn, "privacy_password_hash").map_err(|e| e.to_string())?.unwrap_or_default();
    Ok(!hash.is_empty() && db::hash_password(&salt, &password) == hash)
}

#[tauri::command]
fn change_privacy_password(state: tauri::State<AppState>, old_password: String, new_password: String) -> Result<(), String> {
    let conn = state.db.0.lock().unwrap();
    let salt = db::get_meta(&conn, "privacy_salt").map_err(|e| e.to_string())?.unwrap_or_default();
    let hash = db::get_meta(&conn, "privacy_password_hash").map_err(|e| e.to_string())?.unwrap_or_default();
    if db::hash_password(&salt, &old_password) != hash {
        return Err("旧密码错误".to_string());
    }
    db::set_meta(&conn, "privacy_password_hash", &db::hash_password(&salt, &new_password)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 忘记密码:回答两个安全问题,全部正确则重置
#[tauri::command]
fn reset_privacy_password(state: tauri::State<AppState>, a1: String, a2: String, new_password: String) -> Result<bool, String> {
    let conn = state.db.0.lock().unwrap();
    let salt = db::get_meta(&conn, "privacy_salt").map_err(|e| e.to_string())?.unwrap_or_default();
    let questions = db::get_meta(&conn, "privacy_questions").map_err(|e| e.to_string())?;
    let Some(qs) = questions else { return Ok(false) };
    let answers: Vec<String> = serde_json::from_str::<Vec<serde_json::Value>>(&qs)
        .map_err(|e| e.to_string())?
        .iter()
        .filter_map(|q| q.get("a").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .collect();
    if answers.len() != 2 {
        return Ok(false);
    }
    if db::hash_password(&salt, &a1) != answers[0] || db::hash_password(&salt, &a2) != answers[1] {
        return Ok(false);
    }
    db::set_meta(&conn, "privacy_password_hash", &db::hash_password(&salt, &new_password)).map_err(|e| e.to_string())?;
    Ok(true)
}

// ============ commands: 全局快捷键 ============

fn shortcuts_file(app: &tauri::AppHandle) -> std::path::PathBuf {
    data_dir(app).join("shortcuts.json")
}

fn load_shortcut_map(app: &tauri::AppHandle) -> HashMap<String, String> {
    let mut map: HashMap<String, String> = HashMap::new();
    for (kind, keys) in DEFAULT_SHORTCUTS {
        map.insert(kind.to_string(), keys.to_string());
    }
    if let Ok(s) = std::fs::read_to_string(shortcuts_file(app)) {
        if let Ok(saved) = serde_json::from_str::<HashMap<String, String>>(&s) {
            for (k, v) in saved {
                map.insert(k, v);
            }
        }
    }
    map
}

fn handle_shortcut(app: &tauri::AppHandle, kind: &str) {
    match kind {
        "new_note" => {
            let _ = new_note_via(app, "text");
        }
        "clipboard_note" => {
            // 剪贴板插件要求主线程
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Ok(text) = app2.clipboard().read_text() {
                    let trimmed = text.trim().to_string();
                    if !trimmed.is_empty() {
                        let mut note = base_note("text", "text", None);
                        note.title = first_line_title(&trimmed);
                        note.content = trimmed;
                        let _ = create_note(&app2, note, true);
                    }
                }
            });
        }
        "capture" => {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = show_capture(app2).await;
            });
        }
        _ => {}
    }
}

fn register_shortcuts(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let map = load_shortcut_map(app);
    let mut registered = state.shortcuts.lock().unwrap();
    registered.clear();
    for (kind, keys) in &map {
        let Ok(sc) = keys.parse::<Shortcut>() else { continue };
        let k = kind.clone();
        if app.global_shortcut().on_shortcut(sc, move |app, _sc, event| {
            if matches!(event.state(), ShortcutState::Pressed) {
                handle_shortcut(app, &k);
            }
        }).is_ok() {
            registered.insert(kind.clone(), sc);
        }
    }
}

#[tauri::command]
fn get_shortcuts(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<Vec<ShortcutInfo>, String> {
    let map = load_shortcut_map(&app);
    let registered = state.shortcuts.lock().unwrap();
    let mut infos: Vec<ShortcutInfo> = map.into_iter().map(|(kind, keys)| {
        let reg = keys.parse::<Shortcut>().map(|sc| registered.get(&kind) == Some(&sc)).unwrap_or(false);
        ShortcutInfo { kind, keys, registered: reg }
    }).collect();
    infos.sort_by(|a, b| a.kind.cmp(&b.kind));
    Ok(infos)
}

/// 修改全局快捷键:先尝试注册新组合,成功才替换;失败保留原快捷键(spec 7.11 被动冲突检测)
#[tauri::command]
fn set_shortcut(app: tauri::AppHandle, state: tauri::State<AppState>, kind: String, keys: String) -> Result<(), String> {
    if !DEFAULT_SHORTCUTS.iter().any(|(k, _)| k == &kind) {
        return Err("未知的快捷键类型".to_string());
    }
    let sc: Shortcut = keys.parse().map_err(|_| "无效的快捷键组合".to_string())?;
    let mut registered = state.shortcuts.lock().unwrap();
    // 与本应用其他快捷键冲突
    for (k, existing) in registered.iter() {
        if k != &kind && *existing == sc {
            return Err("与本应用其他快捷键冲突".to_string());
        }
    }
    let k = kind.clone();
    let app2 = app.clone();
    if app.global_shortcut().on_shortcut(sc, move |app, _sc, event| {
        if matches!(event.state(), ShortcutState::Pressed) {
            handle_shortcut(app, &k);
        }
    }).is_err() {
        return Err("该快捷键已被其他应用占用,请更换".to_string());
    }
    // 新组合注册成功,注销旧组合并生效
    if let Some(old) = registered.remove(&kind) {
        let _ = app.global_shortcut().unregister(old);
    }
    registered.insert(kind.clone(), sc);
    drop(registered);
    // 持久化
    let mut map = load_shortcut_map(&app);
    map.insert(kind, keys);
    let _ = std::fs::write(shortcuts_file(&app), serde_json::to_string(&map).unwrap_or_default());
    let _ = app2;
    Ok(())
}

// ============ commands: 闪电捕获栏 ============

#[tauri::command]
async fn show_capture(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("capture") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("capture-show", ());
        return Ok(());
    }
    let (x, y) = top_center_position(&app, 520.0);
    let w = tauri::WebviewWindowBuilder::new(
        &app,
        "capture",
        tauri::WebviewUrl::App("capture.html".into()),
    )
    .title("快速便签")
    .inner_size(520.0, 160.0)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .build()
    .map_err(|e| e.to_string())?;
    let _ = w.show();
    let _ = w.set_focus();
    Ok(())
}

// ============ setup / 入口 ============

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_dir = data_dir(app.handle());
            std::fs::create_dir_all(&app_dir).expect("failed to create app data dir");
            let db_path = app_dir.join("sticky_notes.db");

            let conn = Connection::open(db_path).expect("failed to open database");
            db::init_db(&conn).expect("failed to initialize database");
            db::migrate(&conn).expect("failed to migrate database");

            // 设备标识:首次启动生成,之后只读(spec 3.4,为将来同步预埋)
            let device_id_path = app_dir.join("device_id");
            let device_id = if let Ok(existing) = std::fs::read_to_string(&device_id_path) {
                existing.trim().to_string()
            } else {
                let id = db::new_uuid();
                let _ = std::fs::write(&device_id_path, &id);
                id
            };

            app.manage(AppState {
                db: DbConn(Mutex::new(conn)),
                device_id,
                shortcuts: Mutex::new(HashMap::new()),
                queue_lock: Mutex::new(()),
            });

            register_shortcuts(app.handle());

            // 启动时清理超期回收站便签(spec 7.11:启动检查)
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let _ = auto_clean_trash_impl(&app_handle);
            });

            // 应用运行期间每天检查一次(spec 7.11:每天凌晨检查):
            // 每 30 分钟醒来一次,仅当跨天(上次检查日期 != 今天)才真正执行清理;
            // 日期用 SQLite 本地日期(与 trashed_at 清理口径一致),无需额外依赖
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_clean: Option<String> = app_handle
                    .state::<AppState>()
                    .db
                    .0
                    .lock()
                    .ok()
                    .and_then(|conn| db::get_meta(&conn, "last_auto_clean_date").ok().flatten());
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(30 * 60));
                    let today: String = app_handle
                        .state::<AppState>()
                        .db
                        .0
                        .lock()
                        .ok()
                        .and_then(|conn| {
                            conn.query_row("SELECT date('now','localtime')", [], |r| r.get(0)).ok()
                        })
                        .unwrap_or_default();
                    if !today.is_empty() && last_clean.as_deref() == Some(today.as_str()) {
                        continue;
                    }
                    let _ = auto_clean_trash_impl(&app_handle);
                    if let Ok(conn) = app_handle.state::<AppState>().db.0.lock() {
                        let _ = db::set_meta(&conn, "last_auto_clean_date", &today);
                    }
                    last_clean = Some(today);
                }
            });

            let show_item = MenuItem::with_id(app, "show", "显示管理器", true, None::<&str>)?;
            let new_text_item = MenuItem::with_id(app, "new_text", "新建文字便签", true, None::<&str>)?;
            let new_todo_item = MenuItem::with_id(app, "new_todo", "新建待办", true, None::<&str>)?;
            let capture_item = MenuItem::with_id(app, "capture", "快速记录", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &new_text_item, &new_todo_item, &capture_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_categories, add_category, delete_category, rename_category, reorder_categories,
            get_notes, add_note, update_note, set_note_pinned, set_note_color, set_note_style,
            delete_note, restore_note, delete_note_forever, auto_clean_trash,
            get_note, open_note, get_open_note_ids, close_note_window, duplicate_note, reorder_notes,
            discard_empty_note,
            get_all_todos, add_todo, update_todo, delete_todo,
            get_all_timeline,
            get_attachments, pick_attachment, add_attachment_path, delete_attachment,
            open_attachment, open_url,
            export_note, export_all,
            get_privacy_status, set_privacy_password, verify_privacy_password,
            change_privacy_password, reset_privacy_password,
            get_shortcuts, set_shortcut,
            show_capture, save_capture
        ])
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "new_text" | "new_todo" => {
                    // 菜单事件在主线程派发,同步建窗会死锁(tauri WebviewWindowBuilder Known issues)
                    let note_type = if event.id().as_ref() == "new_text" { "text" } else { "todo" };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = new_note_via(&app, note_type);
                    });
                }
                "capture" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = show_capture(app).await;
                    });
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
                // 便签窗口经系统途径关闭(Alt+F4 等)也是隐藏,通知管理器刷新「已打开」
                if window.label().starts_with("note-") {
                    // 未填写任何内容的便签关闭即删除(与窗口内 × 按钮同一逻辑,兜底系统关闭路径)
                    if let Some(id) = window.label().strip_prefix("note-").and_then(|s| s.parse::<i64>().ok()) {
                        let _ = discard_empty_note(window.app_handle().clone(), window.state::<AppState>(), id);
                    }
                    let _ = window.app_handle().emit_to("main", "note-window-hidden", ());
                }
            }
            // spec 7.13 锁定时机:最小化才锁定(失焦不锁)。
            // 失焦原因 JS 侧无法区分,由 Rust 检测最小化后通知前端。
            // tao/tauri 无 Minimized 事件;Windows 最小化触发 WM_SIZE(lParam=0) → Resized(0,0),
            // 且 WM_SYSCOMMAND(SC_MINIMIZE) 先于失焦置位 MINIMIZED 标志,两条路径互为兜底。
            if let tauri::WindowEvent::Resized(size) = event {
                if window.label() == "main" && size.width == 0 && size.height == 0 {
                    let _ = window.emit("main-minimized", ());
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "main" && window.is_minimized().unwrap_or(false) {
                    let _ = window.emit("main-minimized", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::resolve_data_dir;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sticky-notes-test-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn portable_marker_switches_to_exe_data_dir() {
        let exe_dir = temp_dir("portable-on");
        std::fs::write(exe_dir.join("portable.txt"), "").unwrap();
        let appdata = PathBuf::from(r"C:\Users\x\AppData\Roaming\com.stickynotes.app");
        assert_eq!(
            resolve_data_dir(Some(&exe_dir), &appdata),
            exe_dir.join("data")
        );
        std::fs::remove_dir_all(&exe_dir).ok();
    }

    #[test]
    fn no_marker_falls_back_to_appdata() {
        let exe_dir = temp_dir("portable-off");
        let appdata = PathBuf::from(r"C:\Users\x\AppData\Roaming\com.stickynotes.app");
        assert_eq!(resolve_data_dir(Some(&exe_dir), &appdata), appdata);
        std::fs::remove_dir_all(&exe_dir).ok();
    }

    #[test]
    fn missing_exe_dir_falls_back_to_appdata() {
        let appdata = PathBuf::from(r"C:\Users\x\AppData\Roaming\com.stickynotes.app");
        assert_eq!(resolve_data_dir(None, &appdata), appdata);
    }
}
