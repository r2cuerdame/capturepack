# capturepack

[English](README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## バグを 5 秒で説明できますか？

**CapturePack は、LLM に何かを説明する最速の方法です。**

> スクリーンショットではなく、コンテキストをキャプチャ。
>
> より良い入力。より良い回答。

CapturePack は、スクリーンショットや画面録画の先へ踏み込み、人にも AI にも視覚的な問題を理解させるための、オープンソースのコンテキストキャプチャ形式とツールキットです。

🌐 **[capturepack.dev](https://capturepack.dev)** · [ダウンロード](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=2" alt="デモ: Ctrl+Alt+C を押すと直近 30 秒が凍りつき、マウスホイールで時間をスクラブし、ドラッグで対象を選び、注釈を書けば、CapturePack が保存されます。" width="760">
</p>

CapturePack の**フォルダー**には、スクリーンショットには収められないものが詰まっています。直近 30 秒のリプレイ、スナップショット、編集可能な注釈、機械可読なイベントタイムライン、そして人にも AI にも読めるレポート — 別の開発者や任意の LLM が状況をその場で理解するために必要なもの、すべてです。共有したくなったら、フォルダーを 1 つの `.capturepack` ファイルにまとめるだけ。

## 5 秒のワークフロー

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## なぜ

- **スクリーンショットはピクセルを残します。** そのフレームの前に何が起きたかは失われます。
- **動画は動きを残します。** 意図と構造は失われます。
- **CapturePack はコンテキストを残します。** 時間、空間、意図、環境。

## 🕰 タイムマシンです

バグはもう起きてしまった？ CapturePack は**すでに録画していました**。何かがおかしくなった*あと*に `Ctrl+Alt+C` を押せば、直近 30 秒がその場で凍りつき、マウスホイールが**時間を遡って**、壊れたまさにそのフレームへ連れて行きます。注釈を付けるのは再現ではなく、その瞬間そのものに。

## 🤖 LLM のために

CapturePack は、AI が本当に理解できる入力です。

- パックを **ChatGPT、Claude、Codex、Cursor、Gemini** に放り込むだけ — 生成されたレポートとコンテキストファイルが、追加のプロンプトなしで状況を説明します。
- 何も添付しなくても構いません。アプリは **MCP サーバー**を動かしているので、接続された AI は*「最新の CapturePack を分析して」*と聞くだけで、自分で読みに行きます。

より良い入力。より良い回答。

## 🌍 対応言語

CapturePack は **9 言語**を話します: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- アプリは**システムの言語**に自動で合わせます — 設定 → 一般 でいつでも変更できます。
- 生成されるパック文書（`README.md`、`report.md`、`skills/`）は独自の言語設定に従えます。あなたが書いた説明が翻訳されることはありません。
- [capturepack.dev](https://capturepack.dev) もブラウザーの言語を自動で判別します。

## 原則

ローカルファースト · オフラインファースト · オープンな形式 · プラグインベース · クラウドなし · ログインなし · データベースなし · AI 依存なし · ベンダーロックインなし。

生成された CapturePack は、いつまでも読めるままであるべきです。

## CapturePack の中身

パックはただの**フォルダー**です — 中を覗けて、編集でき、ごまかしがない。ZIP（`.capturepack`）は共有したいときにだけ作られます。

```
CapturePack_2026-07-27_143052/
├── replay.webm              # 元の証拠 — 一切変更されません
├── replay_annotated.webm    # 注釈を焼き込んだ動画。どのプレーヤーでも再生できます
├── snapshot.png             # キャプチャしたフレーム（オリジナル）
├── annotations.json         # 真のソース: ボックス、表示時間、番号、ぼかし
├── timeline.json            # 機械可読なイベントログ
├── report.md                # あなたの説明を、LLM がそのまま読める形で
├── manifest.json            # 形式のバージョン、収録物の一覧
├── README.md                # 人が最初に読む文書
├── skills/                  # AI 向けに構造化したコンテキスト（MCP なしでも機能）
└── plugins/                 # 連携から得た構造化メタデータ
```

`manifest.json` と `snapshot.png` だけ、ほかには何もない — そんなスクリーンショットのみのパックも、完全に有効です。

どんな実装よりも仕様が大切です — どの言語からでも CapturePack ファイルを生成できます。[SPEC.md](SPEC.md) を参照してください。

## MCP — キャプチャと対話する

アプリには、常時稼働・読み取り専用の [MCP](https://modelcontextprotocol.io) サーバーが `http://127.0.0.1:39393/mcp`（localhost のみ）に同梱されています。どんな AI でも最新のパックを自分で見つけて分析できます — プロンプトは「最新の CapturePack を分析して」、それだけです。

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

ツール、クライアント設定、各種オプションは [docs/MCP.md](docs/MCP.md) へ。

## ステータス

開発初期段階です。プロジェクトのビジョンは [GOAL.md](GOAL.md)、次に来るものは [ROADMAP.md](ROADMAP.md) をご覧ください。

## セキュリティと署名

Windows ビルドは現在署名されていません（SmartScreen が警告を出します — *詳細情報 → 実行*）。
各リリースには検証用の `SHA256SUMS.txt` が付属し、OSS 向けコード署名の申請は審査中です。
詳細、チームの役割、プライバシーの扱いは [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) へ。

## ♥ 支援

CapturePack は無料・オープンソースで、クラウドも使いません — アカウントなし、テレメトリーなし、売り物もなし。
これで時間が浮いたなら、[**GitHub でのスポンサー**](https://github.com/sponsors/r2cuerdame)が開発を前に進めます。

## ライセンス

[MIT](LICENSE)
