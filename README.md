# pi-antigravity-auth

This is a **pi coding agent** extension that brings the full feature set of OpenCode's Antigravity authentication (free Gemini & Claude access) into pi.

*Read this in other languages: [English](#english), [简体中文](#简体中文).*

---

<h2 id="english">English</h2>

### 🚀 Features
- **Zero-Proxy Architecture**: Uses pi's native extension API with a global `fetch` hook to transparently redirect `@google/genai` traffic, eliminating the need for a background proxy server.
- **Shared Account Pool**: Reuses your `~/.config/opencode/antigravity-accounts.json`. If you have already logged in via OpenCode, you can start making requests immediately without re-authenticating.
- **Auto-Rotation**: Seamlessly rotates across multiple Google accounts to bypass quota limits, inheriting V1's resilient connection layer.
- **Integrated `google_search` Tool**: Full support for Google Grounding searches just like the original extension.
- **SSE Fix**: Mitigates formatting bugs in the original V1 stream parser to guarantee stable parsing in pi.

> **Disclaimer**: This is a third-party port of the `opencode-antigravity-auth` V1 plugin. Using undocumented Google endpoints via authentication token scraping may violate Google’s Terms of Service and lead to account bans. **Use at your own risk.**

### 📦 Installation
Run this directly in your terminal:
```bash
pi install git:github.com/YSQI-ai/pi-antigravity-auth
```

### 🔧 Commands
- `/login` -> Select `Antigravity` to bind your pi session to a Google account.
- `/antigravity-login` -> Silently add an additional Google account to the rotation pool without altering pi's main credential.
- `/antigravity-logout` -> Clear pi's credential **and** wipe the shared account pool entirely.
- `/antigravity-accounts` -> Display the current status of the rotation pool.

### 🤖 Models
Once authenticated, you can invoke models via:
```bash
pi -p "Hello!" --model antigravity/antigravity-gemini-3-pro
```

---

<h2 id="简体中文">简体中文</h2>

### 🚀 特性
- **无代理架构**：利用 pi 原生扩展 API 和全局 `fetch` 拦截，透明重定向 `@google/genai` 的请求流量，无需后台代理服务器。
- **账号池共享**：直接复用 `~/.config/opencode/antigravity-accounts.json`。如果你之前在 OpenCode 登录过，无需重新认证即可直接使用。
- **自动轮换**：无缝轮换多个 Google 账号以绕过限流，继承了原版 V1 插件强大的断线重连与轮询层。
- **内置 `google_search` 工具**：和原版扩展一样，完全支持基于 Google Grounding 的联网搜索。
- **流式格式修复**：修复了原版 V1 SSE 解析器在拼接数据块时的格式 Bug，确保在 pi 中稳定输出。

> **免责声明**：这是 `opencode-antigravity-auth` V1 插件的第三方移植版。通过提取认证 Token 调用未公开的 Google 接口可能违反 Google 的服务条款，并有封号风险。**请自行承担风险。**

### 📦 安装
在终端中直接运行：
```bash
pi install git:github.com/YSQI-ai/pi-antigravity-auth
```

### 🔧 指令
- `/login` -> 选择 `Antigravity`，将你的 pi 绑定到一个 Google 账号。
- `/antigravity-login` -> 静默地向轮换账号池追加额外的 Google 账号，而不改变 pi 主界面的凭据绑定。
- `/antigravity-logout` -> 登出并清空 pi 凭据 **同时** 清空共享账号池。
- `/antigravity-accounts` -> 显示当前账号池的轮换状态与活跃情况。

### 🤖 模型列表
认证成功后，可以通过如下命令调用模型：
```bash
pi -p "Hello!" --model antigravity/antigravity-gemini-3-pro
```
