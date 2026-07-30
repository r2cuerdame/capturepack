# capturepack

[English](README.md) · [한국어](README.ko.md) · **日本語** · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português](README.pt.md) · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## バグを巻き戻し、オブジェクトを選び、その状態をAIへ

**CapturePackは、既定30秒のローリングリプレイを、人とAIが読める構造化された証拠に変えます。**

問題が起きた後にショートカットを押し、その瞬間まで巻き戻して、過去フレームに
記録されたコントロールまたはウィンドウをObject Pickで選びます。CapturePackは
対象の識別情報と観測済みの位置・動きを保存し、AIにピクセルだけから推測させません。

🌐 **[capturepack.dev](https://capturepack.dev)** · [ダウンロード](https://github.com/r2cuerdame/capturepack/releases/latest)

現在公開中のWindows版: **CapturePack 0.3.2**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/ja/capturepack-time-machine-poster.webp" alt="右側のNOWから再生ヘッドを左の5秒前へ動かし、その過去フレームに存在した子UIコントロールを復元して選択し、AI向け構造化証拠を書き出すCapturePack" width="760">
</p>

## ワークフロー

1. **巻き戻す** — ライブ録画がオンの初期状態で、不具合の後に
   `Ctrl+Alt+C`を押します。長さは1–60秒に設定できます。ライブ録画をオフに
   すると何も記録されません。
2. **オブジェクトを選ぶ** — 過去フレームのカーソル下にある記録済み
   コントロールを選びます。観測済み境界、アクセシブル名、コントロール種別、
   選択時刻を保存し、子コントロールが得られなければ実際のウィンドウを使います。
3. **動きを追う** — 所有ウィンドウとコントロールの位置をリプレイ時計上で
   観測します。各サンプルがディスプレイを示すため、保存・再読込後も、
   モニターをまたぐ対象の時刻と座標が保たれます。
4. **構造化コンテキストを渡す** — フォルダーを人やAIへ渡すか、任意の
   ローカル専用・読み取り専用MCPサーバーで保存済みパックを読ませます。

### オブジェクト情報の出所

- **Windows UI Automation（内蔵）:** アプリが公開するアクセシブル名、
  意味的なコントロール種別、AutomationId、プロセス/ウィンドウ情報、
  観測済み境界。
- **Chrome DOM（任意のプレビュー拡張）:** 明示的に選んだ要素のselector、
  role、text、URL。DOMを継続配信しません。
- **HWNDウィンドウのフォールバック:** 子コントロールが得られない場合も、
  オブジェクトを捏造せず実際のウィンドウと観測済み位置を保存します。

### 1枚だけ必要な場合

`Ctrl+Alt+S`は範囲選択を初期表示し、モニター境界を途切れなくドラッグできます。
上部の**全画面キャプチャ**は、全モニターを1枚の仮想デスクトップ画像として
明示的に撮ります。画像は同じエディターで、対応可能ならネイティブ100%で開きます。
画像パックには動画も`timeline.json`もありません。範囲パックは選択ピクセルと
切り抜き位置だけを保存し、隠れた全画面や別モニター画像を保持しません。

## パックの内容

動画パック:

```text
CapturePack_2026-07-27_143052/
├── replay.mp4               # オリジナル（replay.webmの場合あり）
├── replay_annotated.webm    # 任意の派生ビュー（マニフェスト宣言時のみ）
├── snapshot.png
├── annotations.json         # 対象の識別情報 + 観測済み境界
├── timeline.json
├── report.md · README.md · skills/
├── plugins/                 # UIA / 任意のChrome DOMコンテキスト
└── manifest.json
```

画像パック:

```text
CapturePack_2026-07-27_143052/
├── snapshot.png             # 選択範囲または仮想デスクトップ全体
├── annotations.json
├── report.md · README.md · skills/
├── plugins/                 # 任意のオブジェクトコンテキスト
└── manifest.json            # capture_kind: image、動画/タイムラインなし
```

オブジェクト情報と移動トラックは観測できた場合だけ含まれます。利用できる
UIオブジェクトやサンプルがなければ、パックは推測せずその事実を示します。

## MCP

任意の読み取り専用[MCP](https://modelcontextprotocol.io)サーバーが同梱され、
初期状態では`http://127.0.0.1:39393/mcp`で有効・自動起動します。設定 → MCPで
直ちに停止し、自動起動も無効にできます。ユーザーが保存済みの画像/動画パック
だけを読み、新しいキャプチャを開始することはできません。

`capturepack_history`で履歴を探し、`capturepack_open`で選択できます。
`capturepack_latest`は最新パックへの近道です。詳細は[docs/MCP.md](docs/MCP.md)へ。

## 設定と診断

- 設定 → キャプチャで動画（`Ctrl+Alt+C`）と画像（`Ctrl+Alt+S`）の
  ショートカットを個別に変更し、リプレイ長と1～30 fpsを設定できます。
- 情報 → **ログフォルダーを開く**でローカル診断を確認できます。
  ログが自動送信されることはありません。

## 共有前のプライバシー確認

画面のピクセル、ウィンドウタイトル、アクセシブル名、Chrome DOMのselector・
role・text・URLには機密情報が含まれる場合があります。CapturePackはキャプチャ、
テレメトリ、クラッシュレポートをアップロードしません。唯一の外部リクエストは、
設定で無効にできる任意のGitHub Releases更新確認です。

ぼかしは非破壊です。注釈済みビューは保護されますが、フルパック内の
`snapshot.png`と元のリプレイは未編集のままです。共有前にオリジナルを確認し、
非公開情報がある場合はフルパックを共有しないでください。

## 状態とセキュリティ

0.3.2が現在の公開版です。現在のビルドは未署名のためSmartScreenが警告することがあり、各リリースに
検証用`SHA256SUMS.txt`があります。

ローカルファースト · オフラインファースト · オープン形式 · クラウドなし ·
ログインなし · テレメトリなし

## ライセンス

[MIT](LICENSE)
