// CapturePack landing i18n — 9 languages, client-side.
// Default: browser language; persisted in localStorage under "cp_lang".
;(function () {
  var DICT = {
    en: {
      h1: 'Capture context,<br>not screenshots.',
      sub: 'The fastest way to explain something to humans and AI.',
      btn_download: 'Download',
      btn_sponsor: '♥ Sponsor',
      badge_foss: 'Free & open source',
      badge_local: 'Local-first · no cloud',
      badge_mcp: 'MCP built-in',
      f1_title: '🕰 It’s a time machine',
      f1_body: 'CapturePack was already recording. Press the hotkey <em>after</em> the bug happens, then scroll the wheel to travel back through the last 30 seconds to the exact frame where it broke.',
      f2_title: '🤖 Built for LLMs',
      f2_body: 'Drop a pack into ChatGPT, Claude, Cursor, or Gemini — it explains itself. Or connect over MCP and just say <em>“Analyze the latest CapturePack.”</em>',
      out_note: 'One folder. Enough context for any developer — or any LLM.<br>Zip it only when you share.',
      rm_title: 'Roadmap', rm_now: 'Now', rm_next: 'Next', rm_later: 'Later', rm_full: 'Full roadmap →',
      now1: '30-second replay capture', now2: 'Scrub-timeline annotation editor', now3: 'Folder packs + annotated replay', now4: 'Auto-update + built-in MCP server',
      next1: 'History — browse & re-edit packs', next2: 'Chrome DOM capture extension', next3: 'Semantic object picking (UIA)', next4: 'Plugin manager',
      later1: 'Unity · Unreal · VS Code · Git plugins', later2: 'Frame-accurate element tracking', later3: 'Prompt builder', later4: 'Sanitized sharing',
      ft_roadmap: 'Roadmap', ft_releases: 'Releases', ft_sponsor: 'Sponsor',
      ft_license: 'MIT License · Open Source',
      ft_why: 'Made because explaining bugs to AI<br>was taking too much time.'
    },
    ko: {
      h1: '스크린샷이 아니라,<br>맥락을 캡처하세요.',
      sub: '사람과 AI에게 무언가를 설명하는 가장 빠른 방법.',
      btn_download: '다운로드',
      btn_sponsor: '♥ 후원',
      badge_foss: '무료 · 오픈소스',
      badge_local: '로컬 우선 · 클라우드 없음',
      badge_mcp: 'MCP 내장',
      f1_title: '🕰 타임머신입니다',
      f1_body: 'CapturePack은 이미 녹화 중이었습니다. 버그가 난 <em>뒤에</em> 단축키를 누르고, 휠을 굴려 마지막 30초를 거슬러 정확히 고장난 프레임으로 이동하세요.',
      f2_title: '🤖 LLM을 위해 태어났습니다',
      f2_body: '팩을 ChatGPT, Claude, Cursor, Gemini에 넣으면 스스로 설명합니다. 아니면 MCP로 연결하고 <em>“방금 캡처한 것 분석해줘”</em>라고만 하세요.',
      out_note: '폴더 하나면 충분합니다 — 어떤 개발자에게도, 어떤 LLM에게도.<br>공유할 때만 ZIP으로.',
      rm_title: '로드맵', rm_now: '지금', rm_next: '다음', rm_later: '이후', rm_full: '전체 로드맵 →',
      now1: '30초 리플레이 캡처', now2: '스크럽 타임라인 에디터', now3: '폴더 팩 + 어노테이션 영상', now4: '자동 업데이트 + MCP 서버 내장',
      next1: 'History — 팩 탐색 · 재편집', next2: 'Chrome DOM 캡처 확장', next3: '의미 객체 선택 (UIA)', next4: '플러그인 매니저',
      later1: 'Unity · Unreal · VS Code · Git 플러그인', later2: '프레임 단위 요소 추적', later3: '프롬프트 빌더', later4: '민감정보 제거 공유',
      ft_roadmap: '로드맵', ft_releases: '릴리스', ft_sponsor: '후원',
      ft_license: 'MIT 라이선스 · 오픈소스',
      ft_why: 'AI에게 버그를 설명하는 데<br>시간이 너무 걸려서 만들었습니다.'
    },
    ja: {
      h1: 'スクリーンショットではなく、<br>コンテキストをキャプチャ。',
      sub: '人にもAIにも、何かを説明する最速の方法。',
      btn_download: 'ダウンロード',
      btn_sponsor: '♥ スポンサー',
      badge_foss: '無料 · オープンソース',
      badge_local: 'ローカルファースト · クラウドなし',
      badge_mcp: 'MCP内蔵',
      f1_title: '🕰 タイムマシンです',
      f1_body: 'CapturePackはすでに録画していました。バグが起きた<em>後</em>にホットキーを押し、ホイールで直近30秒を遡って、壊れた瞬間のフレームへ。',
      f2_title: '🤖 LLMのために',
      f2_body: 'パックをChatGPT、Claude、Cursor、Geminiに渡せば、自ら説明します。あるいはMCPで接続して<em>「最新のCapturePackを分析して」</em>と言うだけ。',
      out_note: 'フォルダひとつで十分 — どんな開発者にも、どんなLLMにも。<br>共有するときだけZIPに。',
      rm_title: 'ロードマップ', rm_now: '今', rm_next: '次', rm_later: '将来', rm_full: '全ロードマップ →',
      now1: '30秒リプレイキャプチャ', now2: 'スクラブタイムラインエディタ', now3: 'フォルダパック + 注釈付き動画', now4: '自動更新 + MCPサーバー内蔵',
      next1: 'History — パックの閲覧と再編集', next2: 'Chrome DOMキャプチャ拡張', next3: 'セマンティックオブジェクト選択 (UIA)', next4: 'プラグインマネージャー',
      later1: 'Unity · Unreal · VS Code · Gitプラグイン', later2: 'フレーム精度の要素トラッキング', later3: 'プロンプトビルダー', later4: 'サニタイズ共有',
      ft_roadmap: 'ロードマップ', ft_releases: 'リリース', ft_sponsor: 'スポンサー',
      ft_license: 'MITライセンス · オープンソース',
      ft_why: 'AIにバグを説明する時間が<br>長すぎたので作りました。'
    },
    zh: {
      h1: '捕捉上下文，<br>而不是截图。',
      sub: '向人类和 AI 解释问题的最快方式。',
      btn_download: '下载',
      btn_sponsor: '♥ 赞助',
      badge_foss: '免费开源',
      badge_local: '本地优先 · 无云端',
      badge_mcp: '内置 MCP',
      f1_title: '🕰 这是一台时光机',
      f1_body: 'CapturePack 一直在录制。bug 发生<em>之后</em>再按快捷键，滚动滚轮回到过去 30 秒中出错的那一帧。',
      f2_title: '🤖 为 LLM 而生',
      f2_body: '把包扔给 ChatGPT、Claude、Cursor 或 Gemini，它会自我解释。或者通过 MCP 连接，只需说<em>“分析最新的 CapturePack”</em>。',
      out_note: '一个文件夹就够了 — 对任何开发者、任何 LLM。<br>分享时才打包 ZIP。',
      rm_title: '路线图', rm_now: '现在', rm_next: '下一步', rm_later: '以后', rm_full: '完整路线图 →',
      now1: '30 秒回放捕捉', now2: '时间轴拖动标注编辑器', now3: '文件夹包 + 标注视频', now4: '自动更新 + 内置 MCP 服务器',
      next1: 'History — 浏览与重新编辑', next2: 'Chrome DOM 捕捉扩展', next3: '语义对象选择 (UIA)', next4: '插件管理器',
      later1: 'Unity · Unreal · VS Code · Git 插件', later2: '逐帧元素追踪', later3: '提示词生成器', later4: '脱敏分享',
      ft_roadmap: '路线图', ft_releases: '发布', ft_sponsor: '赞助',
      ft_license: 'MIT 许可 · 开源',
      ft_why: '因为向 AI 解释 bug 太费时间，<br>所以做了它。'
    },
    es: {
      h1: 'Captura contexto,<br>no capturas de pantalla.',
      sub: 'La forma más rápida de explicar algo a humanos y a la IA.',
      btn_download: 'Descargar',
      btn_sponsor: '♥ Patrocinar',
      badge_foss: 'Gratis y open source',
      badge_local: 'Local primero · sin nube',
      badge_mcp: 'MCP integrado',
      f1_title: '🕰 Es una máquina del tiempo',
      f1_body: 'CapturePack ya estaba grabando. Pulsa el atajo <em>después</em> del bug y desplázate con la rueda por los últimos 30 segundos hasta el fotograma exacto.',
      f2_title: '🤖 Hecho para LLMs',
      f2_body: 'Suelta un pack en ChatGPT, Claude, Cursor o Gemini: se explica solo. O conéctate por MCP y di <em>«Analiza el último CapturePack»</em>.',
      out_note: 'Una carpeta. Contexto suficiente para cualquier desarrollador — o cualquier LLM.<br>Comprime solo al compartir.',
      rm_title: 'Hoja de ruta', rm_now: 'Ahora', rm_next: 'Siguiente', rm_later: 'Después', rm_full: 'Hoja de ruta completa →',
      now1: 'Captura de replay de 30 s', now2: 'Editor con línea de tiempo', now3: 'Packs en carpeta + vídeo anotado', now4: 'Auto-actualización + servidor MCP',
      next1: 'History — explorar y reeditar packs', next2: 'Extensión Chrome DOM', next3: 'Selección semántica de objetos (UIA)', next4: 'Gestor de plugins',
      later1: 'Plugins Unity · Unreal · VS Code · Git', later2: 'Seguimiento de elementos por fotograma', later3: 'Generador de prompts', later4: 'Compartir saneado',
      ft_roadmap: 'Hoja de ruta', ft_releases: 'Versiones', ft_sponsor: 'Patrocinar',
      ft_license: 'Licencia MIT · Open Source',
      ft_why: 'Creado porque explicar bugs a la IA<br>llevaba demasiado tiempo.'
    },
    fr: {
      h1: 'Capturez le contexte,<br>pas des captures d’écran.',
      sub: 'Le moyen le plus rapide d’expliquer quelque chose aux humains et à l’IA.',
      btn_download: 'Télécharger',
      btn_sponsor: '♥ Sponsoriser',
      badge_foss: 'Gratuit & open source',
      badge_local: 'Local d’abord · sans cloud',
      badge_mcp: 'MCP intégré',
      f1_title: '🕰 Une machine à remonter le temps',
      f1_body: 'CapturePack enregistrait déjà. Appuyez sur le raccourci <em>après</em> le bug, puis remontez les 30 dernières secondes à la molette jusqu’à l’image exacte.',
      f2_title: '🤖 Conçu pour les LLM',
      f2_body: 'Déposez un pack dans ChatGPT, Claude, Cursor ou Gemini : il s’explique tout seul. Ou connectez-vous en MCP et dites <em>« Analyse le dernier CapturePack »</em>.',
      out_note: 'Un dossier. Assez de contexte pour tout développeur — ou tout LLM.<br>Zippez seulement pour partager.',
      rm_title: 'Feuille de route', rm_now: 'Maintenant', rm_next: 'Ensuite', rm_later: 'Plus tard', rm_full: 'Feuille de route complète →',
      now1: 'Capture replay de 30 s', now2: 'Éditeur à timeline', now3: 'Packs dossier + vidéo annotée', now4: 'Mise à jour auto + serveur MCP',
      next1: 'History — parcourir et rééditer', next2: 'Extension Chrome DOM', next3: 'Sélection sémantique d’objets (UIA)', next4: 'Gestionnaire de plugins',
      later1: 'Plugins Unity · Unreal · VS Code · Git', later2: 'Suivi d’éléments image par image', later3: 'Générateur de prompts', later4: 'Partage assaini',
      ft_roadmap: 'Feuille de route', ft_releases: 'Versions', ft_sponsor: 'Sponsoriser',
      ft_license: 'Licence MIT · Open Source',
      ft_why: 'Créé parce qu’expliquer des bugs à l’IA<br>prenait trop de temps.'
    },
    de: {
      h1: 'Erfasse Kontext,<br>keine Screenshots.',
      sub: 'Der schnellste Weg, Menschen und KI etwas zu erklären.',
      btn_download: 'Herunterladen',
      btn_sponsor: '♥ Sponsern',
      badge_foss: 'Kostenlos & Open Source',
      badge_local: 'Local-first · keine Cloud',
      badge_mcp: 'MCP integriert',
      f1_title: '🕰 Eine Zeitmaschine',
      f1_body: 'CapturePack hat schon aufgenommen. Drücke den Hotkey <em>nach</em> dem Bug und scrolle mit dem Mausrad durch die letzten 30 Sekunden bis zum exakten Frame.',
      f2_title: '🤖 Für LLMs gebaut',
      f2_body: 'Wirf ein Pack in ChatGPT, Claude, Cursor oder Gemini — es erklärt sich selbst. Oder verbinde dich per MCP und sag <em>„Analysiere das neueste CapturePack“</em>.',
      out_note: 'Ein Ordner. Genug Kontext für jeden Entwickler — und jedes LLM.<br>Zippen nur zum Teilen.',
      rm_title: 'Roadmap', rm_now: 'Jetzt', rm_next: 'Als Nächstes', rm_later: 'Später', rm_full: 'Komplette Roadmap →',
      now1: '30-Sekunden-Replay-Aufnahme', now2: 'Timeline-Scrub-Editor', now3: 'Ordner-Packs + annotiertes Video', now4: 'Auto-Update + integrierter MCP-Server',
      next1: 'History — Packs durchsuchen & neu bearbeiten', next2: 'Chrome-DOM-Erweiterung', next3: 'Semantische Objektauswahl (UIA)', next4: 'Plugin-Manager',
      later1: 'Unity · Unreal · VS Code · Git-Plugins', later2: 'Frame-genaues Element-Tracking', later3: 'Prompt-Builder', later4: 'Bereinigtes Teilen',
      ft_roadmap: 'Roadmap', ft_releases: 'Releases', ft_sponsor: 'Sponsern',
      ft_license: 'MIT-Lizenz · Open Source',
      ft_why: 'Entstanden, weil es zu lange dauerte,<br>KI Bugs zu erklären.'
    },
    pt: {
      h1: 'Capture contexto,<br>não capturas de tela.',
      sub: 'O jeito mais rápido de explicar algo para humanos e para a IA.',
      btn_download: 'Baixar',
      btn_sponsor: '♥ Apoiar',
      badge_foss: 'Grátis e open source',
      badge_local: 'Local-first · sem nuvem',
      badge_mcp: 'MCP embutido',
      f1_title: '🕰 É uma máquina do tempo',
      f1_body: 'O CapturePack já estava gravando. Aperte o atalho <em>depois</em> do bug e role a roda do mouse pelos últimos 30 segundos até o quadro exato.',
      f2_title: '🤖 Feito para LLMs',
      f2_body: 'Solte um pack no ChatGPT, Claude, Cursor ou Gemini: ele se explica sozinho. Ou conecte via MCP e diga <em>“Analise o CapturePack mais recente”</em>.',
      out_note: 'Uma pasta. Contexto suficiente para qualquer dev — ou qualquer LLM.<br>Zipe só na hora de compartilhar.',
      rm_title: 'Roteiro', rm_now: 'Agora', rm_next: 'Próximo', rm_later: 'Depois', rm_full: 'Roteiro completo →',
      now1: 'Captura de replay de 30 s', now2: 'Editor com linha do tempo', now3: 'Packs em pasta + vídeo anotado', now4: 'Auto-update + servidor MCP',
      next1: 'History — navegar e reeditar packs', next2: 'Extensão Chrome DOM', next3: 'Seleção semântica de objetos (UIA)', next4: 'Gerenciador de plugins',
      later1: 'Plugins Unity · Unreal · VS Code · Git', later2: 'Rastreamento de elementos por quadro', later3: 'Gerador de prompts', later4: 'Compartilhamento sanitizado',
      ft_roadmap: 'Roteiro', ft_releases: 'Versões', ft_sponsor: 'Apoiar',
      ft_license: 'Licença MIT · Open Source',
      ft_why: 'Feito porque explicar bugs para a IA<br>tomava tempo demais.'
    },
    ru: {
      h1: 'Захватывайте контекст,<br>а не скриншоты.',
      sub: 'Самый быстрый способ объяснить что-то людям и ИИ.',
      btn_download: 'Скачать',
      btn_sponsor: '♥ Поддержать',
      badge_foss: 'Бесплатно и open source',
      badge_local: 'Локально · без облака',
      badge_mcp: 'Встроенный MCP',
      f1_title: '🕰 Это машина времени',
      f1_body: 'CapturePack уже вёл запись. Нажмите хоткей <em>после</em> бага и прокрутите колесом последние 30 секунд до нужного кадра.',
      f2_title: '🤖 Создан для LLM',
      f2_body: 'Бросьте пак в ChatGPT, Claude, Cursor или Gemini — он объяснит себя сам. Или подключитесь по MCP и скажите: <em>«Проанализируй последний CapturePack»</em>.',
      out_note: 'Одна папка — достаточно контекста для любого разработчика и любой LLM.<br>ZIP — только для отправки.',
      rm_title: 'Дорожная карта', rm_now: 'Сейчас', rm_next: 'Дальше', rm_later: 'Позже', rm_full: 'Полная карта →',
      now1: 'Захват реплея 30 секунд', now2: 'Редактор с таймлайном', now3: 'Папки-паки + видео с аннотациями', now4: 'Автообновление + MCP-сервер',
      next1: 'History — просмотр и редактирование', next2: 'Расширение Chrome DOM', next3: 'Семантический выбор объектов (UIA)', next4: 'Менеджер плагинов',
      later1: 'Плагины Unity · Unreal · VS Code · Git', later2: 'Покадровый трекинг элементов', later3: 'Генератор промптов', later4: 'Очищенный шеринг',
      ft_roadmap: 'Дорожная карта', ft_releases: 'Релизы', ft_sponsor: 'Поддержать',
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

  function apply(lang) {
    var dict = DICT[lang] || DICT.en
    var nodes = document.querySelectorAll('[data-i18n]')
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-i18n')
      if (dict[key]) nodes[i].innerHTML = dict[key]
    }
    document.documentElement.lang = lang
    try { localStorage.setItem('cp_lang', lang) } catch (e) {}
  }

  var sel = document.getElementById('langSel')
  var lang = detect()
  sel.value = lang
  if (lang !== 'en') apply(lang)
  sel.addEventListener('change', function () { apply(sel.value) })
})()
