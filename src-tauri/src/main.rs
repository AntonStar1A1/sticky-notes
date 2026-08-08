#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use std::sync::Mutex;
use rusqlite::{Connection, params};

mod db;

pub struct DbConn(pub Mutex<Connection>);

#[tauri::command]
fn get_categories(state: tauri::State<DbConn>) -> Result<Vec<db::Category>, String> {
    let conn = state.0.lock().unwrap();
    db::get_all_categories(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_category(state: tauri::State<DbConn>, name: String) -> Result<db::Category, String> {
    let conn = state.0.lock().unwrap();
    db::add_category(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_category(state: tauri::State<DbConn>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::delete_category(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_notes(state: tauri::State<DbConn>) -> Result<Vec<db::Note>, String> {
    let conn = state.0.lock().unwrap();
    db::get_all_notes(&conn).map_err(|e| e.to_string())
}

// 注意:Windows 上在同步 command 里创建 WebviewWindow 会死锁(wry/WebView2 已知问题),
// 创建窗口的 command 必须声明为 async(见 tauri 官方文档 WebviewWindowBuilder 的 Known issues)。
#[tauri::command]
async fn add_note(app: tauri::AppHandle, state: tauri::State<'_, DbConn>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
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

#[tauri::command]
fn update_note(app: tauri::AppHandle, state: tauri::State<DbConn>, note: db::Note) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    // 只在置顶状态变化时广播,普通编辑由前端防抖静默保存,避免全量刷新
    let prev_pin: Option<bool> = conn
        .query_row("SELECT is_pinned FROM notes WHERE id = ?1", params![note.id], |r| r.get(0))
        .ok();
    let result = db::update_note(&conn, &note).map_err(|e| e.to_string());
    if prev_pin != Some(note.is_pinned) {
        let _ = app.emit("notes-updated", ());
    }
    result
}

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

#[tauri::command]
fn get_note(state: tauri::State<DbConn>, id: i64) -> Result<db::Note, String> {
    let conn = state.0.lock().unwrap();
    db::get_note_by_id(&conn, id).map_err(|e| e.to_string())
}

// open_note 也会创建窗口,同样需要 async 避免 Windows 死锁
#[tauri::command]
async fn open_note(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    let conn = app.state::<DbConn>();
    let note = db::get_note_by_id(&conn.0.lock().unwrap(), id).map_err(|e| e.to_string())?;
    let window = create_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit("highlight", ());
    Ok(())
}

#[tauri::command]
fn get_all_todos(state: tauri::State<DbConn>) -> Result<Vec<db::TodoItem>, String> {
    let conn = state.0.lock().unwrap();
    db::get_all_todos(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_todo(state: tauri::State<DbConn>, note_id: i64, content: String) -> Result<db::TodoItem, String> {
    let conn = state.0.lock().unwrap();
    db::add_todo_item(&conn, note_id, &content).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_todo(state: tauri::State<DbConn>, item: db::TodoItem) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::update_todo_item(&conn, &item).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_todo(state: tauri::State<DbConn>, id: i64) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::delete_todo_item(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_pinned_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pinned") {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "pinned",
        tauri::WebviewUrl::App("pinned.html".into()),
    )
    .title("置顶便签")
    .inner_size(300.0, 500.0)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
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

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir).expect("failed to create app data dir");
            let db_path = app_dir.join("sticky_notes.db");
            
            let conn = Connection::open(db_path).expect("failed to open database");
            db::init_db(&conn).expect("failed to initialize database");
            db::migrate(&conn).expect("failed to migrate database");

            app.manage(DbConn(Mutex::new(conn)));

            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let pinned_item = MenuItem::with_id(app, "pinned", "置顶列表", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &pinned_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    match event {
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_categories, add_category, delete_category,
            get_notes, add_note, update_note, delete_note,
            get_note, open_note,
            get_all_todos, add_todo, update_todo, delete_todo,
            show_pinned_window
        ])
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "pinned" => {
                    let _ = show_pinned_window(app.clone());
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
