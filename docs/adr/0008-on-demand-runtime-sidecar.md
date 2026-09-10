# ADR-0008：Runtime 使用按需 sidecar

## 状态
已接受。

## 需求与上下文
Terminal 和 Agent LiveProcess 应能在 GUI 重启期间继续存在，但不能恢复并不存在的进程。

## 决策
同一个签名后的 Tabverse 可执行文件以 windowless helper 模式按需启动 Runtime Supervisor；没有 LiveProcess 且超过 idle window 后退出。

## 备选与拒绝原因
- 常驻 Resident Service：增加安装、升级和权限生命周期。
- GUI 持有进程：GUI 退出会杀死工作。
- 每个功能一个通用 Worker：重复生命周期和数据库所有权。

## 跨平台影响
Supervisor 语义统一，启动和本地 transport 由平台 adapter 实现。

## Remote 带宽影响
无额外周期 Remote 流量；只传现有功能的语义数据。

## 迁移影响与可逆性
旧 Resident 服务不迁入。sidecar 可随应用关闭并由下一次需要重新启动。
