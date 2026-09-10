# Tabverse 零付费分发说明

## 产物来源

Tabverse 安装包由 GitHub Actions 从对应版本 tag 或明确指定的源码 ref 构建。下载后先核对同一构建提供的 `SHA256SUMS`，再安装应用。

## macOS

macOS 安装包使用 ad-hoc 签名，没有 Apple Developer ID，也没有提交 Apple notarization。Apple Silicon 使用 `aarch64` 或 `arm64` DMG，Intel 使用 `x64` DMG。

首次打开时：

1. 将 `Tabverse.app` 拖入 `/Applications`。
2. 在 Finder 中右键 `Tabverse.app`，选择“打开”。
3. 如果仍被拦截，进入“系统设置 → 隐私与安全性”，仅对 Tabverse 选择“仍要打开”。

如果系统没有显示上述单应用入口，可以执行：

```bash
xattr -dr com.apple.quarantine /Applications/Tabverse.app
```

该命令只移除 Tabverse 应用的下载隔离标记。不要运行 `spctl --master-disable`，不要全局关闭 Gatekeeper。

## Windows 和 Linux

Windows 和 Linux 安装包同样不使用付费代码签名服务。系统或安全软件可能显示未知发布者提示。请只从 `spalagu/Tabverse` GitHub Release 或对应 GitHub Actions run 下载，并核对 SHA-256。

## 发布约束

- Release Candidate 只作为 GitHub Actions artifact 保存，不创建 tag 或 release。
- 正式发布使用新的不可变版本 tag。
- 发布流程不得覆盖已有 tag 或已有 GitHub Release。
- `v0.0.1` 是历史版本，不会被 V3 发布覆盖。
