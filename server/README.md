# Painel de transferências

Servidor que recebe os webhooks da app Access. Sem dependências — só Node 22+
(`node:http` + `node:sqlite`). Contrato e armadilhas: `../BACKOFFICE.md`.

**Multi-cliente:** cada cliente tem o seu telemóvel com a app, o seu token de
webhook, a sua senha, e vê exclusivamente os seus registos. O administrador vê
todos e gere os acessos.

```bash
ADMIN_PASS=<senha> node server/server.js   # ADMIN_PASS só é lido no 1º arranque
node server/test.js                        # parser, validação, dedupe, isolamento
```

| Variável | Omissão | Nota |
|---|---|---|
| `ADMIN_PASS` | — | Cria o utilizador `admin`. Só usada com a BD vazia |
| `PORT` | `3000` | |
| `DB_PATH` | `server/transferencias.db` | |

## Pôr um cliente a funcionar

1. Entrar como `admin` → **Novo cliente**: nome, senha e **o número do telemóvel**
   que vai fazer as transferências para este cliente.
2. O painel mostra **URL, token e número** para copiar. O token aparece **uma
   única vez** — no servidor só fica o `sha256`.
3. Na app desse telemóvel, ecrã **Painel (webhook)**: colar os três.
4. O cliente entra com o nome e a senha dele e vê só o que é seu.
5. Menu ⋯ → **Formato do pedido por API**: o corpo do `POST` que o sistema dele
   vai copiar, com o nome da sequência que configuraste no telemóvel. Sem isto a
   página de integração só mostra um exemplo genérico, e uma sequência com outro
   nome faz a ordem ser aceite e nunca executada. (Se o cliente disparar por SMS,
   é **Formato do SMS de pedido** em vez deste — basta um dos dois.)

## De quem é cada transferência

O SMS do operador não diz para que cliente foi a transferência — só traz TID,
IBAN truncado e valor. Quem responde a essa pergunta é **o número do telemóvel
de onde a confirmação saiu**, escrito na app e registado aqui no cliente.

A cadeia, por ordem (`atribuir()` em `server.js`):

| # | Regra | `atribuido_por` |
|---|---|---|
| 1 | O número que veio no payload está registado num cliente | `numero` |
| 2 | Não está (ou não veio): fica com o dono do token | `token` |
| 3 | O administrador moveu-a à mão | `manual` |

**O número ganha ao token de propósito.** Um telemóvel pode usar o token de outro
cliente — é o caso de um telemóvel teu a servir vários — e quem está ao pé do SIM
é quem sabe de quem é o dinheiro.

O número é normalizado antes de comparar: ficam os últimos 9 dígitos, por isso
`+244 923 456 789`, `00244923456789` e `923-456-789` são o mesmo SIM. **Um número
só pode estar registado num cliente** — se pudesse estar em dois, deixava de
identificar seja quem for, e a atribuição dava o resultado errado em silêncio.

### Por atribuir

Transferências que vieram de um telemóvel que não está registado em ninguém
aparecem na secção **Por atribuir** do `/admin`. Ficaram com o dono do token para
não se perderem, mas ninguém confirmou que são dele.

Escolher o cliente no `select` resolve. Se aceitares registar o telemóvel ao mesmo
tempo, **as outras transferências que já tinham chegado do mesmo número vão
juntas**, e as seguintes passam a ser atribuídas sozinhas.

A app só envia o número se ele estiver preenchido. Um telemóvel com a app antiga,
ou com o campo em branco, cai sempre na regra 2 — nada se perde, mas aparece
marcado como `por token` na coluna Telemóvel do painel do cliente.

## Gerir os clientes

| Botão | O que faz | Consequência na app |
|---|---|---|
| **Juntar telemóvel** | Regista mais um número neste cliente | nenhuma — passa a reconhecer as que vierem de lá |
| **Tirar &lt;número&gt;** | Deixa de reconhecer aquele SIM | as já atribuídas ficam onde estão |
| **Novo token** | Gera outro token e mata o anterior | ⚠️ o antigo dá `401` (4xx) e a app **descarta a fila** |
| **Senha** | Muda a senha do painel | nenhuma — fecha a sessão aberta do cliente |
| **Renomear** | Muda o nome, que é o utilizador do login | nenhuma — mas o cliente tem de ser avisado |
| **Desativar** | Suspende o acesso | webhook passa a `503`: a app **acumula em fila**, nada se perde |
| **Remover** | Apaga o cliente | recusado se tiver histórico — aí só **Desativar** |

A regra que decide entre **Desativar** e **Novo token** é a do §4 do
BACKOFFICE.md: a app trata 4xx como definitivo e apaga o payload da fila, e o
SMS não volta a chegar. Para suspender alguém temporariamente, usa sempre
**Desativar**.

**Remover recusa clientes com transferências.** São registos financeiros e não
há confirmação que os traga de volta. Quem tem histórico desativa-se; o histórico
fica e deixa de contar para os totais de clientes ativos.

## Ler a lista

- **Sem receber há** — o número que importa. `nunca` num cliente acabado de criar
  é normal; passadas 24 h sem nada (ou desde que foi criado) fica a vermelho e
  entra no cartão **Sem dar sinal**. Silêncio é indistinguível de "não houve
  transferências", por isso é a única forma de ver uma app parada.
- **A rever** — transferências que trouxeram TID mas não diziam "sucesso". Ver §3.
- Clicar no nome abre o painel desse cliente, exatamente como ele o vê.

## Rotas

- `POST /webhooks/transferencias` — `Bearer <token do cliente>`, dedupe por `tid`,
  `503` em falha transitória (nunca `4xx`: a app descarta e o SMS não volta).
- `/` — painel do cliente; sem sessão mostra o login. `/admin` — gestão (só admin).
- `/api/transferencias[?cliente=<id>]` — o `cliente=` só é aceite ao admin.
- `POST /api/v1/ordens` — `Bearer ak_…`, cria uma ordem (trigger por API);
  `GET /api/v1/ordens/<ref>` dá o estado. Contrato em `../BACKOFFICE.md §8`.
- `GET /api/telemovel/ordens` — `Bearer <token do cliente>`, long-poll do telemóvel.
- `POST /api/telemovel/ordens/<id>/falha` — `Bearer <token do cliente>`, o telemóvel
  desiste de uma ordem (`operador_indisponivel`). Ver `../BACKOFFICE.md §8`.
- `/api/clientes` — `GET` lista; `POST` com `accao`
  `criar` | `numero` | `tirarNumero` | `token` | `senha` | `renomear` | `estado` |
  `formato` | `formatoApi` | `chaveApi` | `remover`.
- `/api/por-atribuir` — `GET` lista as que vieram de telemóveis desconhecidos;
  `POST {tid, cliente, registarNumero}` resolve-as.

## Saldo

"Saldo" aqui é **o total transferido com sucesso**, calculado a partir dos
registos. Não é o saldo da conta no operador: esse vem no SMS mas nunca sai do
telemóvel, por decisão deliberada (BACKOFFICE.md §6). Mudar isso obriga a alterar
o `Confirmation.kt` na app.

## HTTPS

A app recusa `http://`. Em produção põe isto atrás de um proxy com TLS
(Caddy resolve com uma linha) — o servidor em si só fala HTTP no localhost.

ponytail: SQLite num ficheiro, sessões num `Map` em memória, painel a fazer polling
de 60 s. Aguenta uma dúzia de clientes com um telemóvel cada. Postgres, sessões
persistidas e SSE só quando isto correr em mais do que um processo.
