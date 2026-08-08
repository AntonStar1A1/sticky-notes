use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub note_type: String, // "text" or "todo"
    pub category_id: Option<i64>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub opacity: f64,
    pub is_pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TodoItem {
    pub id: i64,
    pub note_id: i64,
    pub content: String,
    pub is_done: bool,
    pub sort_order: i32,
}

pub fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            note_type TEXT NOT NULL DEFAULT 'text',
            category_id INTEGER,
            x REAL NOT NULL DEFAULT 100.0,
            y REAL NOT NULL DEFAULT 100.0,
            width REAL NOT NULL DEFAULT 200.0,
            height REAL NOT NULL DEFAULT 200.0,
            opacity REAL NOT NULL DEFAULT 0.8,
            is_pinned BOOLEAN NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS todo_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            is_done BOOLEAN NOT NULL DEFAULT 0,
            sort_order INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO categories (name) VALUES ('默认'), ('工作'), ('生活'), ('学习'), ('灵感');
        "
    )?;
    Ok(())
}

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

pub fn get_all_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare("SELECT id, name, created_at FROM categories")?;
    let cats = stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(cats)
}

pub fn add_category(conn: &Connection, name: &str) -> Result<Category> {
    conn.execute("INSERT INTO categories (name) VALUES (?1)", params![name])?;
    let id = conn.last_insert_rowid();
    Ok(Category {
        id,
        name: name.to_string(),
        created_at: String::new(),
    })
}

pub fn delete_category(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_all_notes(conn: &Connection) -> Result<Vec<Note>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, content, note_type, category_id, x, y, width, height, opacity, is_pinned, created_at, updated_at FROM notes"
    )?;
    let notes = stmt.query_map([], |row| {
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
    })?.collect::<Result<Vec<_>>>()?;
    Ok(notes)
}

pub fn add_note(conn: &Connection, note: &Note) -> Result<Note> {
    conn.execute(
        "INSERT INTO notes (title, content, note_type, category_id, x, y, width, height, opacity, is_pinned) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![note.title, note.content, note.note_type, note.category_id, note.x, note.y, note.width, note.height, note.opacity, note.is_pinned],
    )?;
    let id = conn.last_insert_rowid();
    let mut new_note = note.clone();
    new_note.id = id;
    Ok(new_note)
}

pub fn update_note(conn: &Connection, note: &Note) -> Result<()> {
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, note_type = ?3, category_id = ?4, x = ?5, y = ?6, width = ?7, height = ?8, opacity = ?9, is_pinned = ?10, updated_at = CURRENT_TIMESTAMP WHERE id = ?11",
        params![note.title, note.content, note.note_type, note.category_id, note.x, note.y, note.width, note.height, note.opacity, note.is_pinned, note.id],
    )?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn get_all_todos(conn: &Connection) -> Result<Vec<TodoItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, content, is_done, sort_order FROM todo_items ORDER BY note_id, sort_order"
    )?;
    let items = stmt.query_map([], |row| {
        Ok(TodoItem {
            id: row.get(0)?,
            note_id: row.get(1)?,
            content: row.get(2)?,
            is_done: row.get(3)?,
            sort_order: row.get(4)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(items)
}

pub fn add_todo_item(conn: &Connection, note_id: i64, content: &str) -> Result<TodoItem> {
    let mut stmt = conn.prepare("SELECT MAX(sort_order) FROM todo_items WHERE note_id = ?1")?;
    let max_order: i32 = stmt.query_row(params![note_id], |row| row.get(0)).unwrap_or(0);
    
    conn.execute(
        "INSERT INTO todo_items (note_id, content, is_done, sort_order) VALUES (?1, ?2, 0, ?3)",
        params![note_id, content, max_order + 1],
    )?;
    let id = conn.last_insert_rowid();
    Ok(TodoItem {
        id,
        note_id,
        content: content.to_string(),
        is_done: false,
        sort_order: max_order + 1,
    })
}

pub fn update_todo_item(conn: &Connection, item: &TodoItem) -> Result<()> {
    conn.execute(
        "UPDATE todo_items SET content = ?1, is_done = ?2, sort_order = ?3 WHERE id = ?4",
        params![item.content, item.is_done, item.sort_order, item.id],
    )?;
    Ok(())
}

pub fn delete_todo_item(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM todo_items WHERE id = ?1", params![id])?;
    Ok(())
}
