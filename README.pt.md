# capturepack

[English](README.md) · [한국어](README.ko.md) · [日本語](README.ja.md) · [中文](README.zh.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português** · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/r2cuerdame/capturepack?color=7c5cff&label=release)](https://github.com/r2cuerdame/capturepack/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/r2cuerdame/capturepack/total?color=7c5cff)](https://github.com/r2cuerdame/capturepack/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Sponsor](https://img.shields.io/badge/%E2%99%A5_Sponsor-ea4aaa)](https://github.com/sponsors/r2cuerdame)

## Volte ao erro. Marque o instante. Entregue o estado à IA.

**O CapturePack transforma um replay contínuo — 30 segundos por padrão — em
evidência estruturada para pessoas e IA.**

Pressione o atalho depois que algo der errado e volte ao quadro em que o
problema aconteceu. Marque o que quebrou, escreva o que você quis dizer e salve.
O pack leva o replay, a geometria de janelas e controles que a área de trabalho
registrou ao longo do tempo e as suas anotações — em vez de deixar uma IA
deduzir tudo a partir dos pixels.

**O Object Pick é um recurso de imagem estática.** Faça uma captura de tela e
você pode clicar no controle real sob o cursor: o CapturePack registra o nome, o
papel, o AutomationId e o processo desse controle e, num navegador, a página
visível inteira. Um replay não consegue oferecer a mesma coisa com honestidade —
veja [por quê](#por-que-a-seleção-pertence-à-imagem-estática) — então um vídeo
fica com as caixas que você desenha.

O pack salvo corresponde ao que o usuário capturou: um pack de vídeo reúne o
replay, os quadros, as anotações, a geometria de janelas e controles observada
ao longo do tempo e uma linha do tempo de eventos; um pack de imagem contém a
imagem estática explícita, as anotações e o contexto de objetos. Dê dois cliques
em `viewer.html` para inspecionar qualquer um dos dois offline, sem instalar o
CapturePack e sem subir servidor. Ele continua sendo uma pasta local e aberta,
que funciona sem IA, sem conta e sem serviço na nuvem.

🌐 **[capturepack.dev](https://capturepack.dev)** · [Baixar](https://github.com/r2cuerdame/capturepack/releases/latest)

Versão pública atual para Windows: **CapturePack 0.4.6**. Na versão 0.4.4, o
Histórico cria uma **Cópia para compartilhar** (`.share.zip`) cujas únicas mídias
são imagens estáticas PNG anotadas e revisadas; acompanham-nas um README gerado,
um visualizador offline e um inventário mínimo. Ela exclui originais, todos os
vídeos e o contexto estruturado. O ZIP completo (`.zip`) ainda inclui os originais.

<p align="center">
  <a href="https://capturepack.dev/">
    <img src="https://raw.githubusercontent.com/r2cuerdame/capturepack/main/site/assets/motion/pt/capturepack-time-machine-poster.webp" alt="O CapturePack parte de AGORA à direita, move o cursor de reprodução para a esquerda até 5 segundos atrás, marca com uma caixa a falha que já sumiu da tela e exporta evidência estruturada para IA." width="760">
  </a>
</p>

Repare na direção: o cursor de reprodução parte de **AGORA, à direita**, e viaja
**para a esquerda, até 5 segundos atrás**, onde a falha que já sumiu da tela
ainda está lá para ser marcada. Essa mesma evidência é salva como dados
estruturados para IA.

## Fluxo

1. **Volte** — com a gravação ao vivo ligada (o padrão), pressione `Ctrl+Alt+C`
   depois do erro e percorra o replay congelado até o quadro em que a interface
   estava errada. A duração do replay é configurável de 1 a 60 segundos.
2. **Marque** — arraste com o botão direito uma caixa sobre o que quebrou e
   escreva o que você quis dizer. A caixa tem um tempo de vida, então aparece e
   desaparece junto com o instante que ela explica.
3. **Ou capture a imagem estática e selecione o objeto** — pressione o atalho de
   captura de tela e o Object Pick destaca o controle real sob o cursor. Um
   clique registra o nome acessível, o tipo do controle, o AutomationId, o
   processo e os limites observados; a janela continua sendo a alternativa
   quando não há dados do controle. Num navegador, o pack guarda também a
   própria página: cada elemento que estava visível, com papel, retângulo e
   texto. O que você digitou, campos de senha e qualquer coisa oculta são
   recusados de propósito, e o payload lista o que ficou de fora, para que quem
   lê saiba que um formulário aparentemente vazio é uma omissão deliberada.
4. **Entregue o contexto estruturado** — salve a pasta para outra pessoa da
   equipe, jogue no ChatGPT, Claude, Codex, Cursor ou Gemini, ou deixe que uma
   IA conectada a leia pelo servidor MCP integrado e somente leitura.

### Por que a seleção pertence à imagem estática

Não porque um replay não mereça seleção, mas porque só dá para selecionar nele
pela *metade*.

Geometria de janela é barata: o CapturePack a amostra cerca de cem vezes por
segundo, então consegue dizer qual janela estava onde em qualquer quadro.
Percorrer os **controles** de uma janela não é barato — uma única varredura das
janelas do Chromium numa área de trabalho comum custa 326 ms contra 13,9 ms para
todo o resto somado — então o rastreador que roda durante a gravação se limita a
3% de CPU e pula essas janelas. O resultado era um recurso que oferecia o botão
dentro do navegador no instante exato em que você capturou, e apenas a janela do
navegador um segundo para cada lado, sem nada na tela para dizer qual dos dois
você tinha em mãos.

Uma imagem estática não tem essa divisão. É um instante só, a varredura completa
roda nele e todo controle da área de trabalho fica disponível. É para lá que vai
a precisão.

Um vídeo continua *registrando* o que estava ali — a geometria de janelas e
controles ao longo do tempo vai para a linha do tempo de contexto do pack, para
uma IA ler. O que ele não faz mais é convidar você a clicar nesses controles.

### Fontes de contexto

- **Windows UI Automation (integrado):** nome acessível do controle, tipo
  semântico, AutomationId, identidade do processo/janela e limites observados
  quando o aplicativo os expõe.
- **Chrome DOM (extensão opcional em prévia):** seletor, papel, texto e URL do
  elemento que você escolhe explicitamente — clique no ícone do CapturePack na
  barra de ferramentas e depois no elemento. Funciona dentro de iframes, lê a
  página apenas naquela seleção e não transmite o DOM continuamente.
  Configurações › Plugins › Chrome DOM informa o que o seletor fez por último,
  de modo que uma seleção que não chega diz o motivo.
  **Clique uma vez no ícone do CapturePack e autorize o navegador.** Depois
  disso você não pressiona mais nada no Chrome: o seu atalho de captura normal
  já traz a página visível junto. Essa autorização única existe porque o Chrome
  nunca enxerga um atalho global — ele entrega uma página a uma extensão apenas
  quando o clique acontece dentro do Chrome, ou quando o usuário já autorizou a
  extensão. Nada é retido antes da autorização (a instalação não exibe nenhum
  aviso de permissão), e `chrome://extensions` revoga tudo a qualquer momento.
  Um pack gravado sem a autorização simplesmente não leva página nenhuma — e diz
  isso.
- **Janela HWND como alternativa:** quando nenhum controle filho está
  disponível, o CapturePack ainda registra a janela real e sua geometria
  observada, em vez de inventar um controle.

### Precisa só de um quadro?

Pressione `Ctrl+Alt+S` para abrir a captura de região. Arrastar uma região é o
padrão; o botão **Capturar tela inteira**, no topo, captura explicitamente toda
a área de trabalho virtual — todos os monitores numa única imagem. O resultado
abre no mesmo editor de contexto em 100% nativo (ou na escala compatível mais
próxima, no caso de uma área de trabalho excepcionalmente grande) e pode ser
deslocado com o mouse, mas o pack é declarado como imagem e não contém arquivo
de replay. Um pack de região guarda apenas os pixels selecionados mais os
metadados de posição do recorte — ele não mantém uma imagem oculta da tela
inteira nem de um segundo monitor.

## Por quê

- **Capturas de tela preservam pixels.** Você perde o que aconteceu antes do
  quadro.
- **Vídeos preservam movimento.** Você perde a intenção e a estrutura.
- **O CapturePack preserva contexto.** O replay e a geometria de janelas
  registrada ao longo dele, o objeto selecionado numa imagem estática, as
  anotações e o estado que foi realmente capturado.

## Primeiro, volte no tempo

O bug já aconteceu? Se a gravação ao vivo estiver ligada (o padrão), o
CapturePack já tem o replay recente na memória. Pressione `Ctrl+Alt+C` *depois*
que algo der errado e use a roda do mouse para rolar **de volta no tempo** até o
quadro em que quebrou. Com a gravação ao vivo desligada nada é registrado, e o
atalho avisa que a gravação está desligada.

## O que o contexto estruturado diz

Uma anotação feita sobre uma imagem estática pode identificar mais do que um
retângulo. As anotações de um vídeo são as caixas que você desenhou, mais o
instante que cada uma explica:

- **Identidade do alvo:** nome UIA, tipo do controle (o papel semântico do
  controle), AutomationId, identidade do processo ou da janela quando o
  aplicativo os expõe; uma seleção opcional pelo Chrome DOM pode trazer, no
  lugar, seletor, papel, texto e URL.
- **Estado capturado no tempo:** o instante escolhido, a tela em que ele estava
  e os limites observados naquele instante.
- **Evidência visual e narrativa:** mídia original, anotações editáveis, vistas
  e relatórios gerados; um pack de vídeo acrescenta keyframes, uma linha do
  tempo e a geometria de janelas registrada ao longo dela.

Esse contexto pode ser lido diretamente da pasta comum. Uma IA conectada também
pode usar o **servidor MCP somente leitura** do app e começar com: *"Analise o
CapturePack mais recente."*

## 🌍 Idiomas

O CapturePack fala **9 idiomas**: English · 한국어 · 日本語 · 中文 · Español · Français · Deutsch · Português · Русский

- O app segue automaticamente o **idioma do sistema** — dá para mudar quando quiser em Configurações → Geral.
- Os documentos gerados no pack (`viewer.html`, `README.md`, `report.md`, `skills/`) podem seguir a própria configuração de idioma; as suas descrições nunca são traduzidas.
- O [capturepack.dev](https://capturepack.dev) também detecta o idioma do navegador automaticamente.

## Princípios

Local primeiro · Offline primeiro · Formato aberto · Baseado em plugins · Sem nuvem · Sem login · Sem banco de dados · Sem dependência de IA · Sem aprisionamento a fornecedor.

Os CapturePacks gerados devem continuar legíveis para sempre.

## O que existe dentro de um CapturePack

O pack é uma **pasta** comum — navegável, editável, honesta. Um ZIP completo
(`.zip`) é uma cópia opcional de distribuição e ainda contém as evidências
originais. Desde a versão 0.4.4, o Histórico também oferece uma **Cópia para
compartilhar** revisada (`.share.zip`) cujas únicas mídias são imagens estáticas
PNG anotadas e revisadas; acompanham-nas um README gerado, um visualizador offline
e um inventário mínimo fechado.

Packs de vídeo podem conter:

```
CapturePack_2026-07-27_143052/
├── replay.mp4               # evidência original (ou replay.webm como alternativa)
├── replay_annotated.webm    # vista derivada opcional; só quando declarada no manifesto
├── snapshot.png             # o quadro capturado (original)
├── annotations.json         # a fonte real: caixas, tempos de vida, números, desfoque
├── timeline.json            # packs de vídeo: registro de eventos legível por máquina
├── viewer.html              # visualização offline com dois cliques; sem servidor
├── report.md                # a sua descrição, pronta para LLM
├── manifest.json            # versão do formato, inventário
├── README.md                # o primeiro documento que uma pessoa lê
├── skills/                  # contexto estruturado para IA (funciona sem MCP)
└── plugins/                 # metadados do objeto de UI capturado, quando houver
```

Packs de imagem são deliberadamente diferentes:

```
CapturePack_2026-07-27_143052/
├── snapshot.png             # a região explícita ou toda a área de trabalho virtual
├── annotations.json         # anotações da imagem
├── viewer.html              # visualização offline com dois cliques; sem servidor
├── report.md · README.md
├── manifest.json            # capture_kind: image
├── skills/                  # contexto específico de imagem; sem skill de linha do tempo
└── plugins/                 # metadados de objeto opcionais
```

Um pack de imagem registra `capture_kind: "image"` e um escopo de região ou de
tela inteira. Ele não tem replay nem `timeline.json`. Uma imagem de região
também registra de onde veio o recorte, sem armazenar pixels fora dele.
Os metadados de objeto também são evidência opcional: se um aplicativo não expõe
um objeto de UI utilizável, o pack diz isso em vez de fabricar contexto.

A especificação importa mais do que qualquer implementação — qualquer linguagem pode gerar arquivos CapturePack. Veja o [SPEC.md](SPEC.md).

## MCP — converse com as suas capturas

O app inclui um servidor [MCP](https://modelcontextprotocol.io) opcional e
somente leitura, habilitado e iniciado automaticamente por padrão em
`http://127.0.0.1:39393/mcp` (apenas localhost). Em Configurações → MCP dá para
pará-lo na hora ou desativar o início automático. Ele lê apenas CapturePacks que
o usuário já salvou e não pode iniciar uma captura de imagem ou de vídeo.

Uma IA pode chamar `capturepack_history` para navegar/pesquisar registros de
imagem e vídeo e depois `capturepack_open` com o id escolhido;
`capturepack_latest` continua sendo o atalho para o pack mais recente.

```
claude mcp add --transport http capturepack http://127.0.0.1:39393/mcp
```

Ferramentas, configuração de clientes e ajustes: [docs/MCP.md](docs/MCP.md).

## Configurações e diagnóstico

- Configurações → Captura permite alterar separadamente os atalhos de vídeo
  (`Ctrl+Alt+C`) e de imagem (`Ctrl+Alt+S`), a duração do replay e a taxa de
  captura de 5 a 30 fps.
- Sobre / Informações → **Abrir pasta de logs** abre os diagnósticos locais de
  execução, com tamanho limitado. Os logs nunca são enviados automaticamente.

## Estado

**0.4.6 é o download público atual para Windows.** O CapturePack continua sendo
um projeto em estágio inicial, então guarde o pack original ao relatar um
problema e veja o [GOAL.md](GOAL.md) para a visão do produto e o
[ROADMAP.md](ROADMAP.md) para o que vem a seguir.

Limitação conhecida: o alinhamento de PTS entre vídeo e contexto por monitor
ainda está em medição na
[issue #89](https://github.com/r2cuerdame/capturepack/issues/89). O CapturePack
registra evidência de tempo ambígua em vez de escondê-la atrás de um
deslocamento global fixo no código.

## Documentação

- [Índice da documentação](docs/README.md) — o melhor ponto de entrada para
  engenharia, integrações, QA, releases, esquemas e material histórico.
- [Especificação do pack](SPEC.md) e [arquitetura](ARCHITECTURE.md) — o contrato
  do formato aberto e os limites da implementação atual.
- [QA de release](docs/QA.md), [handoff atual](docs/HANDOFF.md) e
  [processo de release](docs/RELEASING.md) — como as mudanças são verificadas,
  repassadas e publicadas.
- [MCP](docs/MCP.md) e [API do provedor temporal](docs/temporal-provider-api.md)
  — acesso somente leitura a packs salvos e integração de provedores de
  contexto.

CapturePack `0.4.6` é a versão do aplicativo. O `format_version` do pack evolui
de forma independente, por mudanças aditivas de formato; leitores devem seguir o
[SPEC.md](SPEC.md) em vez de deduzir o suporte ao formato pela versão do app.

## Segurança e assinatura

Os builds para Windows ainda não são assinados (o SmartScreen vai alertar — *Mais informações → Executar assim mesmo*);
toda versão traz `SHA256SUMS.txt` para verificação, e uma solicitação de assinatura de código
para projetos open source está em andamento. Detalhes, papéis da equipe e práticas de privacidade: [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md).

## Privacidade antes de compartilhar

Pixels da tela, títulos de janela e nomes acessíveis — mais seletor, papel,
texto e URL quando o Chrome DOM é usado — podem ser sensíveis. O CapturePack
mantém as capturas e o contexto de objetos nesta máquina e não envia capturas,
telemetria nem relatórios de falha. Sua única requisição externa é a verificação
opcional de atualizações no GitHub Releases, que pode ser desativada em
Configurações → Geral.

O desfoque não é destrutivo: ele protege as vistas anotadas geradas, mas o
`snapshot.png` e o replay original dentro do pack completo continuam sem
censura. Quando a mídia original ou o contexto estruturado precisar permanecer
privado, use Histórico → **Cópia para compartilhar**, disponível desde a versão
0.4.4, e revise a prévia de cada imagem estática incluída antes de enviar.
A cópia exclui originais, todos os contêineres de vídeo, manifestos, anotações,
linhas do tempo, contexto de plugins e documentos gerados do pack; os PNGs
incluídos são recodificados de forma canônica somente a partir de seus pixels.
Ainda assim, ela não garante que as imagens derivadas revisadas estejam livres
de segredos não marcados.

## ♥ Apoie

O CapturePack é gratuito, open source e livre de nuvem — sem contas, sem telemetria, nada para vender.
Se ele economiza o seu tempo, [**patrocinar no GitHub**](https://github.com/sponsors/r2cuerdame) mantém o projeto andando.

## Licença

[MIT](LICENSE)
