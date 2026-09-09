# V3 Runtime Supervisor

## 所有权

窗口化 GUI 不拥有 LiveProcess。同一个签名后的 Tabverse 可执行文件以 `--helper <state-dir>` 启动无窗口 Runtime Supervisor，Supervisor 独占写入 `runtime.db`。

```text
GUI client
├── Terminal local socket / Windows Named Pipe
└── Agent local socket / Windows Named Pipe
        ↓
Runtime Supervisor
├── Terminal PTY LiveProcess
├── Agent LiveProcess
└── runtime.db lease、heartbeat、generation、state
```

IPC bootstrap token 通过匿名 stdin pipe 传给子进程，不写入 endpoint 文件。Agent IPC 使用双向 HMAC challenge；token 不出现在协议线上。endpoint 文件在 Unix 上使用 `0600`。

## 生命周期

- create：Supervisor 创建 LiveProcess，写入 generation 和 attached 状态。
- GUI detach：断开 GUI egress，LiveProcess 继续运行。
- GUI restart/reattach：新客户端取得新 generation；旧客户端的变更请求被拒绝。
- logical tab close：显式终止 LiveProcess并写入 stopped。
- Supervisor failure：lease 过期后，新 Host 将未停止记录标为 interrupted；不伪造进程恢复。
- 空 Supervisor 经过 idle window 后退出；任何 Terminal 或 Agent LiveProcess 都会保持 Supervisor 存活。

## 数据库规则

`app.db` 保存 Workspace、Tab 和设置；`runtime.db` 只保存 runtime 身份、generation、状态、Host instance 和必要 checkpoint。GUI 不直接写 `runtime.db`。

`app.db` 首次创建时事务性导入旧 `state/*.json`，且不删除或改写旧文件。`crates/tabverse-state/tests/fixtures/` 固定保存 `v0.0.1` 的 `type` 会话格式以及 `v0.0.2/v0.0.3` 的 `kind` 会话格式；测试覆盖三版投影、一次性导入、失败回滚和修复后重试。

注册表中的产品设置由 `app.db.settings` 持有。首次运行 V3 时，只把现有 `config.toml` 中明确写出的注册设置事务性导入，原文件不删除；导入标记与全部设置同时提交，失败后可以重试。此后 `config_get`、本地 `config_set/config_reset` 和 App Share Steer RPC 都以 `app.db` 为权威。profiles、templates、快捷键和 Files walk 规则仍是声明式配置文件内容。`[network]` 中的注册设置额外写成派生的启动投影，因为 HostNetworkGateway 在 Tauri 打开数据库前构造；投影不是读取权威源。

## 验证

`src-tauri/tests/runtime_supervisor_process.rs` 启动实际 `tabverse --helper` 子进程，跨两个 GUI 客户端验证同一 PID 下的 Terminal snapshot/继续执行和 Agent handle 重新附着。`crates/tabverse-runtime` 另行验证 writer lease、stale Host、interrupted 状态和无假恢复。
