# V3 Remote Browser

## 产品边界

Remote Browser 的目标是取得 Host 网络能力，不是远程桌面。Remote 设备负责渲染；正常导航不传像素。

不会同步 Host Wry Browser 的 cookie、localStorage、DOM、history 或页面像素。Remote Browser cookie 和缓存按连接及 `context_id` 独立。

## 请求链路

```text
隔离 iframe
→ context-scoped 虚拟 URL
→ Join Service Worker
→ wasm HostNetworkClient
→ 独立 iroh QUIC stream
→ HostNetworkGateway
→ Host DNS / 路由 / TLS / proxy
```

请求和响应 head 是有界 JSON；body 是流内原始字节。取消 iframe、切换标签、AbortSignal 或断开 viewer 会取消 QUIC 流和 Host HTTP 请求。

## 渲染与隔离

- HTML 使用 DOM parser 改写静态 URL、表单、iframe 和 `<base>`。
- CSS 使用 PostCSS 改写 `url()` 和 `@import`。
- iframe 使用 `sandbox="allow-forms allow-scripts"`，不授予 `allow-same-origin`。
- 注入 CSP 只允许当前 context 的虚拟代理路径；页面不能读取 Join 状态、ticket 或协议对象。
- bootstrap 将 fetch、XMLHttpRequest 和 EventSource 的 HTTP(S) URL 映射到虚拟代理路径。
- GitHub Pages Join 必须先注册 Service Worker 并确认当前页面已受其控制，再挂载应用。Service Worker 是 CSS、图片、字体、脚本等虚拟子资源的必要数据面，不只是离线缓存优化；注册或接管失败必须显式阻止启动，不能降级为只有主 HTML 的残页。
- WebSocket 尚未伪装为 HTTP；未来必须使用专用长连接数据流。

## HTTP 状态

- Host 处理 HTTP/HTTPS、Host DNS、LAN/VPN/localhost 和 Host 信任链。
- redirect 在 Remote 侧逐跳处理；跨源会剥离 Authorization、Proxy-Authorization 和 Cookie。
- cookie jar 使用成熟 cookie store，`Set-Cookie` 不暴露给 Remote JS。
- HostNetworkGateway 按 context、URL 和 `Vary` 缓存；支持 Cache-Control、Expires、ETag、Last-Modified 和条件重验证。
- 缓存正文单项最多 16 MiB、连接总计最多 64 MiB；超限响应仍正常流式传输，只是不缓存。

## 当前兼容层级

V3 Level 1 覆盖 HTML、CSS、图片/字体、链接、表单、基础 JavaScript、HTTP(S) 和服务端 cookie 连续性。fetch/XHR/EventSource 已走 Host HTTP 流。WebSocket、`document.cookie` 完整模拟和复杂 Web App 兼容属于后续增量能力。
