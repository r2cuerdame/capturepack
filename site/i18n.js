// CapturePack landing i18n — 9 languages, client-side.
// Default: browser language; persisted in localStorage under "cp_lang".
;(function () {
  var DICT = {
    en: {
      ft_guide: 'Guide',
      h1: 'Rewind 30 seconds.<br>Mark what broke.',
      sub: 'With Live recording on (the default), CapturePack freezes the last 30 seconds so you can go back to the frame where the interface was actually wrong — and on a still, pick the real control and save its name and captured state as structured data for AI.',
      btn_download: 'Download',
      btn_sponsor: '♥ Sponsor',
    release_note: 'Public download: 0.4.1. A saved pack’s browser page can now be read back — reopening a capture recovered none of it before — and what object picking offers is measured, not assumed.',
      badge_foss: 'Free & open source',
      badge_local: 'Local-first · no cloud',
      badge_mcp: 'MCP built-in',
      demo_title: 'At NOW, rewind left 5 seconds—then mark it.',
      demo_alt: 'Animated CapturePack editor: the playhead starts at NOW on the right and moves left to 5 seconds ago, where the failure that has already vanished from the screen is still there to box and explain, and the pack exports structured data.',
      demo_body: 'Watch the playhead start at NOW on the right and travel left to 5s AGO. By the time you notice, the Save changes failure is gone from the screen — in that past frame it is still there to box and explain, and the pack carries it, with the desktop’s recorded window geometry, to AI.',
      f1_title: '1 · Rewind the last 30 seconds',
      f1_body: 'With Live recording on (the default), press <em>Ctrl+Alt+C after the bug</em>. CapturePack freezes the rolling replay so you can scrub back to the frame where the interface was actually wrong. Turn recording off and nothing is recorded.',
      f2_title: '2 · Mark it — or pick the real object on a still',
      f2_body: 'In a replay you box what broke and say what you meant; the box has a lifetime, so it appears with the moment it explains. On a still, Object Pick highlights the real control under the cursor and one click records its accessible name, control type and observed bounds — the window is the fallback when child-control data is unavailable.',
      f3_title: '3 · A still keeps everything the frame contained',
      f3_body: 'An image pack records every control that was on screen at the instant you captured — and, from every visible browser window, the page itself: every element you could see, with its role, rectangle and text. A video records the window and control geometry it observed through time, and no page. Values you typed, password boxes and anything hidden are refused on purpose, and the pack says so in its own payload.',
      f4_title: '4 · Give AI structured evidence',
      f4_body: 'A box carries its own rectangle and the display it sits on; when it was picked, it also names what it points at — the target’s name, role, and AutomationId or selector. Read the folder directly or use the optional, local-only, read-only MCP server.',
      sources_title: 'What a still collects, with honest fallbacks',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Built in. Captures accessible names, semantic control types, AutomationId and observed bounds when an app exposes them.',
      source_dom_title: 'Chrome DOM preview',
      source_dom_body: 'Optional extension. Records selector, role, text and URL for the element you explicitly pick; it does not stream the DOM.',
      source_hwnd_title: 'HWND window fallback',
      source_hwnd_body: 'If no child control is available, CapturePack records the real window and its observed geometry instead of inventing an object.',
      still_kicker: 'ONE FRAME, SAME CONTEXT EDITOR',
      still_title: 'Need a still? Press Ctrl+Alt+S.',
      still_body: 'Region selection is the default. The explicit Full screen capture button captures every monitor in one virtual-desktop image. Images that fit open at native 100%; oversized captures open fitted so the whole image is visible. No video is saved. A region pack keeps only the selected pixels and crop placement metadata — never a hidden full-screen or second-monitor image.',
      out_title: 'The pack matches what you captured',
      out_video_title: 'Video pack',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              original (or replay.webm fallback)\n├─ replay_annotated.webm   optional; only when manifest-declared\n├─ snapshot.png\n├─ annotations.json        the boxes you drew, with lifetimes\n├─ timeline.json           events on the replay clock\n├─ plugins/                UIA / optional Chrome DOM context\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Image pack',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            explicit region or virtual desktop\n├─ annotations.json        image annotations\n├─ plugins/                optional object context\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           no replay or timeline',
      out_note: 'One local folder: visual evidence plus machine-readable object context.<br>Zip it only when you share.',
      privacy_kicker: 'LOCAL DOES NOT MEAN REDACTED',
      privacy_title: 'Review the original before sharing.',
      privacy_body: 'CapturePack uploads no captures, telemetry or crash reports; the optional GitHub update check can be disabled, and MCP can be stopped in Settings. Blur is non-destructive: annotated views are protected, but snapshot.png and the original replay in a full pack remain unredacted.',
      ft_releases: 'Releases', ft_sponsor: 'Sponsor',
      ft_license: 'MIT License · Open Source',
      ft_why: 'Made because explaining bugs to AI<br>was taking too much time.'
    },
    ko: {
      ft_guide: '사용 안내',
      h1: '30초 전으로 되감고,<br>무엇이 망가졌는지 표시하세요.',
      sub: '라이브 녹화가 켜진 기본 상태에서 CapturePack은 지난 30초를 얼려 인터페이스가 실제로 잘못됐던 프레임으로 돌아가게 해 주고, 정지 화면에서는 실제 컨트롤을 직접 선택해 이름과 캡처된 상태를 AI용 구조화 데이터로 저장합니다.',
      btn_download: '다운로드',
      btn_sponsor: '♥ 후원',
    release_note: '현재 공개 다운로드는 0.4.1입니다. 저장된 팩의 브라우저 페이지를 이제 다시 읽어올 수 있습니다. 지금까지는 캡처를 다시 열어도 아무것도 되살아나지 않았습니다. 객체 선택이 무엇을 내주는지도 이제 짐작이 아니라 측정으로 확인합니다.',
      badge_foss: '무료 · 오픈소스',
      badge_local: '로컬 우선 · 클라우드 없음',
      badge_mcp: 'MCP 내장',
      demo_title: '오른쪽 NOW에서 왼쪽 5초 전으로 되감은 다음 표시하세요.',
      demo_alt: 'CapturePack 편집기 애니메이션: 재생 헤드가 오른쪽 NOW에서 왼쪽 5초 전으로 이동하고, 이미 화면에서 사라진 실패가 아직 남아 있는 그 프레임에서 상자를 그려 설명한 뒤 구조화 데이터를 내보냅니다.',
      demo_body: '재생 헤드는 오른쪽 NOW에서 시작해 왼쪽 5초 전으로 이동합니다. 알아차렸을 때 저장 실패는 이미 화면에서 사라진 뒤지만, 그 과거 프레임에는 아직 남아 있어 상자를 그리고 설명할 수 있습니다. 팩은 그것을 데스크톱의 기록된 창 좌표와 함께 AI에게 전달합니다.',
      f1_title: '1 · 마지막 30초 되감기',
      f1_body: '라이브 녹화가 켜진 기본 상태에서 <em>버그가 난 뒤 Ctrl+Alt+C</em>를 누르세요. 순환 리플레이가 고정되어 실제로 잘못됐던 프레임으로 돌아갈 수 있습니다. 녹화를 끄면 아무것도 기록되지 않습니다.',
      f2_title: '2 · 표시하거나, 정지 화면에서 실제 객체를 선택하거나',
      f2_body: '리플레이에서는 망가진 곳에 상자를 그리고 무슨 뜻인지 적습니다. 상자에는 수명이 있어 설명하는 순간에 함께 나타납니다. 정지 화면에서는 객체 선택이 커서 아래의 실제 컨트롤을 강조하고, 한 번 클릭하면 접근성 이름, 컨트롤 유형, 관측 경계가 기록됩니다. 하위 컨트롤 데이터가 없으면 실제 창이 대체 대상이 됩니다.',
      f3_title: '3 · 정지 화면은 그 프레임에 있던 것을 그대로 보관',
      f3_body: '이미지 팩에는 캡처한 순간 화면에 있던 컨트롤이 기록되고, 보이는 모든 브라우저 창에서는 눈에 보이던 모든 요소가 역할, 사각형, 텍스트와 함께 페이지 단위로 남습니다. 영상 팩에는 시간에 따라 관측한 창과 컨트롤의 좌표만 남고, 페이지는 남지 않습니다. 입력한 값, 가려져 있던 텍스트, 화면 밖으로 스크롤된 부분은 기록을 의도적으로 거부하고, 암호 입력란은 있었다는 사실 외에 아무것도 남기지 않습니다. 무엇을 남기지 않았는지는 팩이 페이로드에 직접 적어 두므로, 비어 보이는 폼이 원래 빈 폼인지 거부된 결과인지 읽는 사람이 구분할 수 있습니다.',
      f4_title: '4 · AI에 구조화된 증거 전달',
      f4_body: '상자는 자신의 사각형과 자신이 놓인 디스플레이를 담고, 객체 선택으로 만든 상자라면 가리키는 대상의 이름, 역할, AutomationId 또는 selector까지 적습니다. 폴더를 직접 읽거나 선택 사항인 로컬 전용 읽기 전용 MCP 서버를 사용하세요.',
      sources_title: '정지 화면이 모으는 것과 정직한 대체 경로',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: '기본 내장입니다. 앱이 제공하는 접근성 이름, 의미 있는 컨트롤 유형, AutomationId와 관측 경계를 캡처합니다.',
      source_dom_title: 'Chrome DOM 프리뷰',
      source_dom_body: '선택 확장입니다. 명시적으로 고른 요소의 selector, 역할, 텍스트, URL만 기록하며 DOM을 계속 전송하지 않습니다.',
      source_hwnd_title: 'HWND 창 대체 경로',
      source_hwnd_body: '하위 컨트롤을 얻지 못하면 객체를 만들어내지 않고 실제 창과 관측된 위치를 기록합니다.',
      still_kicker: '한 장의 이미지, 같은 맥락 편집기',
      still_title: '한 장이면 충분할 때는 Ctrl+Alt+S.',
      still_body: '기본은 영역 선택입니다. 상단의 전체 화면 캡처 버튼은 모든 모니터를 하나의 가상 데스크톱 이미지로 담습니다. 편집기에 들어오는 이미지는 화면 안에 들어오면 원본 100%로, 더 크면 전체가 한눈에 보이도록 맞춰 열립니다. 영상은 저장되지 않습니다. 영역 팩은 선택한 픽셀과 크롭 위치 정보만 보관하며 숨겨진 전체 화면이나 다른 모니터 이미지를 남기지 않습니다.',
      out_title: '캡처한 종류에 맞는 팩',
      out_video_title: '영상 팩',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              원본(replay.webm 대체 가능)\n├─ replay_annotated.webm   선택 항목; 매니페스트 선언 시에만\n├─ snapshot.png\n├─ annotations.json        직접 그린 상자와 그 수명\n├─ timeline.json           리플레이 시계의 이벤트\n├─ plugins/                UIA / 선택 Chrome DOM 맥락\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: '이미지 팩',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            선택 영역 또는 가상 데스크톱\n├─ annotations.json        이미지 주석\n├─ plugins/                선택 객체 맥락\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           리플레이와 타임라인 없음',
      out_note: '로컬 폴더 하나에 시각 증거와 기계가 읽을 수 있는 객체 맥락을 담습니다.<br>공유할 때만 ZIP으로 만드세요.',
      privacy_kicker: '로컬 저장은 비식별화를 뜻하지 않습니다',
      privacy_title: '공유하기 전에 원본을 확인하세요.',
      privacy_body: 'CapturePack은 캡처, 텔레메트리, 충돌 보고서를 업로드하지 않습니다. 선택적인 GitHub 업데이트 확인은 끌 수 있고 MCP도 설정에서 중지할 수 있습니다. 블러는 비파괴 방식이므로 주석 결과물은 보호되지만 전체 팩의 snapshot.png와 원본 리플레이는 가려지지 않은 상태로 남습니다.',
      ft_releases: '릴리스', ft_sponsor: '후원',
      ft_license: 'MIT 라이선스 · 오픈소스',
      ft_why: 'AI에게 버그를 설명하는 데<br>시간이 너무 걸려서 만들었습니다.'
    },
    ja: {
      ft_guide: '使い方',
      h1: '30秒前まで巻き戻し、<br>壊れた箇所に印を付ける。',
      sub: 'ライブ録画がオンの既定状態で、CapturePackは直近30秒を凍結し、インターフェースが実際に壊れていたフレームまで戻れるようにします。静止画では実際のコントロールを直接選択し、名前と取得時の状態をAI向け構造化データとして保存します。',
      btn_download: 'ダウンロード',
      btn_sponsor: '♥ スポンサー',
    release_note: '現在の公開ダウンロードは0.4.1です。保存したパックのブラウザーページを、ようやく読み戻せるようになりました。これまではキャプチャを開き直しても何も戻ってきませんでした。オブジェクト選択が何を差し出すかも、推測ではなく計測で確かめます。',
      badge_foss: '無料 · オープンソース',
      badge_local: 'ローカルファースト · クラウドなし',
      badge_mcp: 'MCP内蔵',
      demo_title: '右のNOWから左の「5秒前」へ巻き戻し、印を付ける。',
      demo_alt: 'CapturePackエディターのアニメーション：再生ヘッドが右のNOWから左の5秒前へ移動し、すでに画面から消えた不具合がまだ残っているそのフレームで囲んで説明し、構造化データを書き出します。',
      demo_body: '再生ヘッドは右のNOWから左の「5秒前」へ移動します。気づいたときには保存の失敗はもう画面から消えていますが、その過去フレームにはまだ残っていて、囲んで説明できます。パックはそれを、デスクトップの記録済みウィンドウ座標とともにAIへ渡します。',
      f1_title: '1 · 直近30秒を巻き戻す',
      f1_body: 'ライブ録画がオンの初期状態で、<em>バグが起きた後にCtrl+Alt+C</em>を押します。ローリングリプレイが固定され、実際にUIが壊れていたフレームまで戻れます。録画をオフにすると何も記録されません。',
      f2_title: '2 · 印を付ける — または静止画で実際のオブジェクトを選ぶ',
      f2_body: 'リプレイでは壊れた箇所を囲み、意図を書き添えます。ボックスには寿命があり、説明する瞬間とともに現れます。静止画ではObject Pickがカーソル下の実際のコントロールを強調し、1回のクリックでアクセシブル名、コントロール種別、観測境界を記録します。子コントロール情報がなければ実際のウィンドウがフォールバックです。',
      f3_title: '3 · 静止画はそのフレームにあったものを残す',
      f3_body: '画像パックには取得した瞬間に画面にあったコントロールが記録され、見えているすべてのブラウザーウィンドウではページ自体も残ります。見えていたすべての要素を、ロール・矩形・テキストとともに。動画パックに残るのは、時間の経過とともに観測したウィンドウとコントロールの座標だけで、ページは残りません。入力した値、パスワード欄、隠れていたものは意図的に拒否され、何を残さなかったかはパック自身のペイロードに書かれています。',
      f4_title: '4 · AIへ構造化された証拠を渡す',
      f4_body: 'ボックスは自身の矩形と、置かれたディスプレイを持ちます。Object Pickで作られたボックスなら、指し示す対象の名前、役割、AutomationIdまたはselectorも記します。フォルダを直接読むか、任意のローカル専用・読み取り専用MCPサーバーを使えます。',
      sources_title: '静止画が集めるものと、正直なフォールバック',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: '標準で内蔵。アプリが公開するアクセシブル名、意味的なコントロール種別、AutomationId、観測済み境界を取得します。',
      source_dom_title: 'Chrome DOMプレビュー',
      source_dom_body: '任意の拡張機能。明示的に選んだ要素のselector、role、text、URLだけを記録し、DOMを継続配信しません。',
      source_hwnd_title: 'HWNDウィンドウのフォールバック',
      source_hwnd_body: '子コントロールが得られなければ、オブジェクトを捏造せず、実際のウィンドウと観測済みの位置を記録します。',
      still_kicker: '1枚でも、同じコンテキストエディター',
      still_title: '静止画ならCtrl+Alt+S。',
      still_body: '初期状態は範囲選択です。上部の「全画面キャプチャ」ボタンは、すべてのモニターを1枚の仮想デスクトップ画像にまとめます。エディター内に収まる画像はネイティブ100%で、大きな画像は全体が見えるようにフィット表示で開きます。動画は保存しません。範囲パックは選択したピクセルと切り抜き位置だけを保持し、隠れた全画面画像や別モニター画像は残しません。',
      out_title: 'キャプチャした種類に合うパック',
      out_video_title: '動画パック',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              オリジナル（replay.webmの場合あり）\n├─ replay_annotated.webm   任意・マニフェスト宣言時のみ\n├─ snapshot.png\n├─ annotations.json        自分で描いたボックスと寿命\n├─ timeline.json           リプレイ時計上のイベント\n├─ plugins/                UIA / 任意のChrome DOMコンテキスト\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: '画像パック',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            明示した範囲または仮想デスクトップ\n├─ annotations.json        画像の注釈\n├─ plugins/                任意のオブジェクトコンテキスト\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           リプレイとタイムラインなし',
      out_note: 'ひとつのローカルフォルダに、視覚的証拠と機械可読なオブジェクトコンテキストを保存します。<br>共有するときだけZIPにしてください。',
      privacy_kicker: 'ローカル保存は匿名化ではありません',
      privacy_title: '共有前にオリジナルを確認してください。',
      privacy_body: 'CapturePackはキャプチャ、テレメトリ、クラッシュレポートをアップロードしません。任意のGitHub更新確認は無効化でき、MCPも設定で停止できます。ぼかしは非破壊で、注釈済みビューは保護されますが、フルパック内のsnapshot.pngと元のリプレイは未編集のまま残ります。',
      ft_releases: 'リリース', ft_sponsor: 'スポンサー',
      ft_license: 'MITライセンス · オープンソース',
      ft_why: 'AIにバグを説明する時間が<br>長すぎたので作りました。'
    },
    zh: {
      ft_guide: '使用指南',
      h1: '回溯 30 秒，<br>标记出问题的地方。',
      sub: '实时录制默认开启时，CapturePack 会冻结最近 30 秒，让你回到界面真正出错的那一帧；在静止画面中，你还能直接选中真实控件，把名称和捕获状态保存为 AI 可读的结构化数据。',
      btn_download: '下载',
      btn_sponsor: '♥ 赞助',
    release_note: '当前公开下载为 0.4.1。保存下来的包，里面的浏览器页面终于能读回来了——此前重新打开一次捕获，页面什么也剩不下；对象选择给出的范围也不再靠猜，而是有实测。',
      badge_foss: '免费开源',
      badge_local: '本地优先 · 无云端',
      badge_mcp: '内置 MCP',
      demo_title: '从右侧 NOW 向左回溯 5 秒，再标记。',
      demo_alt: 'CapturePack 编辑器动画：播放头从右侧 NOW 向左移动到 5 秒前，在那一帧里，已经从屏幕上消失的故障仍然存在，可以框选并加以说明，然后导出结构化数据。',
      demo_body: '播放头从右侧 NOW 开始，向左移动到“5 秒前”。等你察觉时，保存失败早已从屏幕上消失；而在那一帧里它仍然存在，可以框选并说明。包会把它连同桌面记录下来的窗口坐标一起交给 AI。',
      f1_title: '1 · 回溯最近 30 秒',
      f1_body: '实时录制默认开启时，<em>问题发生后按 Ctrl+Alt+C</em>。循环回放会被冻结，让你回到界面真正出错的那一帧。关闭录制后不会记录任何内容。',
      f2_title: '2 · 标记它 —— 或在静止画面中选择真实对象',
      f2_body: '在回放中，你框出出问题的地方并写下含义；方框带有生命周期，会随它所解释的那一刻一同出现。在静止画面中，对象选择会高亮光标下的真实控件，单击一次即可记录无障碍名称、控件类型和观测边界；没有子控件数据时，真实窗口会作为备用目标。',
      f3_title: '3 · 静止画面保留那一帧里的内容',
      f3_body: '图片包会记录你捕获的那一刻屏幕上的控件；在每个可见的浏览器窗口里还会记录页面本身：你当时能看到的每个元素，连同角色、矩形和文本。视频包只记录它随时间观测到的窗口和控件位置，不记录页面。你输入过的值、密码框除“它存在过”之外的一切、对你不可见的文本以及滚动到可视范围之外的内容，都被刻意拒绝记录；包也会在自身数据里写明拒绝了什么。',
      f4_title: '4 · 向 AI 提供结构化证据',
      f4_body: '方框自带矩形和所在的显示器；若由对象选择生成，还会写明它所指对象的名称、角色以及 AutomationId 或 selector。可直接读取文件夹，也可使用可选的本机只读 MCP 服务器。',
      sources_title: '静止画面会收集什么，以及如实的备用方案',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: '内置功能。在应用提供时捕获无障碍名称、语义控件类型、AutomationId 和观测边界。',
      source_dom_title: 'Chrome DOM 预览',
      source_dom_body: '可选扩展。只记录你明确选择的元素的 selector、角色、文本和 URL，不会持续传输 DOM。',
      source_hwnd_title: 'HWND 窗口备用方案',
      source_hwnd_body: '无法取得子控件时，CapturePack 会记录真实窗口及其观测位置，而不会虚构对象。',
      still_kicker: '一张图片，同一个上下文编辑器',
      still_title: '只需静态图时，按Ctrl+Alt+S。',
      still_body: '默认是区域选择。顶部的“全屏捕获”按钮会把所有显示器合成一张虚拟桌面图片。能放入编辑器的图片以原生 100% 打开；更大的图片会自适应显示完整内容。不会保存视频。区域包只保留所选像素和裁剪位置元数据，不会暗中保存全屏或另一台显示器的图像。',
      out_title: '包与所选捕获类型一致',
      out_video_title: '视频包',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              原始回放（或 replay.webm）\n├─ replay_annotated.webm   可选；仅在清单声明时存在\n├─ snapshot.png\n├─ annotations.json        你画的方框及其生命周期\n├─ timeline.json           回放时钟上的事件\n├─ plugins/                UIA / 可选 Chrome DOM 上下文\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: '图片包',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            明确选择的区域或虚拟桌面\n├─ annotations.json        图片标注\n├─ plugins/                可选对象上下文\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           无回放和时间线',
      out_note: '一个本地文件夹同时保存视觉证据和机器可读的对象上下文。<br>仅在分享时打包为 ZIP。',
      privacy_kicker: '本地保存不等于已脱敏',
      privacy_title: '分享前请检查原始内容。',
      privacy_body: 'CapturePack 不会上传捕获内容、遥测或崩溃报告；可关闭可选的 GitHub 更新检查，也可在设置中停止 MCP。模糊是非破坏性的：标注视图会被保护，但完整包中的 snapshot.png 和原始回放仍保留未遮挡内容。',
      ft_releases: '发布', ft_sponsor: '赞助',
      ft_license: 'MIT 许可 · 开源',
      ft_why: '因为向 AI 解释 bug 太费时间，<br>所以做了它。'
    },
    es: {
      ft_guide: 'Guía',
      h1: 'Rebobina 30 segundos.<br>Marca lo que falló.',
      sub: 'Con la grabación en vivo activada (por defecto), CapturePack congela los últimos 30 segundos para que vuelvas al fotograma donde la interfaz falló de verdad; y en una captura fija puedes seleccionar el control real y guardar su nombre y estado como datos estructurados para la IA.',
      btn_download: 'Descargar',
      btn_sponsor: '♥ Patrocinar',
    release_note: 'La descarga pública actual es 0.4.1. La página de navegador guardada en un pack por fin se puede volver a leer — al reabrir una captura no se recuperaba nada — y lo que ofrece la selección de objetos ahora se mide, no se supone.',
      badge_foss: 'Gratis y open source',
      badge_local: 'Local primero · sin nube',
      badge_mcp: 'MCP integrado',
      demo_title: 'Desde AHORA, rebobina 5 segundos a la izquierda y marca.',
      demo_alt: 'Editor de CapturePack animado: el cabezal parte de AHORA a la derecha y va a la izquierda hasta hace 5 segundos, donde el fallo que ya desapareció de la pantalla sigue estando para encuadrarlo y explicarlo, y el paquete exporta datos estructurados.',
      demo_body: 'Mira cómo el cabezal parte de AHORA a la derecha y viaja a la izquierda hasta HACE 5 s. Cuando te das cuenta, el fallo de Guardar ya no está en pantalla; en ese fotograma pasado sigue ahí para encuadrarlo y explicarlo, y el paquete lo lleva a la IA junto con la geometría de ventanas registrada del escritorio.',
      f1_title: '1 · Retrocede los últimos 30 segundos',
      f1_body: 'Con la grabación en vivo activada de forma predeterminada, pulsa <em>Ctrl+Alt+C después del fallo</em>. La repetición se congela para volver al fotograma donde la interfaz estaba realmente mal. Si desactivas la grabación, no se registra nada.',
      f2_title: '2 · Márcalo — o selecciona el objeto real en una captura fija',
      f2_body: 'En una reproducción encuadras lo que falló y escribes lo que querías decir; el recuadro tiene una vida útil y aparece con el momento que explica. En una captura fija, Object Pick resalta el control real bajo el cursor y un clic registra su nombre accesible, tipo de control y límites observados; la ventana sirve de respaldo si faltan datos del control hijo.',
      f3_title: '3 · Una captura fija conserva lo que contenía el fotograma',
      f3_body: 'Un pack de imagen registra los controles que estaban en pantalla en el instante que capturaste — y, de cada ventana de navegador visible, la página misma: cada elemento que podías ver, con su rol, rectángulo y texto. Un pack de vídeo registra la geometría de ventanas y controles que observó a lo largo del tiempo, pero ninguna página. Los valores que escribiste, los campos de contraseña y todo lo oculto se rechazan a propósito, y el paquete lo dice en su propia carga.',
      f4_title: '4 · Entrega evidencia estructurada a la IA',
      f4_body: 'El recuadro lleva su propio rectángulo y la pantalla en la que está; si nació de Object Pick, además nombra lo que señala: el nombre, el rol y el AutomationId o selector del objetivo. Lee la carpeta directamente o usa el servidor MCP opcional, local y de solo lectura.',
      sources_title: 'Lo que recoge una captura fija, con alternativas honestas',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Integrado. Captura nombres accesibles, tipos semánticos, AutomationId y límites observados cuando la aplicación los expone.',
      source_dom_title: 'Vista previa de Chrome DOM',
      source_dom_body: 'Extensión opcional. Registra selector, rol, texto y URL del elemento que eliges explícitamente; no transmite el DOM continuamente.',
      source_hwnd_title: 'Alternativa de ventana HWND',
      source_hwnd_body: 'Si no hay control hijo, CapturePack registra la ventana real y su geometría observada en vez de inventar un objeto.',
      still_kicker: 'UNA IMAGEN, EL MISMO EDITOR DE CONTEXTO',
      still_title: '¿Solo necesitas una imagen? Pulsa Ctrl+Alt+S.',
      still_body: 'La selección de región es la opción predeterminada. El botón Capturar pantalla completa reúne todos los monitores en una sola imagen del escritorio virtual. Las imágenes que caben se abren al 100% nativo; las más grandes se ajustan para mostrar la captura completa. No se guarda vídeo. Un pack de región conserva solo los píxeles elegidos y la posición del recorte, nunca una imagen oculta de toda la pantalla ni de otro monitor.',
      out_title: 'El pack coincide con lo que capturaste',
      out_video_title: 'Pack de vídeo',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              original (o replay.webm)\n├─ replay_annotated.webm   opcional; solo si lo declara el manifiesto\n├─ snapshot.png\n├─ annotations.json        los recuadros que dibujaste, con vida útil\n├─ timeline.json           eventos del reloj de repetición\n├─ plugins/                contexto UIA / Chrome DOM opcional\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Pack de imagen',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            región explícita o escritorio virtual\n├─ annotations.json        anotaciones de imagen\n├─ plugins/                contexto de objeto opcional\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           sin repetición ni cronología',
      out_note: 'Una carpeta local: evidencia visual y contexto de objetos legible por máquinas.<br>Comprímela en ZIP solo cuando la compartas.',
      privacy_kicker: 'LOCAL NO SIGNIFICA CENSURADO',
      privacy_title: 'Revisa el original antes de compartir.',
      privacy_body: 'CapturePack no sube capturas, telemetría ni informes de fallos; la comprobación opcional de actualizaciones en GitHub puede desactivarse y MCP puede detenerse en Ajustes. El desenfoque no es destructivo: protege las vistas anotadas, pero snapshot.png y la repetición original del pack completo siguen sin censurar.',
      ft_releases: 'Versiones', ft_sponsor: 'Patrocinar',
      ft_license: 'Licencia MIT · Open Source',
      ft_why: 'Creado porque explicar bugs a la IA<br>llevaba demasiado tiempo.'
    },
    fr: {
      ft_guide: 'Guide',
      h1: 'Rembobinez 30 secondes.<br>Marquez ce qui a cassé.',
      sub: 'Avec l’enregistrement en direct activé (par défaut), CapturePack fige les 30 dernières secondes pour revenir à l’image où l’interface était réellement fautive ; et sur une capture fixe, vous sélectionnez le vrai contrôle et enregistrez son nom et son état comme données structurées pour l’IA.',
      btn_download: 'Télécharger',
      btn_sponsor: '♥ Sponsoriser',
    release_note: 'Le téléchargement public actuel est la 0.4.1. La page web enregistrée dans un pack se relit enfin — rouvrir une capture n’en restituait rien — et ce que propose la sélection d’objet est désormais mesuré, non supposé.',
      badge_foss: 'Gratuit & open source',
      badge_local: 'Local d’abord · sans cloud',
      badge_mcp: 'MCP intégré',
      demo_title: 'Depuis MAINTENANT, rembobinez 5 secondes à gauche, puis marquez.',
      demo_alt: 'Éditeur CapturePack animé : la tête de lecture part de MAINTENANT à droite et va vers la gauche jusqu’à il y a 5 secondes, où la panne déjà disparue de l’écran est encore là pour être encadrée et expliquée, puis le pack exporte des données structurées.',
      demo_body: 'La tête de lecture part de MAINTENANT à droite et va vers la gauche jusqu’à IL Y A 5 s. Quand vous le remarquez, l’échec d’enregistrement a déjà quitté l’écran ; dans cette image passée il est encore là, à encadrer et à expliquer, et le pack le transmet à l’IA avec la géométrie des fenêtres enregistrée du bureau.',
      f1_title: '1 · Remontez les 30 dernières secondes',
      f1_body: 'Lorsque l’enregistrement en direct est activé par défaut, appuyez sur <em>Ctrl+Alt+C après le bug</em>. Le replay est figé pour revenir à l’image où l’interface était réellement incorrecte. Si vous coupez l’enregistrement, rien n’est enregistré.',
      f2_title: '2 · Marquez-le — ou sélectionnez le vrai objet sur une capture fixe',
      f2_body: 'Dans une relecture, vous encadrez ce qui a cassé et écrivez ce que vous vouliez dire ; le cadre a une durée de vie et apparaît avec le moment qu’il explique. Sur une capture fixe, Object Pick met en évidence le vrai contrôle sous le curseur et un clic enregistre son nom accessible, son type et ses limites observées ; la fenêtre sert de secours si les données du contrôle enfant manquent.',
      f3_title: '3 · Une capture fixe conserve ce que contenait l’image',
      f3_body: 'Un pack image enregistre les contrôles présents à l’écran à l’instant capturé — et, de chaque fenêtre de navigateur visible, la page elle-même : chaque élément visible, avec son rôle, son rectangle et son texte. Un pack vidéo enregistre la géométrie des fenêtres et des contrôles qu’il a observée au fil du temps, mais aucune page. Les valeurs saisies, les champs de mot de passe et tout ce qui est masqué sont refusés volontairement, et le pack le déclare dans sa propre charge utile.',
      f4_title: '4 · Donnez à l’IA des preuves structurées',
      f4_body: 'Le cadre porte son propre rectangle et l’écran où il se trouve ; s’il vient d’Object Pick, il nomme aussi ce qu’il désigne : le nom, le rôle et l’AutomationId ou selector de la cible. Lisez le dossier directement ou utilisez le serveur MCP facultatif, local et en lecture seule.',
      sources_title: 'Ce que collecte une capture fixe, avec des solutions de repli honnêtes',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Intégré. Capture les noms accessibles, types sémantiques, AutomationId et limites observées lorsque l’application les expose.',
      source_dom_title: 'Aperçu Chrome DOM',
      source_dom_body: 'Extension facultative. Enregistre sélecteur, rôle, texte et URL de l’élément explicitement choisi ; elle ne diffuse pas le DOM en continu.',
      source_hwnd_title: 'Repli sur la fenêtre HWND',
      source_hwnd_body: 'Sans contrôle enfant, CapturePack enregistre la vraie fenêtre et sa géométrie observée au lieu d’inventer un objet.',
      still_kicker: 'UNE IMAGE, LE MÊME ÉDITEUR DE CONTEXTE',
      still_title: 'Besoin d’une image fixe ? Ctrl+Alt+S.',
      still_body: 'La sélection de zone est le choix par défaut. Le bouton Capture plein écran réunit tous les moniteurs dans une seule image du bureau virtuel. Une image qui tient dans l’éditeur s’ouvre à 100 % natif ; une image plus grande est ajustée pour rester entièrement visible. Aucune vidéo n’est enregistrée. Un pack de zone ne conserve que les pixels choisis et la position du recadrage, jamais une image plein écran cachée ni celle d’un autre moniteur.',
      out_title: 'Le pack correspond à votre capture',
      out_video_title: 'Pack vidéo',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              original (ou replay.webm)\n├─ replay_annotated.webm   facultatif ; déclaré par le manifeste\n├─ snapshot.png\n├─ annotations.json        les cadres dessinés, avec leur durée\n├─ timeline.json           événements de l’horloge du replay\n├─ plugins/                contexte UIA / Chrome DOM facultatif\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Pack image',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            zone explicite ou bureau virtuel\n├─ annotations.json        annotations de l’image\n├─ plugins/                contexte d’objet facultatif\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           sans replay ni chronologie',
      out_note: 'Un dossier local : preuves visuelles et contexte d’objet lisible par machine.<br>Créez un ZIP uniquement pour le partager.',
      privacy_kicker: 'LOCAL NE VEUT PAS DIRE CAVIARDÉ',
      privacy_title: 'Vérifiez l’original avant de le partager.',
      privacy_body: 'CapturePack n’envoie ni captures, ni télémétrie, ni rapports de plantage ; la vérification facultative des mises à jour GitHub peut être désactivée et MCP arrêté dans les réglages. Le flou est non destructif : il protège les vues annotées, mais snapshot.png et le replay original du pack complet restent non caviardés.',
      ft_releases: 'Versions', ft_sponsor: 'Sponsoriser',
      ft_license: 'Licence MIT · Open Source',
      ft_why: 'Créé parce qu’expliquer des bugs à l’IA<br>prenait trop de temps.'
    },
    de: {
      ft_guide: 'Anleitung',
      h1: '30 Sekunden zurückspulen.<br>Markieren, was kaputtging.',
      sub: 'Mit eingeschalteter Live-Aufnahme (Standard) friert CapturePack die letzten 30 Sekunden ein, damit Sie zu dem Bild zurückkehren, in dem die Oberfläche wirklich falsch war — und auf einem Standbild wählen Sie das echte Steuerelement aus und speichern Name und erfassten Zustand als strukturierte Daten für KI.',
      btn_download: 'Herunterladen',
      btn_sponsor: '♥ Sponsern',
    release_note: 'Der aktuelle öffentliche Download ist 0.4.1. Die im Pack gespeicherte Browserseite lässt sich endlich wieder lesen — beim erneuten Öffnen einer Aufnahme kam davon nichts zurück — und was die Objektauswahl anbietet, wird gemessen statt vermutet.',
      badge_foss: 'Kostenlos & Open Source',
      badge_local: 'Local-first · keine Cloud',
      badge_mcp: 'MCP integriert',
      demo_title: 'Von JETZT 5 Sekunden nach links zurückspulen — dann markieren.',
      demo_alt: 'Animierter CapturePack-Editor: Der Abspielkopf startet rechts bei JETZT und wandert nach links zu vor 5 Sekunden, wo der bereits vom Bildschirm verschwundene Fehler noch da ist, um umrahmt und erklärt zu werden, und das Paket exportiert strukturierte Daten.',
      demo_body: 'Der Abspielkopf startet rechts bei JETZT und wandert nach links zu VOR 5 SEKUNDEN. Wenn Sie es bemerken, ist der Speicher-Fehler längst vom Bildschirm verschwunden; in jenem früheren Bild ist er noch da, zum Umrahmen und Erklären, und das Paket bringt ihn samt der aufgezeichneten Fenstergeometrie des Desktops zur KI.',
      f1_title: '1 · Die letzten 30 Sekunden zurückspulen',
      f1_body: 'Drücke bei standardmäßig aktivierter Live-Aufnahme <em>Ctrl+Alt+C nach dem Fehler</em>. Das Replay wird eingefroren, damit du zu dem Bild mit der fehlerhaften Oberfläche zurückkehrst. Bei ausgeschalteter Aufnahme wird nichts aufgezeichnet.',
      f2_title: '2 · Markieren — oder auf einem Standbild das echte Objekt wählen',
      f2_body: 'In einer Wiedergabe umrahmen Sie, was kaputtging, und schreiben dazu, was Sie meinten; der Rahmen hat eine Lebensdauer und erscheint mit dem Moment, den er erklärt. Auf einem Standbild hebt Object Pick das echte Steuerelement unter dem Mauszeiger hervor, und ein Klick speichert barrierefreien Namen, Steuerelementtyp und beobachtete Grenzen; fehlen Daten des untergeordneten Elements, dient das Fenster als Rückfall.',
      f3_title: '3 · Ein Standbild behält, was im Bild war',
      f3_body: 'Ein Bild-Pack speichert die Steuerelemente, die im Moment der Aufnahme auf dem Bildschirm waren — und aus jedem sichtbaren Browserfenster die Seite selbst: jedes sichtbare Element mit Rolle, Rechteck und Text. Ein Video-Pack speichert die Fenster- und Steuerelementgeometrie, die es im Zeitverlauf beobachtet hat, aber keine Seite. Eingegebene Werte, Passwortfelder und alles Verborgene werden absichtlich verweigert, und das Paket sagt das in seiner eigenen Nutzlast.',
      f4_title: '4 · KI strukturierte Belege geben',
      f4_body: 'Der Rahmen trägt sein eigenes Rechteck und das Display, auf dem er liegt; stammt er aus Object Pick, nennt er zusätzlich Name, Rolle und AutomationId oder selector des Ziels. Lies den Ordner direkt oder nutze den optionalen, lokalen, schreibgeschützten MCP-Server.',
      sources_title: 'Was ein Standbild sammelt, mit ehrlichen Rückfällen',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Integriert. Erfasst barrierefreie Namen, semantische Typen, AutomationId und beobachtete Grenzen, wenn die App sie bereitstellt.',
      source_dom_title: 'Chrome-DOM-Vorschau',
      source_dom_body: 'Optionale Erweiterung. Speichert Selektor, Rolle, Text und URL des ausdrücklich gewählten Elements; sie streamt das DOM nicht.',
      source_hwnd_title: 'HWND-Fenster als Rückfall',
      source_hwnd_body: 'Ist kein untergeordnetes Element verfügbar, speichert CapturePack das echte Fenster und seine beobachtete Geometrie, statt ein Objekt zu erfinden.',
      still_kicker: 'EIN BILD, DERSELBE KONTEXTEDITOR',
      still_title: 'Nur ein Standbild? Drücke Ctrl+Alt+S.',
      still_body: 'Die Bereichsauswahl ist voreingestellt. Die Schaltfläche Vollbildaufnahme vereint alle Monitore in einem Bild des virtuellen Desktops. Bilder, die in den Editor passen, öffnen sich in nativen 100 %; größere Bilder werden vollständig eingepasst. Es wird kein Video gespeichert. Ein Bereichs-Pack behält nur die ausgewählten Pixel und die Zuschnittposition, niemals ein verborgenes Vollbild oder das Bild eines zweiten Monitors.',
      out_title: 'Das Pack entspricht der Aufnahmeart',
      out_video_title: 'Video-Pack',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              Original (oder replay.webm)\n├─ replay_annotated.webm   optional; nur bei Manifest-Deklaration\n├─ snapshot.png\n├─ annotations.json        die gezeichneten Rahmen, mit Lebensdauer\n├─ timeline.json           Ereignisse der Replay-Uhr\n├─ plugins/                UIA / optionaler Chrome-DOM-Kontext\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Bild-Pack',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            gewählter Bereich oder virtueller Desktop\n├─ annotations.json        Bildanmerkungen\n├─ plugins/                optionaler Objektkontext\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           kein Replay, keine Timeline',
      out_note: 'Ein lokaler Ordner: visuelle Belege plus maschinenlesbarer Objektkontext.<br>Erstelle nur zum Teilen eine ZIP-Datei.',
      privacy_kicker: 'LOKAL BEDEUTET NICHT GESCHWÄRZT',
      privacy_title: 'Prüfe das Original vor dem Teilen.',
      privacy_body: 'CapturePack lädt keine Aufnahmen, Telemetrie oder Absturzberichte hoch. Die optionale GitHub-Updateprüfung lässt sich deaktivieren und MCP in den Einstellungen stoppen. Unschärfe ist nicht destruktiv: annotierte Ansichten sind geschützt, doch snapshot.png und das Original-Replay im vollständigen Pack bleiben ungeschwärzt.',
      ft_releases: 'Releases', ft_sponsor: 'Sponsern',
      ft_license: 'MIT-Lizenz · Open Source',
      ft_why: 'Entstanden, weil es zu lange dauerte,<br>KI Bugs zu erklären.'
    },
    pt: {
      ft_guide: 'Guia',
      h1: 'Volte 30 segundos.<br>Marque o que quebrou.',
      sub: 'Com a gravação ao vivo ligada (padrão), o CapturePack congela os últimos 30 segundos para você voltar ao quadro em que a interface realmente falhou — e, em uma imagem estática, selecionar o controle real e salvar seu nome e estado capturado como dados estruturados para IA.',
      btn_download: 'Baixar',
      btn_sponsor: '♥ Apoiar',
    release_note: 'O download público atual é 0.4.1. A página de navegador guardada no pack enfim pode ser lida de volta — reabrir uma captura não recuperava nada dela — e o que a seleção de objeto oferece agora é medido, não presumido.',
      badge_foss: 'Grátis e open source',
      badge_local: 'Local-first · sem nuvem',
      badge_mcp: 'MCP embutido',
      demo_title: 'De AGORA, volte 5 segundos à esquerda — e marque.',
      demo_alt: 'Editor do CapturePack animado: o cursor de reprodução começa em AGORA, à direita, e vai para a esquerda até 5 segundos atrás, onde a falha que já sumiu da tela ainda está lá para ser marcada e explicada, e o pacote exporta dados estruturados.',
      demo_body: 'O cursor de reprodução começa em AGORA, à direita, e segue para a esquerda até 5 s ATRÁS. Quando você percebe, a falha ao salvar já saiu da tela; naquele quadro passado ela ainda está lá, para ser marcada e explicada, e o pacote a leva à IA junto com a geometria de janelas registrada da área de trabalho.',
      f1_title: '1 · Volte pelos últimos 30 segundos',
      f1_body: 'Com a gravação ao vivo ativa por padrão, pressione <em>Ctrl+Alt+C depois do erro</em>. O replay é congelado para voltar ao quadro em que a interface estava errada. Ao desligar a gravação, nada é registrado.',
      f2_title: '2 · Marque — ou escolha o objeto real em uma imagem estática',
      f2_body: 'Em uma reprodução você marca o que quebrou e escreve o que quis dizer; a caixa tem tempo de vida e aparece junto com o momento que explica. Em uma imagem estática, o Object Pick destaca o controle real sob o cursor e um clique registra nome acessível, tipo do controle e limites observados; a janela serve de contingência quando faltam dados do controle filho.',
      f3_title: '3 · Uma imagem estática guarda o que o quadro continha',
      f3_body: 'Um pack de imagem registra os controles que estavam na tela no instante em que você capturou — e, de cada janela de navegador visível, a própria página: cada elemento que você podia ver, com papel, retângulo e texto. Um pack de vídeo registra a geometria de janelas e controles que observou ao longo do tempo, mas nenhuma página. Valores digitados, campos de senha e tudo o que estava oculto são recusados de propósito, e o pacote diz isso na própria carga.',
      f4_title: '4 · Entregue evidências estruturadas à IA',
      f4_body: 'A caixa carrega o próprio retângulo e a tela em que está; se veio do Object Pick, ela também nomeia o que aponta: o nome, o papel e o AutomationId ou selector do alvo. Leia a pasta diretamente ou use o servidor MCP opcional, local e somente leitura.',
      sources_title: 'O que uma imagem estática coleta, com alternativas honestas',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Integrado. Captura nomes acessíveis, tipos semânticos, AutomationId e limites observados quando o aplicativo os expõe.',
      source_dom_title: 'Prévia do Chrome DOM',
      source_dom_body: 'Extensão opcional. Registra seletor, papel, texto e URL do elemento escolhido explicitamente; não transmite o DOM continuamente.',
      source_hwnd_title: 'Alternativa da janela HWND',
      source_hwnd_body: 'Sem controle filho, o CapturePack registra a janela real e sua geometria observada em vez de inventar um objeto.',
      still_kicker: 'UMA IMAGEM, O MESMO EDITOR DE CONTEXTO',
      still_title: 'Precisa só de uma imagem? Pressione Ctrl+Alt+S.',
      still_body: 'A seleção de região é o padrão. O botão Capturar tela inteira reúne todos os monitores em uma única imagem da área de trabalho virtual. Imagens que cabem no editor abrem em 100% nativo; imagens maiores são ajustadas para aparecer por inteiro. Nenhum vídeo é salvo. Um pack de região mantém apenas os pixels escolhidos e a posição do recorte, nunca uma imagem oculta da tela inteira ou de outro monitor.',
      out_title: 'O pack corresponde ao que foi capturado',
      out_video_title: 'Pack de vídeo',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              original (ou replay.webm)\n├─ replay_annotated.webm   opcional; só se declarado no manifesto\n├─ snapshot.png\n├─ annotations.json        as caixas que você desenhou, com duração\n├─ timeline.json           eventos do relógio do replay\n├─ plugins/                contexto UIA / Chrome DOM opcional\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Pack de imagem',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            região explícita ou área de trabalho virtual\n├─ annotations.json        anotações da imagem\n├─ plugins/                contexto de objeto opcional\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           sem replay nem linha do tempo',
      out_note: 'Uma pasta local: evidência visual e contexto de objetos legível por máquina.<br>Crie o ZIP somente ao compartilhar.',
      privacy_kicker: 'LOCAL NÃO SIGNIFICA CENSURADO',
      privacy_title: 'Revise o original antes de compartilhar.',
      privacy_body: 'O CapturePack não envia capturas, telemetria nem relatórios de falha; a verificação opcional de atualizações no GitHub pode ser desativada e o MCP interrompido nas Configurações. O desfoque não é destrutivo: protege as vistas anotadas, mas snapshot.png e o replay original do pack completo continuam sem censura.',
      ft_releases: 'Versões', ft_sponsor: 'Apoiar',
      ft_license: 'Licença MIT · Open Source',
      ft_why: 'Feito porque explicar bugs para a IA<br>tomava tempo demais.'
    },
    ru: {
      ft_guide: 'Руководство',
      h1: 'Отмотайте 30 секунд назад.<br>Отметьте, что сломалось.',
      sub: 'При включённой живой записи (по умолчанию) CapturePack замораживает последние 30 секунд, чтобы вернуться к кадру, где интерфейс действительно ошибся, — а на снимке экрана вы выбираете настоящий элемент управления и сохраняете его имя и состояние как структурированные данные для ИИ.',
      btn_download: 'Скачать',
      btn_sponsor: '♥ Поддержать',
    release_note: 'Текущая публичная загрузка — 0.4.1. Сохранённую в пакете веб-страницу наконец можно прочитать: раньше при повторном открытии захвата от неё не оставалось ничего. А то, что предлагает выбор объекта, теперь измеряется, а не угадывается.',
      badge_foss: 'Бесплатно и open source',
      badge_local: 'Локально · без облака',
      badge_mcp: 'Встроенный MCP',
      demo_title: 'От СЕЙЧАС отмотайте 5 секунд влево — и отметьте.',
      demo_alt: 'Анимация редактора CapturePack: ползунок начинает справа на отметке СЕЙЧАС и движется влево к «5 секунд назад», где уже исчезнувший с экрана сбой ещё виден — его можно обвести и пояснить, после чего пакет экспортирует структурированные данные.',
      demo_body: 'Ползунок начинает справа на отметке СЕЙЧАС и движется влево к «5 секунд назад». Когда вы замечаете сбой сохранения, его уже нет на экране; в том прошлом кадре он ещё есть — его можно обвести и пояснить, и пакет передаёт это ИИ вместе с записанной геометрией окон рабочего стола.',
      f1_title: '1 · Вернитесь на последние 30 секунд',
      f1_body: 'При включённой по умолчанию фоновой записи нажмите <em>Ctrl+Alt+C после ошибки</em>. Повтор замрёт, чтобы вы вернулись к кадру с неверным интерфейсом. Если выключить запись, ничего не записывается.',
      f2_title: '2 · Отметьте — или выберите настоящий объект на снимке',
      f2_body: 'В записи вы обводите то, что сломалось, и пишете, что имели в виду; у рамки есть время жизни, поэтому она появляется вместе с моментом, который объясняет. На снимке экрана Object Pick подсвечивает настоящий элемент под указателем, и один щелчок записывает доступное имя, тип элемента и наблюдавшиеся границы; если данных дочернего элемента нет, резервной целью становится окно.',
      f3_title: '3 · Снимок сохраняет то, что было в кадре',
      f3_body: 'Пакет изображения записывает элементы управления, которые были на экране в момент захвата, — а из каждого видимого окна браузера и саму страницу: каждый видимый элемент с его ролью, прямоугольником и текстом. Видеопакет записывает геометрию окон и элементов управления, наблюдавшуюся во времени, а страницы в нём нет. Введённые значения, поля паролей и всё скрытое отклоняются намеренно, и пакет сообщает об этом в собственных данных.',
      f4_title: '4 · Передайте ИИ структурированные доказательства',
      f4_body: 'Рамка несёт собственный прямоугольник и дисплей, на котором лежит; если она создана через Object Pick, она ещё и называет то, на что указывает, — имя, роль и AutomationId или selector цели. Читайте папку напрямую или используйте необязательный локальный MCP-сервер только для чтения.',
      sources_title: 'Что собирает снимок, и честные запасные варианты',
      source_uia_title: 'Windows UI Automation',
      source_uia_body: 'Встроено. Сохраняет доступные имена, семантические типы, AutomationId и наблюдавшиеся границы, когда приложение их предоставляет.',
      source_dom_title: 'Предпросмотр Chrome DOM',
      source_dom_body: 'Необязательное расширение. Записывает селектор, роль, текст и URL явно выбранного элемента и не транслирует DOM постоянно.',
      source_hwnd_title: 'Запасной вариант окна HWND',
      source_hwnd_body: 'Если дочерний элемент недоступен, CapturePack записывает настоящее окно и его наблюдавшуюся геометрию, а не выдумывает объект.',
      still_kicker: 'ОДИН СНИМОК, ТОТ ЖЕ РЕДАКТОР КОНТЕКСТА',
      still_title: 'Нужен только снимок? Нажмите Ctrl+Alt+S.',
      still_body: 'По умолчанию выбирается область. Кнопка полноэкранного снимка объединяет все мониторы в одно изображение виртуального рабочего стола. Изображение, которое помещается в редакторе, открывается в исходном масштабе 100%; более крупное вписывается целиком. Видео не сохраняется. Пакет области хранит только выбранные пиксели и положение кадрирования — без скрытого полного экрана или изображения другого монитора.',
      out_title: 'Пакет соответствует виду захвата',
      out_video_title: 'Видеопакет',
      out_tree: 'CapturePack_2026-07-27_143052/\n├─ replay.mp4              оригинал (или replay.webm)\n├─ replay_annotated.webm   необязательно; только если заявлен\n├─ snapshot.png\n├─ annotations.json        нарисованные рамки и их время жизни\n├─ timeline.json           события часов повтора\n├─ plugins/                UIA / необязательный контекст Chrome DOM\n├─ report.md · README.md · skills/\n└─ manifest.json',
      out_image_title: 'Пакет изображения',
      out_image_tree: 'CapturePack_2026-07-27_143052/\n├─ snapshot.png            выбранная область или виртуальный рабочий стол\n├─ annotations.json        аннотации изображения\n├─ plugins/                необязательный контекст объекта\n├─ report.md · README.md · skills/\n└─ manifest.json           capture_kind: image\n                           без повтора и временной шкалы',
      out_note: 'Одна локальная папка: визуальные доказательства и машиночитаемый контекст объектов.<br>Создавайте ZIP только для отправки.',
      privacy_kicker: 'ЛОКАЛЬНО НЕ ЗНАЧИТ СКРЫТО',
      privacy_title: 'Проверьте оригинал перед отправкой.',
      privacy_body: 'CapturePack не загружает снимки, телеметрию или отчёты о сбоях; необязательную проверку обновлений GitHub можно отключить, а MCP остановить в настройках. Размытие не изменяет оригинал: аннотированные представления защищены, но snapshot.png и исходный повтор в полном пакете остаются без скрытия.',
      ft_releases: 'Релизы', ft_sponsor: 'Поддержать',
      ft_license: 'Лицензия MIT · Open Source',
      ft_why: 'Сделано потому, что объяснять баги ИИ<br>было слишком долго.'
    }
  }

  var SUPPORTED = ['en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru']

  function detect() {
    var saved = null
    try { saved = localStorage.getItem('cp_lang') } catch (e) {}
    if (saved && SUPPORTED.indexOf(saved) >= 0) return saved
    var nav = (navigator.language || 'en').toLowerCase().slice(0, 2)
    return SUPPORTED.indexOf(nav) >= 0 ? nav : 'en'
  }

  /**
   * Make the mp4 an actual fallback for a webm the browser accepted and then
   * could not play. See the note at the call site for why <source> alone does
   * not do this.
   *
   * `src` on the VIDEO wins over its <source> children, so setting it is what
   * takes the decision back. The flag is per element and survives a language
   * change: a machine that cannot decode one VP9 file cannot decode the next
   * one either, so re-arming would only cost the visitor the same failure again.
   */
  function bindMotionFallback(video, base) {
    video.setAttribute('data-motion-base', base)
    if (video.getAttribute('data-motion-bound') === '1') return
    video.setAttribute('data-motion-bound', '1')
    video.addEventListener('error', function () {
      if (video.getAttribute('data-motion-fellback') === '1') return
      video.setAttribute('data-motion-fellback', '1')
      var mp4 = video.getAttribute('data-motion-base') + '.mp4'
      if (video.currentSrc && video.currentSrc.indexOf('.mp4') >= 0) return
      video.src = mp4
      if (typeof video.load === 'function') video.load()
      if (typeof video.play === 'function') {
        var again = video.play()
        if (again && typeof again.catch === 'function') again.catch(function () {})
      }
    })
  }

  function apply(lang) {
    var dict = DICT[lang] || DICT.en
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n')
      if (dict[key]) nodes[i].innerHTML = dict[key]
    }
    var altNodes = document.querySelectorAll('[data-i18n-alt]')
    for (var j = 0; j < altNodes.length; j++) {
      var altKey = altNodes[j].getAttribute('data-i18n-alt')
      if (dict[altKey]) altNodes[j].setAttribute('alt', dict[altKey])
    }
    var videos = document.querySelectorAll('video[data-motion]')
    for (var k = 0; k < videos.length; k++) {
      var motion = videos[k].getAttribute('data-motion')
      if (!motion) continue
      var base = 'assets/motion/' + lang + '/' + motion
      videos[k].setAttribute('poster', base + '-poster.webp')
      var sources = videos[k].querySelectorAll('[data-motion-source]')
      for (var s = 0; s < sources.length; s++) {
        var format = sources[s].getAttribute('data-motion-source')
        if (format === 'webm' || format === 'mp4') {
          sources[s].setAttribute('src', base + '.' + format)
        }
      }
      // A <source> LIST IS NOT A FALLBACK, WHICH IS THE WHOLE PROBLEM.
      //
      // The browser picks one source from its `type` attribute and then commits
      // to it. If that file turns out not to DECODE here — a machine without VP9,
      // a driver that refuses it, hardware acceleration in a bad mood — the
      // element goes to MEDIA_ERR_DECODE or MEDIA_ERR_SRC_NOT_SUPPORTED and
      // stops. It does not try the next <source>. So the mp4 sitting right beside
      // the webm, which every one of those machines can play, was never reached
      // and the visitor saw an empty box with a play button that did nothing.
      //
      // Reported as "영상이 안나오는데" — autoplay dead AND manual play dead,
      // reproduced in a private window, while the files themselves decode
      // perfectly and serve 200. That combination is what a committed-and-failed
      // source looks like from outside.
      //
      // So the fallback is made real: on the element's own error, drop to the
      // mp4 directly. Once, because a second failure is not this problem and a
      // retry loop would hide it. If the mp4 fails too, the error stands and the
      // poster remains — which is at least a picture of what the film shows.
      bindMotionFallback(videos[k], base)
      if (typeof videos[k].load === 'function') videos[k].load()
      var reduce = typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduce) {
        videos[k].removeAttribute('autoplay')
        if (typeof videos[k].pause === 'function') videos[k].pause()
      } else if (typeof videos[k].play === 'function') {
        var started = videos[k].play()
        if (started && typeof started.catch === 'function') started.catch(function () {})
      }
    }
    document.documentElement.lang = lang
    try { localStorage.setItem('cp_lang', lang) } catch (e) {}
  }

  var sel = document.getElementById('langSel')
  var lang = detect()
  sel.value = lang
  apply(lang)
  sel.addEventListener('change', function () { apply(sel.value) })
})()
