#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use std::sync::Mutex;
use rusqlite::Connection;

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

// 新建便签共享逻辑:command / 托盘菜单 / 全局快捷键三路复用。
// 展开态 360×420、默认置顶、不透明,落在光标所在显示器中央(create_note_window 内居中)。
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

// 托盘菜单 / 全局快捷键共用的新建便签入口:按 note_type 推导标题(text→新建便签,todo→新建待办),
// 再走共享的 create_note。快捷键回调由 global-hotkey 在后台线程派发,可同步调用;
// 托盘菜单 handler 在主线程事件循环上,同步建窗会死锁(见下方 on_menu_event),必须经 spawn 调用本函数。
fn new_note_via(app: &tauri::AppHandle, note_type: &str) -> Result<db::Note, String> {
    let title = if note_type == "todo" { "新建待办" } else { "新建便签" };
    create_note(app, title.to_string(), note_type.to_string(), None)
}

// 注意:Windows 上在同步 command 里创建 WebviewWindow 会死锁(wry/WebView2 已知问题),
// 创建窗口的 command 必须声明为 async(见 tauri 官方文档 WebviewWindowBuilder 的 Known issues)。
// 因此这里保持 async 包装;事件处理器(托盘/快捷键)经 new_note_via 调用 create_note。
#[tauri::command]
async fn add_note(app: tauri::AppHandle, state: tauri::State<'_, DbConn>, title: String, note_type: String, category_id: Option<i64>) -> Result<db::Note, String> {
    let _ = state;
    create_note(&app, title, note_type, category_id)
}

// 编辑静默落库:update_note 不再承载置顶(update_note 的 UPDATE 已移除 is_pinned 字段),
// 也不广播(编辑由前端防抖/失焦 flush,广播无意义;顺带消除"行不存在/更新失败也广播"的误导)
#[tauri::command]
fn update_note(state: tauri::State<DbConn>, note: db::Note) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::update_note(&conn, &note).map_err(|e| e.to_string())
}

// 置顶专用命令:原子单字段 UPDATE(经 db::set_pinned),置顶变化即广播 notes-updated,
// 供管理器列表与 note 窗口双向同步。绝不整行写回,避免陈旧快照覆盖另一窗口的置顶切换。
#[tauri::command]
fn set_note_pinned(app: tauri::AppHandle, state: tauri::State<DbConn>, id: i64, pinned: bool) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    db::set_pinned(&conn, id, pinned).map_err(|e| e.to_string())?;
    let _ = app.emit("notes-updated", ());
    Ok(())
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
    let label = format!("note-{}", id);
    let is_new = app.get_webview_window(&label).is_none();
    let window = create_note_window(&app, &note).map_err(|e| e.to_string())?;
    let _ = window.show();
    let _ = window.set_focus();
    if is_new {
        // 新建窗口:页面 JS 监听器尚未注册,立即 emit 会丢事件(管理器首次双击打开不高亮)。
        // 延迟后重试几次(400/800/1200ms),确保 React 的 listen() 已注册完成再命中;
        // 只发给本窗口,放独立线程 sleep,不阻塞主线程/异步运行时。
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

            let show_item = MenuItem::with_id(app, "show", "显示管理器", true, None::<&str>)?;
            let new_text_item = MenuItem::with_id(app, "new_text", "新建文字便签", true, None::<&str>)?;
            let new_todo_item = MenuItem::with_id(app, "new_todo", "新建待办", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &new_text_item, &new_todo_item, &quit_item])?;

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

            // 全局快捷键:Ctrl+Alt+N 新建文字便签,Ctrl+Alt+T 新建待办。
            // 注册失败(与其他应用冲突)时跳过该项,不阻塞启动。
            for (s, note_type) in [("Ctrl+Alt+N", "text"), ("Ctrl+Alt+T", "todo")] {
                let Ok(shortcut) = s.parse::<Shortcut>() else { continue };
                let nt = note_type.to_string();
                if let Err(e) = app.global_shortcut().on_shortcut(shortcut, move |app, _shortcut, event| {
                    if !matches!(event.state(), tauri_plugin_global_shortcut::ShortcutState::Pressed) {
                        return;
                    }
                    // global-hotkey 在后台线程派发回调,此处可同步建窗
                    let _ = new_note_via(app, &nt);
                }) {
                    eprintln!("注册全局快捷键 {} 失败(可能与其他应用冲突),跳过:{}", s, e);
                }
            }

            Ok(())
        })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_categories, add_category, delete_category,
            get_notes, add_note, update_note, set_note_pinned, delete_note,
            get_note, open_note,
            get_all_todos, add_todo, update_todo, delete_todo
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
                    // 菜单事件在主线程派发,同步建窗会死锁(tauri WebviewWindowBuilder Known issues:
                    // "deadlocks when used in a synchronous command or event handlers")。
                    // 挪到异步运行时线程执行;AppHandle 可克隆,闭包 move 捕获。
                    let note_type = if event.id().as_ref() == "new_text" { "text" } else { "todo" };
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = new_note_via(&app, note_type);
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
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
