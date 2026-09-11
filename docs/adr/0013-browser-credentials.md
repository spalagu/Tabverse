# ADR-0013：Browser 凭据是本地核心能力

## 状态
已接受。

## 需求与上下文
本地 Browser 需要按 origin 保存、填充、更新、删除和选择多账户登录，同时避免明文落盘。

## 决策
CredentialVault 将加密记录保存到 `app.db`；机器 master-key bundle 由 Keychain、Credential Manager 或 Secret Service 保护。BrowserBridge 只在匹配 origin 的页面捕获和填充。

## 备选与拒绝原因
- 明文配置：泄漏密码。
- 依赖 WebView 自有密码库：跨平台行为和迁移不可控。
- Synchronizing Host credentials to Remote: rejected because Browser is local-only.

## 跨平台影响
vault 和 origin 规则共享，master-key adapter 分平台。

## Remote 带宽影响
凭据不进入 Remote snapshot、控制帧或数据流。

## 迁移影响与可逆性
legacy importer 一次性导入受支持记录；失败不删除源。忘记全部凭据不影响 Agent 登录。
