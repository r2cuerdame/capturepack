# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## 回溯 bug，选择对象，把当时的状态交给 AI

**CapturePack 把默认 30 秒的循环回放变成人和 AI 都能读取的结构化证据。**

问题发生后按下快捷键，回到出错时刻，再用对象选择挑出过去画面里已捕获的控件或
窗口。CapturePack 保存目标身份、观测位置和移动，不让 AI 只凭像素猜测。

🌐 **[capturepack.dev](https://capturepack.dev)** · [下载](https://github.com/r2cuerdame/capturepack/releases/latest)

当前公开 Windows 版本：**CapturePack 0.3.1**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="CapturePack 回到过去画面，选择子 UI 控件，显示捕获时的名称和控件类型，跟随所属窗口的观测移动，并导出 AI 可读的结构化证据" width="760">
</p>

## 使用流程

1. **回溯** — 实时录制默认开启时，在问题发生后按 `Ctrl+Alt+C`。回放长度可设为
   1–60 秒。关闭实时录制后不会记录任何内容。
2. **选择对象** — 在过去画面中选择光标下已捕获的控件。记录观测边界、无障碍
   名称、控件类型和选择时刻；无法取得子控件时，以真实窗口为备用目标。
3. **追踪移动** — 所属窗口和控件的位置按回放时钟观测。每个样本都标明显示器，
   因此保存并重新打开后，跨显示器对象仍保持相同时间和坐标。
4. **交付结构化上下文** — 把文件夹交给开发者或 AI，也可使用可选的本机只读
   MCP 服务器读取已经保存的包。

### 对象信息来源

- **Windows UI Automation（内置）：** 应用公开的无障碍名称、语义控件类型、
  AutomationId、进程/窗口身份和观测边界。
- **Chrome DOM（可选预览扩展）：** 你明确选择的元素的 selector、角色、文本和
  URL；不会持续传输 DOM。
- **HWND 窗口备用方案：** 取得不到子控件时，不虚构对象，而是记录真实窗口及其
  观测位置。

### 只需要一张图片

`Ctrl+Alt+S` 默认打开区域选择，可无缝跨越显示器边界拖动。顶部的**全屏捕获**
会把所有显示器明确保存为一张虚拟桌面图片。图片在同一编辑器中打开，支持时使用
原生 100% 比例。图片包没有视频和 `timeline.json`。区域包只保存所选像素和裁剪
位置，不会暗中保留全屏或其他显示器图片。

## 包内内容

视频包：

```text
CapturePack_2026-07-27_143052/
├── replay.mp4               # 原始证据（也可能是 replay.webm）
├── replay_annotated.webm    # 可选派生视图；仅在清单声明时存在
├── snapshot.png
├── annotations.json         # 对象身份 + 观测边界
├── timeline.json
├── report.md · README.md · skills/
├── plugins/                 # UIA / 可选 Chrome DOM 上下文
└── manifest.json
```

图片包：

```text
CapturePack_2026-07-27_143052/
├── snapshot.png             # 所选区域或完整虚拟桌面
├── annotations.json
├── report.md · README.md · skills/
├── plugins/                 # 可选对象上下文
└── manifest.json            # capture_kind: image，无视频/时间线
```

对象信息和移动轨迹只在确实观测到时保存。没有可用 UI 对象或样本时，包会如实说明，
不会编造上下文。

## MCP

应用内置可选的只读 [MCP](https://modelcontextprotocol.io) 服务器，默认在
`http://127.0.0.1:39393/mcp` 启用并自动启动。可在设置 → MCP 中立即停止或关闭
自动启动。它只读取用户已经保存的图片包和视频包，不能发起新捕获。

使用 `capturepack_history` 搜索历史记录，再用 `capturepack_open` 打开所选包；
`capturepack_latest` 可直接打开最新包。详见 [docs/MCP.md](docs/MCP.md)。

## 设置与诊断

- 在设置 → 捕获中可分别修改视频（`Ctrl+Alt+C`）与图像（`Ctrl+Alt+S`）
  快捷键，并设置回放长度和1–30 fps捕获速率。
- 信息 → **打开日志文件夹**可查看本地运行诊断；日志不会自动上传。

## 分享前检查隐私

屏幕像素、窗口标题、无障碍名称以及 Chrome DOM 的 selector、角色、文本和 URL
可能包含敏感信息。CapturePack 不会上传捕获内容、遥测或崩溃报告。应用唯一的
外部请求是可在设置中关闭的 GitHub Releases 更新检查。

模糊是非破坏性的：它保护标注后的派生视图，但完整包中的 `snapshot.png` 和原始
回放仍保留未遮挡内容。分享前请检查原始文件；存在私密信息时不要分享完整包。

## 状态与安全

0.3.1 是当前公开版本。当前构建未签名，SmartScreen 可能警告；
每个版本都附带用于验证的 `SHA256SUMS.txt`。

本地优先 · 离线优先 · 开放格式 · 无云端 · 无登录 · 无遥测

## 许可证

[MIT](LICENSE)
