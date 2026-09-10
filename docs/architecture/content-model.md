# V3 Content 模型

## 单一目录

`resources/content-types.json` 是内容能力和 OS 文件关联的唯一目录。`tools/check-content-catalog.mjs` 校验目录；`tools/generate-tauri-associations.mjs` 生成并检查 Tauri bundle associations；Rust build 直接读取同一目录。

当前目录覆盖 32 类内容、118 个扩展名和 31 个安装关联组，包括 Markdown、文本/代码、JSON/YAML/TOML/XML、图片、CSV/TSV、HTML、PDF、压缩包、SQLite、Office 和常见媒体。

## 路由

`OpenIntent` 是系统打开、深链、命令和 Workbench 内部打开操作的统一输入。`OpenIntentRouter` 根据 ContentRegistry 选择明确 handler；未知或不可内嵌内容进入安全 fallback，不通过扩展名散落判断。

```text
OS/deep link/Workbench intent
→ OpenIntent
→ ContentRegistry
→ ContentHandler
→ preview/editor/inspect/fallback
```

## 状态边界

- 内容目录描述能力，不保存用户数据。
- 用户关联偏好和 Tab 状态属于 `app.db`。
- installer association、运行时识别和显示元数据来自同一 catalog。
- 应用不得静默抢占系统默认程序；默认应用变更必须经过用户明确操作并可查询状态。

## 非目标

ContentRegistry 不是 Plugin Kernel，不加载外部执行代码，也不引入 Resident runtime。
