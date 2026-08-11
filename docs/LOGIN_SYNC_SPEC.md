# 便签应用 - 登录与多设备同步技术文档

> **状态**: 设计完成，待实现
>
> **更新时间**: 2026-08-10
>
> **MVP 范围**: 基础 CRUD + 本地模式 / 登录 + 简单同步 / 同步状态指示器 / 离线队列持久化

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
  color VARCHAR(20) DEFAULT '#FFD700',
  position_x INT DEFAULT 100,
  position_y INT DEFAULT 100,
  width INT DEFAULT 300,
  height INT DEFAULT 300,
  is_pinned BOOLEAN DEFAULT FALSE,
  is_deleted BOOLEAN DEFAULT FALSE,     -- 软删除
  device_id VARCHAR(100),               -- 最后修改的设备
  version INT DEFAULT 1,                -- 版本号，每次修改 +1
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES sys_user(id) ON DELETE CASCADE,
  INDEX idx_user_id (user_id),
  INDEX idx_updated_at (updated_at)
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

### 4.2 API 接口设计

| 接口 | 方法 | 说明 | 认证 |
|------|------|------|------|
| `/api/auth/login` | POST | 登录（复用现有） | 无 |
| `/api/auth/register` | POST | 注册（复用现有） | 无 |
| `/api/sticky-notes` | GET | 获取用户所有便签（分页） | 需要 |
| `/api/sticky-notes` | POST | 创建便签 | 需要 |
| `/api/sticky-notes/{id}` | PUT | 更新便签 | 需要 |
| `/api/sticky-notes/{id}` | DELETE | 删除便签（软删除） | 需要 |
| `/api/sticky-notes/sync` | POST | 增量同步 | 需要 |

**分页参数**：`?page=0&size=100`（每页最多 100 条）

**同步接口请求体**：

```json
{
  "lastSyncTime": "2026-08-10T10:00:00Z",
  "deviceId": "uuid-xxxx",
  "localChanges": [
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
      "updatedAt": "2026-08-10T10:00:00Z"
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
    "cloudChanges": [...],
    "appliedChanges": ["note-uuid-1"],
    "serverTime": "2026-08-10T10:01:00Z",
    "hasMore": false
  }
}
```

### 4.3 需要新增的文件

```
src/main/java/com/example/myerp/
├── entity/
│   ├── StickyNote.java
│   └── StickyNoteSyncLog.java
├── repository/
│   ├── StickyNoteRepository.java
│   └── StickyNoteSyncLogRepository.java
├── service/
│   ├── StickyNoteService.java        # CRUD 操作
│   └── StickyNoteSyncService.java    # 同步逻辑
├── controller/
│   └── StickyNoteController.java     # API 接口
└── dto/
    ├── StickyNoteDTO.java
    └── StickyNoteSyncRequest.java
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
  color TEXT,
  position_x INTEGER,
  position_y INTEGER,
  width INTEGER,
  height INTEGER,
  is_pinned INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0,
  created_at TEXT,                  -- ISO 8601 格式
  updated_at TEXT                   -- ISO 8601 格式
);

CREATE INDEX idx_sticky_note_user ON sticky_note(user_id);
CREATE INDEX idx_sticky_note_updated ON sticky_note(updated_at);
```

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
- Token 过期 → 踢回登录页，提示"登录已过期，请重新登录"
- MVP 不做 Token 刷新

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
| 便签变更后 | 防抖 3 秒，避免频繁同步 |
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
│ 1. 获取本地所有便签           │
│    (user_id IS NULL)         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 2. 批量上传到云端             │
│    POST /api/sticky-notes/sync│
│    每批 100 条                │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 3. 更新本地 user_id          │
│    NULL → 实际用户 ID         │
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│ 4. 下载云端便签               │
│    GET /api/sticky-notes     │
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

### 7.1 布局结构（2026-08-11 确认）

```
┌──────────────────────────────────────┐
│ 标题栏 (32px)          [─] [✕]       │
├──┬───────────────────────────────────┤
│  │ 用户信息栏（头像 + 昵称 + 同步状态）│  ← 新增
├──┬───────────────────────────────────┤
│分│  搜索栏                            │
│类│  ┌───────────────────────────┐     │
│栏│  │  便签卡片 1               │     │
│36│  │  便签卡片 2               │     │
│px│  │  便签卡片 3               │     │
│  │  └───────────────────────────┘     │
│⚙ │                                   │
└──┴───────────────────────────────────┘
```

### 7.2 用户信息栏

- **位置**：标题栏下方、搜索栏上方，横跨整个窗口宽度
- **高度**：48px
- **内容**：
  - 左侧：用户头像（32px 圆形）+ 用户名/昵称
  - 右侧：同步状态小字
- **未登录状态**：显示「点击登录」引导文字，点击打开登录面板

### 7.3 用户头像

| 状态 | 显示 |
|------|------|
| 已登录 + 自定义头像 | 用户上传的头像（网页端上传） |
| 已登录 + 无头像 | 用户名首字母（圆形背景色） |
| 未登录 | 通用用户图标 |

- **点击行为**：已登录 → 弹出菜单（退出登录）；未登录 → 打开登录面板

### 7.4 同步状态指示器

位置：用户信息栏右侧，小字显示

| 状态 | 显示文字 | 样式 |
|------|---------|------|
| 已同步 | `已同步 · 10:30` | 灰色文字 |
| 同步中 | `同步中 (3/100)` | 蓝色 + 旋转图标 |
| 离线 | `离线` | 红色文字 |

### 7.5 登录面板

- **形式**：侧边面板（复用设置面板的滑入模式）
- **位置**：替换便签列表区域
- **返回**：左上角返回箭头

### 7.6 登录表单

- 邮箱输入框 + 密码输入框 + 登录按钮
- 「去注册」链接 → 点击打开网页端首页
- 不提供「忘记密码」（网页端处理）

### 7.7 登录交互细节

| 场景 | 行为 |
|------|------|
| 登录中 | 按钮变灰 + 文字变为「登录中...」 |
| 登录失败 | 表单下方显示红色错误文字 |
| 登录成功 | 关闭面板 → 更新用户信息栏 → 显示「同步中...」 |
| 注册 | 「去注册」链接，`shell.open(网页端URL)` |

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

---

## 8. 实现清单

### 8.1 Toolbox 后端（Java）

- [ ] 创建 `StickyNote` 实体
- [ ] 创建 `StickyNoteSyncLog` 实体
- [ ] 创建 `StickyNoteRepository`
- [ ] 创建 `StickyNoteSyncLogRepository`
- [ ] 实现 `StickyNoteService`（CRUD）
- [ ] 实现 `StickyNoteSyncService`（同步逻辑）
- [ ] 实现 `StickyNoteController`（API 接口）
- [ ] 创建 DTO 类（`StickyNoteDTO`, `StickyNoteSyncRequest`）
- [ ] 测试 API 接口

### 8.2 Tauri 前端（React）

- [ ] 封装 API 服务（`api.ts`）
- [ ] 实现认证 Hook（`useAuth.ts`）
- [ ] 实现同步 Hook（`useSync.ts`）
- [ ] 创建登录组件（`LoginForm.tsx`）
- [ ] 创建用户菜单（`UserMenu.tsx`）
- [ ] 创建同步状态指示器
- [ ] 实现离线队列持久化
- [ ] 集成到现有应用
- [ ] 测试本地模式
- [ ] 测试登录同步

### 8.3 集成测试

- [ ] 本地模式正常工作
- [ ] 登录后全量同步正确
- [ ] 多设备增量同步验证
- [ ] 离线/在线切换测试
- [ ] 退出登录后本地数据保留
- [ ] 不同账号数据隔离验证
- [ ] 同步失败自动重试验证
- [ ] 编辑中便签不被同步覆盖

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
| JWT 存储 | Tauri 安全存储（系统钥匙串） |
| 传输安全 | HTTPS 必须开启 |
| 数据隔离 | 按 `user_id` 隔离，后端校验所有权 |
| 密码安全 | 复用 Toolbox 的 BCrypt 加密 |
| 便签上限 | 后端限制单用户最多 10,000 条 |

---

## 11. 后续优化（MVP 之后）

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P1 | Token 刷新 | 无感刷新，避免频繁重新登录 |
| P1 | 字段级合并 | 减少冲突时的数据丢失 |
| P1 | 冲突解决 UI | 弹窗让用户选择保留哪个版本 |
| P2 | 分类和标签 | 便签分类管理 |
| P2 | 附件支持 | 图片、文件附件 |
| P2 | 数据压缩 | gzip 压缩减少传输量 |
| P3 | WebSocket 实时同步 | 替代轮询，实时推送 |
| P3 | 版本历史 | 查看便签修改历史 |
| P3 | 端到端加密 | 保护用户隐私 |
