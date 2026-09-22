# CLAUDE.md

## Visão Geral

App Android que automatiza interações noutras apps usando `AccessibilityService`: lê o ecrã, localiza elementos (por texto/ID/tipo) e simula toques/gestos para executar ações automaticamente.

**Caso de uso inicial (MVP):** detectar quando uma app-alvo abre, localizar um botão específico pelo texto e clicar nele automaticamente. Base extensível para outras automações (preencher campos, extrair texto do ecrã, sequências de ações).

## Stack Técnico

- **Linguagem:** Kotlin
- **UI:** Jetpack Compose
- **Min SDK:** 26 (Android 8.0) — `AccessibilityService` funcional a partir daqui
- **Target SDK:** mais recente estável
- **Arquitetura:** MVVM simples (ViewModel + State)
- **Sem backend** nesta fase — tudo local no dispositivo

## Estrutura do Projeto

```
app/src/main/
├── java/.../
│   ├── MainActivity.kt              # ecrã de configuração/status
│   ├── ui/
│   │   └── MainScreen.kt            # Compose UI
│   ├── api/
│   │   └── OrderPoller.kt           # long-poll ao painel: trigger por API (BACKOFFICE §8)
│   ├── accessibility/
│   │   ├── AutomationService.kt     # extends AccessibilityService
│   │   ├── NodeFinder.kt            # localizar nós por texto/ID
│   │   ├── GestureHelper.kt         # dispatchGesture (clique, swipe)
│   │   └── SequenceRunner.kt        # estado de uma sequência USSD em curso
│   ├── data/
│   │   └── RulesStore.kt            # SharedPreferences: regras, sequências, histórico
│   └── model/
│       ├── AutomationRule.kt        # regra: app-alvo + ação
│       └── Sequence.kt              # sequência USSD: número + respostas por ordem
├── res/xml/
│   └── accessibility_service_config.xml
└── AndroidManifest.xml
```

## Componentes Core

### 1. `AutomationService : AccessibilityService`
- Escuta `TYPE_WINDOW_STATE_CHANGED` e `TYPE_WINDOW_CONTENT_CHANGED`
- Filtra por `packageName` da app-alvo **em runtime** (as regras são do utilizador, por
  isso `packageNames` não é usado no XML)
- Em cada evento, percorre `rootInActiveWindow` à procura do nó-alvo

### 2. `NodeFinder`
- `findNodeByText(root, text): AccessibilityNodeInfo?`
- `findNodeByViewId(root, id): AccessibilityNodeInfo?`
- `findEditable(root): AccessibilityNodeInfo?` — campo de resposta das caixas USSD
- Busca recursiva na árvore de nós (`getChild(i)`)

### 3. `GestureHelper`
- `clickNode(node)` → usa `performAction(ACTION_CLICK)` quando possível (mais fiável)
- `tapAt(x, y)` → fallback com `dispatchGesture()` quando o nó não suporta `ACTION_CLICK`

### 4. `SequenceRunner`
- Estado (em memória) de uma sequência USSD em execução
- A `MainActivity` marca via `Intent(ACTION_CALL)`; o serviço responde às caixas que aparecem
- Cada passo é o texto a escrever na caixa seguinte; passo vazio = "só confirmar"
- Confirma pelo id `android:id/button1` (estável entre idiomas, ao contrário de "OK"/"Enviar")

### 5. `MainActivity` / `MainScreen`
- Mostra se o serviço de acessibilidade está ativo (`Settings.Secure.ACCESSIBILITY_ENABLED`)
- Botão "Abrir Definições" → `Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)` (ativação é manual, não pode ser feita por código)
- Lista/edita regras de automação simples (app-alvo + texto do botão a clicar)
- Lista/edita sequências USSD (número + respostas por ordem) com botão "Executar"
- Campos de package/passos com `autoCorrectEnabled = false`: o teclado transformava
  `com.android.settings` em `com. Android. settings` e a regra nunca correspondia

## Permissões e Configuração

**AndroidManifest.xml:**
```xml
<service
    android:name=".accessibility.AutomationService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:exported="false">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config" />
</service>
```

⚠️ O `android:name` do meta-data é **`android.accessibilityservice`** (a constante
`AccessibilityService.SERVICE_META_DATA`) — não `android.accessibilityservice.config`,
apesar de o resource se chamar assim. Com o nome errado, `loadXmlMetaData()` devolve
`null` e o Android aborta o parse **em silêncio**: nenhum erro no logcat, o serviço
aparece ativo nas Definições, mas fica com `eventTypes=0` e `capabilities=0` — não
recebe eventos e `rootInActiveWindow` é sempre `null`. Confirmar com
`adb shell dumpsys accessibility | grep "label=Access"`: `capabilities=33` e
`eventTypes=[...]` preenchido significam que o XML foi lido.

**accessibility_service_config.xml:**
- `accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged"`
- `packageNames` — omitido de propósito: as regras são definidas em runtime, por isso
  a filtragem por app-alvo é feita no `AutomationService`
- `accessibilityFlags="flagDefault"`
- `canRetrieveWindowContent="true"` — sem isto `rootInActiveWindow` é `null`
- `canPerformGestures="true"` — necessário para o fallback `tapAt()`

**CALL_PHONE** (`uses-permission`, pedida em runtime): marcar códigos USSD sem
intervenção do utilizador.

## Testar no Dispositivo

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -s AutomationService:D
```

Ativar em **Definições > Acessibilidade > Apps instaladas > Access**. Depois confirmar:

```bash
adb shell dumpsys accessibility | grep "label=Access"   # capabilities=33, eventTypes preenchido
```

Armadilhas já encontradas:
- **`am force-stop` desativa o serviço de acessibilidade** — tem de ser religado à mão
  nas Definições. Reinstalar com `adb install -r` normalmente mantém-no ativo.
- **APK instalado à mão (não por adb):** Android 13+ bloqueia a opção de Acessibilidade.
  Definições > Apps > Access > ⋮ > "Permitir definições restritas".
- O serviço **não faz nada** sem uma regra/sequência definida — não é sintoma de avaria.
- Os dois `return` iniciais do `onAccessibilityEvent` registam o motivo no logcat.
  Não os tornar silenciosos: foram eles que expuseram o bug do meta-data.

## Convenções de Código

- Kotlin idiomático, null-safety rigoroso (nunca `!!` sem justificação)
- Logs via `Log.d("AutomationService", ...)` para debug de eventos
- Sem hardcoding de coordenadas de ecrã — preferir sempre busca por nó (texto/ID) a `tapAt(x, y)` fixo
- Cada regra de automação isolada e testável independentemente

## Regras de Segurança e Limites

- Nunca capturar/enviar dados do ecrã para fora do dispositivo sem consentimento explícito e visível ao utilizador
- **Exceção deliberada:** o webhook de confirmações envia para o endpoint que o
  utilizador configurar (ver `BACKOFFICE.md`). Só saem TID, últimos 5 dígitos do
  IBAN, valor e estado — nunca o nome do titular, o IBAN completo ou o saldo, que
  vêm no mesmo SMS. Só HTTPS. Manter este payload mínimo ao alterar o parser
- Ativação do serviço é sempre manual (Definições > Acessibilidade) — nunca tentar contornar isto
- Não implementar funcionalidades de keylogging ou captura de credenciais
- Google Play tem políticas restritas para apps com `AccessibilityService` — se o destino for a Play Store, justificar o uso claramente na ficha da app (caso contrário, distribuir via APK direto)

## Documentos

| Ficheiro | Para quê |
|---|---|
| `BACKOFFICE.md` | Contrato do webhook e as armadilhas da entrega |
| `server/README.md` | O painel: como correr e como gerir clientes |
| `DEPLOYMENT.md` | Instalar numa VPS, passo a passo |
| `SPRINTS.md` | Plano faseado |

## Fases de Desenvolvimento

Ver `SPRINTS.md` para o plano faseado.

1. ✅ Serviço base + deteção de app-alvo + log de eventos
2. ✅ `NodeFinder` + clique num botão por texto (caso de uso MVP)
3. ✅ UI de configuração (ativar/desativar, definir app-alvo e texto do botão)
4. ✅ Regras múltiplas + persistência local (SharedPreferences, não DataStore —
   ver nota no `RulesStore`: o serviço precisa de leitura síncrona em callbacks)
5. ✅ Sequências USSD (marcar + responder aos menus por ordem)

6. ✅ Trigger por API (long-poll) — servidor e app; ver `BACKOFFICE.md §8`

Por fazer: salvaguarda para quando um menu USSD chega fora de ordem — hoje a
sequência responde à caixa que aparecer. Irrelevante em consultas, importante em
transferências. A parte do "demora demais" já está: `SequenceRunner.running`
passa a false ao fim de 5 minutos, senão uma sequência pendurada engolia os SMS
seguintes e bloqueava as ordens da API para sempre.
