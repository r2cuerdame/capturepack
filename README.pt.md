# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Volte ao erro. Selecione o objeto. Entregue o estado à IA.

**O CapturePack transforma um replay contínuo — 30 segundos por padrão — em evidência estruturada para pessoas e IA.**

Pressione o atalho depois do erro, volte ao quadro em que ocorreu e selecione o controle ou
a janela capturados. O CapturePack preserva identidade, posição e movimento observados para
que a IA não precise inferir tudo apenas dos pixels.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Baixar](https://github.com/r2cuerdame/capturepack/releases/latest)

Versão pública atual para Windows: **CapturePack 0.3.1**

<p align="center">
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=4" alt="O CapturePack volta a um quadro passado, seleciona um controle filho, mostra nome e tipo capturados, acompanha o movimento observado da janela e exporta evidência estruturada para IA." width="760">
</p>

## Fluxo

1. **Volte** — com a gravação ao vivo ativa por padrão, pressione `Ctrl+Alt+C` depois
   do erro. A duração é configurável de 1–60 segundos. Ao desligar a gravação, nada é
   registrado.
2. **Selecione** — o Object Pick salva limites observados, nome acessível, tipo do controle
   e instante escolhido. Sem controle filho, usa a janela real como alternativa.
3. **Acompanhe** — janela e controle são observados no relógio do replay. Cada amostra
   identifica a tela; packs multimonitor reabertos preservam tempo e coordenadas mesmo
   quando o objeto muda de monitor.
4. **Entregue o contexto** — compartilhe a pasta ou deixe uma IA ler packs já salvos pelo
   servidor MCP opcional, local e somente leitura.

### Fontes de contexto

- **Windows UI Automation (integrado):** nome acessível, tipo semântico, AutomationId,
  identidade do processo/janela e limites observados quando o aplicativo os expõe.
- **Chrome DOM (extensão opcional em prévia):** seletor, papel, texto e URL do elemento
  escolhido explicitamente; não transmite o DOM continuamente.
- **Janela HWND como alternativa:** registra a janela real e sua geometria observada em vez
  de inventar um objeto.

### Precisa só de uma imagem?

`Ctrl+Alt+S` abre a seleção de região e permite arrastar sem interrupção entre monitores.
**Capturar tela inteira** salva explicitamente todos os monitores numa imagem da área de
trabalho virtual. Ela abre no mesmo editor em 100% nativo quando possível. Um pack de imagem
não tem vídeo nem `timeline.json`; uma região guarda apenas seus pixels e posição, nunca uma
tela inteira ou outro monitor ocultos.

## Conteúdo do pack

```text
Pack de vídeo                     Pack de imagem
replay.mp4 ou replay.webm         snapshot.png
replay_annotated.webm (opcional; só se declarado no manifesto)
snapshot.png                      report.md · README.md · skills/
annotations.json · timeline.json  plugins/ (opcional)
plugins/ · manifest.json          manifest.json (capture_kind: image)
                                   sem replay nem linha do tempo
```

Objetos e trajetórias são evidência opcional. Se não foram observados, o pack informa isso e
não inventa contexto.

## MCP

O servidor [MCP](https://modelcontextprotocol.io) opcional e somente leitura fica ativo e
inicia por padrão em `http://127.0.0.1:39393/mcp`. Pode ser parado ou removido da inicialização
automática em Configurações → MCP. Ele lê apenas packs já salvos e não pode iniciar capturas.
Use `capturepack_history`, `capturepack_open` ou `capturepack_latest`.
Detalhes em [docs/MCP.md](docs/MCP.md).

## Configurações e diagnóstico

- Configurações → Captura permite alterar separadamente os atalhos de vídeo
  (`Ctrl+Alt+C`) e imagem (`Ctrl+Alt+S`), a duração e a taxa de 1–30 fps.
- Informações → **Abrir pasta de logs** abre os diagnósticos locais.
  Os logs nunca são enviados automaticamente.

## Privacidade antes de compartilhar

Pixels, títulos de janela, nomes acessíveis e campos DOM podem conter dados sensíveis. O
CapturePack não envia capturas, telemetria nem relatórios de falha. Sua única solicitação
externa é a verificação opcional de atualizações no GitHub, que pode ser desativada.

O desfoque não é destrutivo: protege as vistas anotadas, mas `snapshot.png` e o replay
original do pack completo continuam sem censura. Revise o original e não compartilhe o pack
completo quando houver informações privadas.

## Estado, segurança e licença

0.3.1 é a versão pública atual. O build ainda não é assinado, então o SmartScreen pode alertar; cada
versão inclui `SHA256SUMS.txt`.

Local-first · sem nuvem · sem conta · sem telemetria · [Licença MIT](LICENSE)
