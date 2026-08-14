use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub is_system: bool,
    pub sort_order: i64,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: i64,
    pub uuid: String,
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
    pub color: String,          // 十六进制颜色,卡片色条
    pub sort_order: i64,        // 自定义排序权重(仅本地)
    pub window_style: String,   // glass / solid / gradient
    pub status: String,         // active / trashed
    pub deleted_by: Option<String>, // user / auto_clean / NULL
    pub trashed_at: Option<String>,
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
    pub completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimelineEntry {
    pub id: String,            // uuid,同步标识
    pub note_id: Option<String>, // 便签 id 字符串(删除后仍保留,便于查看快照)
    pub note_title: Option<String>,
    pub action: String,        // create/update/delete/restore/pin/unpin/move/complete/uncomplete/attach/detach
    pub field_changes: Option<String>, // JSON
    pub note_snapshot: Option<String>, // JSON(删除时内容快照)
    pub category_id: Option<i64>,
    pub category_name: Option<String>,
    pub attachment_name: Option<String>,
    pub todo_content: Option<String>,
    pub device_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Attachment {
    pub id: i64,
    pub note_id: i64,
    pub file_name: String,
    pub file_path: String,
    pub file_size: i64,
    pub file_type: String,
    pub created_at: String,
}

const NOTE_COLS: &str = "id, uuid, title, content, note_type, category_id, x, y, width, height, \
    opacity, is_pinned, color, sort_order, window_style, status, deleted_by, trashed_at, \
    created_at, updated_at";

fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        uuid: row.get(1)?,
        title: row.get(2)?,
        content: row.get(3)?,
        note_type: row.get(4)?,
        category_id: row.get(5)?,
        x: row.get(6)?,
        y: row.get(7)?,
        width: row.get(8)?,
        height: row.get(9)?,
        opacity: row.get(10)?,
        is_pinned: row.get(11)?,
        color: row.get(12)?,
        sort_order: row.get(13)?,
        window_style: row.get(14)?,
        status: row.get(15)?,
        deleted_by: row.get(16)?,
        trashed_at: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

pub fn new_uuid() -> String {
    Uuid::new_v4().to_string()
}

/// sha256(salt:password),用于隐私分类密码与安全问题答案
pub fn hash_password(salt: &str, password: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{}:{}", salt, password).as_bytes());
    format!("{:x}", hasher.finalize())
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

        -- v3 迁移后 name 无 UNIQUE(支持重命名撞名),INSERT OR IGNORE 不再去重,每次启动会重复播种;
        -- 改为按名称存在性判断:仅当同名分类不存在时才插入(init_db 每次启动都会执行)
        INSERT INTO categories (name)
        SELECT '默认' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = '默认')
        UNION ALL SELECT '工作' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = '工作')
        UNION ALL SELECT '生活' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = '生活')
        UNION ALL SELECT '学习' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = '学习')
        UNION ALL SELECT '灵感' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = '灵感');
        "
    )?;
    Ok(())
}

pub fn migrate(conn: &Connection) -> Result<()> {
    // meta.value 是 TEXT,必须按字符串读再解析;直接 get::<i64> 会因类型不符恒失败,
    // 被 unwrap_or(0) 吞掉后每次启动都重跑迁移,把全部便签位置/尺寸重置(实测复现)
    let version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| {
            let s: String = r.get(0)?;
            s.parse::<i64>().map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
            })
        })
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
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '3')",
        [],
    )?;
    Ok(())
}

/// v3:按登录同步 spec §12 预埋同步列(uuid/user_id/synced/status/color/sort_order 等),
/// 新增时间轴与附件表,重建 categories 去掉 UNIQUE(支持重命名撞名),预置「隐私」系统分类。
fn migrate_v3(conn: &Connection) -> Result<()> {
    // notes 加列
    conn.execute_batch(
        "ALTER TABLE notes ADD COLUMN uuid TEXT;
         ALTER TABLE notes ADD COLUMN user_id INTEGER;
         ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
         ALTER TABLE notes ADD COLUMN deleted_by TEXT;
         ALTER TABLE notes ADD COLUMN trashed_at TEXT;
         ALTER TABLE notes ADD COLUMN color TEXT NOT NULL DEFAULT '#FFE066';
         ALTER TABLE notes ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE notes ADD COLUMN window_style TEXT NOT NULL DEFAULT 'glass';
         ALTER TABLE notes ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;"
    )?;

    // todo_items 加列
    conn.execute_batch(
        "ALTER TABLE todo_items ADD COLUMN uuid TEXT;
         ALTER TABLE todo_items ADD COLUMN user_id INTEGER;
         ALTER TABLE todo_items ADD COLUMN completed_at TEXT;
         ALTER TABLE todo_items ADD COLUMN synced INTEGER NOT NULL DEFAULT 0;"
    )?;

    // categories 重建:去掉 name UNIQUE(分类重命名可撞名),新增 uuid/user_id/sort_order/is_system/synced
    conn.execute_batch(
        "PRAGMA foreign_keys = OFF;
         CREATE TABLE categories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            uuid TEXT,
            user_id INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_system INTEGER NOT NULL DEFAULT 0,
            synced INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
         );
         INSERT INTO categories_new (id, name, sort_order, is_system, created_at)
            SELECT id, name, id, 0, created_at FROM categories;
         DROP TABLE categories;
         ALTER TABLE categories_new RENAME TO categories;
         PRAGMA foreign_keys = ON;"
    )?;

    // 存量数据补 uuid + 初始 sort_order(创建顺序)
    let mut stmt = conn.prepare("SELECT id FROM notes")?;
    let note_ids: Vec<i64> = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>>>()?;
    drop(stmt);
    for (i, id) in note_ids.iter().enumerate() {
        conn.execute(
            "UPDATE notes SET uuid = ?1, sort_order = ?2 WHERE id = ?3",
            params![new_uuid(), i as i64, id],
        )?;
    }
    let mut stmt = conn.prepare("SELECT id FROM categories WHERE is_system = 0")?;
    let cat_ids: Vec<i64> = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>>>()?;
    drop(stmt);
    for (i, id) in cat_ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET uuid = ?1, sort_order = ?2 WHERE id = ?3",
            params![new_uuid(), i as i64, id],
        )?;
    }
    let mut stmt = conn.prepare("SELECT id FROM todo_items")?;
    let todo_ids: Vec<i64> = stmt.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>>>()?;
    drop(stmt);
    for id in todo_ids {
        conn.execute("UPDATE todo_items SET uuid = ?1 WHERE id = ?2", params![new_uuid(), id])?;
    }

    // 预置「隐私」系统分类:已有同名用户分类则升级为系统分类,否则新建
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM categories WHERE name = '隐私' LIMIT 1", [], |r| r.get(0))
        .ok();
    match existing {
        Some(id) => {
            conn.execute(
                "UPDATE categories SET is_system = 1, sort_order = 10000 WHERE id = ?1",
                params![id],
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO categories (name, uuid, sort_order, is_system) VALUES ('隐私', ?1, 10000, 1)",
                params![new_uuid()],
            )?;
        }
    }

    // 时间轴 + 附件表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sticky_note_timeline (
            id TEXT PRIMARY KEY,
            note_id TEXT,
            note_title TEXT,
            action TEXT NOT NULL,
            field_changes TEXT,
            note_snapshot TEXT,
            category_id INTEGER,
            category_name TEXT,
            attachment_name TEXT,
            todo_content TEXT,
            device_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            synced INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_timeline_date ON sticky_note_timeline(created_at);
         CREATE INDEX IF NOT EXISTS idx_timeline_note ON sticky_note_timeline(note_id);
         CREATE INDEX IF NOT EXISTS idx_timeline_action ON sticky_note_timeline(action);

         CREATE TABLE IF NOT EXISTS sticky_note_attachment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER,
            file_type TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
         );"
    )?;
    Ok(())
}

// ============ meta ============

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM meta WHERE key = ?1")?;
    let mut rows = stmt.query(params![key])?;
    match rows.next()? {
        Some(row) => Ok(Some(row.get(0)?)),
        None => Ok(None),
    }
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

// ============ categories ============

pub fn get_all_categories(conn: &Connection) -> Result<Vec<Category>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, is_system, sort_order, created_at FROM categories ORDER BY sort_order, id",
    )?;
    let cats = stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            is_system: row.get(2)?,
            sort_order: row.get(3)?,
            created_at: row.get(4)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(cats)
}

pub fn add_category(conn: &Connection, name: &str) -> Result<Category> {
    let max_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM categories WHERE is_system = 0",
        [],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO categories (name, uuid, sort_order) VALUES (?1, ?2, ?3)",
        params![name, new_uuid(), max_order + 1],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Category {
        id,
        name: name.to_string(),
        is_system: false,
        sort_order: max_order + 1,
        created_at: String::new(),
    })
}

pub fn delete_category(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM categories WHERE id = ?1 AND is_system = 0", params![id])?;
    Ok(())
}

pub fn rename_category(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE categories SET name = ?1 WHERE id = ?2 AND is_system = 0",
        params![name, id],
    )?;
    Ok(())
}

pub fn reorder_categories(conn: &Connection, ids: &[i64]) -> Result<()> {
    for (i, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE categories SET sort_order = ?1 WHERE id = ?2 AND is_system = 0",
            params![i as i64, id],
        )?;
    }
    Ok(())
}

pub fn get_category_name(conn: &Connection, id: i64) -> Result<Option<String>> {
    conn.query_row("SELECT name FROM categories WHERE id = ?1", params![id], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
}

// ============ notes ============

pub fn get_all_notes(conn: &Connection) -> Result<Vec<Note>> {
    // permanently_deleted 用户不可见、不同步(spec 7.10),留待后续物理清理
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM notes WHERE status != 'permanently_deleted'",
        NOTE_COLS
    ))?;
    let notes = stmt.query_map([], row_to_note)?.collect::<Result<Vec<_>>>()?;
    Ok(notes)
}

pub fn get_note_by_id(conn: &Connection, id: i64) -> Result<Note> {
    conn.query_row(
        &format!("SELECT {} FROM notes WHERE id = ?1", NOTE_COLS),
        params![id],
        row_to_note,
    )
}

pub fn add_note(conn: &Connection, note: &Note) -> Result<Note> {
    let max_order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order), -1) FROM notes",
        [],
        |r| r.get(0),
    )?;
    let uuid = if note.uuid.is_empty() { new_uuid() } else { note.uuid.clone() };
    let color = if note.color.is_empty() { "#FFE066".to_string() } else { note.color.clone() };
    let style = if note.window_style.is_empty() { "glass".to_string() } else { note.window_style.clone() };
    conn.execute(
        "INSERT INTO notes (uuid, title, content, note_type, category_id, x, y, width, height, \
            opacity, is_pinned, color, sort_order, window_style, status) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'active')",
        params![
            uuid, note.title, note.content, note.note_type, note.category_id, note.x, note.y,
            note.width, note.height, note.opacity, note.is_pinned, color, max_order + 1, style
        ],
    )?;
    get_note_by_id(conn, conn.last_insert_rowid())
}

// 注意:UPDATE 不含 is_pinned/sort_order/color/window_style/status —— 这些字段只经
// 专用原子命令变更(set_pinned/set_note_color/set_note_style/reorder/trash/restore),
// flush 整行写回不可能覆盖它们,消除双窗口陈旧快照竞争(同置顶问题的根治方案)。
pub fn update_note(conn: &Connection, note: &Note) -> Result<()> {
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, note_type = ?3, category_id = ?4, x = ?5, \
            y = ?6, width = ?7, height = ?8, opacity = ?9, updated_at = CURRENT_TIMESTAMP WHERE id = ?10",
        params![
            note.title, note.content, note.note_type, note.category_id, note.x, note.y,
            note.width, note.height, note.opacity, note.id
        ],
    )?;
    Ok(())
}

pub fn set_pinned(conn: &Connection, id: i64, pinned: bool) -> Result<()> {
    conn.execute(
        "UPDATE notes SET is_pinned = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![pinned, id],
    )?;
    Ok(())
}

pub fn set_note_color(conn: &Connection, id: i64, color: &str) -> Result<()> {
    conn.execute(
        "UPDATE notes SET color = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![color, id],
    )?;
    Ok(())
}

pub fn set_note_style(conn: &Connection, id: i64, style: &str) -> Result<()> {
    conn.execute(
        "UPDATE notes SET window_style = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![style, id],
    )?;
    Ok(())
}

pub fn trash_note(conn: &Connection, id: i64) -> Result<Option<Note>> {
    let note = get_note_by_id(conn, id).ok();
    // spec:deleted_by 仅记录「彻底删除」来源,trashed 状态保持 NULL
    conn.execute(
        "UPDATE notes SET status = 'trashed', trashed_at = CURRENT_TIMESTAMP, \
            updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    )?;
    Ok(note)
}

pub fn restore_note(conn: &Connection, id: i64) -> Result<Option<Note>> {
    let note = get_note_by_id(conn, id).ok();
    conn.execute(
        "UPDATE notes SET status = 'active', deleted_by = NULL, trashed_at = NULL, \
            updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    )?;
    Ok(note)
}

/// 用户手动彻底删除:trashed → permanently_deleted,deleted_by = 'user'
pub fn delete_note_forever(conn: &Connection, id: i64) -> Result<Option<Note>> {
    permanently_delete_note(conn, id, "user")
}

/// 标记为 permanently_deleted(spec 7.10 软删除状态设计:便签行保留、不同步、用户不可见,
/// 后续物理清理);附件/待办为纯本地关联数据,随彻底删除立即物理清理。
pub fn permanently_delete_note(conn: &Connection, id: i64, deleted_by: &str) -> Result<Option<Note>> {
    let note = get_note_by_id(conn, id).ok();
    conn.execute(
        "UPDATE notes SET status = 'permanently_deleted', deleted_by = ?1, \
            updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
        params![deleted_by, id],
    )?;
    conn.execute("DELETE FROM sticky_note_attachment WHERE note_id = ?1", params![id])?;
    conn.execute("DELETE FROM todo_items WHERE note_id = ?1", params![id])?;
    Ok(note)
}

/// 回收站中超期(days 天)的便签 id 列表
pub fn get_expired_trash_ids(conn: &Connection, days: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM notes WHERE status = 'trashed' AND trashed_at IS NOT NULL \
            AND trashed_at < datetime('now', ?1)",
    )?;
    let ids = stmt
        .query_map(params![format!("-{} days", days)], |r| r.get(0))?
        .collect::<Result<Vec<_>>>()?;
    Ok(ids)
}

/// 自定义排序:ids 按序编号,其余 active 便签续编(避免 sort_order 冲突)
pub fn reorder_notes(conn: &Connection, ids: &[i64]) -> Result<()> {
    let mut order = 0i64;
    for id in ids {
        conn.execute(
            "UPDATE notes SET sort_order = ?1 WHERE id = ?2",
            params![order, id],
        )?;
        order += 1;
    }
    let rest: Vec<i64> = if ids.is_empty() {
        let mut stmt = conn.prepare("SELECT id FROM notes WHERE status = 'active' ORDER BY sort_order, id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        rows.collect::<Result<Vec<_>>>()?
    } else {
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id FROM notes WHERE status = 'active' AND id NOT IN ({}) ORDER BY sort_order, id",
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| r.get(0))?;
        rows.collect::<Result<Vec<_>>>()?
    };
    for id in rest {
        conn.execute(
            "UPDATE notes SET sort_order = ?1 WHERE id = ?2",
            params![order, id],
        )?;
        order += 1;
    }
    Ok(())
}

pub fn duplicate_note(conn: &Connection, id: i64) -> Result<Note> {
    let src = get_note_by_id(conn, id)?;
    let mut copy = src.clone();
    copy.id = 0;
    copy.uuid = String::new();
    copy.title = format!("{} (副本)", src.title);
    copy.is_pinned = false;
    copy.status = "active".to_string();
    copy.deleted_by = None;
    copy.trashed_at = None;
    add_note(conn, &copy)
}

// ============ todos ============

pub fn get_all_todos(conn: &Connection) -> Result<Vec<TodoItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, content, is_done, sort_order, completed_at FROM todo_items \
            ORDER BY note_id, sort_order",
    )?;
    let items = stmt.query_map([], |row| {
        Ok(TodoItem {
            id: row.get(0)?,
            note_id: row.get(1)?,
            content: row.get(2)?,
            is_done: row.get(3)?,
            sort_order: row.get(4)?,
            completed_at: row.get(5)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(items)
}

pub fn get_todo_item(conn: &Connection, id: i64) -> Result<TodoItem> {
    conn.query_row(
        "SELECT id, note_id, content, is_done, sort_order, completed_at FROM todo_items WHERE id = ?1",
        params![id],
        |row| {
            Ok(TodoItem {
                id: row.get(0)?,
                note_id: row.get(1)?,
                content: row.get(2)?,
                is_done: row.get(3)?,
                sort_order: row.get(4)?,
                completed_at: row.get(5)?,
            })
        },
    )
}

pub fn add_todo_item(conn: &Connection, note_id: i64, content: &str) -> Result<TodoItem> {
    let mut stmt = conn.prepare("SELECT MAX(sort_order) FROM todo_items WHERE note_id = ?1")?;
    let max_order: i32 = stmt.query_row(params![note_id], |row| row.get(0)).unwrap_or(0);

    conn.execute(
        "INSERT INTO todo_items (uuid, note_id, content, is_done, sort_order) VALUES (?1, ?2, ?3, 0, ?4)",
        params![new_uuid(), note_id, content, max_order + 1],
    )?;
    let id = conn.last_insert_rowid();
    Ok(TodoItem {
        id,
        note_id,
        content: content.to_string(),
        is_done: false,
        sort_order: max_order + 1,
        completed_at: None,
    })
}

/// 勾选时自动补 completed_at(首次勾选时间),取消勾选则清空
pub fn update_todo_item(conn: &Connection, item: &TodoItem) -> Result<()> {
    conn.execute(
        "UPDATE todo_items SET content = ?1, is_done = ?2, sort_order = ?3, \
            completed_at = CASE WHEN ?2 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END \
            WHERE id = ?4",
        params![item.content, item.is_done, item.sort_order, item.id],
    )?;
    Ok(())
}

pub fn delete_todo_item(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM todo_items WHERE id = ?1", params![id])?;
    Ok(())
}

// ============ timeline ============

pub fn add_timeline(conn: &Connection, entry: &TimelineEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO sticky_note_timeline (id, note_id, note_title, action, field_changes, \
            note_snapshot, category_id, category_name, attachment_name, todo_content, device_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
        params![
            entry.id, entry.note_id, entry.note_title, entry.action, entry.field_changes,
            entry.note_snapshot, entry.category_id, entry.category_name, entry.attachment_name,
            entry.todo_content, entry.device_id
        ],
    )?;
    Ok(())
}

pub fn get_all_timeline(conn: &Connection) -> Result<Vec<TimelineEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, note_title, action, field_changes, note_snapshot, category_id, \
            category_name, attachment_name, todo_content, device_id, created_at \
            FROM sticky_note_timeline ORDER BY created_at DESC, id DESC",
    )?;
    let entries = stmt.query_map([], |row| {
        Ok(TimelineEntry {
            id: row.get(0)?,
            note_id: row.get(1)?,
            note_title: row.get(2)?,
            action: row.get(3)?,
            field_changes: row.get(4)?,
            note_snapshot: row.get(5)?,
            category_id: row.get(6)?,
            category_name: row.get(7)?,
            attachment_name: row.get(8)?,
            todo_content: row.get(9)?,
            device_id: row.get(10)?,
            created_at: row.get(11)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(entries)
}

// ============ attachments ============

pub fn get_attachments(conn: &Connection, note_id: i64) -> Result<Vec<Attachment>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, file_name, file_path, file_size, file_type, created_at \
            FROM sticky_note_attachment WHERE note_id = ?1 ORDER BY id",
    )?;
    let items = stmt.query_map(params![note_id], |row| {
        Ok(Attachment {
            id: row.get(0)?,
            note_id: row.get(1)?,
            file_name: row.get(2)?,
            file_path: row.get(3)?,
            file_size: row.get(4)?,
            file_type: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?.collect::<Result<Vec<_>>>()?;
    Ok(items)
}

pub fn add_attachment(
    conn: &Connection,
    note_id: i64,
    file_name: &str,
    file_path: &str,
    file_size: i64,
    file_type: &str,
) -> Result<Attachment> {
    conn.execute(
        "INSERT INTO sticky_note_attachment (note_id, file_name, file_path, file_size, file_type) \
            VALUES (?1, ?2, ?3, ?4, ?5)",
        params![note_id, file_name, file_path, file_size, file_type],
    )?;
    let id = conn.last_insert_rowid();
    Ok(Attachment {
        id,
        note_id,
        file_name: file_name.to_string(),
        file_path: file_path.to_string(),
        file_size,
        file_type: file_type.to_string(),
        created_at: String::new(),
    })
}

pub fn delete_attachment(conn: &Connection, id: i64) -> Result<Option<Attachment>> {
    let mut stmt = conn.prepare(
        "SELECT id, note_id, file_name, file_path, file_size, file_type, created_at \
            FROM sticky_note_attachment WHERE id = ?1",
    )?;
    let existing = stmt
        .query_row(params![id], |row| {
            Ok(Attachment {
                id: row.get(0)?,
                note_id: row.get(1)?,
                file_name: row.get(2)?,
                file_path: row.get(3)?,
                file_size: row.get(4)?,
                file_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .ok();
    conn.execute("DELETE FROM sticky_note_attachment WHERE id = ?1", params![id])?;
    Ok(existing)
}

// ============ tests ============

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn sample_note() -> Note {
        Note {
            id: 0,
            uuid: String::new(),
            title: "测试便签".to_string(),
            content: "内容第一行\n第二行".to_string(),
            note_type: "text".to_string(),
            category_id: None,
            x: 100.0,
            y: 100.0,
            width: 300.0,
            height: 300.0,
            opacity: 0.9,
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

    #[test]
    fn migration_creates_v3_schema() {
        let conn = setup();
        // 新列存在
        let cols: Vec<String> = {
            let mut stmt = conn.prepare("PRAGMA table_info(notes)").unwrap();
            let rows = stmt.query_map([], |r| r.get::<_, String>(1)).unwrap();
            rows.collect::<Result<Vec<_>>>().unwrap()
        };
        for c in ["uuid", "user_id", "status", "deleted_by", "trashed_at", "color", "sort_order", "window_style", "synced"] {
            assert!(cols.contains(&c.to_string()), "notes 缺列 {}", c);
        }
        // 隐私分类存在且为系统分类
        let cat = conn
            .query_row("SELECT is_system, sort_order FROM categories WHERE name = '隐私'", [], |r| {
                Ok((r.get::<_, i64>(0).unwrap(), r.get::<_, i64>(1).unwrap()))
            })
            .expect("隐私分类不存在");
        assert_eq!(cat, (1, 10000));
        // 时间轴/附件表存在
        let tl: i64 = conn.query_row("SELECT COUNT(*) FROM sticky_note_timeline", [], |r| r.get(0)).unwrap();
        let at: i64 = conn.query_row("SELECT COUNT(*) FROM sticky_note_attachment", [], |r| r.get(0)).unwrap();
        assert_eq!((tl, at), (0, 0));
        // categories 无 UNIQUE(重命名撞名可成功)
        let name = "工作".to_string();
        add_category(&conn, &name).unwrap();
        let c2 = add_category(&conn, &name).unwrap();
        assert_ne!(c2.id, 0);
    }

    #[test]
    fn init_db_seeding_does_not_duplicate_without_name_unique() {
        // 回归:v3 迁移去掉 name UNIQUE 后,init_db 每次启动执行,
        // 播种必须靠名称存在性去重(线上曾复现同名默认分类多份)
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 5);
        // 迁移后再 init_db(模拟每次启动)不得新增重复
        migrate(&conn).unwrap();
        init_db(&conn).unwrap();
        let dupes: i64 = conn.query_row(
            "SELECT COUNT(*) FROM categories c WHERE (SELECT COUNT(*) FROM categories WHERE name = c.name) > 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
        assert_eq!(dupes, 0);
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 6); // 5 默认 + 隐私
        // 用户删除默认分类后重启,播种恢复缺失的默认名(与旧 UNIQUE 时代行为一致)
        conn.execute("DELETE FROM categories WHERE name = '工作'", []).unwrap();
        init_db(&conn).unwrap();
        let work: i64 = conn.query_row("SELECT COUNT(*) FROM categories WHERE name = '工作'", [], |r| r.get(0)).unwrap();
        assert_eq!(work, 1);
    }

    #[test]
    fn migration_is_idempotent_and_preserves_data() {
        let conn = setup();
        let mut n = sample_note();
        let saved = add_note(&conn, &n).unwrap();
        assert!(!saved.uuid.is_empty());
        // 再跑一次 migrate 不应丢数据/报错
        migrate(&conn).unwrap();
        let all = get_all_notes(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "测试便签");
        assert_eq!(all[0].uuid, saved.uuid);
        // 重建 categories 不破坏 FK:便签 category 关联仍有效
        n.category_id = Some(saved.id);
        update_note(&conn, &n).unwrap();
        let reloaded = get_note_by_id(&conn, saved.id).unwrap();
        assert_eq!(reloaded.title, "测试便签");
    }

    #[test]
    fn note_lifecycle_trash_restore_delete() {
        let conn = setup();
        let saved = add_note(&conn, &sample_note()).unwrap();
        assert_eq!(saved.status, "active");
        assert_eq!(saved.color, "#FFE066");

        // 软删除:deleted_by 保持 NULL(spec 7.10 删除来源标记)
        let trashed = trash_note(&conn, saved.id).unwrap().unwrap();
        assert_eq!(trashed.title, "测试便签");
        let in_db = get_note_by_id(&conn, saved.id).unwrap();
        assert_eq!(in_db.status, "trashed");
        assert_eq!(in_db.deleted_by.as_deref(), None);
        assert!(in_db.trashed_at.is_some());

        // 恢复
        restore_note(&conn, saved.id).unwrap();
        let restored = get_note_by_id(&conn, saved.id).unwrap();
        assert_eq!(restored.status, "active");
        assert!(restored.trashed_at.is_none());
        assert!(restored.deleted_by.is_none());

        // 彻底删除:标记 permanently_deleted(行保留),deleted_by = 'user',列表不可见
        let deleted = delete_note_forever(&conn, saved.id).unwrap().unwrap();
        assert_eq!(deleted.id, saved.id);
        let gone = get_note_by_id(&conn, saved.id).unwrap();
        assert_eq!(gone.status, "permanently_deleted");
        assert_eq!(gone.deleted_by.as_deref(), Some("user"));
        assert!(!get_all_notes(&conn).unwrap().iter().any(|n| n.id == saved.id));

        // auto_clean 来源标记
        let a = add_note(&conn, &sample_note()).unwrap();
        permanently_delete_note(&conn, a.id, "auto_clean").unwrap();
        let b = get_note_by_id(&conn, a.id).unwrap();
        assert_eq!(b.status, "permanently_deleted");
        assert_eq!(b.deleted_by.as_deref(), Some("auto_clean"));
    }

    #[test]
    fn duplicate_reorder_color_style() {
        let conn = setup();
        let a = add_note(&conn, &sample_note()).unwrap();
        let dup = duplicate_note(&conn, a.id).unwrap();
        assert_eq!(dup.title, "测试便签 (副本)");
        assert_ne!(dup.id, a.id);
        assert_ne!(dup.uuid, a.uuid);
        assert!(dup.sort_order > a.sort_order);

        reorder_notes(&conn, &[dup.id, a.id]).unwrap();
        let all = get_all_notes(&conn).unwrap();
        let mut ordered = all.clone();
        ordered.sort_by_key(|n| n.sort_order);
        assert_eq!(ordered[0].id, dup.id);
        assert_eq!(ordered[1].id, a.id);

        set_note_color(&conn, a.id, "#FF0000").unwrap();
        set_note_style(&conn, a.id, "solid").unwrap();
        let n = get_note_by_id(&conn, a.id).unwrap();
        assert_eq!(n.color, "#FF0000");
        assert_eq!(n.window_style, "solid");

        // update_note 整行写回不应覆盖 color/style/is_pinned(原子字段保护)
        let mut stale = n.clone();
        stale.color = "#00FF00".to_string();
        stale.window_style = "gradient".to_string();
        stale.is_pinned = true;
        update_note(&conn, &stale).unwrap();
        let after = get_note_by_id(&conn, a.id).unwrap();
        assert_eq!(after.color, "#FF0000");
        assert_eq!(after.window_style, "solid");
        assert!(!after.is_pinned);
    }

    #[test]
    fn category_rename_reorder_and_system_protection() {
        let conn = setup();
        let c = add_category(&conn, "测试分类").unwrap();
        rename_category(&conn, c.id, "重命名").unwrap();
        let cats = get_all_categories(&conn).unwrap();
        assert!(cats.iter().any(|x| x.id == c.id && x.name == "重命名"));

        // 系统分类(隐私)不可重命名/删除
        let priv_cat = cats.iter().find(|x| x.is_system).unwrap();
        rename_category(&conn, priv_cat.id, "改名").unwrap();
        assert!(get_category_name(&conn, priv_cat.id).unwrap().unwrap() == "隐私");
        delete_category(&conn, priv_cat.id).unwrap();
        assert!(get_category_name(&conn, priv_cat.id).unwrap().is_some());

        // 重排序
        let user_ids: Vec<i64> = cats.iter().filter(|x| !x.is_system).map(|x| x.id).collect();
        let mut reversed = user_ids.clone();
        reversed.reverse();
        reorder_categories(&conn, &reversed).unwrap();
        let after = get_all_categories(&conn).unwrap();
        let after_user: Vec<i64> = after.iter().filter(|x| !x.is_system).map(|x| x.id).collect();
        assert_eq!(after_user, reversed);
    }

    #[test]
    fn todo_completed_at_toggle() {
        let conn = setup();
        let note = add_note(&conn, &sample_note()).unwrap();
        let todo = add_todo_item(&conn, note.id, "买牛奶").unwrap();
        assert!(todo.completed_at.is_none());

        let mut done = todo.clone();
        done.is_done = true;
        update_todo_item(&conn, &done).unwrap();
        let after = get_todo_item(&conn, todo.id).unwrap();
        assert!(after.completed_at.is_some());

        let mut undone = after.clone();
        undone.is_done = false;
        update_todo_item(&conn, &undone).unwrap();
        assert!(get_todo_item(&conn, todo.id).unwrap().completed_at.is_none());
    }

    #[test]
    fn timeline_add_and_query_order() {
        let conn = setup();
        let note = add_note(&conn, &sample_note()).unwrap();
        for i in 0..3 {
            let e = TimelineEntry {
                id: new_uuid(),
                note_id: Some(note.id.to_string()),
                note_title: Some(format!("便签{}", i)),
                action: "create".to_string(),
                field_changes: None,
                note_snapshot: None,
                category_id: None,
                category_name: None,
                attachment_name: None,
                todo_content: None,
                device_id: Some("device-1".to_string()),
                created_at: String::new(),
            };
            add_timeline(&conn, &e).unwrap();
        }
        let entries = get_all_timeline(&conn).unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].device_id.as_deref(), Some("device-1"));
        assert_eq!(entries[0].note_id.as_deref(), Some(note.id.to_string().as_str()));
    }

    #[test]
    fn attachment_crud() {
        let conn = setup();
        let note = add_note(&conn, &sample_note()).unwrap();
        let att = add_attachment(&conn, note.id, "报告.pdf", r"C:\files\报告.pdf", 1024, "pdf").unwrap();
        let list = get_attachments(&conn, note.id).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].file_name, "报告.pdf");

        let removed = delete_attachment(&conn, att.id).unwrap().unwrap();
        assert_eq!(removed.file_path, r"C:\files\报告.pdf");
        assert!(get_attachments(&conn, note.id).unwrap().is_empty());
        // 便签删除级联清附件
        add_attachment(&conn, note.id, "x.txt", "C:\\x.txt", 1, "txt").unwrap();
        delete_note_forever(&conn, note.id).unwrap();
        assert!(get_attachments(&conn, note.id).unwrap().is_empty());
    }

    #[test]
    fn expired_trash_detection() {
        let conn = setup();
        let saved = add_note(&conn, &sample_note()).unwrap();
        trash_note(&conn, saved.id).unwrap();
        // 刚进回收站不应过期
        assert!(get_expired_trash_ids(&conn, 30).unwrap().is_empty());
        // 人为把 trashed_at 改到 40 天前
        conn.execute(
            "UPDATE notes SET trashed_at = datetime('now', '-40 days') WHERE id = ?1",
            params![saved.id],
        )
        .unwrap();
        let expired = get_expired_trash_ids(&conn, 30).unwrap();
        assert_eq!(expired, vec![saved.id]);
    }

    #[test]
    fn privacy_hash_and_meta() {
        let conn = setup();
        let salt = "s3cret-salt";
        let h1 = hash_password(salt, "pass123");
        let h2 = hash_password(salt, "pass123");
        assert_eq!(h1, h2);
        assert_ne!(h1, hash_password(salt, "pass124"));
        assert_ne!(h1, hash_password("other-salt", "pass123"));
        assert_eq!(h1.len(), 64);

        set_meta(&conn, "privacy_salt", salt).unwrap();
        set_meta(&conn, "privacy_password_hash", &h1).unwrap();
        assert_eq!(get_meta(&conn, "privacy_salt").unwrap().unwrap(), salt);
        assert_eq!(get_meta(&conn, "privacy_password_hash").unwrap().unwrap(), h1);
        assert!(get_meta(&conn, "nonexistent").unwrap().is_none());
    }
}

    /// 真实备份库迁移验证(可选):
    /// 通过环境变量 STICKY_TEST_BACKUP 指定备份库路径时,复制到临时文件后执行
    /// init_db + migrate,断言迁移成功且数据无损(便签数不变、uuid 补齐、隐私分类就位)。
    /// 未提供路径时直接跳过,保证常规 cargo test 不依赖本机数据。
    #[test]
    fn migrate_real_backup_db() {
        let backup = match std::env::var("STICKY_TEST_BACKUP") {
            Ok(p) => p,
            Err(_) => return, // 未提供备份路径:跳过(纯单元测试环境)
        };
        let target = std::env::temp_dir().join(format!(
            "sticky_migrate_test_{}.db",
            std::process::id()
        ));
        std::fs::copy(&backup, &target).expect("复制备份库失败");

        let conn = Connection::open(&target).expect("打开备份库失败");
        let before: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .expect("读取便签数失败");

        init_db(&conn).unwrap();
        migrate(&conn).unwrap();

        // 版本号按字符串读,与 migrate 的 guard 逻辑一致
        let version = get_meta(&conn, "schema_version").unwrap().expect("schema_version 缺失");
        assert_eq!(version, "3", "迁移后 schema_version 应为 3");

        let after: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
            .expect("读取便签数失败");
        assert_eq!(before, after, "迁移后便签数不应变化");

        let no_uuid: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE uuid IS NULL OR uuid = ''",
                [],
                |r| r.get(0),
            )
            .expect("读取 uuid 统计失败");
        assert_eq!(no_uuid, 0, "迁移后所有便签应有 uuid");

        let privacy: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM categories WHERE name = '隐私' AND is_system = 1",
                [],
                |r| r.get(0),
            )
            .expect("读取隐私分类失败");
        assert_eq!(privacy, 1, "应存在系统分类「隐私」");

        let (tl, at): (i64, i64) = {
            let mut s = conn
                .prepare(
                    "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sticky_note_timeline'),
                            (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sticky_note_attachment')",
                )
                .unwrap();
            s.query_row([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
        };
        assert_eq!((tl, at), (1, 1), "时间轴与附件表应存在");

        drop(conn);
        let _ = std::fs::remove_file(&target);
    }

