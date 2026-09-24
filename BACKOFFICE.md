# Backoffice — Painel de Transferências

Especificação do servidor que recebe as confirmações enviadas pela app Access.

A app corre sequências USSD no telemóvel e, quando o operador confirma uma
transferência por SMS, extrai os campos e faz `POST` para este serviço. O painel
existe para responder a uma pergunta: **o que foi transferido, quando, e correu bem?**

---

## 1. Contrato da API

### `POST /webhooks/transferencias`

Único endpoint que a app usa. Tem de ser **HTTPS** — a app recusa-se a enviar para
`http://`, porque o payload leva identificadores de transações reais.

**Cabeçalhos**

```
Content-Type: application/json; charset=utf-8
Authorization: Bearer <token>
```

O token é configurado na app (ecrã principal → "Painel (webhook)"). Sem
autenticação, qualquer pessoa que descubra o URL injeta transações falsas no painel.

**O token identifica o cliente.** Cada cliente tem o seu telemóvel e o seu token;
é por ele que o servidor sabe a quem pertence a transferência — não há campo de
cliente no payload, e por isso a app não precisou de mudar. Um token revogado
devolve `401`, que a app trata como definitivo: ver §4 antes de revogar tokens com
transferências em curso.

**Corpo**

```json
{
  "tid": "MP260921.2313.B09562",
  "iban_ultimos5": "10219",
  "valor": "500",
  "estado": "sucesso",
  "momento": 1758496380000,
  "numero": "+244 923 456 789"
}
```

| Campo | Tipo | Notas |
|---|---|---|
| `tid` | string | Identificador do operador. **Único** — é a chave de deduplicação |
| `iban_ultimos5` | string \| null | Últimos 5 dígitos do IBAN de destino. `null` se não vier no SMS |
| `valor` | string \| null | Como aparece no SMS (`"500"`). String, não número — ver §4 |
| `estado` | `"sucesso"` \| `"falha"` | Ver §3 |
| `saldo` | string \| null | O que ficou na carteira **deste SIM**, como vem no SMS. `null` se a mensagem não o trouxer — ver §5.1 |
| `momento` | number | Epoch em milissegundos, **do telemóvel** — ver §4 |
| `numero` | string *(opcional)* | Número do SIM deste telemóvel. Diz de que cliente é a transferência — ver §2.1 |
| `ordem_id` | number *(opcional)* | A ordem que deu origem a isto, quando veio por API — ver §8 |

O `numero` **é omitido**, não enviado vazio, quando não está configurado na app:
assim o servidor distingue "esta app não sabe o seu número" de "sabe e está em
branco". Não é lido do sistema — `TelephonyManager.getLine1Number()` devolve vazio
na maioria dos operadores — é escrito à mão no ecrã "Painel (webhook)".

**Respostas esperadas**

| Código | Significado | O que a app faz |
|---|---|---|
| `2xx` | Aceite | Remove da fila |
| `4xx` | Payload ou token inválidos | **Remove da fila** — ver §4 |
| `5xx` / timeout / sem rede | Falha transitória | Mantém em fila e repete mais tarde |

---

## 2. Deduplicação — obrigatória

**A app reenvia.** Se a resposta se perder depois de o servidor gravar, o mesmo
payload volta na tentativa seguinte. Sem deduplicação, o painel mostra
transferências a dobrar.

Usa o `tid` como chave única:

```sql
CREATE TABLE transferencias (
  tid            TEXT PRIMARY KEY,      -- o TID do operador é global, não por cliente
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  iban_ultimos5  TEXT,
  valor          NUMERIC,
  estado         TEXT NOT NULL CHECK (estado IN ('sucesso','falha')),
  momento        TIMESTAMPTZ NOT NULL,
  recebido_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

E grava com `INSERT ... ON CONFLICT (tid) DO NOTHING`, respondendo `200` mesmo
quando já existia. Repetir tem de ser inofensivo.

## 2.1 De quem é a transferência

O SMS não diz para que cliente foi — traz TID, IBAN truncado e valor, mais nada.
Quem responde é o **`numero`** do payload: o SIM de onde a confirmação saiu,
registado no painel no cliente a quem aquele telemóvel pertence.

Ordem de decisão:

1. `numero` registado num cliente → é desse cliente.
2. Caso contrário → fica com o dono do token, marcado para revisão.

O número ganha ao token porque o mesmo token pode servir vários telemóveis. Antes
de comparar, reduz-se aos **últimos 9 dígitos**, para `+244 923 456 789` e
`923456789` serem o mesmo SIM. Um número só pode pertencer a um cliente — se
pertencesse a dois, a atribuição errava em silêncio.

O caso 2 nunca perde nada, mas precisa de decisão humana: o painel lista essas
transferências em "Por atribuir" com o número de origem à vista.

---

## 3. O significado de `estado`

Não é o que parece, e isto importa para não fazeres afirmações erradas no painel.

A app classifica como `sucesso` se o SMS contiver a palavra "sucesso", e como
`falha` caso contrário. **O texto de uma transferência falhada ainda não é
conhecido** — nunca foi observado um SMS de falha real. Portanto:

- `sucesso` é fiável: veio daquela palavra na mensagem do operador.
- `falha` significa **"trazia TID mas não dizia sucesso"**. Pode ser uma falha a
  sério ou uma variante de texto que ninguém previu.

No painel, trata `falha` como *"a rever"* e não como *"não foi transferido"*. Quando
aparecer o primeiro SMS de falha real, ajusta-se o parser na app e aí sim o estado
passa a ser afirmativo.

---

## 4. Particularidades que vão morder

**`momento` vem do telemóvel.** É o relógio do dispositivo quando o SMS foi lido,
não a hora do operador nem a do servidor. Se o telemóvel estiver com a hora errada,
os registos ficam errados. Guarda também o `recebido_em` do servidor: quando os dois
divergirem muito, é sinal de fila atrasada ou relógio desacertado.

**Os registos chegam fora de ordem e com atraso.** A app só esvazia a fila quando
chega um SMS ou quando a app é aberta. Sem rede, uma confirmação pode ficar horas
à espera. Ordena sempre por `momento`, nunca por ordem de chegada.

**`valor` é string.** Vem do SMS como lá está, e o formato angolano usa vírgula
decimal em alguns contextos. Converte no servidor com cuidado e guarda o original —
se um dia vier `1.500,50`, um `parseFloat` ingénuo dá `1.5`.

**`4xx` descarta o payload.** A app trata 4xx como definitivo e remove da fila, para
um item inválido não bloquear todos os que vêm atrás. Consequência: **nunca
devolvas 4xx por um problema temporário teu** (rate limit, manutenção, BD em baixo)
— isso perde registos de forma irrecuperável, porque o SMS não volta a chegar. Para
qualquer coisa transitória, devolve `503`.

**A fila pára no primeiro erro.** Os envios são sequenciais e por ordem; se um
falha, os seguintes esperam. Isto mantém a ordem, mas significa que um payload
problemático atrasa tudo o resto até ser aceite ou descartado com 4xx.

**Limite de 200 na fila.** Acima disso, os mais antigos são descartados no
telemóvel. Só acontece se o servidor estiver em baixo durante muitas transferências.

---

## 5. O painel

O mínimo que responde às perguntas reais:

**Lista de transferências** — ordenada por `momento` descendente, com colunas
`momento`, `valor`, `iban_ultimos5`, `estado`, `tid`. Filtro por estado e por
intervalo de datas.

**Totais do dia/mês** — soma dos valores com `estado = 'sucesso'`, e contagem de
`falha` em destaque, porque é o que precisa de atenção humana.

**Carteiras, uma por telemóvel** — ver §5.1.

**Saúde da ligação** — o mais importante e o mais esquecido: *"há quanto tempo não
chega nada?"*. Se o telemóvel ficar sem rede, for reiniciado, ou a app for morta
pela gestão de bateria da Samsung, o sintoma é silêncio — e silêncio é
indistinguível de "não houve transferências". Mostra `now() - max(recebido_em)` e
alerta acima de um limiar que faça sentido para o teu volume.

---

## 5.1 Carteiras: saldo e saúde por telemóvel

Com vários SIM a trabalhar para o mesmo cliente, duas perguntas deixam de ter
resposta no agregado: **quanto resta em cada um** e **qual deles se calou**. Um
telemóvel sem saldo, ou desligado, fica escondido atrás dos outros.

O painel mostra um cartão por número registado:

| Campo | De onde vem |
|---|---|
| `saldo` | o `saldo` da confirmação **mais recente** daquele SIM |
| `saldo_em` | o `momento` dessa confirmação — é a idade do número |
| `silencio_ms` | `now() - max(recebido_em)` **daquele número**, não do cliente |
| `transferencias` | quantas vieram daquele SIM |

**O saldo é uma fotografia, não um extrato.** É o que o operador disse na última
transferência daquele telemóvel. Um carregamento feito por fora não aparece até à
transferência seguinte, e um telemóvel calado mostra um número velho — por isso o
`saldo_em` vai sempre ao lado, e o painel escreve "de há 2 h". Tratar como
indicação para decidir onde carregar, nunca como saldo contabilístico: a fonte de
verdade continua a ser o operador (§7).

Uma confirmação sem saldo no texto **não apaga** o último conhecido: fica o que se
sabia, com a data que tinha.

Para isto ser exato, as transferências guardam também `numero_norm` — o número
reduzido aos últimos 9 dígitos. Sem essa coluna, o mesmo SIM escrito de duas
maneiras contava como duas carteiras.

## 6. Segurança

**O que a app envia é deliberadamente pouco.** O SMS do operador traz o nome
completo do titular e o IBAN quase inteiro: **isso não sai do telemóvel**. Sai
TID, últimos 5 dígitos, valor, estado e saldo. Mantém assim: o que não está no
servidor não pode ser exposto por ele.

**O saldo é a exceção, e foi uma decisão consciente.** Entrou porque sem ele não
há como saber quanto resta em cada telemóvel sem ir a cada um — é a carteira do
próprio dono do painel, não de terceiros. O preço é real: um servidor comprometido
passa a expor saldos. Se algum dia o painel servir carteiras que não são de quem o
opera, esta decisão tem de ser reavaliada.

**O token é um segredo partilhado, não identidade.** Está guardado em claro nas
preferências da app. Alguém com acesso ao telemóvel desbloqueado consegue lê-lo, por
isso: um token só para esta app, rotacionável, sem permissões além de escrever
transferências.

**Rejeita o que não reconheces.** Valida o formato do `tid` e recusa payloads
malformados — mas com `4xx` apenas quando o problema é mesmo do payload (ver §4).

**Não registes o corpo dos pedidos em texto integral** nos logs de acesso. São dados
financeiros e os logs costumam ter retenção e acessos mais largos do que a base de
dados.

---

## 7. Notas de implementação

Não há nada aqui que exija uma stack específica. Um serviço pequeno chega:
um endpoint, uma tabela, autenticação por token e uma página de listagem.

O que **não** deves fazer é tratar isto como uma fonte de verdade contabilística.
A fonte de verdade é o operador; este painel é uma réplica construída a partir de
SMS, sujeita a mensagens perdidas, telemóveis sem bateria e textos que mudam sem
aviso. Serve para acompanhar e detetar anomalias — não para fechar contas.

---

## 8. Ordens — disparar por API em vez de SMS

O SMS de pedido falha às vezes (é o que o cliente reporta) e não dá resposta: quem
o envia não sabe se chegou. As ordens substituem **só esse gatilho** — a
confirmação continua a vir do SMS do operador, que não está nas nossas mãos.

O telemóvel está atrás de NAT em dados móveis: ninguém lhe liga de fora. Por isso
é ele que pergunta, com long-poll — o servidor segura o pedido até haver ordem.
Sem FCM: traria uma dependência e uma conta Google para ganhar zero latência, e o
FCM descarta mensagens em cenários que aqui não se podem descartar.

```
sistema do cliente ──POST /api/v1/ordens (ak_…)───────> pendente
telemóvel ──GET /api/telemovel/ordens?espera=25 (token app)─> entregue
   … USSD … SMS do operador … POST /webhooks/transferencias {ordem_id} ─> concluida
sistema do cliente ──GET /api/v1/ordens/<ref> ou /api/v1/transferencias
```

### `POST /api/v1/ordens` — pedir

`Authorization: Bearer ak_…` (a mesma chave da API de leitura).

```json
{ "ref": "PED-001", "sequencia": "Transferir",
  "campos": { "valor": "500", "iban": "AO06..." }, "numero": "+244 923 456 789" }
```

| Campo | Notas |
|---|---|
| `ref` | Referência do cliente. `[A-Za-z0-9._-]{1,64}`. **É a idempotência** |
| `sequencia` | Nome da sequência tal como está configurada na app do telemóvel. O administrador publica-o em ⋯ → **Formato do pedido por API**, validado pelo mesmo validador deste endpoint |
| `campos` | Entram nos passos como `{valor}`, `{iban}`. Chaves em minúsculas, máx. 10. `valor` em kwanzas inteiros: `"200.00"` é guardado como `"200"`, cêntimos e `"1.500"` dão `400` — ver abaixo |
| `numero` | *Opcional.* Por que telemóvel tem de sair. Sem ele, qualquer um do cliente |
| `notify_url` | *Opcional.* `https://` do cliente, avisado quando a ordem fecha — ver abaixo |

`201` quando é nova, **`200` quando a `ref` já existia** — devolve a que lá está,
sem criar outra. Repetir o pedido é seguro e é o que se deve fazer quando a
resposta se perde. Corpo de ambas: `{ref, id, sequencia, campos, estado, tid,
criado_em, entregue_em, motivo}`.

**Porque se normaliza o `valor`:** vai tal e qual para a caixa USSD. Em
2026-09-24 as ordens com `"1.00"` e `"200.00"` expiraram todas sem TID, enquanto a
de `"500"` e as disparadas por SMS (valor inteiro) fecharam. Zeros decimais caem;
cêntimos a sério são recusados com erro, em vez de falharem em silêncio no
telemóvel; `"1.500"` também, porque em Angola o ponto é milhares e adivinhar é
transferir outro valor.

`400` só por payload inválido; `503` por problema nosso. Os campos são validados
com mão pesada — vão ser escritos numa caixa USSD e mostrados no painel.

### `GET /api/v1/ordens/<ref>` — estado

O mesmo corpo. O cliente só vê três estados, e só dois são fim:

| `estado` público | Estados internos | Significa |
|---|---|---|
| `em_curso` | `pendente`, `entregue`, `a_verificar` | ainda pode mudar; não há callback |
| `sucesso` | `concluida` | a transferência foi feita |
| `falha` | `falhada`, `expirada` | **certeza** de que nada saiu; o cliente pode repetir com `ref` nova |

Pedido do cliente em 2026-09-24: um callback com resultado incerto
(`expirada` + `sem_confirmacao`) não lhe serve, porque não sabe o que fazer com
ele. Por isso os fins incertos já não são fins: ficam `a_verificar`, o cliente
continua a ver `em_curso`, e o callback só sai quando houver certeza (ver
"Ordens a verificar" abaixo). A forma pública é feita em `estadoPublico()`; o
painel e a BD continuam com os estados internos.

`motivo` é só informativo e só sai nos fins (em `em_curso` é sempre `null`):

| `motivo` | Estado interno | Público | Significa |
|---|---|---|---|
| `nao_recolhida` | `expirada` | `falha` | 10 min `pendente`: nenhum telemóvel a foi buscar |
| `operador_indisponivel` | `falhada` | `falha` | caixa de erro do operador antes de o valor ser escrito, 3 repetições sem êxito |
| `sem_confirmacao` | `a_verificar` | `em_curso` | 10 min `entregue` sem SMS do operador: pode ter corrido |
| `falha_operador` | `a_verificar` | `em_curso` | SMS com TID mas sem "sucesso" (§3): pode ser texto que o parser não conhece |
| `verificacao_manual` | `concluida` ou `falhada` | `sucesso` ou `falha` | o administrador viu o extrato e decidiu |

A pendente expira porque, antes, esperava para sempre: em 2026-09-24 um telemóvel
sem ligação durante a noite foi buscar uma ordem **14 h** depois de criada e
executou-a. Um SMS sem "sucesso" já não fecha a ordem como `falhada`: pelo §3
isso não é uma falha certa, e dizer `falha` ao cliente fazia-o repetir.

`GET /api/v1/ordens?desde=<id>` lista, paginado por `id`.

### "Serviço indisponível": o telemóvel repete sozinho

Em 2026-09-24 a `TESTE-20260924-094026` ficou `entregue` porque o operador
respondeu à marcação com "serviço indisponível, tente mais tarde". A caixa só tem
OK, o passo seguinte esperava um campo de texto, e o runner ficou 5 minutos
parado (sem ir buscar outras ordens) até a ordem expirar como `sem_confirmacao`,
que é precisamente o motivo que manda **não** repetir.

Agora o `SequenceRunner` reconhece a caixa pelo texto (`UssdFailure`), carrega em
OK e liberta-se. O que acontece a seguir depende de o valor já ter sido escrito:

- **Antes do passo com `{valor}`** (ou, numa sequência sem `{valor}`, antes do
  primeiro passo): nada pode ter sido submetido. O telemóvel volta a marcar ao fim
  de 30 s, até 3 vezes. Se todas falharem, faz
  `POST /api/telemovel/ordens/<id>/falha {motivo: "operador_indisponivel", numero}`
  e a ordem fecha logo como `falhada`, com callback. O cliente pode repetir.
  Se o aviso chegar depois de a ordem já ter passado a `a_verificar` por falta de
  SMS, ainda fecha: o telemóvel sabe que nada foi submetido, o relógio não.
- **Depois do `{valor}`**: pode ter corrido. Não repete e não avisa; a ordem segue
  o caminho de sempre (confirmação por SMS, ou `a_verificar` aos 10 min).

Porque é o telemóvel a repetir e não o sistema do cliente: é o único que sabe em
que passo apareceu o erro. Do lado de fora só se vê `entregue`, e repetir às
cegas com `ref` nova é arriscar transferir duas vezes.

O endpoint só aceita motivos da lista `MOTIVOS_DO_TELEMOVEL` e só fecha ordens
ainda `entregue`: se a confirmação chegou entretanto, ganha ela.

### `GET /api/telemovel/ordens` — o telemóvel

`Authorization: Bearer <token da app>` — o mesmo do webhook. Parâmetros `numero`
(o SIM deste telemóvel, decide de que cliente são as ordens pela regra do §2.1) e
`espera` (segundos, máx. 25).

Devolve **uma** ordem — `{id, ref, sequencia, campos}` — e marca-a `entregue` no
mesmo instante, ou `204` ao fim da espera. Uma só porque o telemóvel também só
corre uma sequência de cada vez. Cliente desativado dá `503`, não `4xx`: o
telemóvel continua a tentar.

### `notify_url` — o painel avisa o cliente

Pedido do cliente: consultar o estado em ciclo não escala. Quando a ordem chega a
`sucesso` ou `falha` (públicos), o painel faz `POST` ao `notify_url` com o mesmo
corpo do `GET /api/v1/ordens/<ref>`. `a_verificar` não avisa.

- **Assinatura:** `X-Assinatura` = HMAC-SHA256 hex do corpo, com chave
  `sha256hex(ak_…)`. O servidor só guarda o hash da chave, e é exatamente esse o
  segredo — não há segundo segredo a gerir. Trocar a chave troca a assinatura.
- **Pelo menos uma vez:** só `2xx` conta. Falha → repete com espera a dobrar desde
  30 s, 8 tentativas (~2 h), persistido em `notif_proxima`/`notif_tentativas` —
  sobrevive a reinícios. Depois disso desiste; o `GET` continua a funcionar.
  `notificado_em` guarda quando o cliente aceitou: é o que permite ao painel
  distinguir "recebido" de "desistimos" (as duas têm `notif_proxima` null).
- **Só HTTPS, sem seguir redirects:** corta o grosso do SSRF. Não resolve o DNS
  para recusar IPs privados (marcado `ponytail:` no `urlNotificacaoValida`).
- A expiração passou a correr também num `setInterval` de 30 s: sem ninguém a
  consultar, uma ordem num telemóvel morto nunca expirava nem era avisada.

- **Callback de teste:** `POST /api/callback-teste {url, resultado}` (sessão do
  cliente, ou do admin com `cliente`) envia um corpo de mentira com
  `ref: "TESTE-CALLBACK"`, assinado como os reais, e devolve o status HTTP que o
  recetor respondeu. Está na página de programadores, junto ao `notify_url`.

### Ordens a verificar: quem decide é o administrador

Uma ordem fica `a_verificar` quando o telemóvel a levou e não há confirmação
clara: 10 min sem SMS (`sem_confirmacao`) ou SMS sem "sucesso" (`falha_operador`).
Sai de lá de duas maneiras:

- **O SMS chega atrasado.** O webhook fecha `entregue` **e** `a_verificar`: com
  "sucesso" passa a `concluida` e avisa. Um SMS sem "sucesso" deixa-a onde está.
- **O administrador decide** na secção **Ordens a verificar** do `admin.html`
  (`GET`/`POST /api/a-verificar`): vê cliente, `ref`, telemóvel que a levou
  (coluna `ordens.telemovel`, para saber em que carteira ir ao extrato), valor,
  cauda do IBAN e há quanto tempo está parada; carrega em **Correu** (com o TID
  do extrato, opcional) ou **Não correu**. Fica `concluida`/`falhada` com
  `motivo: verificacao_manual`, e o callback sai com o contador a zero.

Só se decide uma vez: a segunda decisão, ou uma decisão sobre uma ordem que o
SMS já fechou, dá `409`. Um SMS que chegue **depois** de uma decisão não a
desfaz; fica na lista de transferências. Se disser o contrário da decisão, o
cliente já recebeu o fim errado: resolve-se fora do sistema. Por isso, "Não
correu" só depois de ver o extrato.

Na faixa de topo do admin, **Ordens a verificar** fica amarela com qualquer
ordem e vermelha com uma parada há mais de 1 h: é um levantamento do cliente
parado à espera de ti.

### No painel

Secção **Ordens por API** (só aparece a quem tem ordens): as últimas 50, com
estado interno (`a_verificar` aparece como "em verificação"), motivo em texto,
TID e se o callback foi recebido. Dos `campos` só se mostram o valor e os 5
últimos do IBAN. Na faixa de topo, **Ordens falhadas (24 h)** conta as
`falhada` + `expirada`.

### Nada volta a `pendente`

**Nenhuma ordem é reenviada automaticamente.** A sequência pode ter corrido até
ao fim e ter-se perdido só o SMS; repetir sozinho seria transferir duas vezes.
Quem repete é o cliente, com uma `ref` nova, depois de receber `falha`.

### O que isto não resolve

- A confirmação continua a depender do SMS do operador. Se os SMS que falham são
  os *dele*, isto não muda nada — vale a pena saber qual dos dois falha.
- Sequência mal configurada no telemóvel: a ordem é aceite e nunca executa. O
  sintoma é uma fila de `a_verificar` sem SMS, mais o "há quanto tempo não chega
  nada" do §5.
- A verificação é manual. Se ninguém olhar para o admin, o cliente espera.

## 9. Estado atual

| Peça | Estado |
|---|---|
| Extração dos campos do SMS | ✅ validada contra a mensagem real do Afrimoney |
| Atribuição por número do telemóvel | ✅ app envia `numero`, painel resolve (§2.1) |
| Fila persistente com limite | ✅ implementada |
| `POST` com token e HTTPS obrigatório | ✅ implementado |
| Servidor + painel | ✅ `server/` — Node sem dependências, ver `server/README.md` |
| Ordens por API (§8) — servidor | ✅ endpoints, idempotência, long-poll, expiração |
| Ordens por API (§8) — app | ✅ `OrderPoller` no serviço; **falta testar no telemóvel** |
| Ordens por API (§8) — página dos programadores | ✅ secção 1, em pt e zh |
| `notify_url` nas ordens (§8) | ✅ callback assinado, com novas tentativas; **falta testar contra o sistema do cliente** |
| Só `sucesso`/`falha` para o cliente (§8) | ✅ `a_verificar` + decisão no admin + callback de teste |
| Carteiras por telemóvel (§5.1) | ✅ saldo e silêncio por número, no painel |
| Saldo depois de um carregamento | ⬜ só atualiza na transferência seguinte — o SMS de carregamento ainda não foi visto |
| Envio ponta-a-ponta contra um servidor | ⬜ testado com `curl`; **falta a app real** contra um URL HTTPS |
| Texto do SMS de transferência falhada | ⬜ desconhecido (ver §3) |
| Reenvio ao voltar a rede | ⬜ só na chegada de SMS ou ao abrir a app |

O último ponto é a limitação conhecida da entrega: está marcado no código com um
comentário `ponytail:` no `WebhookSender`, e resolve-se passando para `WorkManager`
com `NetworkType.CONNECTED` se vier a incomodar.
