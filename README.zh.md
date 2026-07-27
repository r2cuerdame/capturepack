# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · **中文** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## 你能在 5 秒内说清一个 bug 吗？

**CapturePack 是向 LLM 解释问题的最快方式。**

> 捕捉上下文，而不是截图。
>
> 更好的输入。更好的回答。

CapturePack 是一套开源的上下文捕捉格式与工具集，让人类和 AI 理解截图、录屏之外的视觉问题。

🌐 **[capturepack.dev](https://capturepack.dev)** · [下载](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="演示：按下 Ctrl+Alt+C，最后 30 秒被冻结，滚动滚轮在时间中穿梭，拖拽框选对象，写下标注，CapturePack 就保存好了。" width="760">
</p>

一个 CapturePack **文件夹**装下了截图装不下的东西：最后 30 秒的回放、一张快照、可编辑的标注、机器可读的事件时间线，还有人和 AI 都读得懂的报告 — 另一位开发者或任何 LLM 立刻看懂现场所需的一切。需要分享时，把文件夹打包成一个 `.capturepack` 文件就行。

## 5 秒工作流

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## 为什么

- **截图留住像素。** 这一帧之前发生了什么，全没了。
- **视频留住动作。** 意图和结构，全没了。
- **CapturePack 留住上下文。** 时间、空间、意图、环境。

## 🕰 这是一台时光机

bug 已经发生了？CapturePack **早就在录了**。出问题*之后*再按 `Ctrl+Alt+C` — 最后 30 秒被冻结，滚动滚轮就能**回到过去**，停在出错的那一帧。标注真正发生的那一刻，而不是重演一遍。

## 🤖 为 LLM 而生

CapturePack 是 AI 真正读得懂的输入：

- 把包扔给 **ChatGPT、Claude、Codex、Cursor、Gemini** — 生成的报告和上下文文件会把情况讲清楚，不用你再多写一句提示词。
- 或者干脆什么都不用附：应用内置 **MCP 服务器**，连接上的 AI 只要听到一句*“分析最新的 CapturePack”*，就会自己去读。

更好的输入。更好的回答。

## 🌍 多语言

CapturePack 会说 **9 种语言**：English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- 应用自动跟随你的**系统语言** — 也可以随时在 设置 → 常规 里更改。
- 生成的包文档（`README.md`、`report.md`、`skills/`）可以有自己的语言设置；你亲手写的描述永远不会被翻译。
- [capturepack.dev](https://capturepack.dev) 同样会自动识别你的浏览器语言。

## 原则

本地优先 · 离线优先 · 开放格式 · 插件化 · 无云端 · 无登录 · 无数据库 · 不依赖 AI · 不绑定厂商。

生成的 CapturePack 应当永远可读。

## CapturePack 里装了什么

包就是一个普通**文件夹** — 可浏览、可编辑、坦坦荡荡。只有要分享时才会生成 ZIP（`.capturepack`）。

```
CapturePack_2026-07-27_143052/
├── replay.webm              # 原始证据 — 永不修改
├── replay_annotated.webm    # 标注已烧录进画面；任何播放器都能播
├── snapshot.png             # 捕获到的那一帧（原图）
├── annotations.json         # 真正的源数据：方框、持续时间、编号、模糊
├── timeline.json            # 机器可读的事件日志
├── report.md                # 你的描述，LLM 就绪
├── manifest.json            # 格式版本、文件清单
├── README.md                # 人类最先读的那份文档
├── skills/                  # 为 AI 结构化的上下文（没有 MCP 也能用）
└── plugins/                 # 来自集成插件的结构化元数据
```

只有截图的包 — `manifest.json` + `snapshot.png`，别的什么都没有 — 也完全有效。

规范比任何实现都重要 — 任何语言都可以生成 CapturePack 文件。参见 [SPEC.md](SPEC.md)。

## MCP — 和你的捕获对话

应用内置一个常驻、只读的 [MCP](https://modelcontextprotocol.io) 服务器，地址是 `http://127.0.0.1:39393/mcp`（仅限本机），任何 AI 都能自己找到并分析你最新的包 — 提示词只有一句：“分析最新的 CapturePack”。

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

工具、客户端配置与各项设置：[docs/MCP.md](docs/MCP.md)。

## 状态

开发早期。项目愿景见 [GOAL.md](GOAL.md)，接下来的计划见 [ROADMAP.md](ROADMAP.md)。

## 安全与签名

Windows 版本目前尚未签名（SmartScreen 会警告 — *更多信息 → 仍要运行*）；
每个发布版本都附带 `SHA256SUMS.txt` 供校验，开源代码签名的申请正在处理中。
详情、团队角色与隐私实践：[docs/CODE_SIGNING.md](docs/CODE_SIGNING.md)。

## ♥ 支持

CapturePack 免费、开源、无云端 — 没有账号，没有遥测，也没有什么要卖给你。
如果它帮你省下了时间，[**在 GitHub 上赞助**](https://github.com/sponsors/r2cuerdame) 能让它一直走下去。

## 许可证

[MIT](LICENSE)
