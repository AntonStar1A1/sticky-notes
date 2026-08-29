# Sticky Notes

轻量级桌面便签应用，基于 [Tauri 2](https://v2.tauri.app/) + [React 19](https://react.dev/) + TypeScript 构建。

## 功能

- 多窗口便签 — 每个便签独立窗口，透明无边框
- 分组管理 — 右键菜单将便签归入不同分组
- 时间轴 — 查看便签历史修改记录，支持旧/新内容对比
- 窗口置顶 — 标题栏一键 pin 便签到最前
- 全局快捷键 — 系统级热键快速操作
- 文字捕获 — capture 窗口抓取屏幕文字
- 系统托盘 — 最小化到托盘后台运行
- SQLite 本地存储 — 数据全部存在本地

## 截图

> TODO

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 · TypeScript · Vite · Lucide Icons |
| 后端 | Tauri 2 · Rust · SQLite (rusqlite) |
| 构建 | NSIS / MSI 安装包 |

## 开发

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri 2 前置依赖](https://v2.tauri.app/start/prerequisites/)

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器 (前端热更新 + Tauri 窗口)
npm run tauri dev
```

### 构建发布包

```bash
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`：
- `nsis/` — Windows NSIS 安装程序 (.exe)
- `msi/` — Windows MSI 安装包 (.msi)

## 项目结构

```
Sticky_notes/
├── src/                    # 前端 React 代码
│   ├── App.tsx             # 主窗口 (管理台)
│   ├── NoteApp.tsx         # 便签窗口
│   ├── CaptureApp.tsx      # 文字捕获窗口
│   ├── components/         # UI 组件
│   ├── hooks/              # React Hooks
│   └── types.ts            # 类型定义
├── src-tauri/              # Rust 后端
│   ├── src/main.rs         # Tauri 入口 & 命令注册
│   ├── src/db.rs           # SQLite 数据库操作
│   ├── tauri.conf.json     # Tauri 配置
│   └── Cargo.toml          # Rust 依赖
├── public/                 # 静态资源
└── package.json
```

## License

MIT
