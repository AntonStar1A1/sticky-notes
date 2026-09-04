# Sticky Notes

轻量级桌面便签应用，基于 [Tauri 2](https://v2.tauri.app/) + [React 19](https://react.dev/) + TypeScript 构建。

## 功能

- 多窗口便签 — 每个便签独立窗口，透明无边框
- 分组管理 — 右键菜单将便签归入不同分组
- 拖拽排序 — 分组与便签支持拖动重排（鼠标 / 触控长按）
- 待办清单 — 便签内嵌待办项
- 附件 — 便签可添加图片等附件
- 时间轴 — 查看便签历史修改记录，支持旧/新内容对比
- 窗口置顶 — 标题栏一键 pin 便签到最前
- 隐私锁 — 密码锁定受保护的便签
- 回收站 — 删除的便签可恢复，支持自动清理
- 便签样式 — 颜色与样式自定义
- 全局快捷键 — 系统级热键快速操作
- 文字捕获 — capture 窗口抓取屏幕文字
- 系统托盘 — 最小化到托盘后台运行
- 自动更新 — 应用内检查并安装新版本
- SQLite 本地存储 — 数据全部存在本地

## 截图
<img width="2391" height="1304" alt="image" src="https://github.com/user-attachments/assets/a971b2ed-e52a-4da9-b41d-f9c4cbafab31" />




## 安装

从 [GitHub Releases](https://github.com/AntonStar1A1/sticky-notes/releases) 下载最新版本：

- `Sticky.Notes_<版本>_x64-setup.exe` — NSIS 安装程序（推荐，支持自动更新）
- `Sticky.Notes_<版本>_x64_en-US.msi` — MSI 安装包
- `Sticky.Notes_<版本>_x64_portable.zip` — 便携免安装版，解压即用，数据存在 exe 旁

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 · TypeScript · Vite · Lucide Icons |
| 后端 | Tauri 2 · Rust · SQLite (rusqlite) |
| 更新 | tauri-plugin-updater（minisign 签名） |
| 构建 | NSIS / MSI 安装包 · 便携 zip |

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

便携版：将 `src-tauri/target/release/sticky-notes.exe` 复制到 `src-tauri/target/release/portable/`（与空的 `portable.txt` 标记文件同级），压缩该目录为 zip。

### 发布新版本

1. 同步版本号：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（自动更新按 Cargo.toml 的版本判断）
2. 构建后用签名密钥（`~/.tauri/sticky-notes.key`）对 NSIS 安装包签名：

   ```bash
   TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<密码> npx tauri signer sign \
     -k ~/.tauri/sticky-notes.key \
     -f src-tauri/target/release/bundle/nsis/Sticky.Notes_<版本>_x64-setup.exe
   ```

3. 生成 `latest.json` 更新清单（`signature` 字段为 .sig 文件的原始内容，`url` 指向 release 资产地址）：

   ```json
   {
     "version": "<版本>",
     "notes": "更新说明",
     "pub_date": "2026-09-04T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<.sig 文件内容>",
         "url": "https://github.com/AntonStar1A1/sticky-notes/releases/download/v<版本>/Sticky.Notes_<版本>_x64-setup.exe"
       }
     }
   }
   ```

4. 创建 GitHub Release（tag `v<版本>`），上传安装包、MSI、便携 zip 与 `latest.json` 作为资产

> ⚠️ 签名密钥一旦更换，旧版本内置的公钥将无法验证新签名，已安装的旧版本不能自动更新，需要用户手动安装一次。

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
