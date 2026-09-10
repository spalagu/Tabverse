# ADR-0010：Runtime 身份与进程身份分离

## 状态
已接受。

## 需求与上下文
PID 会复用，GUI 会重连，旧客户端不能在新 Host 上继续写入。

## 决策
`runtime.db` 保存稳定 runtime id、Host instance、generation、lease 和状态。变更请求必须匹配当前 generation；stale Host 记录为 interrupted，不伪造恢复。

## 备选与拒绝原因
- PID 作为身份：重启和 PID 复用会误关联。
- 无 generation 的重连：旧客户端可覆盖新会话。
- 自动 replay：可能重复有副作用的操作。

## 跨平台影响
身份和 lease 规则完全共享；进程探测是平台 adapter。

## Remote 带宽影响
只传必要 session 事件，不传 runtime 数据库。

## 迁移影响与可逆性
旧 Resident identity 不复用。interrupted 记录可清理，但不能改写为 recovered。
