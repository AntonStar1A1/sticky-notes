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

#[tauri::command]
fn add_note(app: tauri::AppHandle, state: tauri::State<DbConn>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let conn = state.0.lock().unwrap();
    let note = db::Note {
        id: 0,
        title,
        content: String::new(),
        note_type,
        category_id,
        x: 100.0,
        y: 100.0,
        width: 200.0,
        height: 200.0,
        opacity: 0.8,
        is_pinned: false,
        created_at: String::new(),
        updated_at: String::new(),
    };
    let result = db::add_note(&conn, &note).map_err(|e| e.to_string());
    let _ = app.emit("notes-updated", ());
    result
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
    let conn = state.0.lock().unwrap();
    let result = db::delete_note(&conn, id).map_err(|e| e.to_string());
    let _ = app.emit("notes-updated", ());
    result
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
