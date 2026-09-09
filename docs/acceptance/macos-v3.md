# Tabverse V3 macOS 验收说明

## 概述

1. 从同一次 GitHub Actions run 下载与 Mac 匹配的 artifact：Apple Silicon 使用 `macos-v3-acceptance-arm64-*`，Intel 使用 `macos-v3-acceptance-x64-*`。
2. 校验 `SHA256SUMS`，安装 DMG 中的 `Tabverse.app`。
3. 先验证 Host localhost，再验证可用的 LAN、VPN/内部 DNS 和企业 HTTPS。
4. 在 Whole-App share 中验证 Browser 大响应、取消和 Steer/View 权限；再验证 Files 选中文件。
5. 保存 `build-info.txt`、Tabverse 日志和失败页面地址。不得在记录中放密码、cookie、ticket 或公司内网页面正文。

该验收构建是 ad-hoc signed，**没有 notarize**。首次打开被 Gatekeeper 拦截时，使用 Finder 对 `Tabverse.app` 右键“打开”，或进入“系统设置 → 隐私与安全性”对 Tabverse 选择“仍要打开”。不得全局关闭 Gatekeeper，不得运行 `spctl --master-disable`。

## 下载、校验和安装

在下载并解压 artifact 后执行：

```bash
cd /path/to/unzipped-artifact
shasum -a 256 -c SHA256SUMS
```

打开 DMG，将 `Tabverse.app` 拖入 `/Applications`。如 Finder 和“系统设置 → 隐私与安全性”均无法给出单应用打开入口，可以只移除该应用的 quarantine 标记：

```bash
xattr -dr com.apple.quarantine /Applications/Tabverse.app
```

该命令只作用于 `/Applications/Tabverse.app`，不改变系统全局安全策略。

## 启动日志

先退出已有 Tabverse，再从 Terminal 启动验收构建并保留输出：

```bash
/Applications/Tabverse.app/Contents/MacOS/Tabverse 2>&1 | tee /tmp/tabverse-v3-acceptance.log
```

验收结束后，日志位于 `/tmp/tabverse-v3-acceptance.log`。只有遇到失败时才需要提供对应时间段；先删除 ticket、用户名、内部域名或其他敏感信息。

## 详细验收清单

### 1. Host localhost

在 Host Terminal 启动临时服务：

```bash
work_dir="$(mktemp -d)"
printf '<h1>Tabverse localhost acceptance</h1><a href="/next.html">next</a>' > "$work_dir/index.html"
printf '<h1>redirect and relative resource passed</h1>' > "$work_dir/next.html"
python3 -m http.server 8765 --bind 127.0.0.1 --directory "$work_dir"
```

在 Tabverse Host 建立 Whole-App share，在 Join 页面进入 Browser 标签并打开 `http://127.0.0.1:8765/`。应看到标题，点击 `next` 后应加载相对地址页面。

### 2. LAN、VPN 和内部 DNS

依次打开 Host 当前能访问的：

- 一个 LAN HTTP/HTTPS 地址；
- 一个必须连接 Host VPN 才能访问的地址；
- 一个只能由 Host DNS 解析的内部域名。

每项记录“通过 / 环境无此条件 / 失败”。单设备验收可以验证功能，但不能证明 Join 设备自身不可达；该网络隔离结论需要第二台设备，当前验收按约定跳过。

### 3. Host 信任的 HTTPS 和企业证书

打开一个只被 Host 系统信任链接受的企业 HTTPS 地址。预期页面正常加载，不要求把 Host Browser cookie、localStorage、DOM 或历史同步到 Join。

### 4. 重定向和相对资源

打开包含 301/302 跳转、相对 CSS、图片、链接或表单的测试页面。预期最终地址栏显示最终 URL，相对资源基于最终 URL 加载。跨源跳转不得继续携带 Authorization、Proxy-Authorization 或 Cookie 请求头。

### 5. 大响应期间控制流

在 Browser 中加载大于 1 MiB 的响应；加载期间切换 Whole-App share 的标签、展开侧栏或执行另一项语义操作。预期控制交互仍立即响应，大正文不阻塞控制流。

### 6. 标签切换取消请求

打开一个持续输出或明显较慢的页面，在响应结束前切换到其他标签。预期旧请求停止；日志中不应继续出现该请求的正文传输。

### 7. Steer、View 和恢复

1. 将 viewer 设置为 Steer，打开一个尚未加载的 Browser 地址：应成功。
2. 将同一 viewer 改为 View，再打开一个新地址：Host 必须拒绝新网络请求。
3. View 状态下切换到 Files 标签并打开当前选中的文件：只读内容应可访问，保存入口不可用。
4. 恢复 Steer，再次打开新 Browser 地址：应恢复访问；Files 小文件可编辑保存。

### 8. Files 大文件原始字节流

在 Host Files 标签选中一个超过 4 MiB 的文本文件，再在 Join Whole-App share 切到该 Files 标签。预期显示前 4 MiB 和 truncated 提示；切换走后未完成读取被取消。文件正文不得通过 `fs_read` 控制 RPC 或 base64 传输。

## 结果记录

记录以下信息：

- GitHub Actions run URL；
- `build-info.txt` 中的 commit 和 target；
- Mac 型号、CPU 架构和 macOS 版本；
- 每项“通过 / 环境无此条件 / 失败”；
- 失败步骤、时间和已脱敏日志片段。

该 workflow 只上传 CI artifact，不创建或覆盖 `v0.0.1` tag/release，也不发布正式安装包。
