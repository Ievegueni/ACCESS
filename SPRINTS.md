# SPRINTS.md

## Sprint 1 — Serviço Base

**Objetivo:** `AccessibilityService` a correr e a registar eventos.

- [x] Criar projeto Kotlin + Compose, min SDK 26
- [x] `AutomationService : AccessibilityService` + registo no `AndroidManifest.xml`
- [x] `accessibility_service_config.xml` (eventos: `typeWindowStateChanged`, `typeWindowContentChanged`)
- [x] `onAccessibilityEvent()` a fazer log do `packageName` e tipo de evento
- [x] `MainActivity` com botão para abrir Definições > Acessibilidade

**Critério de aceitação:** ativar o serviço manualmente e ver logs ao mudar de app.

---

## Sprint 2 — Localização e Clique em Nós

**Objetivo:** localizar um botão por texto numa app-alvo e clicar nele.

- [x] `NodeFinder.findNodeByText(root, text)` — busca recursiva
- [x] `NodeFinder.findNodeByViewId(root, id)`
- [x] `GestureHelper.clickNode(node)` via `ACTION_CLICK`
- [x] Filtrar eventos por `packageName` da app-alvo (hardcoded nesta fase)
- [x] Testar caso de uso MVP: abrir app-alvo → localizar botão → clicar automaticamente

**Critério de aceitação:** clique automático funciona de forma fiável em pelo menos 1 app real.

---

## Sprint 3 — UI de Configuração

**Objetivo:** definir regras sem alterar código.

- [x] `AutomationRule` (data class: app-alvo, texto do botão, ativo/inativo)
- [x] Ecrã Compose: listar, adicionar, editar, remover regras
- [x] Indicador de estado do serviço (ativo/inativo) na UI
- [x] Ligar `AutomationService` às regras definidas na UI (em vez de hardcoded)

**Critério de aceitação:** criar uma regra na UI e ver a automação a executar sem rebuild.

---

## Sprint 4 — Persistência e Regras Múltiplas

**Objetivo:** regras sobrevivem a reinício da app e suportam vários alvos.

- [x] Persistência local com DataStore (lista de `AutomationRule`)
- [x] Suporte a múltiplas regras simultâneas, por app diferente
- [x] Log de execução (histórico simples: quando/o quê foi automatizado)
- [x] Tratamento de falhas (nó não encontrado, timeout)

**Critério de aceitação:** app reiniciada mantém as regras e continua a automatizar corretamente.

---

## Backlog (pós-MVP)

- Suporte a gestos além de clique (swipe, long-press)
- Extração de texto do ecrã (para ler valores, não só clicar)
- Agendamento de automações (por hora/intervalo)
- Exportar/importar regras (JSON)
