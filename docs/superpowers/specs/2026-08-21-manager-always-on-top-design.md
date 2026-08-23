# 管理台独立置顶设计 (Manager Always-on-Top)

**日期:** 2026-08-21(2026-08-23 按实际实现修订)
**状态:** 已实施(v0.1.2 之后)

## 概述

给管理台窗口(`main`)增加一个独立的"窗口置顶"开关。开启后管理台始终浮在其他普通窗口之上;与便签窗口各自的置顶(`is_pinned`,逐条存 DB)完全独立、互不影响。纯前端实现,零 Rust 改动、零权限改动。

## 功能需求

1. **设置入口**:标题栏新增图钉按钮(位于"切换主题"按钮左侧)。置顶时实心品牌色高亮,点击即生效、无需重启;设置面板不加开关项(单一入口,减少发现路径)。
2. **持久化**:置顶状态存 `localStorage`(key: `managerAlwaysOnTop`),重启应用后保持,默认关闭。
3. **独立性**:管理台置顶只影响管理台自身窗口层级——
   - 与便签的逐条置顶(DB `is_pinned`)是两套互不读取的状态,互不覆盖;
   - 打开/关闭管理台置顶不影响任何便签窗口的置顶状态,反之亦然。
4. **与边缘吸附共存**:两者是独立的开关;吸附藏边时窗口本体已移出屏幕,置顶只影响露出的 4px 细条,展开/收回行为不变。

## 实现方案

### 窗口置顶应用

管理台是普通 Tauri 窗口(tauri.conf.json,`decorations: false, transparent: true`),直接使用前端 JS API:

```ts
import { getCurrentWindow } from '@tauri-apps/api/window'
getCurrentWindow().setAlwaysOnTop(value)
```

权限 `core:window:allow-set-always-on-top` 已存在于 `src-tauri/capabilities/default.json:18`,且该 capability 覆盖 `main` 窗口(便签窗口已在用同一 API,NoteApp.tsx:344)。**无需新增 Rust 命令、无需改 capability。**

### 状态持久化与广播(复用 edgeDock 模式)

- `src/managerPin.ts`(新增):
  - `MANAGER_PIN_KEY = 'managerAlwaysOnTop'`、`MANAGER_PIN_EVENT = 'manager-pin-changed'`;
  - `isManagerPinned()` / `setManagerPinned()` helper(与 `isEdgeDockEnabled` / `setEdgeDockEnabled` 同构)。
- `src/App.tsx`:
  - `useState` 初始值取 `isManagerPinned()`,供标题栏按钮亮/灭渲染;
  - 点击按钮:取反 → 写 localStorage → 广播 `manager-pin-changed` → 由事件回调统一调 `setAlwaysOnTop`(副作用不在 setState updater 内,避免 StrictMode 双触发);
  - 新增一个 `useEffect`:挂载时按 `isManagerPinned()` 应用初始置顶;监听 `manager-pin-changed` 实时 `setAlwaysOnTop`(与现有 `edge-dock-changed` 监听模式一致)。
- `src/components/PinToggleIcon.tsx`(新增):手绘 SVG 图钉图标,置顶=实心品牌色,未置顶=描边,免 fill/stroke 同一路径的双色折中。

### 与便签置顶的隔离

- 便签置顶:DB 字段 `is_pinned`,经 Rust `set_note_pinned` 命令 + 建窗时 `.always_on_top(note.is_pinned)`(main.rs:240)。
- 管理台置顶:localStorage,纯前端,不经过 DB、不经过任何 Rust 命令。
- 两条链路零交叉,天然满足"单独"。

### 与边缘吸附的交互

- 吸附藏边时:窗口移出屏幕只露 4px,细条同样置顶(QQ 藏边条本身也置顶,属正常预期)。
- 展开(reveal)/收回(retract)只操作 `setPosition`,不触碰 always-on-top,置顶状态全程保持。

## 实现效果

1. 开启后,管理台浮于所有普通窗口之上;焦点切到其他应用(记事本、浏览器等)不遮挡管理台。
2. 管理台与置顶便签同处"置顶层",按激活顺序互压——点击谁谁获得焦点,不会出现永久遮挡。
3. 关闭开关立即恢复普通窗口层级,无需重启。
4. 重启应用、升级安装后置顶状态保持(localStorage 不随版本清理)。
5. 全屏应用(视频、游戏)之上也会显示管理台——这是"置顶"的正常预期,关闭开关即恢复。

## 文件改动

| 文件 | 动作 | 说明 |
|------|--------|-------------|
| `src/managerPin.ts` | 新增 | 置顶状态 key/事件常量 + is/set helper |
| `src/components/PinToggleIcon.tsx` | 新增 | 手绘 SVG 图钉图标(实心/描边两态) |
| `src/App.tsx` | 修改 | 标题栏图钉按钮(主题切换左侧)+ 挂载时应用初始置顶 + 监听事件实时应用 |
| `src/App.css` | 修改 | `.title-btn.pinned` 激活态:品牌色底白图钉 |

不需要动 SettingsPanel.tsx、不需要动任何 Rust 文件与 capabilities、不动 NoteApp.tsx。

## 边界情况

- **藏边细条置顶**:若后续用户觉得露出的 4px 细条在视频/游戏下碍眼,可扩展为"藏边时临时取消置顶、展开时恢复"(本次不做,保持 MVP 简单)。
- **最小化/托盘**:置顶是窗口属性,show/hide 不影响;托盘点击"显示管理器"恢复后仍置顶。
- **多显示器**:`setAlwaysOnTop` 是窗口级属性,与显示器无关,无需额外处理。
- **边缘吸附开关关闭**:与置顶互不联动,两个开关各自独立生效。

## 测试方法(手动,Windows)

1. **基础开关**:标题栏点图钉按钮(置顶时品牌色高亮);切到记事本/浏览器聚焦,管理台仍浮在上面。再点一次,管理台立即恢复正常层级。
2. **持久化**:开启置顶 → 完全退出应用(含托盘) → 重启 → 管理台仍置顶。关闭置顶后重启,不再置顶。
3. **独立性**:管理台开置顶;打开一个未置顶便签 → 便签仍处于普通层(可被管理台遮挡),管理台关置顶后不影响已置顶便签;将某便签置顶 → 便签与管理台同处置顶层、按激活排序,两者互不覆盖状态。
4. **与边缘吸附共存**:置顶 + 边缘吸附同开,把管理台拖到屏幕边缘吸附 → 露出的 4px 细条浮于其他窗口之上;鼠标移入展开后正常置顶显示,移出收回后行为不变。
5. **托盘交互**:置顶状态下最小化到托盘 → 点托盘"显示管理器" → 窗口恢复后仍置顶。
6. **全屏应用**:全屏视频下管理台仍浮于其上(预期);关闭置顶后不再遮挡。
7. **升级保持**:升级安装新版本后,置顶设置保持(localStorage 不变,验证与"关于页版本号"同一升级流程)。

## 成功标准

- [ ] 标题栏出现图钉按钮,默认未置顶(描边图标)
- [ ] 开关即生效,管理台浮于普通窗口之上,关闭即恢复
- [ ] 重启应用后置顶状态保持
- [ ] 便签置顶与管理台置顶互不影响
- [ ] 与边缘吸附同时开启时藏边/展开/收回行为正常
- [ ] 无 Rust、无 capability、无数据库改动

## 明确不做

- 藏边时自动临时取消置顶(列为后续可选项)
- 便签窗口置顶逻辑的任何改动
- 托盘菜单加置顶入口(标题栏图钉单入口即可)
