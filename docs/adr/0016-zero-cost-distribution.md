# ADR-0016：采用零付费桌面分发

## 状态

已接受。

## 需求与上下文

Tabverse 是开源项目，当前分发不得依赖付费开发者账户、付费签名服务或付费托管。macOS 的 Apple Developer ID 需要加入付费的 Apple Developer Program，Apple notarization 又要求应用使用有效的 Developer ID 证书签名，因此不属于当前交付边界。

## 决策

- macOS 安装包由 GitHub Actions 在 Apple Silicon 和 Intel 原生 runner 上构建。
- macOS 应用保持 ad-hoc 签名，不申请 Apple Developer ID，不提交 Apple notarization。
- Windows 和 Linux 构建同样不得依赖付费签名服务。
- 每个 Release Candidate 只上传 GitHub Actions artifact；只有显式创建的新版本 tag 才能发布 GitHub Release。
- 发布产物必须包含 SHA-256 校验值、源码 commit、目标架构和平台安装说明。
- macOS 说明必须明确应用未 notarize，并只指导用户对 Tabverse 单应用授权；不得要求全局关闭 Gatekeeper。
- 已存在的 tag 和 release 不得被发布 workflow 覆盖。

## 备选与拒绝原因

- Apple Developer ID 与 notarization：会引入年度付费和账户依赖。
- Mac App Store：需要付费账户，也改变当前直接分发模型。
- 全局关闭 Gatekeeper：扩大用户设备攻击面，不接受。
- 把未 notarize 隐藏在故障排查说明中：用户无法在下载前理解安装步骤，不接受。

## 用户影响

macOS 用户首次打开 Tabverse 时，需要在 Finder 中右键“打开”，或在“系统设置 → 隐私与安全性”中仅允许 Tabverse。必要时可以只移除 `/Applications/Tabverse.app` 的 quarantine 标记。此限制必须在下载说明中提前展示。

## 迁移影响与可逆性

零付费分发不改变应用数据和协议。如果未来项目获得免费的合规签名能力，可以用新的 ADR 增加签名和 notarization；不得静默改变当前承诺。
