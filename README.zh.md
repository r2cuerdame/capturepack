# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## 回溯 bug，标记那一刻，把当时的状态交给 AI

**CapturePack 把默认 30 秒的循环回放变成人和 AI 都能读懂的结构化证据。**

出问题之后按下快捷键，回溯到真正出错的那一帧。框出坏掉的地方，写下你想说的话，
然后保存。包里带着回放、桌面随时间记录下来的窗口与控件坐标，以及你的批注——
AI 不必只凭像素去猜。

**Object Pick（对象选择）是静止图像的功能。** 截一张图，你就能点击光标下的真实
控件：CapturePack 会记录它的名称、角色、AutomationId 和进程，在浏览器里还会记录
整个可见页面。回放无法诚实地给出同样的东西——
[原因见此](#为什么对象选择属于静止图像)——所以在视频里，你得到的是自己画的方框。

保存下来的包与用户实际捕获的内容一致：视频包包含回放、画面帧、批注、随时间观测到
的窗口与控件坐标，以及事件时间线；图片包包含明确捕获的那张静止图像、批注和对象
上下文。双击 `viewer.html` 即可离线查看两种包，无需安装 CapturePack，也不用启动
服务器。它始终是一个本地的、开放的文件夹，没有 AI、账号或云服务照样能用。

🌐 **[capturepack.dev](https://capturepack.dev)** · [下载](https://github.com/r2cuerdame/capturepack/releases/latest)

当前公开 Windows 版本：**CapturePack 0.4.5**。0.4.4 可从历史记录创建经检查的
**分享副本**（`.share.zip`）；其中唯一的媒体是经检查的带批注 PNG 静态图片，并附带
生成的 README、离线查看器和最小清单。原始内容、所有视频和结构化上下文都会被排除。
完整 ZIP（`.zip`）仍会包含原始内容。

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/zh/capturepack-time-machine-poster.webp" alt="CapturePack 从右侧的 NOW 出发，把播放头向左移动到 5 秒前，框出屏幕上已经消失的故障，并导出供 AI 使用的结构化证据" width="760">
  </a>
</p>

注意方向：播放头从**右侧的 NOW** 出发，一路向**左走到 5 秒前**——屏幕上已经消失
的故障，在那里依然等着被标记。同一份证据也会以结构化数据的形式保存下来交给 AI。

## 使用流程

1. **回溯** —— 实时录制开启时（默认开启），在 bug 发生后按 `Ctrl+Alt+C`，然后在
   冻结的回放里拖动播放头，找到界面出错的那一帧。回放长度可在 1–60 秒之间设置。
2. **标记** —— 右键拖出一个方框框住坏掉的地方，并写下你的意思。方框带有生命周期，
   会随它所解释的那一刻一起出现、一起消失。
3. **或者截图并选择对象** —— 按下截图快捷键，Object Pick 会高亮光标下的真实控件。
   点一下就会记录它的无障碍名称、控件类型、AutomationId、进程和观测边界；拿不到
   控件数据时，窗口仍然是备用目标。在浏览器里，包还会保留页面本身：你能看到的
   每一个元素，连同它的角色、矩形和文本。你输入的内容、密码框以及任何隐藏内容都会
   被刻意拒绝收集，载荷中会列出被略去的部分，这样读到的人就知道，看起来空白的表单
   其实是脱敏的结果。
4. **交付结构化上下文** —— 把文件夹交给另一位开发者，丢进 ChatGPT、Claude、Codex、
   Cursor 或 Gemini，也可以让已连接的 AI 通过内置的只读 MCP 服务器来读取它。

### 为什么对象选择属于静止图像

不是因为在回放里选择对象不值得，而是因为在回放里只能选到*一半*。

记录窗口坐标的开销很低：CapturePack 每秒采样约一百次，所以任何一帧它都能告诉你
哪个窗口在哪里。而遍历一个窗口里的**控件**，开销就完全不是一回事了——在一台普通
的桌面上，光是遍历那些 Chromium 窗口就要 326 ms，其余所有窗口加起来才 13.9 ms——
所以录制期间运行的追踪器会把自己控制在 3% 的 CPU 占用内，并直接跳过它们。结果就是：
这个功能曾经只能在你捕获的那一瞬间交出浏览器里的按钮，前后各挪一秒就只剩下浏览器
窗口本身，而画面上没有任何东西告诉你此刻拿到的到底是哪一种。

静止图像没有这种割裂。它只有一个瞬间，完整的遍历就在这个瞬间跑完，桌面上的每一个
控件都可以选。所以，精度就用在了这里。

视频依然会*记录*当时的一切——窗口和控件随时间变化的坐标会进入包的上下文时间线，
供 AI 读取。它不再做的，只是邀请你去点击。

### 对象上下文的来源

- **Windows UI Automation（内置）：** 无障碍控件名称、语义类型、AutomationId、
  进程/窗口身份，以及应用公开时的观测边界。
- **Chrome DOM（可选的预览版扩展）：** 你明确选中的那个元素的 selector、角色、文本
  和 URL——先点击 CapturePack 工具栏图标，再点击该元素。它在 iframe 内同样有效，
  只在这一次选择时读取页面，不会持续传输 DOM。设置 › 插件 › Chrome DOM 会报告选择器
  上一次做了什么，所以没有送达的选择也会说明原因。
  **点一次 CapturePack 图标，并在浏览器中授权即可。** 之后你在 Chrome 里什么都不用按：
  平时的捕获快捷键就会把可见页面一并带上。这份一次性授权之所以存在，是因为 Chrome
  永远看不到全局快捷键——它只在 Chrome 内部发生点击时，或者对用户已经授权的扩展，
  才会把页面交出去。在你授权之前不会保留任何内容（安装时不会出现权限警告），
  `chrome://extensions` 也可以随时收回授权。没有授权时写出的包只是不带页面，并且会
  说明这一点。
- **HWND 窗口备用方案：** 没有可用的子控件时，CapturePack 仍然记录真实窗口及其观测
  坐标，而不是凭空编造一个控件。

### 只需要一帧？

按 `Ctrl+Alt+S` 打开区域捕获。默认就是拖选一块区域；顶部的**捕获整个屏幕**按钮则会
明确捕获整个虚拟桌面——所有显示器合成一张图。结果会在同一个上下文编辑器中以原生
100% 打开（桌面特别大时会取最接近的可用缩放比例），并且可以平移，但这个包会被声明
为图片，不含任何回放文件。区域包只保存所选像素以及裁剪位置的元数据——不会暗中保留
一张全屏或第二块显示器的图像。

## 为什么

- **截图留住的是像素。** 你会失去这一帧之前发生的事。
- **视频留住的是过程。** 你会失去意图和结构。
- **CapturePack 留住的是上下文。** 回放、随之记录下来的窗口坐标、在静止图像上选中的
  对象、批注，以及真正被捕获下来的状态。

## 先回溯

bug 已经发生了？只要实时录制是开着的（默认开启），CapturePack 就已经把最近的回放
留在内存里。在出问题*之后*按 `Ctrl+Alt+C`，然后用鼠标滚轮**沿时间往回滚**，找到它
出错的那一帧。关闭实时录制则什么都不会记录，按下快捷键时也会告诉你录制已关闭。

## 结构化上下文说了什么

在静止图像上做的批注，能标明的远不止一个矩形。视频的批注则是你画的那些方框，加上
每个方框所解释的那一刻：

- **目标身份：** 应用公开时的 UIA 名称、控件类型（控件的语义角色）、AutomationId、
  进程或窗口身份；可选的 Chrome DOM 选择则可以改为携带 selector、角色、文本和 URL。
- **时间中的捕获状态：** 被选中的那一刻、它所在的显示器，以及那一刻观测到的边界。
- **视觉与叙述证据：** 原始媒体、可编辑的批注、生成的视图与报告；视频包还会加上
  关键帧、时间线，以及随之记录的窗口坐标。

这些上下文可以直接从普通文件夹里读出来。已连接的 AI 也可以使用应用的**只读 MCP
服务器**，从这一句开始：*“分析最新的 CapturePack。”*

## 🌍 语言

CapturePack 支持 **9 种语言**：English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- 应用会自动跟随你的**系统语言**——随时可在 设置 → 常规 中更改。
- 生成的包文档（`viewer.html`、`README.md`、`report.md`、`skills/`）可以使用各自独立的语言设置；你自己写的描述永远不会被翻译。
- [capturepack.dev](https://capturepack.dev) 同样会自动识别浏览器语言。

## 原则

本地优先 · 离线优先 · 开放格式 · 插件化 · 无云端 · 无登录 · 无数据库 · 不依赖 AI · 不绑定厂商。

生成的 CapturePack 应当永远可读。

## CapturePack 里有什么

包就是一个普通的**文件夹**——可浏览、可编辑、不藏东西。完整分发副本是普通 ZIP
（`.zip`），其中仍包含原始证据。0.4.4 还在历史记录中提供经检查的**分享副本**
（`.share.zip`）；其中唯一的媒体是经检查的带批注 PNG 静态图片，并附带生成的 README、
离线查看器和最小封闭清单。

视频包可能包含：

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # 原始证据（或备用的 replay.webm）
├── replay_annotated.webm    # 可选的派生视图；仅在清单声明时存在
├── snapshot.png             # 捕获到的那一帧（原始）
├── annotations.json         # 真正的源头：方框、生命周期、编号、模糊
├── timeline.json            # 视频包专有：机器可读的事件日志
├── viewer.html              # 双击即可离线查看；无需服务器
├── report.md                # 你的描述，可直接喂给 LLM
├── manifest.json            # 格式版本、文件清单
├── README.md                # 人类最先读到的文档
├── skills/                  # 为 AI 整理的上下文（没有 MCP 也能用）
└── plugins/                 # 可用时捕获到的 UI 对象元数据
```

图片包则刻意不同：

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # 明确选择的区域或完整虚拟桌面
├── annotations.json         # 图片批注
├── viewer.html              # 双击即可离线查看；无需服务器
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # 图片专属上下文；没有时间线 skill
└── plugins/                 # 可选的对象元数据
```

图片包会记录 `capture_kind: "image"`，以及区域或全屏这两种范围之一。它没有回放，也
没有 `timeline.json`。区域图片还会记录裁剪来自哪里，但不会保存裁剪范围之外的像素。
对象元数据同样属于可选证据：如果某个应用没有公开可用的 UI 对象，包会如实说明，而不
是编造上下文。

规范比任何具体实现都重要——任何语言都可以生成 CapturePack 文件。参见 [SPEC.md](SPEC.md)。

## MCP —— 与你的捕获对话

应用内置一个可选的只读 [MCP](https://modelcontextprotocol.io) 服务器，默认启用并自动
启动在 `http://127.0.0.1:39393/mcp`（仅限本机）。在 设置 → MCP 中可以立即停止它，或者
关闭自动启动。它只读取用户已经保存的 CapturePack，不能发起图片或视频捕获。

AI 可以调用 `capturepack_history` 浏览/搜索图片和视频记录，再用选中的 id 调用
`capturepack_open`；`capturepack_latest` 仍然是打开最新包的捷径。

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

工具、客户端配置与设置详见：[docs/MCP.md](docs/MCP.md)。

## 设置与诊断

- 设置 → 捕获 中可以分别配置视频（`Ctrl+Alt+C`）与图片（`Ctrl+Alt+S`）快捷键、
  回放长度以及 5–30 fps 的捕获帧率。
- 关于 / 信息 → **打开日志文件夹** 会打开本地的、有大小上限的运行诊断。日志绝不会
  被自动上传。

## 状态

**0.4.5 是当前公开的 Windows 下载版本。** CapturePack 仍是一个早期阶段的项目，因此
报告问题时请保留原始包；产品愿景见 [GOAL.md](GOAL.md)，接下来的计划见
[ROADMAP.md](ROADMAP.md)。

已知限制：各显示器之间的视频/上下文 PTS 对齐仍在
[issue #89](https://github.com/r2cuerdame/capturepack/issues/89) 中测量中。
CapturePack 宁可如实记录含糊的时间证据，也不用一个写死的全局偏移把它遮过去。

## 文档

- [文档索引](docs/README.md) —— 工程、集成、QA、发布、schema 与历史资料的最佳入口。
- [包规范](SPEC.md)与[架构](ARCHITECTURE.md) —— 开放格式契约与当前实现边界。
- [发布 QA](docs/QA.md)、[当前交接文档](docs/HANDOFF.md)与[发布流程](docs/RELEASING.md)
  —— 变更如何验证、如何交接、如何发布。
- [MCP](docs/MCP.md)与[时间上下文提供方 API](docs/temporal-provider-api.md)
  —— 只读的已保存包访问，以及上下文提供方集成。

CapturePack `0.4.5` 是应用版本号。包的 `format_version` 通过纯追加式的格式变更独立
演进；读取方应当遵循 [SPEC.md](SPEC.md)，而不是从应用版本推断格式支持情况。

## 安全与签名

Windows 构建目前未签名（SmartScreen 会警告——*更多信息 → 仍要运行*）；每个发布都附带
用于校验的 `SHA256SUMS.txt`，开源代码签名的申请也正在处理中。详情、团队角色与隐私
实践见：[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md)。

## 分享前的隐私检查

屏幕像素、窗口标题和无障碍名称——使用 Chrome DOM 时还包括 selector、角色、文本和
URL——都可能是敏感信息。CapturePack 把捕获内容和对象上下文都留在这台机器上，不上传
任何捕获、遥测或崩溃报告。应用唯一的对外请求，是可以在 设置 → 常规 中关闭的
GitHub Releases 更新检查。

模糊是非破坏性的：它保护的是生成的批注视图，而完整包里的 `snapshot.png` 和原始回放
仍然未被遮挡。当原始媒体或结构化上下文必须保密时，请在 0.4.4 中使用历史记录 →
**分享副本**，并在发送前逐一检查所含静态图片的预览。分享副本会排除原始
内容、所有视频容器、manifest、批注、时间线、插件上下文和生成的包文档，并把所含 PNG
仅按像素数据规范化重编码。即便如此，也不能保证经检查的衍生图片中没有未标记的秘密。

## ♥ 赞助

CapturePack 免费、开源、无云端——没有账号，没有遥测，也没有什么要卖给你。
如果它替你省下了时间，[**在 GitHub 上赞助**](https://github.com/sponsors/r2cuerdame)
能让它继续走下去。

## 许可证

[MIT](LICENSE)
