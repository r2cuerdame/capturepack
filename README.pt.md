# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Você consegue explicar um bug em menos de 5 segundos?

**O CapturePack é o jeito mais rápido de explicar algo a um LLM.**

> Capture contexto, não capturas de tela.
>
> Melhor entrada. Melhores respostas.

O CapturePack é um formato aberto de captura de contexto — e o kit de ferramentas que vem junto — para que humanos e IAs entendam problemas visuais muito além de capturas e gravações de tela.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Baixar](https://github.com/r2cuerdame/capturepack/releases/latest)

<p align="center">
  <!-- Absolute raw URL with a version query: GitHub proxies README images through
       camo, which caches by source URL — without the bump a fixed demo keeps
       rendering the stale copy for hours. Bump ?v= whenever demo.svg changes. -->
  <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/demo.svg?v=3" alt="Demo: aperte Ctrl+Alt+C, os últimos 30 segundos congelam, a roda do mouse percorre o tempo, arraste para selecionar o objeto, escreva a anotação e o CapturePack está salvo." width="760">
</p>

Uma **pasta** CapturePack reúne o que uma captura de tela não consegue: os últimos 30 segundos de replay, o quadro capturado, anotações editáveis, uma linha do tempo de eventos legível por máquina e relatórios legíveis por humanos e por IA — tudo o que outro desenvolvedor ou qualquer LLM precisa para entender a situação na hora. Quando for compartilhar, empacote a pasta em um único arquivo `.capturepack`.

## O fluxo de 5 segundos

```
Ctrl+Alt+C  →  capture  →  5-second annotation  →  save  →  drop into
                                                              ChatGPT / Claude / Codex / Cursor / Gemini
                                                              or send to another developer
```

## Por quê

- **Capturas de tela guardam pixels.** Você perde o que aconteceu antes do quadro.
- **Vídeos guardam movimento.** Você perde a intenção e a estrutura.
- **O CapturePack guarda contexto.** Tempo, espaço, intenção, ambiente.

## 🕰 É uma máquina do tempo

O bug já aconteceu? O CapturePack **já estava gravando**. Aperte `Ctrl+Alt+C`
*depois* que algo deu errado — os últimos 30 segundos ficam congelados e a roda do
mouse leva você **de volta no tempo**, até o quadro exato em que quebrou. Anote
aquele momento, não uma reencenação.

## 🤖 Feito para LLMs

Um CapturePack é uma entrada que a IA realmente entende:

- Solte o pack no **ChatGPT, Claude, Codex, Cursor ou Gemini** — o relatório gerado
  e os arquivos de contexto explicam a situação sem nenhum prompt extra.
- Ou nem anexe nada: o app roda um **servidor MCP**, então a IA conectada só precisa
  ouvir *“Analise o CapturePack mais recente.”* e ela lê sozinha.

Melhor entrada. Melhores respostas.

## 🌍 Idiomas

O CapturePack fala **9 idiomas**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- O app segue o **idioma do sistema** automaticamente — troque quando quiser em Configurações → Geral.
- Os documentos gerados dentro do pack (`README.md`, `report.md`, `skills/`) podem ter o próprio idioma; o que você escreve nunca é traduzido.
- O [capturepack.dev](https://capturepack.dev) também detecta o idioma do seu navegador.

## Princípios

Local-first · Offline-first · Formato aberto · Baseado em plugins · Sem nuvem · Sem login · Sem banco de dados · Sem dependência de IA · Sem vendor lock-in.

Os CapturePacks gerados devem continuar legíveis para sempre.

## O que tem dentro de um CapturePack

O pack é uma **pasta** comum — navegável, editável, honesta. O ZIP (`.capturepack`)
só é criado quando você quer compartilhar.

```
CapturePack_2026-07-27_143052/
├── replay.webm              # evidência original — nunca modificada
├── replay_annotated.webm    # com as anotações renderizadas; roda em qualquer player
├── snapshot.png             # o quadro capturado (original)
├── annotations.json         # a fonte da verdade: caixas, durações, números, desfoque
├── timeline.json            # registro de eventos legível por máquina
├── report.md                # sua descrição, pronta para o LLM
├── manifest.json            # versão do formato, inventário
├── README.md                # o primeiro documento que um humano lê
├── skills/                  # contexto estruturado para IA (funciona sem MCP)
└── plugins/                 # metadados estruturados das integrações
```

Um pack só com a captura de tela — `manifest.json` + `snapshot.png`, nada mais — é totalmente válido.

A especificação importa mais do que qualquer implementação — qualquer linguagem pode gerar arquivos CapturePack. Veja [SPEC.md](SPEC.md).

## MCP — converse com suas capturas

O app traz um servidor [MCP](https://modelcontextprotocol.io) sempre ligado e somente leitura em `http://127.0.0.1:39393/mcp` (só localhost), para que qualquer IA encontre e analise o seu pack mais recente sozinha — “Analise o CapturePack mais recente.” é o prompt inteiro.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Ferramentas, configuração dos clientes e ajustes: [docs/MCP.md](docs/MCP.md).

## Status

Em desenvolvimento inicial. Veja [GOAL.md](GOAL.md) para a visão do projeto e [ROADMAP.md](ROADMAP.md) para os próximos passos.

## Segurança e assinatura

As builds para Windows ainda não são assinadas (o SmartScreen vai avisar — *Mais informações → Executar assim mesmo*);
toda versão publicada inclui `SHA256SUMS.txt` para verificação, e um pedido de certificado
de assinatura para projetos OSS está em andamento. Detalhes, papéis da equipe e práticas de privacidade: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## ♥ Apoiar

O CapturePack é gratuito, open source e sem nuvem — sem contas, sem telemetria, nada para vender.
Se ele economiza seu tempo, [**apoiar no GitHub**](https://github.com/sponsors/r2cuerdame) mantém o projeto andando.

## Licença

[MIT](LICENSE)
