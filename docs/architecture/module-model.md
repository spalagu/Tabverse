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

## 非目标

- 外部插件安装、更新、签名和包管理。
- Plugin Kernel、Resident Runtime 或 CEF runtime。
- 为未来能力预建动态生命周期框架。
