# ADR-0007：SQLite 持有结构化持久状态

## 状态
已接受。

## 需求与上下文
Workspace、Tab、注册设置和内容偏好需要事务、一致迁移和单一权威源。

## 决策
`app.db` 由 `tabverse-state` 持有；Workspace、Tab、settings、content preferences 事务性写入 SQLite。声明式 profiles、templates 和快捷键仍保留在配置文件。

## 备选与拒绝原因
- 新增 JSON 数据库：缺少事务和 schema migration。
- frontend 直接持有 SQLite：破坏环境边界和单写者规则。

## 跨平台影响
schema 与迁移跨平台一致；数据库路径由 Desktop adapter 决定。

## Remote 带宽影响
Remote 只取得 snapshot、action 和窄 RPC 结果，不复制数据库。

## 迁移影响与可逆性
v0.0.1–v0.0.3 fixture 迁移事务性、幂等，源文件成功前不删除。回滚版本仍可读取保留的旧文件。
