# 便签应用 - 登录与多设备同步技术文档

> **状态**: 设计完成，待实现
>
> **更新时间**: 2026-08-14
>
> **MVP 范围**: 基础 CRUD + 本地模式 / 登录 + 简单同步 / 同步状态指示器 / 离线队列持久化 / Token 刷新 / 分类+待办+时间轴同步

---

## 1. 项目概述

### 1.1 背景

便签应用 (Sticky_notes) 是一个 Tauri 桌面应用，使用 SQLite 本地存储。现在需要添加多设备同步功能，复用现有 Toolbox 项目的后端服务。

### 1.2 核心设计原则

- **本地优先**：默认本地模式，无需登录即可使用
- **登录同步**：登录后启用云端同步，支持多设备
- **离线可用**：无网络时正常操作，联网后自动同步
- **数据隔离**：本地便签绑定 `user_id`，不同账号数据隔离

---

## 2. 整体架构

### 2.1 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri 桌面便签                            │
│                                                             │
│   ┌─────────────┐      ┌─────────────┐                     │
│   │  本地模式    │      │  登录模式    │                     │
│   │  (默认)     │ ───▶ │  (可选)     │                     │
│   │  SQLite     │ 登录  │  SQLite +   │                     │
│   │  无需账号    │ 后同步 │  云端同步   │                     │
│   └─────────────┘      └─────────────┘                     │
│         │                      │                            │
│         │                      ▼                            │
│         │              ┌──────────────┐                     │
│         │              │ Toolbox API  │                     │
│         │              │ /api/sticky-*│                     │
│         │              └──────────────┘                     │
│         │                      │                            │
│         └──────────────────────┘                            │
│                    本地 SQLite                               │
└─────────────────────────────────────────────────────────────┘
                              │
                        HTTPS API
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Toolbox 后端 (Spring Boot)                 │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │ 用户模块     │  │ 其他工具    │  │ 便签同步模块 (新增)   │ │
│  │ Auth/User   │  │ AI/Note/... │  │ StickyNote*         │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
│         │                                    │              │
│         └──────────┬─────────────────────────┘              │
│                    │                                        │
│              ┌─────┴─────┐                                  │
│              │  MySQL DB  │                                  │
│              │  sys_user  │ ← 现有用户表                      │
│              │  sticky_*  │ ← 新增表                         │
│              └───────────┘                                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 用户体验流程

```
首次打开
    │
    ▼
┌──────────────┐
│ 直接使用便签  │ ← 本地 SQLite 存储，无需登录
│ 创建/编辑/删除│
└──────┬───────┘
       │
       │ 想要多设备同步？
       ▼
┌──────────────┐
│  点击登录按钮  │ ← 顶部工具栏用户头像
│  输入账号密码  │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  登录成功                                 │
│  1. 本地数据上传到云端（全部，含登录前的）   │
│  2. 云端数据下载到本地                     │
│  3. 之后自动双向同步                       │
│  4. 退出登录 → 回到本地模式，数据保留       │
└──────────────────────────────────────────┘
```

### 2.3 两种模式对比

| 维度 | 本地模式 | 登录模式 |
|------|---------|---------|
| 数据存储 | 仅 SQLite | SQLite + MySQL |
| 多设备同步 | 不支持 | 支持 |
| 登录要求 | 不需要 | 需要 Toolbox 账号 |
| 网络要求 | 不需要 | 需要 |
| 数据安全 | 仅本机 | 云端备份 |

---

## 3. 关键设计决策

### 3.1 同步策略：Last Write Wins (LWW)

**含义**：谁最后修改的，以谁为准。不做复杂冲突弹窗，直接用时间戳判断。

```
场景：
  设备 A 在 10:00 修改了便签标题为 "会议记录"
  设备 B 在 10:01 修改了同一便签标题为 "待办事项"
  
结果：同步后，两边都显示 "待办事项"（10:01 的更新）
```

**特殊场景处理**：

| 场景 | 处理方式 |
|------|---------|
| 首次登录，本地有便签，云端空 | 全量上传 |
| 首次登录，云端有便签，本地空 | 全量下载 |
| 首次登录，两边都有便签 | 合并，按 `id` 去重，更新时间新的覆盖旧的 |
| 登录后断网操作，再联网 | 离线队列中的变更批量上传 |
| 用户正在编辑便签时同步 | 编辑中的便签不更新，编辑完成后以最新时间为准 |

### 3.2 便签 ID 策略

使用 **UUID v4** 作为便签 ID，保证跨设备全局唯一，不需要设备 UUID + 笔记 ID 的组合。

```typescript
// 生成 UUID v4
const noteId = crypto.randomUUID();  // 浏览器/Node.js 内置
```

### 3.3 数据隔离

- 本地便签绑定 `user_id`，本地模式下为 `NULL`
- 用户 A 的便签只在 A 登录时显示和同步
- 用户 B 登录时看不到 A 的本地便签
- 退出登录后，本地数据保留，下次登录同一账号继续同步

### 3.4 设备标识

- 首次启动时生成 UUID，存储在 `app_data_dir/device_id` 文件中
- 之后只读，不修改
- 开发版和正式版天然隔离（不同的 app_data_dir）

---

## 4. Toolbox 后端设计

### 4.1 数据库设计

**sticky_note 表**

```sql
CREATE TABLE sticky_note (
  id VARCHAR(36) PRIMARY KEY,           -- UUID v4，客户端生成
  user_id BIGINT NOT NULL,              -- 关联 sys_user.id
  title TEXT,
  content TEXT,
  color VARCHAR(20),                    -- 十六进制颜色值
  position_x INT DEFAULT 100,
  position_y INT DEFAULT 100,
  width INT DEFAULT 300,
  height INT DEFAULT 300,
  is_pinned BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'active',  -- active / trashed / permanently_deleted
  deleted_by VARCHAR(20),               -- 删除来源: user / auto_clean / NULL
  category_id VARCHAR(36),              -- 关联 sticky_category.id
  sort_order INT DEFAULT 0,             -- 自定义排序权重
  device_id VARCHAR(100),               -- 最后修改的设备
  version INT DEFAULT 1,                -- 版本号，每次修改 +1
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  trashed_at TIMESTAMP NULL,            -- 进入回收站时间
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_status (status),
  INDEX idx_updated_at (updated_at),
  INDEX idx_sort_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**sticky_note_sync_log 表**

```sql
CREATE TABLE sticky_note_sync_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  note_id VARCHAR(36) NOT NULL,
  action VARCHAR(10) NOT NULL,          -- create / update / delete
  device_id VARCHAR(100),               -- 设备标识
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  INDEX idx_user_sync (user_id, synced_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**sticky_category 表**

```sql
CREATE TABLE sticky_category (
  id VARCHAR(36) PRIMARY KEY,        -- UUID v4，客户端生成，全局唯一
  user_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  is_system BOOLEAN DEFAULT FALSE,   -- 系统分类（隐私）
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**todo_item 表**

```sql
CREATE TABLE todo_item (
  id VARCHAR(36) PRIMARY KEY,        -- UUID v4，客户端生成
  note_id VARCHAR(36) NOT NULL,      -- 关联便签 ID
  user_id BIGINT NOT NULL,
  content TEXT NOT NULL,
  is_completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP NULL,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES sticky_note(id) ON DELETE CASCADE,
  INDEX idx_note_id (note_id),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**sticky_timeline 表**

```sql
CREATE TABLE sticky_timeline (
  id VARCHAR(36) PRIMARY KEY,        -- UUID v4，客户端生成
  user_id BIGINT NOT NULL,
  note_id VARCHAR(36),               -- 关联便签 ID（删除后可能为 NULL）
  note_title TEXT,
  action VARCHAR(20) NOT NULL,       -- create / update / delete / restore / pin / unpin / move / complete / uncomplete
  field_changes TEXT,                -- JSON
  note_snapshot TEXT,                -- 删除时的内容快照
  category_id VARCHAR(36),
  category_name VARCHAR(100),
  todo_content TEXT,
  device_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  INDEX idx_user_date (user_id, created_at),
  INDEX idx_note_id (note_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 4.2 API 接口设计

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/auth/login` | POST | 登录（复用现有） | 无 |
| `/api/auth/register` | POST | 注册（复用现有） | 无 |
| `/api/auth/refresh` | POST | 刷新 Token | 需要 |
| `/api/sticky-notes` | GET | 获取用户所有便签（分页） | 需要 |
| `/api/sticky-notes` | POST | 创建便签 | 需要 |
| `/api/sticky-notes/{id}` | PUT | 更新便签 | 需要 |
| `/api/sticky-notes/{id}` | DELETE | 删除便签（软删除） | 需要 |
| `/api/sticky-notes/sync` | POST | 增量同步（便签+待办+分类+时间轴） | 需要 |
| `/api/sticky-categories` | GET | 获取用户所有分类 | 需要 |
| `/api/sticky-categories` | POST | 创建分类 | 需要 |
| `/api/sticky-categories/{id}` | PUT | 更新分类 | 需要 |
| `/api/sticky-categories/{id}` | DELETE | 删除分类 | 需要 |
| `/api/todo-items` | GET | 获取用户所有待办（分页） | 需要 |
| `/api/todo-items` | POST | 创建待办 | 需要 |
| `/api/todo-items/{id}` | PUT | 更新待办 | 需要 |
| `/api/todo-items/{id}` | DELETE | 删除待办 | 需要 |

**分页参数**：`?page=0&size=100`（每页最多 100 条）

**同步接口请求体**：

```json
{
  "lastSyncTime": "2026-08-10T10:00:00Z",
  "deviceId": "uuid-xxxx",
  "notes": [
    {
      "id": "note-uuid-1",
      "action": "create",
      "title": "新便签",
      "content": "内容",
      "color": "#FFD700",
      "positionX": 100,
      "positionY": 100,
      "width": 300,
      "height": 300,
      "isPinned": false,
      "status": "active",
      "categoryId": 1,
      "updatedAt": "2026-08-10T10:00:00Z"
    }
  ],
  "categories": [
    {
      "localId": "cat-local-uuid-1",
      "action": "create",
      "name": "工作"
    }
  ],
  "todos": [
    {
      "id": "todo-uuid-1",
      "noteId": "note-uuid-1",
      "action": "create",
      "content": "买牛奶",
      "isCompleted": false,
      "sortOrder": 0,
      "updatedAt": "2026-08-10T10:00:00Z"
    }
  ],
  "timeline": [
    {
      "id": "timeline-uuid-1",
      "noteId": "note-uuid-1",
      "noteTitle": "新便签",
      "action": "create",
      "fieldChanges": null,
      "noteSnapshot": null,
      "categoryId": 1,
      "categoryName": "工作",
      "todoContent": null,
      "createdAt": "2026-08-10T10:00:00Z"
    }
  ]
}
```

**同步接口响应体**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "cloudNotes": [...],
    "cloudCategories": [...],
    "cloudTodos": [...],
    "cloudTimeline": [...],
    "appliedChanges": ["note-uuid-1"],
    "serverTime": "2026-08-10T10:01:00Z",
    "hasMore": false
  }
}
```

> **同步范围**：一次同步请求包含便签、分类、待办、时间轴四类数据。后端按顺序处理：先处理分类（便签依赖 category_id），再处理便签，再处理待办（依赖 note_id），最后处理时间轴。

### 4.3 需要新增的文件

```
src/main/java/com/example/myerp/
├── entity/
│   ├── StickyNote.java
│   ├── StickyCategory.java
│   ├── TodoItem.java
│   ├── StickyTimeline.java
│   └── StickyNoteSyncLog.java
├── repository/
│   ├── StickyNoteRepository.java
│   ├── StickyCategoryRepository.java
│   ├── TodoItemRepository.java
│   ├── StickyTimelineRepository.java
│   └── StickyNoteSyncLogRepository.java
├── service/
│   ├── StickyNoteService.java        # CRUD 操作
│   ├── StickyCategoryService.java    # 分类 CRUD
│   ├── TodoItemService.java          # 待办 CRUD
│   ├── StickyTimelineService.java    # 时间轴操作
│   └── StickyNoteSyncService.java    # 同步逻辑（便签+分类+待办+时间轴）
├── controller/
│   ├── StickyNoteController.java     # 便签 API
│   ├── StickyCategoryController.java # 分类 API
│   └── TodoItemController.java       # 待办 API
└── dto/
    ├── StickyNoteDTO.java
    ├── StickyCategoryDTO.java
    ├── TodoItemDTO.java
    ├── StickyTimelineDTO.java
    └── StickySyncRequest.java        # 统一同步请求（含便签+分类+待办+时间轴）
```

### 4.4 复用现有模块

| 模块 | 复用内容 |
|------|---------|
| `SysUser` | 用户表，通过 `user_id` 关联 |
| `JwtUtil` | JWT 生成和验证 |
| `JwtAuthFilter` | 请求认证 |
| `UserContext` | 获取当前用户 ID |
| `Result<T>` | API 响应格式 |

### 4.5 权限设计

- 所有登录用户都能使用便签同步，不需要单独授权
- 使用现有的 JWT 认证机制
- Tauri 端调用 `/api/auth/login` 获取 token，格式：

```json
{
  "code": 200,
  "data": {
    "token": "eyJhbGciOiJI...",
    "userId": 1,
    "username": "admin"
  }
}
```

---

## 5. Tauri 前端设计

### 5.1 本地 SQLite 表结构

```sql
CREATE TABLE sticky_note (
  id TEXT PRIMARY KEY,              -- UUID v4，全局唯一
  user_id INTEGER,                  -- 本地模式为 NULL，登录后填入
  title TEXT,
  content TEXT,
  color TEXT,                       -- 十六进制颜色值
  position_x INTEGER,
  position_y INTEGER,
  width INTEGER,
  height INTEGER,
  is_pinned INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',     -- active / trashed / permanently_deleted
  deleted_by TEXT,                  -- 删除来源: user / auto_clean / NULL
  category_id TEXT,                  -- 关联 sticky_category.id
  sort_order INTEGER DEFAULT 0,     -- 自定义排序权重（仅本地，不同步）
  synced INTEGER DEFAULT 0,         -- 0=未同步, 1=已同步（首次上传标记）
  created_at TEXT,                  -- ISO 8601 格式
  updated_at TEXT,                  -- ISO 8601 格式
  trashed_at TEXT                   -- 进入回收站时间
);

CREATE INDEX idx_sticky_note_user ON sticky_note(user_id);
CREATE INDEX idx_sticky_note_status ON sticky_note(status);
CREATE INDEX idx_sticky_note_updated ON sticky_note(updated_at);
CREATE INDEX idx_sticky_note_sort ON sticky_note(sort_order);
```

**sticky_category 表（分类，需同步）**

```sql
CREATE TABLE sticky_category (
  id TEXT PRIMARY KEY,              -- UUID v4，全局唯一
  user_id INTEGER,                  -- 本地模式为 NULL，登录后填入
  name TEXT NOT NULL,               -- 分类名称
  sort_order INTEGER DEFAULT 0,     -- 本地排序权重（不同步，各设备独立）
  is_system INTEGER DEFAULT 0,      -- 1=系统分类（隐私），不可删除
  created_at TEXT NOT NULL,         -- ISO 8601 格式
  updated_at TEXT NOT NULL,         -- ISO 8601 格式
  synced INTEGER DEFAULT 0          -- 0=未同步, 1=已同步
);

CREATE INDEX idx_sticky_category_user ON sticky_category(user_id);
```

**todo_items 表（待办项，需同步）**

```sql
CREATE TABLE todo_items (
  id TEXT PRIMARY KEY,              -- UUID v4，全局唯一
  note_id TEXT NOT NULL,            -- 关联便签 ID（便签 status=active 才显示）
  user_id INTEGER,                  -- 本地模式为 NULL，登录后填入
  content TEXT NOT NULL,             -- 待办内容
  is_completed INTEGER DEFAULT 0,   -- 0=未完成, 1=已完成
  completed_at TEXT,                -- 完成时间（ISO 8601）
  sort_order INTEGER DEFAULT 0,     -- 同一便签内的排序
  created_at TEXT NOT NULL,         -- ISO 8601 格式
  updated_at TEXT NOT NULL,         -- ISO 8601 格式
  synced INTEGER DEFAULT 0          -- 0=未同步, 1=已同步
);

CREATE INDEX idx_todo_note ON todo_items(note_id);
CREATE INDEX idx_todo_user ON todo_items(user_id);
```

**sticky_note_timeline 表（操作日志，需同步）**

```sql
CREATE TABLE sticky_note_timeline (
  id TEXT PRIMARY KEY,              -- UUID v4，全局唯一（同步用）
  user_id INTEGER,                  -- 本地模式为 NULL，登录后填入
  note_id TEXT NOT NULL,             -- 关联便签 ID
  note_title TEXT,                   -- 便签标题快照
  action TEXT NOT NULL,              -- create / update / delete / restore / pin / unpin / move / complete / uncomplete
  field_changes TEXT,                -- JSON: {"title": {"old": "A", "new": "B"}, ...}
  note_snapshot TEXT,                -- 便签内容快照（删除时保存完整内容）
  category_id INTEGER,               -- 分类 ID
  category_name TEXT,                -- 分类名称快照
  todo_content TEXT,                 -- 待办项内容（待办操作时）
  device_id TEXT,                    -- 操作设备 ID（同步后显示来源设备）
  created_at TEXT NOT NULL,          -- ISO 8601
  synced INTEGER DEFAULT 0           -- 0=未同步, 1=已同步
);

CREATE INDEX idx_timeline_date ON sticky_note_timeline(created_at);
CREATE INDEX idx_timeline_note ON sticky_note_timeline(note_id);
CREATE INDEX idx_timeline_action ON sticky_note_timeline(action);
CREATE INDEX idx_timeline_user ON sticky_note_timeline(user_id);
```

> **排序说明**：`sort_order` 仅用于本地排序，不同步到云端。各设备同步后按创建时间排序，用户可在各设备上独立拖拽调整顺序。

### 5.2 需要新增的文件

```
src/
├── components/
│   └── Auth/
│       ├── LoginForm.tsx         # 登录界面
│       └── UserMenu.tsx          # 用户菜单（顶部工具栏头像）
├── hooks/
│   ├── useAuth.ts                # 认证状态管理
│   └── useSync.ts                # 同步逻辑
├── services/
│   ├── api.ts                    # API 请求封装
│   └── sync.ts                   # 同步引擎
└── types/
    └── sync.ts                   # 同步相关类型
```

### 5.3 登录态持久化

- JWT 存储在 **Tauri 安全存储**（系统钥匙串）
- 应用启动时自动检查并恢复登录态
- **Token 刷新**：access_token 快过期时（剩余 < 5 分钟），自动调用 `/api/auth/refresh` 获取新 token，使用 refresh_token 刷新，用户无感
- refresh_token 过期 → 踢回登录页，提示"登录已过期，请重新登录"
- 同步请求返回 401 → 尝试刷新 token → 刷新成功则重试原请求 → 刷新失败则踢回登录页

### 5.4 设备 ID 生成

```typescript
// 首次启动时生成，存储在 app_data_dir/device_id
function getDeviceId(): string {
  const deviceIdFile = await appDataDir() + '/device_id';
  
  if (await exists(deviceIdFile)) {
    return await readTextFile(deviceIdFile);
  }
  
  const id = crypto.randomUUID();
  await writeTextFile(deviceIdFile, id);
  return id;
}
```

### 5.5 同步状态指示器

```
┌─────────────────────────────────┐
│  顶部工具栏                      │
│  ┌─────┐  ┌──────────────────┐ │
│  │ 📝  │  │ ● 已同步 10:30   │ │  ← 同步状态指示器
│  └─────┘  └──────────────────┘ │
└─────────────────────────────────┘
```

显示内容：
- `● 同步中...` — 正在同步
- `● 已同步 10:30` — 上次同步时间
- `● 离线模式` — 未登录或无网络

自动重试：
- 同步失败后自动重试 5 次
- 5 次都失败后，每 1 分钟重试一次
- 网络恢复时立即触发同步

### 5.6 同步触发时机

| 触发条件 | 说明 |
|---------|------|
| 用户登录后 | 首次全量同步 |
| 便签/分类/待办/时间轴变更后 | 防抖 3 秒，避免频繁同步 |
| 应用启动时 | 恢复登录态后自动同步 |
| 网络恢复时 | 立即同步离线队列 |
| 手动触发 | 用户点击同步按钮（可选） |

### 5.7 离线队列设计

```typescript
interface QueuedChange {
  id: string;                    // 队列 ID
  noteId: string;                // 便签 ID
  action: 'create' | 'update' | 'delete';
  data: any;                     // 便签数据
  timestamp: number;             // 变更时间
  deviceId: string;              // 设备 ID
  userId: number | null;         // 用户 ID（本地模式为 null）
  retryCount: number;            // 已重试次数
  status: 'pending' | 'syncing' | 'failed' | 'completed';
}
```

持久化：存储在 `app_data_dir/sync_queue.json`

处理逻辑：
1. 登录前的本地变更 → 登录后全量上传
2. 登录后的增量变更 → 走离线队列
3. 队列按时间顺序处理
4. 每批最多 100 条（分页）

---

## 6. 同步流程详解

### 6.1 首次登录同步

```
用户登录
    │
    ▼
┌──────────────────────────────┐
│ 1. 获取本地未同步的数据       │
│    便签: synced = 0           │
│    分类: synced = 0           │
│    待办: synced = 0           │
│    时间轴: synced = 0         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 2. 批量上传到云端             │
│    POST /api/sticky-notes/sync│
│    先上传分类，再便签，再待办  │
│    每批 100 条                │
│    每批成功后标记 synced = 1  │
└──────────────┬───────────────┘
               │
               ▼ (中断恢复: 下次只传 synced=0 的)
┌──────────────────────────────┐
│ 3. 更新本地 user_id          │
│    NULL → 实际用户 ID         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4. 下载云端数据               │
│    GET /api/sticky-notes     │
│    GET /api/sticky-categories │
│    GET /api/todo-items        │
│    按 updated_at 增量下载    │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 5. 合并到本地 SQLite          │
│    按 id 去重，LWW 策略       │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 6. 更新 lastSyncTime         │
│    完成首次同步               │
└──────────────────────────────┘
```

> **断点续传**：每批上传成功后，本地标记 `synced = 1`。同步中断后重新登录时，只上传 `synced = 0` 的数据，避免重复上传。

### 6.2 增量同步

```
便签变更（创建/修改/删除）
    │
    ▼
┌──────────────────────────────┐
│ 1. 写入本地 SQLite            │
│ 2. 加入离线队列               │
└──────────────┬───────────────┘
               │
               ▼ (防抖 3 秒)
┌──────────────────────────────┐
│ 3. 收集队列中的变更           │
│    按时间排序，每批 100 条     │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4. 发送到云端                 │
│    POST /api/sticky-notes/sync│
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 5. 接收云端变更               │
│    排除当前设备的变更          │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 6. 合并到本地 SQLite          │
│    LWW 策略                   │
│    编辑中的便签跳过            │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 7. 清理已完成的队列项         │
│ 8. 更新 lastSyncTime         │
└──────────────────────────────┘
```

### 6.3 错误处理

| 错误类型 | 处理方式 |
|---------|---------|
| 网络超时 | 自动重试 5 次，失败后每 1 分钟重试 |
| 服务器 500 | 提示"服务器错误，请稍后重试" |
| 数据格式错误 | 跳过该条，记录日志，继续处理其他条目 |
| Token 过期 | 踢回登录页，提示重新登录 |
| 网络断开 | 切换到离线模式，联网后自动同步 |

---

## 7. 用户体验细节

### 7.1 布局结构（2026-08-11 确认，2026-08-13 设计更新）

**窗口尺寸**：280px × 600px（Tauri 配置 `tauri.conf.json`）

```
┌──────────────────────────────────────────────────┐
│ 标题栏 (32px)                                    │
│ ☁️✓ 便签        [👤] [🎨] [─] [✕]              │
│ 同步状态         登录  主题  最小  关闭            │
├──┬───────────────────────────────────────────────┤
│  │ 用户信息栏（仅登录后显示：头像 + 昵称）        │  ← 未登录时隐藏
├──┬───────────────────────────────────────────────┤
│分│  [便签 | 待办]              [🔍 搜索...]  [12]│  ← 标签+搜索合并一行
│类│  ┌───────────────────────────────────────┐    │
│栏│  │█ 便签卡片 1                           │    │  ← 左侧色条
│36│  │█ 便签卡片 2                           │    │
│px│  │█ 便签卡片 3                           │    │
│  │  └───────────────────────────────────────┘    │
│  │  （悬停显示文字 tooltip）                      │
│📁│                                              │
│🔒│                                              │
│🕐│                                              │
│──│ ← 分隔线                                     │
│+ │                                              │
│──│ ← 分隔线                                     │
│🗑️│                                              │
│⚙ │                                              │
└──┴───────────────────────────────────────────────┘
```

### 7.2 用户信息栏（仅登录后显示）

> **未登录时完全隐藏**。标题栏右侧显示登录图标（Lucide `User`），点击打开登录面板。

- **位置**：标题栏下方、标签切换行上方，横跨整个窗口宽度
- **高度**：约 40px
- **内容**：
  - 左侧：用户头像（24px 圆形）+ 用户名/昵称
  - 右侧：无（同步状态已移至标题栏）
- **未登录状态**：用户信息栏完全隐藏，标题栏右侧显示登录图标

### 7.3 用户头像

| 状态 | 显示 |
|------|------|
| 已登录 + 自定义头像 | 用户上传的头像（网页端上传） |
| 已登录 + 无头像 | 用户名首字母（圆形背景色） |
| 未登录 | 通用用户图标 |

- **点击行为**：已登录 → 弹出菜单（退出登录）；未登录 → 打开登录面板

### 7.4 同步状态指示器

位置：用户信息栏右侧，小字显示

| 状态 | 显示 | 样式 |
|------|------|------|
| 已同步 | 绿色圆点 + `已同步 · 10:30` | 绿色圆点 + 灰色文字 |
| 同步中 | 旋转图标 + `同步中 (3/100)` | 蓝色旋转图标 + 蓝色文字 |
| 离线 | 灰色圆点 + `离线` | 灰色圆点 + 灰色文字 |

### 7.5 登录面板

- **形式**：侧边面板（复用设置面板的滑入模式）
- **位置**：替换便签列表区域
- **返回**：左上角返回箭头 + 右上角关闭按钮

### 7.6 登录表单

- 邮箱输入框 + 密码输入框 + 登录按钮
- 「去注册」链接 → 点击打开网页端首页
- 不提供「忘记密码」（网页端处理）

### 7.7 登录交互细节

| 场景 | 行为 |
|------|------|
| 登录中 | 按钮变灰 + 文字变为「登录中...」 |
| 登录失败 | 表单下方显示红色错误文字（见下方错误文案） |
| 登录成功 | 关闭面板 → 更新用户信息栏 → 显示「同步中...」 |
| 注册 | 「去注册」链接，`shell.open(网页端URL)` |

**登录失败错误文案**：

| 错误类型 | 提示文案 |
|---------|---------|
| 网络超时 / 无法连接 | 「网络连接失败，请检查网络后重试」 |
| 密码错误 | 「邮箱或密码错误，请重新输入」 |
| 账号不存在 | 「邮箱或密码错误，请重新输入」（不暴露账号是否存在） |
| 账号被封禁 | 「该账号已被禁用，请联系管理员」 |
| 服务器错误 (5xx) | 「服务器繁忙，请稍后重试」 |
| 请求过于频繁 | 「操作过于频繁，请稍后再试」 |
| 未知错误 | 「登录失败，请稍后重试」 |

> **安全说明**：密码错误和账号不存在使用相同提示，避免暴露账号是否存在。

### 7.8 用户菜单（点击头像）

```
┌──────────────────┐
│  🚪 退出登录      │
└──────────────────┘
```

退出确认：「确定退出登录？退出后本地便签将保留」

### 7.9 退出登录

- 保留本地数据
- 清除登录态（JWT）
- 回到本地模式
- 便签继续可用

### 7.10 便签操作便捷化（2026-08-11 确认）

#### 快速新建

| 方式 | 操作 | 说明 |
|------|------|------|
| 快捷键 | `Ctrl+N` | 新建文字便签，自动打开编辑窗口 |
| 快捷键 | `Ctrl+T` | 新建待办清单，自动打开编辑窗口 |
| 工具栏 | 点击 `+` 按钮 | 默认新建文字便签（长按可选类型？待定） |

#### 便签窗口管理

- 保持独立窗口编辑（不改为内联编辑）
- **同一便签只允许打开一个窗口**：点击「在窗口中打开」时，如果该便签已有窗口，聚焦已有窗口而非新建
- 主界面新增「已打开的便签」列表区域，显示当前打开的窗口
- 点击列表项 → 聚焦对应窗口
- 位置：搜索栏下方或用户信息栏下方

#### 便签窗口状态

| 状态 | 尺寸 | 标题栏显示 | 内容区 |
|------|------|-----------|--------|
| 展开态 | 360×420 | 标题 + 时间 + 操作按钮 | 标题输入 + 内容编辑/待办列表 + 底部状态栏（字数/保存状态） |
| 收起态 | 240×200 | 标题 + 操作按钮（无时间） | 内容摘要（纯文本，最多 4 行） |

**时间显示规则**：仅展开态标题栏显示时间，收起态不显示时间。

#### 删除与回收站

**软删除状态设计**（数据库层面）：

| status 值 | 含义 | 用户可见 |
|-----------|------|---------|
| `active` | 正常显示 | ✓ |
| `trashed` | 回收站 | ✓（回收站页面） |
| `permanently_deleted` | 彻底删除 | ✗（不同步，后续物理清理） |

**交互流程**：

```
用户删除便签
    │
    ▼
状态: active → trashed
便签从主列表消失
    │
    ▼
用户进入回收站（分类栏底部入口）
    │
    ├── 恢复 → trashed → active
    └── 彻底删除 → trashed → permanently_deleted
```

**回收站入口**：分类栏底部，⚙ 设置按钮上方，图标为垃圾桶

#### 搜索增强

- `Ctrl+F` 聚焦搜索框
- 搜索匹配文字高亮显示（标题和内容中）

#### 便签颜色标记

- **入口**：右键菜单 → 「颜色」
- **预设颜色**：黄 `#FFE066` / 绿 `#A8E6CF` / 蓝 `#66D9EF` / 粉 `#FFB3BA` / 紫 `#D4A5FF` / 橙 `#FFB86C`
- **自定义**：支持手动输入十六进制颜色值
- **显示**：卡片背景色（半透明）

#### 便签排序

**排序模式**：

| 模式 | 说明 |
|------|------|
| 更新时间（默认） | 最近编辑的在前 |
| 创建时间 | 最新创建的在前 |
| 标题字母 | A-Z 排序 |
| 自定义 | 用户拖拽排序 |

**排序菜单**：搜索栏右侧或工具栏，下拉菜单选择

**自定义排序规则**：
- 选择「自定义」后进入拖拽模式
- 拖拽排序结果持久化保存
- 切换到其他排序模式后再切回「自定义」，恢复上次的顺序
- 新增便签：追加到自定义列表末尾

#### 导出功能

| 方式 | 操作 | 格式 |
|------|------|------|
| 单条导出 | 右键便签 → 导出 | `.txt` 文件 |
| 批量导出 | 工具栏或设置 → 导出所有 | `.json` 或 `.csv` |

#### 透明度调节

- 展开态和收起态统一支持滚轮调节透明度
- 滚轮上滚 = 增加透明度，下滚 = 减少透明度
- 范围：15% ~ 100%

#### 分类增强

| 功能 | 操作 |
|------|------|
| 重命名 | 双击分类名，或右键菜单 → 重命名 |
| 拖拽排序 | 拖拽分类项调整顺序 |

### 7.11 体验增强功能（2026-08-11 确认）

#### 全局快捷键

| 功能 | 默认快捷键 | 说明 |
|------|-----------|------|
| 快速新建文字便签 | `Ctrl+Shift+N` | 任何应用中均可触发 |
| 剪贴板创建便签 | `Ctrl+Shift+V` | 将剪贴板内容存为新便签 |
| 应用内新建文字便签 | `Ctrl+N` | 仅在 app 窗口激活时 |
| 应用内新建待办 | `Ctrl+T` | 仅在 app 窗口激活时 |
| 聚焦搜索 | `Ctrl+F` | 仅在 app 窗口激活时 |

**自定义设置**：设置面板 → 快捷键，支持用户自定义全局热键

**快捷键冲突检测**：

- 注册全局热键时，Tauri 会返回注册结果（成功/失败）
- 注册失败（被其他应用占用）→ 设置面板中该快捷键标红，显示提示「该快捷键已被其他应用占用，请更换」
- 不主动扫描系统已注册的快捷键（无可靠跨平台方案），采用**被动检测**：注册时捕获失败即为冲突
- 用户修改快捷键后，先尝试注册新组合，成功才生效；失败则保留原快捷键并提示冲突
- 应用内快捷键（Ctrl+N/T/F）冲突时，以本应用为准，不提示

#### 便签复制/克隆

- 入口：右键便签 → 「复制便签」
- 行为：创建一个标题为「原标题 (副本)」、内容相同的新便签
- 状态：新便签为 active，未分类（或与原便签同分类）

#### 自动保存状态提示

- 位置：便签窗口标题栏角落
- 显示：
  - 保存中 → 蓝色小圆点
  - 已保存 → 绿色小圆点，1 秒后消失
  - 未修改 → 无显示

#### 字数统计

- 位置：便签窗口底部状态栏
- 显示：`XX 字 · XX 字符`
- 开关：设置面板 → 「显示字数统计」，默认关闭

#### 主题切换

**入口**：设置面板 → 主题

**预设主题**：

| 主题名 | 背景色 | 文字色 | 说明 |
|--------|--------|--------|------|
| 暗色（默认） | `rgba(20,20,25,0.85)` | 白色 | 现有毛玻璃风格 |
| 亮色 | `rgba(255,255,255,0.95)` | 深色 | 浅色背景 |
| 淡蓝 | `rgba(200,220,240,0.9)` | 深色 | 清新风格 |
| 淡紫 | `rgba(220,200,240,0.9)` | 深色 | 柔和风格 |
| 淡黄 | `rgba(240,230,200,0.9)` | 深色 | 温暖风格 |

**自定义颜色**：支持手动输入十六进制背景色

#### 便签窗口样式

- **入口**：便签展开编辑时，右键菜单 → 「窗口样式」
- **可选样式**：
  - 毛玻璃（默认）
  - 纯色背景
  - 渐变背景
- 样式跟随便签保存，每个便签可独立设置

#### 回收站自动清理

**规则**：
- 自动清理：回收站中超过 30 天的便签，自动标记为 `permanently_deleted`
- 清理频率：应用启动时检查 + 每天凌晨检查一次（应用运行时）

**首次使用提示**：
- 用户首次进入回收站时，弹出提示：「回收站中的便签将在 30 天后自动彻底删除，删除后无法恢复」
- 提示框带「不再提示」复选框，勾选后不再弹出
- 提示记录存储在本地设置中

**删除来源标记**（新增字段 `deleted_by`）：

| deleted_by 值 | 含义 |
|---------------|------|
| `NULL` | 未删除（active / trashed 状态） |
| `user` | 用户手动彻底删除 |
| `auto_clean` | 系统自动清理（超过 30 天） |

**数据库变更**：

```sql
-- sticky_note 表新增字段
ALTER TABLE sticky_note ADD COLUMN deleted_by VARCHAR(20) DEFAULT NULL;
```

### 7.12 创新交互功能（2026-08-11 确认）

#### 闪电捕获栏（Quick Capture Bar）

**形态**：全局热键唤出的极简输入栏，类似 macOS Spotlight。

```
┌─────────────────────────────────────────────────────┐
│  📝 记点什么...                                Enter │
└─────────────────────────────────────────────────────┘
```

**交互流程**：

```
任意应用中按热键
    │
    ▼
屏幕顶部/中央弹出输入栏
    │
    ▼
输入内容，回车
    │
    ▼
自动保存为新便签，输入栏关闭
```

**详细规则**：

| 项目 | 说明 |
|------|------|
| 默认热键 | `Ctrl+Shift+Q`（可自定义） |
| 位置 | 屏幕顶部居中（固定，不跟随鼠标） |
| 输入 | 单行文本框，支持回车换行变为多行 |
| 保存 | `Enter` 保存并关闭，`Shift+Enter` 换行 |
| 取消 | `Esc` 关闭，不保存 |
| 标题 | 自动取第一行内容（截取前 30 字符） |
| 分类 | 保存到当前选中的分类，或未分类 |
| 保存后 | 不打开便签窗口，仅在列表中出现 |
| 动画 | 淡入淡出，200ms |

#### 拖拽创建便签

**支持的拖拽内容**：

| 拖拽内容 | 创建结果 |
|---------|---------|
| 纯文字 | 标题 = 第一行（前 30 字符），内容 = 全部文字 |
| URL 链接 | 标题 = 域名，内容 = URL |
| 图片 | 暂不支持（后续附件功能再考虑） |

**交互规则**：

- 拖拽到 app 窗口范围内时，窗口边框高亮提示
- 松开鼠标即创建便签
- 创建后自动打开便签窗口（方便用户补充编辑）

#### 内容感知快捷操作（URL 检测）

**检测规则**：

| 内容特征 | 右键菜单新增项 | 说明 |
|---------|--------------|------|
| URL 链接 | 「在浏览器中打开」 | 使用系统默认浏览器打开 |
| 邮箱地址 | 「发送邮件」 | 打开默认邮件客户端 |

**检测方式**：

- 便签内容中匹配 URL 正则：`https?://[^\s]+`
- 便签内容中匹配邮箱正则：`[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}`
- 便签标题栏或右键菜单显示快捷操作入口

### 7.13 借鉴敬业签的功能（2026-08-11 确认，细节已细化）

#### 时间轴（操作日志）

**入口**：底部功能栏新增「时间轴」按钮，点击替换便签列表区域

**界面**：

```
┌─────────────────────────────────────────────────────────────┐
│  时间轴                                                      │
├─────────────────────────────────────────────────────────────┤
│  [今天] [本周] [本月] [全部]           [🔽 筛选]    [🔍]     │
├─────────────────────────────────────────────────────────────┤
│  今天                                                        │
│  10:30  修改了「会议记录」  [展开 ▼]  📱 我的电脑             │
│         ├ 标题: 无标题 → 会议记录                             │
│         ├ 内容: 已修改                                        │
│         └ 分类: 未分类 → 工作                                 │
│  09:15  新建了「待办清单」  📱 手机                           │
│  09:00  ☐ 完成了「买牛奶」（购物清单）  📱 我的电脑           │
│                                                             │
│  昨天                                                        │
│  18:00  删除了「过期通知」  [查看内容]  📱 手机               │
│  14:20  修改了「项目计划」  📱 我的电脑                       │
│  10:00  新建了「购物清单」  📱 我的电脑                       │
│                                                             │
│              [< 1 2 3 ... 10 >]  每页 [50▾] 条              │
└─────────────────────────────────────────────────────────────┘
```

**记录的操作**：

| 操作 | 记录 | 展示 |
|------|------|------|
| 新建便签 | ✓ | 标题快照 |
| 编辑便签 | ✓ | 具体字段变化（可展开） |
| 删除便签（进回收站） | ✓ | 标题快照 + 可查看内容 |
| 从回收站恢复 | ✓ | |
| 彻底删除 | ✓ | |
| 置顶/取消置顶 | ✓ | |
| 添加/删除附件 | ✓ | "添加了 xxx.pdf" |
| 移动分类 | ✓ | "从 A → B" |
| 修改颜色 | ✗ | 不记录 |
| 勾选/取消待办项 | ✓ | 默认折叠/隐藏 |

**编辑操作的字段变化记录**：

| 字段 | 记录 | 展示方式 |
|------|------|---------|
| 标题 | ✓ | "标题: AAA → BBB" |
| 内容 | ✓ | "内容: 已修改"（不展示具体内容） |
| 分类 | ✓ | "分类: 工作 → 个人" |
| 附件 | ✓ | "添加了 xxx.pdf" / "删除了 xxx.pdf" |
| 置顶 | ✓ | "置顶了" / "取消置顶" |

**筛选条件**（顶部一行：时间范围标签 + 筛选器按钮 + 搜索框）：

| 维度 | 选项 | 交互方式 |
|------|------|---------|
| 时间范围 | 今天 / 本周 / 本月 / 全部 | 横向标签切换（始终显示） |
| 操作类型 | 新建 / 修改 / 删除（可多选） | 筛选器按钮展开面板 |
| 关键词 | 搜索便签标题 | 搜索框（始终显示） |

> **筛选器按钮**：点击 `🔽 筛选` 弹出面板，面板内可多选操作类型。选中条件后按钮高亮（品牌色），表示有活跃筛选。

**分页**：
- 默认每页 50 条
- 可自定义每页数量（20/50/100）
- 设置保存在本地
- 底部分页导航：`[< 1 2 3 ... 10 >]`

**已删除便签的展示**：
- 时间轴中显示「查看内容」按钮
- 点击弹窗展示便签的完整内容快照

**数据库**：

```sql
CREATE TABLE sticky_note_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,             -- 关联便签 ID
  note_title TEXT,                   -- 便签标题快照
  action TEXT NOT NULL,              -- create / update / delete / restore / pin / unpin / attach / detach / move / complete / uncomplete
  field_changes TEXT,                -- JSON: {"title": {"old": "A", "new": "B"}, ...}
  note_snapshot TEXT,                -- 便签内容快照（删除时保存完整内容）
  category_id INTEGER,               -- 分类 ID
  category_name TEXT,                -- 分类名称快照
  attachment_name TEXT,              -- 附件名称（附件操作时）
  todo_content TEXT,                 -- 待办项内容（待办操作时）
  created_at TEXT NOT NULL           -- ISO 8601
);

CREATE INDEX idx_timeline_date ON sticky_note_timeline(created_at);
CREATE INDEX idx_timeline_note ON sticky_note_timeline(note_id);
CREATE INDEX idx_timeline_action ON sticky_note_timeline(action);
```

#### 待办独立视图

**UI 布局**：

```
┌────────────────────────────────────────────┐
│ 标题栏 (32px)                  [─] [✕]     │
├──┬─────────────────────────────────────────┤
│ 用户信息栏                                  │
├──┬─────────────────────────────────────────┤
│  │ [便签] [待办]  ← 顶部横向切换            │
│  │  搜索栏                                 │
│分│  ┌─────────────────────────────────┐    │
│类│  │  未完成                          │    │
│栏│  │  ☐ 买牛奶         (购物清单)     │    │
│  │  │  ☐ 写周报         (工作待办)     │    │
│  │  │  ☐ 回复邮件       (工作待办)     │    │
│  │  │                                  │    │
│⚙ │  │  已完成                          │    │
│  │  │  ☑ 提交代码       (工作待办)     │    │
│  │  │  ☑ 买机票         (旅行计划)     │    │
│  │  └─────────────────────────────────┘    │
│  │                                         │
│  │ [+ 新增待办]                             │
│  └─────────────────────────────────────────┘
│  [时间轴]  ← 底部功能栏                     │
└────────────────────────────────────────────┘
```

**数据来源**：
- 展示所有待办项（todo_items），跨便签平铺
- 不是便签级别的展示，是待办项级别的展示

**排序规则**：
- 未完成在上，已完成在下
- 未完成：按创建时间倒序（最新创建的在前）
- 已完成：按完成时间倒序（最近完成的在前）

**隐私分类的待办**：
- 不显示在全局待办视图中
- 只在隐私分类内可见

**操作**：

| 操作 | 说明 |
|------|------|
| 勾选完成 | 点击复选框，实时切换状态 |
| 编辑内容 | 点击待办项文字，内联编辑 |
| 新增待办 | 点击底部「+ 新增待办」，自动创建新的待办便签 |
| 删除待办 | 右键菜单或悬浮删除按钮 |
| 跳转到所属便签 | 右键菜单「打开所属便签」，或点击来源标签 |

**标签切换的交互**：
- 搜索内容保留，自动在新视图中搜索
- 分类栏选中状态保留
- 便签/待办各自独立的滚动位置

#### 分类加密（隐私分组）

**内置隐私分组**：
- 系统预置一个「隐私」分类，不可删除、不可重命名
- 图标为🔒

**密码管理**：

| 项目 | 规则 |
|------|------|
| 首次设置 | 点击「隐私」分类时引导设置密码 |
| 修改密码 | 设置面板 → 安全 → 修改密码，需输入旧密码 |
| 密码强度 | 无要求，任意长度 |
| 密码存储 | 哈希存储在本地 SQLite |
| 安全问题 | 设置 2 个安全问题，用于找回密码 |
| 找回密码 | 回答 2 个安全问题，验证正确后重置密码 |

**安全问题设置流程**：

```
设置密码时
    │
    ▼
输入密码
    │
    ▼
设置安全问题 1
    │
    ▼
设置安全问题 2
    │
    ▼
完成
```

**找回密码流程**：

```
忘记密码
    │
    ▼
点击「忘记密码」
    │
    ▼
回答安全问题 1
    │
    ▼
回答安全问题 2
    │
    ├── 两个都正确 → 重置密码
    └── 任一错误 → 提示错误，重新输入
```

**锁定时机**：

| 场景 | 锁定？ |
|------|-------|
| 切换到其他分类 | ✓ |
| 切换到「待办」视图 | ✓ |
| 切换到「时间轴」 | ✓ |
| 应用最小化 | ✓ |
| 应用失去焦点 | ✗ |
| 超时未操作 | ✗ |
| 关闭应用再打开 | ✓ |

**锁定后的显示**：
- 便签列表区域只显示密码输入框
- 不显示任何便签内容

**交互流程**：

```
点击「隐私」分类
    │
    ├── 首次（未设置密码）→ 引导设置密码 + 安全问题
    │
    └── 已设置密码 → 显示密码输入框
                          │
                          ├── 输入正确 → 显示隐私便签
                          └── 输入错误 → 提示错误，重新输入
                                      │
                                      └── [忘记密码] → 安全问题找回

切换到其他分类 / 视图
    │
    ▼
自动锁定
```

**设计定位**：
- 隐私分类是**视觉隐藏**功能，防止他人偷窥使用者的电脑屏幕，**不提供数据加密**
- 本地 SQLite 存储明文，云端同步也是明文
- 仅在 UI 层面通过密码锁定来隐藏内容，不具备真正的安全防护能力

**同步说明**：
- 隐私分类的便签同步到云端（明文）
- UI 上有明确提示：「隐私分类仅用于视觉隐藏，数据以明文同步到云端，请勿存储密码、银行卡号等高度敏感信息」
- 提示位置：首次进入隐私分类时 + 设置面板中

#### 附件支持（文件链接）

**当前阶段**：支持文件链接（不嵌入文件内容）

> **⚠️ 多设备限制**：附件使用本地文件路径存储，在多设备同步场景下，其他设备无法打开该文件（路径不存在）。附件功能**仅在单设备场景下可用**，后续版本将支持文件上传到云端以实现跨设备访问。

**数据库**：

```sql
CREATE TABLE sticky_note_attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,             -- 关联便签 ID
  file_name TEXT NOT NULL,           -- 文件名
  file_path TEXT NOT NULL,           -- 文件路径（本地）或 URL
  file_size INTEGER,                 -- 文件大小（字节）
  file_type TEXT,                    -- 文件类型（扩展名）
  created_at TEXT NOT NULL
);
```

**交互**：
- 便签编辑窗口底部添加「附件」区域
- 支持拖拽文件到便签窗口添加附件
- 支持点击「添加附件」按钮选择文件
- 附件列表显示文件名、大小
- 双击附件打开文件（使用系统默认程序）
- 右键附件可删除

### 7.14 UI 规范与细节（2026-08-11 确认，2026-08-13 设计语言更新）

#### 设计语言

**风格定位**：冷峻、高信息密度、科技感（参考 Linear）

**设计原则**：
- 信息密度优先，减少无意义的留白
- 暗色为主色调，冷色系配色
- 线条感强，少用圆角（圆角 4-6px，不用大圆角）
- 图标统一使用 Lucide Icons（SVG），不用 emoji
- 视觉层级通过字号差异 + 中性色阶体现，不依赖装饰元素

#### 间距系统（4px 基准，适配 280px 窄屏）

| 尺寸 | 用途 |
|------|------|
| 4px | 图标与文字间距、紧凑元素间距 |
| 6px | 卡片之间间距（窄屏优化，标准 8px） |
| 8px | 卡片内元素间距、列表项间距 |
| 12px | 卡片内边距、搜索框内边距、面板内边距 |
| 16px | 区域间距 |
| 24px | 大区域分隔 |
| 32px | 标题栏高度 |

#### 字号体系（适配 280px 窄屏）

| 元素 | 字号 | 字重 | 说明 |
|------|------|------|------|
| 标题栏 | 14px | 600 | 固定「便签」 |
| 便签标题 | 13px | 600 | 加粗，视觉锚点（窄屏从 14px 缩小） |
| 分类名 | 12px | 400 | 悬停 tooltip 显示 |
| 内容预览 | 11px | 400 | 窄屏优化 |
| 按钮文字 | 12px | 400 | |
| 搜索框 | 12px | 400 | |
| 时间 | 10px | 400 | 最小字号，辅助信息 |
| 同步状态 | 10px | 400 | 标题栏内 |

#### 色彩系统

> 后续补充完整色彩规范表（主色、语义色、中性色阶、各主题色值）

**当前定义**：

| 类型 | 暗色主题 | 说明 |
|------|---------|------|
| 背景色 | `rgba(20,20,25,0.85)` | 毛玻璃底色 |
| 文字主色 | `#E8E8E8` | 主要文字 |
| 文字次色 | `#A0A0A0` | 次要信息（时间、预览） |
| 文字禁用 | `#666666` | 禁用态 |
| 分割线 | `rgba(255,255,255,0.08)` | 细分割线 |
| 选中态 | `rgba(255,255,255,0.06)` | 分类栏选中背景 |
| 悬浮态 | `rgba(255,255,255,0.04)` | 卡片悬浮背景 |
| 品牌色 | `#4C9EEB` | 按钮、链接、选中指示 |
| 成功色 | `#4CAF50` | 同步成功 |
| 警告色 | `#FF9800` | |
| 错误色 | `#F44336` | 删除、错误提示 |

#### 标题栏

| 项目 | 规则 |
|------|------|
| 标题文字 | 固定显示「便签」，不变 |
| 左侧区域 | 标题文字 + 同步状态图标（已登录时） |
| 右侧区域 | 登录图标（未登录） / 用户头像（已登录） + 主题切换 + 最小化 + 关闭 |
| 同步状态（标题栏） | 云朵图标：☁️✓ 已同步 / ☁️↻ 同步中（旋转动画） / ☁️✗ 离线（断开云朵） |
| 登录图标 | 未登录时显示人形轮廓图标（Lucide `User`），点击打开登录面板 |
| 主题切换 | 点击弹出主题选择面板（暗色/亮色/淡蓝/淡紫/淡黄/自定义） |
| 拖拽 | 整个标题栏可拖拽移动窗口（图标区域除外） |

> **同步状态位置变更**：同步状态从用户信息栏移至标题栏左侧，与标题文字同行，确保在任何视图下都可见。

#### 用户信息栏（仅登录后显示）

> **未登录时完全隐藏**，标题栏右侧仅显示登录图标。登录后展开用户信息栏。

| 状态 | 显示 |
|------|------|
| 未登录 | 完全隐藏用户信息栏 |
| 已登录 | 头像（24px 圆形）+ 昵称 |
| 高度 | 约 40px |

> **同步状态已移至标题栏**，用户信息栏不再显示同步状态。

**点击区域**：头像和昵称均可点击，弹出用户菜单

#### 分类栏

**图标规则**：

| 分类 | 图标 | 说明 |
|------|------|------|
| 分类 | 图标 | 说明 |
|------|------|------|
| 全部 | Lucide `LayoutGrid` | 始终显示 |
| 用户自定义分类 | Lucide `Folder` | 默认图标，可自定义 |
| 隐私 | Lucide `Lock` | 系统分类 |
| 时间轴 | Lucide `Clock` | 系统功能，与用户分类同级 |
| 回收站 | Lucide `Trash2` | 系统功能，位于分类栏底部 |
| 设置 | Lucide `Settings` | 系统功能，位于分类栏底部 |

> **图标规范**：统一使用 Lucide Icons（SVG），尺寸 16px，颜色跟随文字色。不用 emoji。

**排序**：用户自定义顺序（拖拽），新创建的默认排在最下面

**分类栏布局**：

```
┌────────────────────────────┐
│ [☷] 全部                   │
│ [📁] 工作                   │
│ [📁] 个人                   │
│ ...                         │
│ ─────────── 分隔线 ──────── │
│ [🔒] 隐私                   │
│ [🕐] 时间轴                 │
│                             │
│ [+]    ← 新增分类           │
│ ─────────── 分隔线 ──────── │
│ [🗑️] 回收站                 │
│ [⚙]   设置                  │
└────────────────────────────┘
```

**选中反馈**：左侧品牌色竖线（2px，`#4C9EEB`），不加背景色变化

#### 标签切换 + 搜索栏（合并为一行）

```
┌────────────────────────────────────────────────────────┐
│ [便签 | 待办]              [🔍 搜索...  ]  [12]        │
└────────────────────────────────────────────────────────┘
```

| 项目 | 规则 |
|------|------|
| 布局 | 左侧标签切换，右侧搜索框 + 数量 |
| 标签样式 | 纯文字：「便签 | 待办」，选中态品牌色下划线 |
| 动画 | 无动画，直接切换 |
| 搜索高亮 | 搜索结果中关键词背景色高亮 |
| 无结果 | 显示「暂无结果」文字 |
| 聚焦 | 边框变色（品牌色 `#4C9EEB`） |
| 快捷键 | `Ctrl+F` 聚焦搜索框 |
| 交互 | 搜索内容保留、分类选中状态保留 |

> **布局优化**：标签切换和搜索栏合并为一行，省去独立的标签切换行，信息密度更高。

#### 便签卡片

```
┌──────────────────────────────────────────┐
│█  标题文字（1行，溢出省略）         [⋯] │  ← 标题行 (13px, 600)
│   内容预览文字（1行，溢出省略）          │  ← 预览行 (11px, 400)
│   10:30 · 工作                           │  ← 时间行 (10px, 400)
└──────────────────────────────────────────┘
  ↑4px色条
```

| 项目 | 规则 |
|------|------|
| 布局 | 左侧色条 + 三行结构（标题 / 内容预览 / 时间+标签） |
| 标题行 | 13px 600，单行，溢出省略号，右侧悬浮显示操作按钮 |
| 预览行 | 11px 400，**单行**，溢出省略号 |
| 时间行 | 10px 400，时间 + 分类标签（品牌色胶囊） |
| 圆角 | 4px（冷峻风格，不用大圆角） |
| 边框 | 1px solid `rgba(255,255,255,0.06)` |
| 卡片间距 | 6px（窄屏优化，间距系统） |
| 内边距 | 8px 12px |
| 颜色标记 | **左侧 4px 竖条**（不使用整个背景色，更克制） |
| 悬浮效果 | 背景色变亮 `rgba(255,255,255,0.04)`，0.15s 过渡 |
| 操作按钮 | 标题行右侧，悬浮时显示，隐藏时显示时间 |
| 置顶卡片 | 排序时有 1px 分隔线 `rgba(255,255,255,0.08)` |
| 无阴影 | 暗色主题下 box-shadow 不可见，不使用阴影 |

#### 待办视图

| 项目 | 规则 |
|------|------|
| 布局 | `☐ 待办内容              (来源便签名)` |
| 已完成样式 | 删除线 + 灰色文字 + 移到底部 + 可折叠隐藏 |
| 操作 | 悬浮显示删除按钮 + 右键菜单 |
| 新增 | 底部「+ 新增待办」，自动创建新的待办便签 |

#### 时间轴

| 项目 | 规则 |
|------|------|
| 操作图标 | 新建➕ 修改✏️ 删除🗑️ 恢复↩️ 置顶📌 |
| 展开动画 | 直接显示，无动画 |
| 分页 | 底部分页导航，可自定义每页数量 |

#### 设置面板

**分组结构**：

```
── 基本设置 ──
边缘吸附 [开关]
字数统计 [开关]

── 安全 ──
隐私密码 [设置/修改]

── 外观 ──
主题切换

── 快捷键 ──
全局新建 [快捷键]
剪贴板创建 [快捷键]

── 关于 ──
版本号
检查更新
用户协议/隐私政策
```

#### 登录面板

| 项目 | 规则 |
|------|------|
| 布局 | `[返回] 登录` + 邮箱输入 + 密码输入 + 登录按钮 + 去注册链接 |
| 返回按钮 | 左上角箭头 + 右上角关闭，两者都有 |
| 去注册 | 点击打开网页端注册页面 |

#### 右键菜单

```
┌──────────────────────────┐
│  在窗口中打开             │
│  置顶                    │
│  颜色                    │
│  复制便签                │
│  导出                    │
│─────────────────────────│  ← 细分割线（rgba(255,255,255,0.08)）
│  删除                    │  ← 危险操作，单独分组
└──────────────────────────┘
```

| 项目 | 规则 |
|------|------|
| 图标 | 不加图标，纯文字 |
| 分组 | 用细分割线将「查看/编辑」和「危险操作（删除）」分开 |
| 菜单项 | 在窗口中打开、置顶、颜色、复制便签、导出 ── 删除 |

#### 通用 UI 元素

**空状态**：

| 场景 | 显示 |
|------|------|
| 没有便签 | 「暂无便签」文字 |
| 没有搜索结果 | 「暂无结果」文字 |
| 回收站为空 | 「回收站为空」文字 |
| 时间轴无记录 | 「暂无记录」文字 |

**加载状态**：

| 场景 | 显示 |
|------|------|
| 便签列表加载中 | 旋转图标 |
| 同步中 | 进度条 |
| 保存中 | 圆点提示（蓝色） |

**确认弹窗**：自定义弹窗（毛玻璃风格），不用系统弹窗

**Toast 提示**：顶部居中，1.5 秒自动消失

**滚动条**：细滚动条（现有样式）

**字体字号**（保持现有）：

| 元素 | 字号 | 字重 |
|------|------|------|
| 标题栏 | 12px | 600 |
| 分类名 | 11px | 400 |
| 便签标题 | 13px | 600 |
| 便签内容预览 | 11px | 400 |
| 时间 | 10px | 400 |
| 按钮文字 | 12px | 400 |
| 搜索框 | 12px | 400 |

**动画时长**（统一）：

| 动画 | 时长 |
|------|------|
| 悬浮效果 | 0.15s |
| 面板滑入 | 0.2s |
| 弹窗淡入 | 0.2s |
| 标签切换 | 0.15s |
| 展开/收起 | 0.2s |

#### 快捷键

**提示方式**：设置面板中统一列出所有快捷键

**冲突处理**：提示冲突，不允许覆盖系统快捷键

---

## 8. 实现清单

### 8.1 Toolbox 后端（Java）

- [ ] 创建 `StickyNote` 实体
- [ ] 创建 `StickyCategory` 实体
- [ ] 创建 `TodoItem` 实体
- [ ] 创建 `StickyTimeline` 实体
- [ ] 创建 `StickyNoteSyncLog` 实体
- [ ] 创建 `StickyNoteRepository`
- [ ] 创建 `StickyCategoryRepository`
- [ ] 创建 `TodoItemRepository`
- [ ] 创建 `StickyTimelineRepository`
- [ ] 创建 `StickyNoteSyncLogRepository`
- [ ] 实现 `StickyNoteService`（CRUD）
- [ ] 实现 `StickyCategoryService`（CRUD）
- [ ] 实现 `TodoItemService`（CRUD）
- [ ] 实现 `StickyNoteSyncService`（同步逻辑：便签+分类+待办+时间轴）
- [ ] 实现 `StickyNoteController`（API 接口）
- [ ] 实现 `StickyCategoryController`（API 接口）
- [ ] 实现 `TodoItemController`（API 接口）
- [ ] 实现 Token 刷新接口（`/api/auth/refresh`）
- [ ] 创建 DTO 类（`StickyNoteDTO`, `StickyCategoryDTO`, `TodoItemDTO`, `StickySyncRequest`）
- [ ] 测试 API 接口

### 8.2 Tauri 前端（React）— 登录同步

- [ ] 封装 API 服务（`api.ts`）
- [ ] 实现认证 Hook（`useAuth.ts`）含 Token 自动刷新
- [ ] 实现同步 Hook（`useSync.ts`）含便签+分类+待办+时间轴
- [ ] 创建登录组件（`LoginForm.tsx`）含完整错误文案
- [ ] 创建用户菜单（`UserMenu.tsx`）
- [ ] 创建同步状态指示器
- [ ] 实现离线队列持久化
- [ ] 实现首次同步断点续传（synced 标记）
- [ ] 集成到现有应用
- [ ] 测试本地模式
- [ ] 测试登录同步

### 8.3 Tauri 前端（React）— 便签操作 UX

- [ ] 快捷键：`Ctrl+N` 新建文字便签，`Ctrl+T` 新建待办
- [ ] 全局快捷键：`Ctrl+Shift+N` 快速新建，`Ctrl+Shift+V` 剪贴板创建
- [ ] 快捷键自定义设置（设置面板）含冲突检测提示
- [ ] 工具栏 `+` 按钮
- [ ] 已打开便签列表（主界面，同一便签单窗口限制）
- [ ] 便签复制/克隆（右键菜单）
- [ ] 自动保存状态提示（蓝色/绿色圆点）
- [ ] 字数统计（设置开关）
- [ ] 回收站功能（status: active / trashed / permanently_deleted）
- [ ] 回收站入口（分类栏垃圾桶图标）
- [ ] 回收站自动清理（30 天，deleted_by 标记来源）
- [ ] 回收站首次使用提示（30 天自动删除警告）
- [ ] `Ctrl+F` 聚焦搜索
- [ ] 搜索高亮
- [ ] 便签颜色标记（预设 + 自定义十六进制）
- [ ] 排序菜单（更新时间/创建时间/标题/自定义）
- [ ] 自定义拖拽排序（持久化，仅本地不同步）
- [ ] 单条导出（.txt）
- [ ] 批量导出（.json / .csv）
- [ ] 展开态滚轮调节透明度
- [ ] 分类重命名
- [ ] 分类拖拽排序（仅本地不同步）
- [ ] 主题切换（暗色/亮色/淡蓝/淡紫/淡黄/自定义）
- [ ] 便签窗口样式选择（毛玻璃/纯色/渐变）
- [ ] 闪电捕获栏（全局热键唤出，回车保存）
- [ ] 拖拽创建便签（文字/链接）
- [ ] 内容感知：URL 可点击打开
- [ ] 时间轴（操作日志，左侧入口，含设备来源标识）
- [ ] 分类加密（隐私分组，视觉隐藏，密码保护）
- [ ] 附件支持（文件链接，拖拽添加，仅单设备可用）
- [ ] 待办独立视图（顶部标签切换）

### 8.4 集成测试 — 登录同步

- [ ] 本地模式正常工作
- [ ] 登录后全量同步正确
- [ ] 多设备增量同步验证
- [ ] 离线/在线切换测试
- [ ] 退出登录后本地数据保留
- [ ] 不同账号数据隔离验证
- [ ] 同步失败自动重试验证
- [ ] 编辑中便签不被同步覆盖
- [ ] 分类同步验证（跨设备可见）
- [ ] 待办项同步验证（跨设备一致）
- [ ] 时间轴同步验证（含设备来源显示）
- [ ] 首次同步断点续传（中断后重试只传未同步数据）
- [ ] Token 自动刷新（无感续期）
- [ ] Token 过期后踢回登录页

### 8.5 集成测试 — 便签操作

- [ ] 快捷键 Ctrl+N/T 正常新建
- [ ] 全局快捷键 Ctrl+Shift+N/V 正常触发
- [ ] 快捷键自定义设置生效
- [ ] 便签复制/克隆功能
- [ ] 自动保存状态提示（圆点显示）
- [ ] 字数统计显示和开关
- [ ] 回收站：删除 → 恢复 → 彻底删除
- [ ] 回收站自动清理（30 天，deleted_by 标记）
- [ ] 回收站首次使用提示（30 天警告）
- [ ] 颜色标记：预设颜色 + 自定义颜色
- [ ] 排序：各排序模式切换正确
- [ ] 自定义拖拽排序持久化
- [ ] 导出：单条 .txt + 批量 .json/.csv
- [ ] 分类重命名和拖拽排序
- [ ] 搜索高亮和 Ctrl+F 聚焦
- [ ] 主题切换（各预设主题 + 自定义颜色）
- [ ] 便签窗口样式选择
- [ ] 闪电捕获栏：热键唤出、输入保存、Esc 取消
- [ ] 拖拽创建：拖文字到窗口、拖链接到窗口
- [ ] 内容感知：URL 右键打开浏览器
- [ ] 时间轴：操作记录、筛选、点击跳转
- [ ] 分类加密：密码设置、进入验证、自动锁定
- [ ] 附件：拖拽添加、双击打开、删除
- [ ] 待办视图：标签切换、勾选完成、状态分组

### 8.6 Tauri 前端（React）— UI 打磨

- [ ] 标题栏：同步状态图标（云朵）+ 登录图标 + 主题切换 + 最小化 + 关闭
- [ ] 用户信息栏：未登录时隐藏，登录后展开（头像+昵称，40px）
- [ ] 同步状态：标题栏左侧云朵图标（✓已同步 / ↻同步中 / ✗离线）
- [ ] 分类栏：统一 Lucide SVG 图标（不用 emoji）
- [ ] 分类栏布局：用户分类 / 分隔线 / 隐私+时间轴 / + / 分隔线 / 回收站+设置
- [ ] 标签切换 + 搜索栏合并为一行（左侧标签，右侧搜索+数量）
- [ ] 搜索高亮（关键词背景色）
- [ ] 便签卡片：左侧 4px 色条（不用整个背景色）
- [ ] 便签卡片：4px 圆角、1px 边框、6px 间距、8px 12px 内边距
- [ ] 便签卡片：三行结构（标题13px / 预览11px单行 / 时间10px+标签）
- [ ] 置顶卡片分隔线（1px `rgba(255,255,255,0.08)`）
- [ ] 待办项布局（来源便签名）
- [ ] 已完成待办样式（删除线+灰色+折叠）
- [ ] 时间轴：筛选器按钮（展开面板）替代横向多标签
- [ ] 时间轴：操作设备来源标识
- [ ] 空状态文字提示
- [ ] 加载状态（旋转图标/进度条/圆点）
- [ ] 右键菜单：纯文字 + 细分割线分组（查看/编辑 | 删除）
- [ ] 自定义确认弹窗（毛玻璃风格）
- [ ] Toast 提示（顶部居中，1.5s 消失）
- [ ] 设置面板分组（基本/安全/外观/快捷键/关于）
- [ ] 登录面板布局（返回+关闭双入口）

---

## 9. 数据量与性能

| 指标 | 限制 |
|------|------|
| 单用户最大便签数 | 10,000 条 |
| 同步每批传输量 | 100 条 |
| 首次同步预估时间 | 10,000 条 ≈ 100 批 × 1 秒/批 ≈ 2 分钟 |
| 增量同步频率 | 变更后防抖 3 秒 |
| 离线队列最大长度 | 10,000 条 |

---

## 10. 安全考虑

| 项目 | 措施 |
|------|------|
| JWT 存储 | Tauri 安全存储（系统钥匙串），含 access_token + refresh_token |
| Token 刷新 | access_token 过期前自动刷新，refresh_token 过期后踢回登录页 |
| 传输安全 | HTTPS 必须开启 |
| 数据隔离 | 按 `user_id` 隔离，后端校验所有权 |
| 密码安全 | 复用 Toolbox 的 BCrypt 加密 |
| 便签上限 | 后端限制单用户最多 10,000 条 |
| 隐私分类 | 仅为视觉隐藏（UI 层密码锁定），数据明文存储和同步 |

---

## 11. 后续优化（MVP 之后）

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P1 | 字段级合并 | 减少冲突时的数据丢失 |
| P1 | 账号注销 + 云端数据删除 | GDPR 合规，用户可删除所有云端数据 |
| P1 | 附件云端上传 | 支持跨设备访问附件（替代本地路径） |
| P2 | 便签提醒 | 右键设置提醒时间，系统通知 |
| P2 | Markdown 支持 | 编辑源码，查看渲染 |
| P2 | 图片附件 | 便签内嵌图片显示 |
| P2 | 日历视图 | 月/周视图，可视化时间管理 |
| P2 | 数据压缩 | gzip 压缩减少传输量 |
| P3 | 便签链接 | `[[标题]]` 创建链接跳转 |
| P3 | WebSocket 实时同步 | 替代轮询，实时推送 |
| P3 | 版本历史 | 查看便签修改历史 |
| P3 | 端到端加密 | 保护用户隐私 |

**已明确不做**：标签系统（与分类重叠）、自然语言搜索、画布视图、便签地图、呼吸灯、手势操作、仪表盘、数据导入、选择性同步、账号注销（后续版本）

**待考虑**：智能模板、便签堆叠、剪贴板监听

---

## 12. 不动 Toolbox 前提下的实施建议（2026-08-14）

> **背景**：Toolbox 后端暂不动（`/api/sticky-*`、`/api/auth/refresh` 均不存在）。此阶段先落地纯本地功能（本文档 7.10~7.14 节），但本地 schema 按本文档的同步设计预埋，将来接后端时零迁移。

### 12.1 ID 体系预埋

当前本地使用 SQLite 整数自增 ID，与本文档 3.2 节的 UUID v4 设计冲突。建议：

- `notes` / `categories` / `todo_items` 三张表各加 `uuid TEXT` 列，对存量数据一次性生成（`crypto.randomUUID()` 或 Rust `uuid` crate）
- 未来同步时以 `uuid` 作为跨设备标识；本地整数 ID 继续作为内部主键（或视后端实现时机逐步切换为 uuid 主键）

### 12.2 按 spec DDL 预建字段

在实现回收站、颜色标记、排序、时间轴等本地功能时，直接按本文档 5.1 节的表结构加列，不要只加当下需要的列：

```sql
ALTER TABLE notes ADD COLUMN uuid TEXT;                 -- UUID v4，同步标识
ALTER TABLE notes ADD COLUMN user_id INTEGER;           -- 本地模式 NULL，登录后填入
ALTER TABLE notes ADD COLUMN status TEXT DEFAULT 'active';  -- active / trashed / permanently_deleted
ALTER TABLE notes ADD COLUMN deleted_by TEXT;           -- user / auto_clean / NULL
ALTER TABLE notes ADD COLUMN trashed_at TEXT;
ALTER TABLE notes ADD COLUMN color TEXT;                -- 十六进制颜色
ALTER TABLE notes ADD COLUMN sort_order INTEGER DEFAULT 0;
ALTER TABLE notes ADD COLUMN synced INTEGER DEFAULT 0;  -- 0=未同步, 1=已同步
```

`categories` / `todo_items` 同理：加 `uuid`、`user_id`、`synced`；`categories` 加 `sort_order`；`todo_items` 加 `completed_at`。

好处：回收站（`status`）、30 天自动清理（`trashed_at` / `deleted_by`）、颜色（`color`）、自定义排序（`sort_order`）这些纯本地功能现在就能用上这些列，将来同步时无需二次迁移。

### 12.3 时间轴与离线队列按 spec 结构预搭

- `sticky_note_timeline` 表按本文档 7.13 节的 DDL 建立，本地记录操作日志。时间轴本身是纯本地功能，现在即可用；「设备来源」在单设备阶段恒为本机
- 离线队列（`sync_queue.json` + `synced` 标记）先实现「写入侧」：变更时标记 `synced = 0`、写入队列文件；上传侧留空，将来只差 API 对接

### 12.4 登录的前提与限制

如果此阶段要做登录 UI，需先确认：

1. 现有 `/api/auth/login`、`/api/auth/register` 的实际请求/响应格式（本文档 4.5 节为假设）
2. **CSP + CORS 双重限制**：前端 fetch 会被 `default-src 'self'` 和浏览器 CORS 拦截，且不能改后端加 CORS 头 → 登录请求必须走 Rust 侧 reqwest（Tauri 侧新增依赖与 invoke 命令，不算动 Toolbox）
3. **无 `/api/auth/refresh`**：token 过期只能提示重新登录，无法无感续期
4. 登录后无同步可用，仅用户信息栏展示，价值有限——建议同步后端就绪前不作为优先项

### 12.5 可行性结论

| 类别 | 能否实现 |
|------|---------|
| 便签操作 UX + UI 打磨（7.10~7.14 节，约 40 项） | ✅ 纯本地可全部实现 |
| 登录 UI + 登录态持久化 | ⚠️ 有条件（依赖现有 auth 接口），无同步无意义 |
| Token 无感刷新 | ❌ 缺 `/api/auth/refresh` |
| 云同步全链路（4~6 节） | ❌ 缺 `/api/sticky-*` 全部接口 |
