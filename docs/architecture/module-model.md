# V3 模块模型

## 目标

Tabverse V3 使用内置 Feature Module，不提供可安装 Plugin Kernel。模块负责声明产品能力；运行环境通过端口和适配器提供能力。

## 当前分层

```text
packages/runtime-contracts   可移植 DTO 和端口
packages/workbench           环境无关的产品界面和交互
packages/runtime-desktop     Desktop 端口适配器
packages/runtime-remote      Join/Remote 端口适配器
src-tauri                    Tauri 命令、组合根和 OS 适配器
crates/tabverse-*            可复用 Rust Core
```

`packages/workbench/src/tabView.tsx` 的 renderer catalog 是内置模块组合点。Files、Browser、Terminal、Agent、Remote、Settings 都通过明确 renderer 注册，不经过动态包安装或 Plugin 生命周期。

## 依赖方向

- Workbench 不依赖 Tauri、Desktop runtime 或 Remote runtime。
- `runtime-contracts` 不依赖 React、Workbench 或具体 runtime。
- Desktop/Remote runtime 可以依赖 contracts，不能反向依赖应用源码。
- `crates/tabverse-*` 不依赖 Tauri；`src-tauri` 负责组装。
- 模块不得取得未声明的 privileged API；所有环境能力通过类型化 context/port 传入。

`tools/check-workbench-boundary.mjs` 在 `npm run check:architecture` 中自动执行以上边界。

## Desktop 组合根

`src-tauri/src/lib.rs` 是进程启动、共享状态组装、插件注册和命令清单的组合根；尚未迁出的适配器按功能继续拆分。Files 命令适配器位于 `src-tauri/src/fs_commands.rs`：阻塞池选择、IPC 参数和 watch 事件属于适配器，目录读取、搜索、替换、归档和检查语义仍由 `tabverse-fs` 实现。新增 Files 行为不得重新写回组合根。

`src-tauri/src/state_commands.rs` 持有 `AppDatabase`、数据库路径解析以及 state/config IPC 适配器。其他 Desktop 适配器只能通过该模块公开的窄入口取得 `AppStateStore`；Workbench 和 Rust Core 不接触数据库句柄。

`src-tauri/src/terminal_commands.rs` 持有 Terminal IPC、helper 事件缓冲、GUI channel 适配和共享源接线。终端进程与协议语义仍由 `tabverse-term` 实现，远程会话排序与权限语义仍由 `tabverse-remote` 实现。新增 Terminal 命令不得重新写回组合根。

`src-tauri/src/remote_commands.rs` 持有 Remote Join IPC 和 GUI channel 适配。连接、加密传输、控制/数据流以及 Host 端授权仍由 `tabverse-remote` 实现；`context_id` 不在该适配器中参与授权判断。

`src-tauri/src/agent_commands.rs` 持有 Agent 登录、Agent Tab IPC、Runtime Supervisor 接线和共享源注册。Agent 事件与回合语义属于 `tabverse-agent`，runtime 身份和进程生命周期属于 `tabverse-runtime`；适配器不保存恢复状态，也不伪造进程恢复。

`src-tauri/src/credential_commands.rs` 持有本机用户确认、密码导入导出和整机迁移 IPC。凭据存储与加密属于 credential adapter 和 `app.db` vault；迁移包格式与备份恢复语义属于 `migrate` 模块，组合根不得直接处理明文凭据。

`src-tauri/src/appearance_commands.rs` 持有窗口全屏、macOS traffic lights、主题背景、主题偏好和 webview 日志 IPC。平台调用只存在于带 target 条件的适配器分支，主题偏好仍写入 `app.db` scope。

`src-tauri/src/browser_commands.rs` 是官方 Tauri/Wry Browser adapter，持有 webview 创建、导航、查找、快照、页面代理和 Browser IPC 接线。密码、cookie、userscript、网络和 Remote Browser 的产品语义仍分别属于现有专用模块与 Rust Core；Browser adapter 不引入 CEF 或自定义 Tauri runtime。

## 非目标

- 外部插件安装、更新、签名和包管理。
- Plugin Kernel、Resident Runtime 或 CEF runtime。
- 为未来能力预建动态生命周期框架。
