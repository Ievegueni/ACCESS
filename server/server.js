// Painel de transferências — recebe os webhooks da app Access e serve a listagem.
// Multi-cliente: cada cliente tem o seu token de webhook, a sua senha e vê só os
// seus registos. Sem dependências: node:http + node:sqlite (Node 22+).
// Contrato e armadilhas: ../BACKOFFICE.md

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual, randomBytes, scryptSync, createHash, createHmac } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASS = process.env.ADMIN_PASS;   // só necessário no primeiro arranque
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'transferencias.db');

/** Ligar só quando houver mesmo um proxy à frente — ver clienteIp(). */
const CONFIAR_PROXY = process.env.CONFIAR_PROXY === '1';

const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id          INTEGER PRIMARY KEY,
    nome        TEXT NOT NULL UNIQUE,
    senha       TEXT NOT NULL,               -- scrypt: salt:hash
    token_hash  TEXT UNIQUE,                 -- sha256 do token do webhook
    admin       INTEGER NOT NULL DEFAULT 0,
    ativo       INTEGER NOT NULL DEFAULT 1,
    criado_em   INTEGER NOT NULL
  );
  -- Números dos SIM que trabalham para cada cliente. É a "referência" que se
  -- regista no painel e se escreve no ecrã da app do telemóvel correspondente.
  -- Um cliente pode ter vários telemóveis; um número só pode servir um cliente,
  -- senão não identificava ninguém (ver atribuir()).
  CREATE TABLE IF NOT EXISTS numeros (
    numero      TEXT PRIMARY KEY,            -- normalizado: só os dígitos finais
    bruto       TEXT NOT NULL,               -- como foi escrito, para mostrar
    cliente_id  INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    criado_em   INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transferencias (
    tid            TEXT PRIMARY KEY,         -- o TID do operador é global
    cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
    iban_ultimos5  TEXT,
    valor_texto    TEXT,
    valor          REAL,
    estado         TEXT NOT NULL CHECK (estado IN ('sucesso','falha')),
    momento        INTEGER NOT NULL,
    recebido_em    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cliente_momento ON transferencias(cliente_id, momento DESC);
  CREATE INDEX IF NOT EXISTS idx_numeros_cliente ON numeros(cliente_id);
  -- Pedidos que o sistema do cliente faz por API, para o telemóvel executar.
  -- Substitui o SMS de pedido; o SMS de confirmação do operador continua igual.
  CREATE TABLE IF NOT EXISTS ordens (
    id          INTEGER PRIMARY KEY,
    cliente_id  INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    ref         TEXT NOT NULL,              -- referência do cliente: a idempotência
    numero      TEXT,                       -- normalizado; null = qualquer telemóvel do cliente
    sequencia   TEXT NOT NULL,              -- nome da sequência configurada na app
    campos      TEXT NOT NULL,              -- JSON: {valor, iban, ...} → {valor} nos passos
    estado      TEXT NOT NULL CHECK (estado IN ('pendente','entregue','concluida','falhada','expirada','a_verificar')),
    tid         TEXT,                       -- preenchido quando a confirmação chega
    criado_em   INTEGER NOT NULL,
    entregue_em INTEGER,
    UNIQUE (cliente_id, ref)
  );
`);

// Colunas acrescentadas depois da primeira versão. `ADD COLUMN` é barato e
// idempotente com esta guarda; recriar a tabela não seria nenhuma das duas.
const colunas = db.prepare('PRAGMA table_info(transferencias)').all().map((c) => c.name);
if (!colunas.includes('numero_origem')) {
  // O número que veio no payload, tal como veio. Guardado mesmo quando não
  // corresponde a ninguém: é o que permite perceber a quem pertence depois.
  db.exec('ALTER TABLE transferencias ADD COLUMN numero_origem TEXT');
}
if (!colunas.includes('atribuido_por')) {
  // Como se soube de quem era: 'numero' | 'token' | 'manual'. Sem isto, uma
  // atribuição errada é indistinguível de uma certa quando alguém reclama.
  db.exec("ALTER TABLE transferencias ADD COLUMN atribuido_por TEXT NOT NULL DEFAULT 'token'");
}

if (!colunas.includes('saldo')) {
  // O que ficou na carteira daquele SIM depois desta transferência, como veio no
  // SMS e já interpretado. É o que permite responder a "quanto tenho em cada
  // telemóvel" sem ir a cada um deles.
  db.exec('ALTER TABLE transferencias ADD COLUMN saldo_texto TEXT');
  db.exec('ALTER TABLE transferencias ADD COLUMN saldo REAL');
}
if (!colunas.includes('numero_norm')) {
  // `numero_origem` é como veio escrito, e por isso não serve para agrupar: o
  // mesmo SIM aparece como "+244 923…" e "923456789". A forma normalizada em
  // coluna própria é o que torna as consultas por telemóvel exatas e baratas.
  db.exec('ALTER TABLE transferencias ADD COLUMN numero_norm TEXT');
  const atualizar = db.prepare('UPDATE transferencias SET numero_norm = ? WHERE tid = ?');
  for (const t of db.prepare('SELECT tid, numero_origem FROM transferencias').all()) {
    atualizar.run(normalizarNumero(t.numero_origem), t.tid);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_numero_norm ON transferencias(cliente_id, numero_norm, momento DESC)');
}

const colunasCliente = db.prepare('PRAGMA table_info(clientes)').all().map((c) => c.name);
if (!colunasCliente.includes('formato_sms')) {
  // Exemplo do SMS de pedido que o sistema do cliente tem de enviar. Vive aqui
  // porque a configuração real está na app, no telemóvel, e o servidor não a vê:
  // é o administrador que configura o telemóvel e escreve aqui o que configurou.
  db.exec('ALTER TABLE clientes ADD COLUMN formato_sms TEXT');
}
if (!colunasCliente.includes('api_hash')) {
  // sha256 da chave de leitura da API. Separada do token do webhook de propósito:
  // aquele vive no telemóvel e só escreve, esta vive no servidor do cliente e só lê.
  // O SQLite recusa UNIQUE num ADD COLUMN; o índice a seguir dá a mesma garantia.
  db.exec('ALTER TABLE clientes ADD COLUMN api_hash TEXT');
}
if (!colunasCliente.includes('formato_api')) {
  // O equivalente do formato_sms para o trigger por API: o corpo do POST que o
  // sistema do cliente tem de enviar, com o nome da sequência e os campos que ela
  // espera. Vive aqui pela mesma razão — está configurado no telemóvel, que o
  // servidor não vê, e é o administrador quem sabe o que lá pôs.
  db.exec('ALTER TABLE clientes ADD COLUMN formato_api TEXT');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_hash ON clientes(api_hash)');

const colunasOrdens = db.prepare('PRAGMA table_info(ordens)').all().map((c) => c.name);
if (!colunasOrdens.includes('notify_url')) {
  // Callback para o sistema do cliente quando a ordem fecha — pediu-o para não
  // ter de consultar o estado em ciclo. `notif_proxima` null = nada a enviar.
  db.exec(`ALTER TABLE ordens ADD COLUMN notify_url TEXT;
           ALTER TABLE ordens ADD COLUMN notif_tentativas INTEGER NOT NULL DEFAULT 0;
           ALTER TABLE ordens ADD COLUMN notif_proxima INTEGER`);
}
if (!colunasOrdens.includes('motivo')) {
  // Porque é que a ordem não fechou bem — ver MOTIVO. Sem isto, `expirada` junta
  // "nenhum telemóvel a foi buscar" (repetir é seguro) com "correu e não chegou
  // o SMS" (repetir pode transferir duas vezes).
  // Até aqui só expirava a entregue: todas as expiradas antigas são essas.
  db.exec(`ALTER TABLE ordens ADD COLUMN motivo TEXT;
           UPDATE ordens SET motivo = 'sem_confirmacao' WHERE estado = 'expirada'`);
}
if (!colunasOrdens.includes('notificado_em')) {
  // Quando o cliente aceitou o callback (2xx). Sem isto, "desistiu ao fim de 8
  // tentativas" e "aceite à primeira" ficam iguais: notif_proxima null nos dois.
  // As que já tinham sido aceites antes desta coluna ficam com 1 — sabe-se que
  // chegaram, não quando.
  db.exec(`ALTER TABLE ordens ADD COLUMN notificado_em INTEGER;
           UPDATE ordens SET notificado_em = 1
            WHERE notif_tentativas BETWEEN 1 AND 7 AND notif_proxima IS NULL`);
}
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ordens'").get().sql.includes("'falhada'")) {
  // O SQLite não altera um CHECK: a tabela é refeita com o mesmo esquema e as
  // mesmas linhas, só com o estado novo aceite. Os índices caem com ela e são
  // recriados logo abaixo.
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ordens'").get();
  db.exec('BEGIN');
  try {
    db.exec(sql.replace(/^CREATE TABLE ordens/, 'CREATE TABLE ordens_nova')
      .replace("'concluida','expirada'", "'concluida','falhada','expirada'"));
    db.exec(`INSERT INTO ordens_nova SELECT * FROM ordens;
             DROP TABLE ordens;
             ALTER TABLE ordens_nova RENAME TO ordens;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
if (!colunasOrdens.includes('telemovel')) {
  // O SIM que levou a ordem (normalizado). `numero` é o pedido, e é quase sempre
  // null; sem isto o administrador não sabe em que carteira ir ver o extrato de
  // uma ordem `a_verificar`.
  db.exec('ALTER TABLE ordens ADD COLUMN telemovel TEXT');
}
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ordens'").get().sql.includes("'a_verificar'")) {
  // Mesma técnica que acima, para o estado `a_verificar`. As ordens que antes
  // fechavam com resultado incerto (expirada sem SMS, SMS sem "sucesso") passam
  // para ele: o cliente só as vê fechadas quando o administrador decidir.
  // O callback em curso é cancelado: sairia como `em_curso`, que não é um fim.
  const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ordens'").get();
  db.exec('BEGIN');
  try {
    // Depois de um RENAME o SQLite guarda o nome entre aspas: `CREATE TABLE "ordens"`.
    db.exec(sql.replace(/^CREATE TABLE\s+"?ordens"?/, 'CREATE TABLE ordens_nova')
      .replace("'falhada','expirada'", "'falhada','expirada','a_verificar'"));
    db.exec(`INSERT INTO ordens_nova SELECT * FROM ordens;
             DROP TABLE ordens;
             ALTER TABLE ordens_nova RENAME TO ordens;
             UPDATE ordens SET estado = 'a_verificar', notif_proxima = NULL
              WHERE (estado = 'expirada' AND motivo = 'sem_confirmacao')
                 OR (estado = 'falhada' AND motivo = 'falha_operador');`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
// O telemóvel consulta isto a cada segundo enquanto espera.
db.exec('CREATE INDEX IF NOT EXISTS idx_ordens_fila ON ordens(cliente_id, estado, id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ordens_notif ON ordens(notif_proxima) WHERE notif_proxima IS NOT NULL');

// --- senhas e tokens -------------------------------------------------------

function cifrar(senha) {
  const sal = randomBytes(16).toString('hex');
  return `${sal}:${scryptSync(senha, sal, 32).toString('hex')}`;
}

function confere(senha, guardado) {
  const [sal, esperado] = String(guardado).split(':');
  if (!sal || !esperado) return false;
  return iguais(scryptSync(senha, sal, 32).toString('hex'), esperado);
}

function iguais(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

/**
 * O cliente a quem pertence o segredo do cabeçalho, ou null.
 *
 * `coluna` é `token_hash` (o telemóvel, que escreve) ou `api_hash` (o sistema do
 * cliente, que lê e pede) — literais do nosso código, nunca do pedido.
 */
function porChave(req, coluna) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  return db.prepare(`SELECT id, nome, ativo FROM clientes WHERE ${coluna} = ?`)
    .get(hashToken(auth.slice(7)));
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Gera um token novo para o cliente. O valor em claro só existe aqui — depois
 *  só fica o hash, por isso perder o token obriga a gerar outro. */
function novoToken(clienteId) {
  const token = randomBytes(24).toString('hex');
  db.prepare('UPDATE clientes SET token_hash = ? WHERE id = ?').run(hashToken(token), clienteId);
  return token;
}

/**
 * Instante de receção, garantidamente maior que todos os anteriores.
 *
 * A API de leitura pagina com `recebido_em > cursor`. Se duas transferências
 * caíssem no mesmo milissegundo e a página acabasse entre elas, a segunda nunca
 * mais aparecia. Empurrar um milissegundo à frente torna o cursor exato.
 *
 * ponytail: uma consulta do máximo por inserção. Ao ritmo de um SMS de cada vez
 * não se nota; com escrita concorrente a sério, passar a um contador na BD.
 */
function recebidoEmUnico() {
  const ultimo = db.prepare('SELECT MAX(recebido_em) m FROM transferencias').get().m ?? 0;
  return Math.max(Date.now(), ultimo + 1);
}

/** Chave de leitura da API, para o sistema do cliente. Mesma regra: só aqui em claro. */
function novaChaveApi(clienteId) {
  const chave = 'ak_' + randomBytes(24).toString('hex');
  db.prepare('UPDATE clientes SET api_hash = ? WHERE id = ?').run(hashToken(chave), clienteId);
  return chave;
}

// Primeiro arranque: cria o admin. Depois disso ADMIN_PASS deixa de ser preciso.
if (!db.prepare('SELECT 1 FROM clientes LIMIT 1').get()) {
  if (!ADMIN_PASS) {
    console.error('Base de dados vazia: define ADMIN_PASS para criar o administrador.');
    process.exit(1);
  }
  db.prepare('INSERT INTO clientes (nome, senha, admin, criado_em) VALUES (?, ?, 1, ?)')
    .run('admin', cifrar(ADMIN_PASS), Date.now());
  console.log('Administrador "admin" criado.');
}

// --- payload ---------------------------------------------------------------

/**
 * "500" → 500 · "1.500,50" → 1500.5 · "1.500" → 1500
 * Com vírgula, os pontos são milhares. Sem vírgula, só são milhares se o
 * agrupamento for exatamente de 3 dígitos — senão um parseFloat ingénuo
 * transformava "1.500" em 1.5. O texto original fica sempre guardado.
 */
function paraNumero(texto) {
  if (texto == null) return null;
  let s = String(texto).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const TID_VALIDO = /^[A-Za-z0-9.\-]{6,64}$/;

/**
 * Reduz um número de telemóvel à forma que serve para comparar.
 *
 * O mesmo SIM é escrito de maneiras diferentes em sítios diferentes:
 * `+244 923 456 789`, `00244923456789`, `923456789`, `923-456-789`. Fica-se com
 * os últimos 9 dígitos — o número nacional angolano — e assim todas coincidem.
 *
 * Devolve null se não sobrarem 9 dígitos: melhor recusar do que registar um
 * número que nunca vai corresponder a nada.
 */
function normalizarNumero(bruto) {
  const digitos = String(bruto ?? '').replace(/\D/g, '');
  return digitos.length >= 9 ? digitos.slice(-9) : null;
}

/**
 * De quem é esta transferência.
 *
 * 1. Pelo número do telemóvel que a enviou — é o que distingue clientes quando
 *    o mesmo token serve vários telemóveis, e sobrevive a trocas de token.
 * 2. Pelo dono do token — o caso do telemóvel dedicado, e o que havia antes de
 *    existirem números.
 *
 * O número ganha ao token de propósito: se os dois discordarem, quem está ao pé
 * do SIM é quem sabe. A divergência fica visível em `atribuido_por`.
 */
function atribuir(numeroBruto, clienteDoToken) {
  const normalizado = normalizarNumero(numeroBruto);
  if (normalizado) {
    const dono = db.prepare('SELECT cliente_id FROM numeros WHERE numero = ?').get(normalizado);
    if (dono) return { clienteId: dono.cliente_id, por: 'numero' };
  }
  // Número em branco, mal formado, ou de um telemóvel ainda não registado:
  // fica com o dono do token para não se perder, e o painel mostra a origem
  // para se poder registar ou reatribuir à mão.
  return { clienteId: clienteDoToken, por: 'token' };
}

/** O nome é o utilizador do login: devolve o nome limpo, ou null se não servir. */
function validarNome(bruto) {
  const nome = String(bruto ?? '').trim();
  return /^[\p{L}\d .\-_]{2,40}$/u.test(nome) ? nome : null;
}

/**
 * Devolve a mensagem de erro, ou null se o número serve.
 *
 * Recusar um número já registado noutro cliente não é zelo: se dois clientes
 * partilhassem o mesmo SIM, o número deixava de identificar seja quem for e a
 * atribuição passava a dar o resultado errado em silêncio.
 */
function validarNumeroLivre(bruto) {
  const numero = normalizarNumero(bruto);
  if (!numero) return 'número inválido — faltam dígitos';
  const dono = db.prepare(
    'SELECT c.nome FROM numeros n JOIN clientes c ON c.id = n.cliente_id WHERE n.numero = ?'
  ).get(numero);
  return dono ? `esse número já está registado em ${dono.nome}` : null;
}

function registarNumero(clienteId, bruto) {
  db.prepare('INSERT INTO numeros (numero, bruto, cliente_id, criado_em) VALUES (?, ?, ?, ?)')
    .run(normalizarNumero(bruto), bruto, clienteId, Date.now());
}

/** Valida o payload da app. Devolve {erro} ou {registo}. */
function validar(corpo) {
  if (!corpo || typeof corpo !== 'object') return { erro: 'corpo não é um objeto' };
  const { tid, iban_ultimos5, valor, estado, momento, numero, ordem_id, saldo } = corpo;
  if (typeof tid !== 'string' || !TID_VALIDO.test(tid)) return { erro: 'tid inválido' };
  if (estado !== 'sucesso' && estado !== 'falha') return { erro: 'estado inválido' };
  if (!Number.isFinite(momento) || momento <= 0) return { erro: 'momento inválido' };
  if (iban_ultimos5 != null && !/^\d{5}$/.test(String(iban_ultimos5))) {
    return { erro: 'iban_ultimos5 inválido' };
  }
  // Só dígitos, ponto e vírgula — é o que o parser da app extrai. Fecha também a
  // porta a HTML injetado, já que o painel mostra este texto tal como veio.
  if (valor != null && !/^[\d.,]{1,20}$/.test(String(valor))) return { erro: 'valor inválido' };
  // Mesma regra do valor: é texto do SMS e vai aparecer no painel.
  if (saldo != null && !/^[\d.,]{1,20}$/.test(String(saldo))) return { erro: 'saldo inválido' };
  // Campo opcional (a app só o envia se estiver configurado). Formato largo de
  // propósito — o que conta é a forma normalizada, não como foi escrito.
  if (numero != null && !/^[\d+()\-. ]{1,25}$/.test(String(numero))) {
    return { erro: 'numero inválido' };
  }
  // Só presente quando a sequência foi disparada por API. Um id que não exista ou
  // já não esteja à espera é ignorado no fecho da ordem — nunca 400: a
  // transferência aconteceu e o registo dela vale mais do que a ligação à ordem.
  if (ordem_id != null && (!Number.isInteger(ordem_id) || ordem_id <= 0)) {
    return { erro: 'ordem_id inválido' };
  }
  return {
    registo: {
      tid,
      iban_ultimos5: iban_ultimos5 == null ? null : String(iban_ultimos5),
      valor_texto: valor == null ? null : String(valor),
      valor: paraNumero(valor),
      saldo_texto: saldo == null ? null : String(saldo),
      saldo: paraNumero(saldo),
      estado,
      momento,
      numero_origem: numero == null ? null : String(numero).trim() || null,
      numero_norm: normalizarNumero(numero),
      ordem_id: ordem_id ?? null,
    },
  };
}

// --- ordens (trigger por API) ----------------------------------------------

/**
 * Depois disto uma ordem deixa de contar: entregue sem confirmação, ou pendente
 * sem nenhum telemóvel a ir buscá-la.
 */
const ORDEM_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Porque é que a ordem não fechou sozinha com sucesso. Os dois primeiros são
 * certezas de que nada correu; os dois do meio deixam a ordem `a_verificar`,
 * porque pode ter corrido; o último diz que foi o administrador a fechá-la.
 */
const MOTIVO = {
  // Nenhum telemóvel a foi buscar: nada correu, repetir é seguro.
  NAO_RECOLHIDA: 'nao_recolhida',
  // O operador respondeu "serviço indisponível" antes de o valor ser escrito;
  // o telemóvel repetiu e desistiu. Nada foi submetido: repetir é seguro.
  OPERADOR_INDISPONIVEL: 'operador_indisponivel',
  // O telemóvel levou-a e o SMS do operador nunca chegou. Pode ter corrido.
  SEM_CONFIRMACAO: 'sem_confirmacao',
  // Chegou SMS com TID mas sem "sucesso" (ver BACKOFFICE §3): pode ser só texto
  // que o parser não conhece.
  FALHA_OPERADOR: 'falha_operador',
  // O administrador viu o extrato e fechou-a (sucesso ou falha).
  VERIFICACAO_MANUAL: 'verificacao_manual',
};

/** Os motivos que o próprio telemóvel pode dar. Os outros só o servidor decide. */
const MOTIVOS_DO_TELEMOVEL = new Set([MOTIVO.OPERADOR_INDISPONIVEL]);

const REF_VALIDA = /^[A-Za-z0-9._\-]{1,64}$/;
const SEQUENCIA_VALIDA = /^[\p{L}\d .\-_]{1,60}$/u;
const CAMPO_VALIDO = /^[\p{L}\w]{1,20}$/u;
// O valor vai ser escrito numa caixa USSD: dígitos, letras e a pontuação que
// aparece em IBANs, montantes e códigos. Nada de chavetas (são os marcadores dos
// passos), nada de quebras de linha, nada de HTML — o painel mostra isto.
const VALOR_VALIDO = /^[\p{L}\d .,:+\-_/@#*]{1,64}$/u;

/**
 * O `valor` vai tal e qual para a caixa USSD, e o menu do operador só aceita
 * kwanzas inteiros: "200.00" era escrito como veio e a ordem expirava sem TID.
 * Zeros decimais caem ("200.00" → "200"); cêntimos a sério são recusados aqui,
 * com erro, em vez de falharem em silêncio no telemóvel. "1.500" também é
 * recusado: em Angola o ponto é milhares, e adivinhar é transferir outro valor.
 */
function normalizarValor(valor) {
  const m = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(valor);
  if (!m) return { erro: 'valor tem de ser um número de kwanzas, ex. 500' };
  if (m[2] && Number(m[2]) !== 0) return { erro: 'valor com cêntimos: só kwanzas inteiros' };
  const inteiro = String(Number(m[1]));
  if (inteiro === '0') return { erro: 'valor tem de ser maior que zero' };
  return { valor: inteiro };
}

/** Valida o pedido do sistema do cliente. Devolve {erro} ou {ordem}. */
function validarOrdem(corpo) {
  if (!corpo || typeof corpo !== 'object') return { erro: 'corpo não é um objeto' };
  const { ref, sequencia, campos, numero, notify_url } = corpo;
  if (typeof ref !== 'string' || !REF_VALIDA.test(ref)) return { erro: 'ref inválida' };
  if (typeof sequencia !== 'string' || !SEQUENCIA_VALIDA.test(sequencia)) {
    return { erro: 'sequencia inválida' };
  }
  if (campos != null && (typeof campos !== 'object' || Array.isArray(campos))) {
    return { erro: 'campos tem de ser um objeto' };
  }
  const limpos = {};
  for (const [chave, valor] of Object.entries(campos || {})) {
    if (!CAMPO_VALIDO.test(chave)) return { erro: `campo inválido: ${chave}` };
    if (!VALOR_VALIDO.test(String(valor))) return { erro: `valor inválido em ${chave}` };
    limpos[chave.toLowerCase()] = String(valor);
  }
  if (limpos.valor != null) {
    const { erro, valor } = normalizarValor(limpos.valor);
    if (erro) return { erro };
    limpos.valor = valor;
  }
  if (Object.keys(limpos).length > 10) return { erro: 'campos a mais' };
  // Sem número, serve qualquer telemóvel do cliente. Com número, tem de ser
  // aquele — é o que permite a um cliente com vários SIM escolher por onde sai.
  if (numero != null && !normalizarNumero(numero)) return { erro: 'numero inválido' };
  if (notify_url != null && !urlNotificacaoValida(notify_url)) return { erro: 'notify_url inválido' };

  return {
    ordem: {
      ref,
      sequencia,
      campos: JSON.stringify(limpos),
      numero: numero == null ? null : normalizarNumero(numero),
      notify_url: notify_url ?? null,
    },
  };
}

/**
 * Só HTTPS: o corpo leva o estado de uma transferência. Também corta o grosso do
 * SSRF — um serviço interno raramente tem certificado válido.
 * ponytail: não resolve o DNS para recusar IPs privados; acrescentar se houver
 * serviços internos com HTTPS na mesma máquina.
 */
function urlNotificacaoValida(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * O que acontece às ordens que ficam 10 minutos sem fechar.
 *
 * A pendente fica `expirada`: nenhum telemóvel a levou, nada correu, e o
 * cliente é avisado de uma falha certa. Tem de expirar porque um telemóvel sem
 * rede de madrugada ia buscá-la horas depois e transferia quando o cliente já
 * tinha desistido dela.
 *
 * A entregue fica `a_verificar`, **sem aviso**: pode ter corrido até ao fim e
 * ter-se perdido só o SMS. Dizer "falha" fazia o cliente repetir e transferir
 * duas vezes; dizer "sucesso" era inventar. Fecha quando o SMS chegar atrasado
 * ou quando o administrador decidir (decidirOrdem). Nunca volta a `pendente`.
 *
 * Os UPDATE são condicionais ao estado, tal como o de tomarOrdem(): das duas,
 * só uma ganha. Corre a pedido e num temporizador (ver o fim do ficheiro): um
 * telemóvel morto não pergunta nada, e o cliente com `notify_url` também não.
 */
function expirarOrdens() {
  const limite = Date.now() - ORDEM_TIMEOUT_MS;
  const { changes } = db.prepare(
    `UPDATE ordens SET estado = 'expirada', motivo = ?,
       notif_proxima = CASE WHEN notify_url IS NOT NULL THEN ? END
     WHERE estado = 'pendente' AND criado_em < ?`
  ).run(MOTIVO.NAO_RECOLHIDA, Date.now(), limite);
  db.prepare(
    `UPDATE ordens SET estado = 'a_verificar', motivo = ?
     WHERE estado = 'entregue' AND entregue_em < ?`
  ).run(MOTIVO.SEM_CONFIRMACAO, limite);
  if (changes) notificarPendentes();
}

// --- notify_url: avisar o sistema do cliente quando a ordem fecha -----------

/** Tentativas com espera a dobrar desde 30 s: cobre ~2 h de servidor em baixo. */
const NOTIF_MAX_TENTATIVAS = 8;
const NOTIF_BASE_MS = 30 * 1000;
const aNotificar = new Set();   // ids em voo: o temporizador e o fecho não enviam duas vezes

/**
 * POST de `ordemPublica` para o `notify_url`, assinado com HMAC-SHA256 do corpo.
 * A chave da assinatura é o sha256 (hex) da chave `ak_` do cliente — ele tem a
 * chave, nós só o hash, e assim não há segundo segredo a gerir.
 *
 * Entrega pelo menos uma vez: se a resposta dele se perder, repete. O cliente
 * trata o callback como idempotente, pela `ref`.
 */
async function notificar(o) {
  if (aNotificar.has(o.id)) return;
  aNotificar.add(o.id);
  try {
    const status = await enviarCallback(o.notify_url, ordemPublica(o), o.api_hash);
    const ok = status >= 200 && status < 300;

    const tentativas = o.notif_tentativas + 1;
    const proxima = ok || tentativas >= NOTIF_MAX_TENTATIVAS
      ? null
      : Date.now() + NOTIF_BASE_MS * 2 ** (tentativas - 1);
    db.prepare('UPDATE ordens SET notif_tentativas = ?, notif_proxima = ?, notificado_em = ? WHERE id = ?')
      .run(tentativas, proxima, ok ? Date.now() : null, o.id);
    // Nunca o corpo nem o URL completo no log: são dados do cliente.
    if (!ok) console.error(`notify_url falhou: ordem ${o.id}, tentativa ${tentativas}`);
  } finally {
    aNotificar.delete(o.id);
  }
}

/**
 * Um POST assinado ao sistema do cliente. Devolve o status HTTP, ou null se nem
 * chegou a haver resposta (rede, DNS, 10 s sem resposta).
 */
async function enviarCallback(url, corpoObj, apiHash) {
  const corpo = JSON.stringify(corpoObj);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Assinatura': createHmac('sha256', apiHash || '').update(corpo).digest('hex'),
      },
      body: corpo,
      redirect: 'manual',              // um 3xx para http:// ou para dentro não é seguido
      signal: AbortSignal.timeout(10000),
    });
    return r.status;
  } catch {
    return null;
  }
}

/** Envia o que está em atraso. Devolve a promessa para os testes esperarem. */
function notificarPendentes() {
  const devidas = db.prepare(
    `SELECT o.*, c.api_hash FROM ordens o JOIN clientes c ON c.id = o.cliente_id
     WHERE o.notif_proxima IS NOT NULL AND o.notif_proxima <= ? LIMIT 50`
  ).all(Date.now());
  return Promise.all(devidas.map(notificar));
}

/** Cria, ou devolve a que já existe com a mesma `ref` — o cliente pode repetir. */
function criarOrdem(clienteId, ordem) {
  const existente = db.prepare('SELECT * FROM ordens WHERE cliente_id = ? AND ref = ?')
    .get(clienteId, ordem.ref);
  if (existente) return { ordem: existente, nova: false };

  const { lastInsertRowid } = db.prepare(
    `INSERT INTO ordens (cliente_id, ref, numero, sequencia, campos, estado, criado_em, notify_url)
     VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)`
  ).run(clienteId, ordem.ref, ordem.numero, ordem.sequencia, ordem.campos, Date.now(),
        ordem.notify_url);

  return { ordem: db.prepare('SELECT * FROM ordens WHERE id = ?').get(Number(lastInsertRowid)), nova: true };
}

/**
 * Entrega a ordem mais antiga a este telemóvel e marca-a `entregue`.
 *
 * Uma de cada vez porque o telemóvel também só corre uma sequência de cada vez.
 * A marcação vem no mesmo UPDATE condicional que a escolhe: mesmo que dois
 * telemóveis do mesmo cliente perguntem ao mesmo tempo, só um leva a ordem.
 */
function tomarOrdem(clienteId, numeroNormalizado) {
  expirarOrdens();
  const ordem = db.prepare(
    `SELECT * FROM ordens
     WHERE cliente_id = ? AND estado = 'pendente' AND (numero IS NULL OR numero = ?)
     ORDER BY id ASC LIMIT 1`
  ).get(clienteId, numeroNormalizado);
  if (!ordem) return null;

  const { changes } = db.prepare(
    "UPDATE ordens SET estado = 'entregue', entregue_em = ?, telemovel = ? WHERE id = ? AND estado = 'pendente'"
  ).run(Date.now(), numeroNormalizado || null, ordem.id);
  if (!changes) return null;   // outro telemóvel chegou primeiro

  return { id: ordem.id, ref: ordem.ref, sequencia: ordem.sequencia, campos: JSON.parse(ordem.campos) };
}

/**
 * O telemóvel desistiu da ordem e diz porquê. Fecha-a já como `falhada`, em vez
 * de a deixar ir para `a_verificar` aos 10 minutos: o telemóvel é o único que
 * sabe que nada foi submetido, e aqui a falha é certa.
 *
 * Fecha a `entregue` e também a que já passou a `a_verificar` só por falta de
 * SMS (um aviso atrasado): o que o telemóvel sabe vale mais do que o relógio.
 * Se a confirmação chegou entretanto, é ela que manda. Devolve se fechou.
 */
function falharOrdem(id, clienteId, motivo) {
  const { changes } = db.prepare(
    `UPDATE ordens SET estado = 'falhada', motivo = ?,
       notif_proxima = CASE WHEN notify_url IS NOT NULL THEN ? END
     WHERE id = ? AND cliente_id = ?
       AND (estado = 'entregue' OR (estado = 'a_verificar' AND motivo = ?))`
  ).run(motivo, Date.now(), id, clienteId, MOTIVO.SEM_CONFIRMACAO);
  if (changes) notificarPendentes();   // sem await: o telemóvel não espera pelo cliente
  return changes > 0;
}

/**
 * O administrador viu o extrato e fecha uma ordem `a_verificar`. É o único
 * caminho para fora desse estado além do SMS atrasado.
 *
 * O contador do callback volta a zero: uma ordem migrada pode já ter esgotado
 * as tentativas com o estado antigo. Devolve se fechou.
 */
function decidirOrdem(id, resultado, tid) {
  const { changes } = db.prepare(
    `UPDATE ordens SET estado = ?, motivo = ?, tid = COALESCE(?, tid),
       notif_tentativas = 0, notificado_em = NULL,
       notif_proxima = CASE WHEN notify_url IS NOT NULL THEN ? END
     WHERE id = ? AND estado = 'a_verificar'`
  ).run(resultado === 'sucesso' ? 'concluida' : 'falhada', MOTIVO.VERIFICACAO_MANUAL,
        tid || null, Date.now(), id);
  if (changes) notificarPendentes();
  return changes > 0;
}

/**
 * O cliente só vê três estados, e só dois são fim. Tudo o que ainda pode mudar,
 * incluindo `a_verificar`, é `em_curso`: o callback só sai com certezas.
 */
function estadoPublico(estado) {
  if (estado === 'concluida') return 'sucesso';
  if (estado === 'falhada' || estado === 'expirada') return 'falha';
  return 'em_curso';
}

/** Como o cliente vê a ordem. Forma pública: mudá-la parte a integração dele. */
function ordemPublica(o) {
  const estado = estadoPublico(o.estado);
  return {
    ref: o.ref,
    id: o.id,
    sequencia: o.sequencia,
    campos: JSON.parse(o.campos),
    estado,
    // Só informativo, e só num fim: em curso, o motivo interno ainda pode mudar.
    motivo: estado === 'em_curso' ? null : o.motivo ?? null,
    tid: o.tid,
    criado_em: o.criado_em,
    entregue_em: o.entregue_em,
  };
}

/**
 * Todas as ordens `a_verificar`, de todos os clientes, para o administrador.
 * Com o telemóvel que a levou: é nessa carteira que se vê o extrato.
 */
function ordensAVerificar() {
  const bruto = new Map(db.prepare('SELECT numero, bruto FROM numeros').all()
    .map((n) => [n.numero, n.bruto]));
  return db.prepare(
    `SELECT o.id, o.ref, o.campos, o.motivo, o.tid, o.criado_em, o.entregue_em, o.telemovel,
            c.nome AS cliente
     FROM ordens o JOIN clientes c ON c.id = o.cliente_id
     WHERE o.estado = 'a_verificar' ORDER BY o.id ASC`
  ).all().map((o) => {
    const campos = JSON.parse(o.campos);
    return {
      id: o.id,
      ref: o.ref,
      cliente: o.cliente,
      valor: campos.valor ?? null,
      iban_ultimos5: campos.iban ? String(campos.iban).slice(-5) : null,
      telemovel: o.telemovel ? bruto.get(o.telemovel) ?? o.telemovel : null,
      motivo: o.motivo,
      tid: o.tid,
      criado_em: o.criado_em,
      entregue_em: o.entregue_em,
    };
  });
}

// --- consultas -------------------------------------------------------------

/**
 * As últimas ordens de um cliente, já na forma do painel.
 *
 * Dos `campos` só saem o valor e os 5 últimos do IBAN, como nas transferências:
 * o painel está à vista e o IBAN inteiro não faz falta para reconhecer a ordem.
 */
function ordensDoPainel(clienteId) {
  const itens = db.prepare(
    'SELECT * FROM ordens WHERE cliente_id = ? ORDER BY id DESC LIMIT 50'
  ).all(clienteId).map((o) => {
    const campos = JSON.parse(o.campos);
    return {
      ref: o.ref,
      sequencia: o.sequencia,
      valor: campos.valor ?? null,
      iban_ultimos5: campos.iban ? String(campos.iban).slice(-5) : null,
      estado: o.estado,
      motivo: o.motivo,
      tid: o.tid,
      criado_em: o.criado_em,
      aviso: !o.notify_url ? null
        : o.notificado_em ? 'aceite'
        : o.notif_proxima ? 'a_tentar'
        : o.notif_tentativas ? 'recusado'
        : 'por_enviar',
    };
  });
  const { falhadas } = db.prepare(
    `SELECT COUNT(*) AS falhadas FROM ordens
     WHERE cliente_id = ? AND estado IN ('falhada', 'expirada') AND criado_em > ?`
  ).get(clienteId, Date.now() - 24 * 3600e3);
  const { a_verificar } = db.prepare(
    "SELECT COUNT(*) AS a_verificar FROM ordens WHERE cliente_id = ? AND estado = 'a_verificar'"
  ).get(clienteId);
  return { itens, falhadas, a_verificar };
}

/** Resumo de um cliente. `saldo` = total transferido com sucesso (ver §5). */
function resumo(clienteId) {
  const agora = Date.now();
  const soma = (desde) => db.prepare(
    `SELECT COALESCE(SUM(valor),0) v, COUNT(*) n FROM transferencias
     WHERE cliente_id = ? AND estado = 'sucesso' AND momento >= ?`
  ).get(clienteId, desde);

  const rever = db.prepare(
    `SELECT COUNT(*) n FROM transferencias WHERE cliente_id = ? AND estado = 'falha'`
  ).get(clienteId);

  const ultimo = db.prepare(
    `SELECT MAX(recebido_em) r, MAX(momento) m FROM transferencias WHERE cliente_id = ?`
  ).get(clienteId);

  return {
    dia: soma(agora - 86400000),
    mes: soma(agora - 30 * 86400000),
    total: soma(0),
    rever: rever.n,
    // "há quanto tempo não chega nada?" — silêncio é indistinguível de "não houve
    // transferências", por isso é isto que se vigia.
    saude: {
      ultimo_recebido: ultimo.r ?? null,
      silencio_ms: ultimo.r ? agora - ultimo.r : null,
      // divergência grande = relógio do telemóvel desacertado ou fila atrasada
      desvio_relogio_ms: ultimo.r && ultimo.m ? ultimo.r - ultimo.m : null,
    },
  };
}

function consultar(clienteId, { estado, de, ate, limite = 500 }) {
  const where = ['cliente_id = ?'];
  const args = [clienteId];
  if (estado === 'sucesso' || estado === 'falha') { where.push('estado = ?'); args.push(estado); }
  if (de) { where.push('momento >= ?'); args.push(Date.parse(de + 'T00:00:00Z')); }
  if (ate) { where.push('momento <= ?'); args.push(Date.parse(ate + 'T23:59:59Z')); }

  const itens = db.prepare(
    `SELECT tid, iban_ultimos5, valor_texto, valor, estado, momento, recebido_em,
            numero_origem, atribuido_por
     FROM transferencias WHERE ${where.join(' AND ')}
     ORDER BY momento DESC LIMIT ?`   // por momento, nunca por ordem de chegada
  ).all(...args, Math.min(Number(limite) || 500, 2000));

  return { itens, numeros: numerosDe(clienteId), carteiras: carteiras(clienteId), ...resumo(clienteId) };
}

const numerosDe = (clienteId) => db.prepare(
  'SELECT numero, bruto FROM numeros WHERE cliente_id = ? ORDER BY criado_em'
).all(clienteId);

/**
 * Uma carteira por telemóvel: quanto lá resta e há quanto tempo não dá sinal.
 *
 * O saldo é o da confirmação mais recente daquele SIM — é uma fotografia do
 * instante em que o operador a enviou, não um extrato. Se o telemóvel esteve sem
 * rede, ou se alguém carregou a conta por fora, o número está velho: por isso vai
 * sempre acompanhado de `saldo_em`, e é isso que o painel mostra ao lado.
 *
 * O silêncio é por número (e não só do cliente) de propósito: com três telemóveis,
 * um que se cale fica escondido atrás dos outros dois no agregado.
 */
function carteiras(clienteId) {
  const ultimoSaldo = db.prepare(
    `SELECT saldo, saldo_texto, momento FROM transferencias
     WHERE cliente_id = ? AND numero_norm = ? AND saldo IS NOT NULL
     ORDER BY momento DESC, recebido_em DESC LIMIT 1`
  );
  const actividade = db.prepare(
    `SELECT MAX(recebido_em) r, COUNT(*) n FROM transferencias
     WHERE cliente_id = ? AND numero_norm = ?`
  );

  const agora = Date.now();
  return numerosDe(clienteId).map((n) => {
    const s = ultimoSaldo.get(clienteId, n.numero);
    const a = actividade.get(clienteId, n.numero);
    return {
      numero: n.numero,
      bruto: n.bruto,
      saldo: s?.saldo ?? null,
      saldo_texto: s?.saldo_texto ?? null,
      saldo_em: s?.momento ?? null,
      transferencias: a.n,
      // null = nunca chegou nada deste telemóvel
      silencio_ms: a.r ? agora - a.r : null,
    };
  });
}

function listarClientes() {
  return db.prepare(
    `SELECT id, nome, ativo, admin, criado_em, formato_sms, formato_api,
            api_hash IS NOT NULL AS tem_chave
     FROM clientes ORDER BY admin, nome`
  ).all().map((c) => ({ ...c, numeros: numerosDe(c.id), ...resumo(c.id) }));
}

/**
 * Transferências que vieram de um telemóvel que não está registado em ninguém.
 *
 * Ficaram com o dono do token para não se perderem, mas ninguém confirmou que
 * são dele — é a lista que o administrador tem de resolver, registando o número
 * ou movendo a transferência à mão.
 *
 * O filtro final é feito aqui e não em SQL porque a comparação é entre formas
 * normalizadas, e essa regra vive em normalizarNumero().
 */
function porAtribuir() {
  const registados = new Set(db.prepare('SELECT numero FROM numeros').all().map((n) => n.numero));
  return db.prepare(
    `SELECT t.tid, t.numero_origem, t.iban_ultimos5, t.valor_texto, t.valor,
            t.momento, t.cliente_id, c.nome AS cliente
     FROM transferencias t
     JOIN clientes c ON c.id = t.cliente_id
     WHERE t.atribuido_por = 'token' AND t.numero_origem IS NOT NULL
     ORDER BY t.momento DESC LIMIT 500`
  ).all().filter((t) => !registados.has(normalizarNumero(t.numero_origem)));
}

// --- sessões ---------------------------------------------------------------

// Em memória: reiniciar o servidor fecha as sessões, que é o comportamento certo
// para um painel com um punhado de utilizadores.
// ponytail: um Map serve para um processo. Mover para a BD só se isto correr
// em mais do que uma instância.
const sessoes = new Map();
const tentativas = new Map();   // ip → { n, ate }

/** Expulsa quem estiver com sessão aberta neste cliente. */
function fecharSessoes(clienteId) {
  for (const [k, s] of sessoes) if (s.id === clienteId) sessoes.delete(k);
}

/**
 * IP de quem fez o pedido, visto de trás de um proxy.
 *
 * Sem isto, em produção `remoteAddress` é sempre 127.0.0.1 (o Caddy) e o limite
 * de tentativas passa a ser global: dez falhas de um atacante trancavam a porta
 * a todos os clientes durante cinco minutos.
 *
 * Só se lê o cabeçalho quando CONFIAR_PROXY está ligado. Em aberto, qualquer um
 * o forjava e o limite deixava de contar seja o que for.
 */
function clienteIp(req) {
  if (CONFIAR_PROXY) {
    // O primeiro da lista é o cliente; os seguintes são proxies.
    const encaminhado = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (encaminhado) return encaminhado;
  }
  return req.socket.remoteAddress || '?';
}

function travado(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() > t.ate) return false;
  return t.n >= 10;
}

function falhou(ip) {
  const t = tentativas.get(ip);
  if (!t || Date.now() > t.ate) tentativas.set(ip, { n: 1, ate: Date.now() + 300000 });
  else t.n++;
}

// --- HTTP ------------------------------------------------------------------

/**
 * Se o browser chegou por HTTPS, mesmo que até aqui venha em claro.
 *
 * Em produção isto corre atrás de um proxy TLS (ngrok, Caddy) que fala http com
 * o servidor: sem olhar para o cabeçalho, o cookie de sessão saía sempre sem
 * `Secure` e podia acabar numa ligação em claro. Confiar no cabeçalho é seguro
 * aqui porque o pior que um pedido forjado consegue é pôr `Secure` a mais.
 */
const porHttps = (req) =>
  req.headers['x-forwarded-proto'] === 'https' || !!req.socket.encrypted;

function json(res, codigo, corpo) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

function corpoDe(req, limite = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let bruto = '';
    req.on('data', (c) => {
      bruto += c;
      if (bruto.length > limite) { req.destroy(); reject(new Error('corpo grande demais')); }
    });
    req.on('end', () => resolve(bruto));
    req.on('error', reject);
  });
}

const pagina = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const PAINEL = pagina('painel.html');
const ADMIN = pagina('admin.html');
const LOGIN = pagina('login.html');
const PROGRAMADORES = pagina('programadores.html');
const ESTATICOS = {
  '/estilo.css': ['text/css', pagina('estilo.css')],
  '/painel.js': ['text/javascript', pagina('painel.js')],
  '/i18n.js': ['text/javascript', pagina('i18n.js')],
};

async function tratar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const ip = clienteIp(req);

  // 1. Webhook da app — autenticado pelo token do cliente, não por sessão.
  if (req.method === 'POST' && url.pathname === '/webhooks/transferencias') {
    const cliente = porChave(req, 'token_hash');
    if (!cliente) return json(res, 401, { erro: 'token inválido' });
    // Cliente desativado é uma decisão nossa e reversível: 503 para a app manter
    // em fila. Com 401 (4xx) ela descartava, e o SMS não volta a chegar (§4).
    if (!cliente.ativo) return json(res, 503, { erro: 'cliente desativado' });

    const { erro, registo } = validar(JSON.parse(await corpoDe(req)));
    if (erro) return json(res, 400, { erro });   // 4xx: a app descarta, e bem

    // Quem enviou (token) não é necessariamente de quem é (número) — ver atribuir().
    const { clienteId, por } = atribuir(registo.numero_origem, cliente.id);

    try {
      // Repetir tem de ser inofensivo: a app reenvia se a resposta se perder.
      db.prepare(
        `INSERT INTO transferencias
           (tid, cliente_id, iban_ultimos5, valor_texto, valor, estado, momento,
            recebido_em, numero_origem, numero_norm, atribuido_por, saldo_texto, saldo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tid) DO NOTHING`
      ).run(registo.tid, clienteId, registo.iban_ultimos5, registo.valor_texto,
            registo.valor, registo.estado, registo.momento, recebidoEmUnico(),
            registo.numero_origem, registo.numero_norm, por,
            registo.saldo_texto, registo.saldo);

      // Fecha a ordem que originou esta transferência, se veio por API. Do mesmo
      // cliente a quem a transferência foi atribuída — é por esse que o telemóvel
      // pede ordens — e só se ainda não fechou: um `ordem_id` velho ou de outro
      // cliente é ignorado, nunca um erro — o registo já está gravado.
      // Aceita também a `a_verificar`: um SMS atrasado resolve a dúvida sozinho.
      // Um SMS sem "sucesso" não é uma falha certa (§3): fica `a_verificar`, sem
      // callback, e o TID fica para o administrador procurar no extrato.
      if (registo.ordem_id) {
        const falhou = registo.estado === 'falha';
        const { changes } = db.prepare(
          `UPDATE ordens SET estado = ?, motivo = ?, tid = ?,
             notif_proxima = CASE WHEN ? AND notify_url IS NOT NULL THEN ? END
           WHERE id = ? AND cliente_id = ? AND estado IN ('entregue', 'a_verificar')`
        ).run(falhou ? 'a_verificar' : 'concluida', falhou ? MOTIVO.FALHA_OPERADOR : null,
              registo.tid, falhou ? 0 : 1, Date.now(), registo.ordem_id, clienteId);
        if (changes && !falhou) notificarPendentes();   // sem await: o telemóvel não espera pelo cliente
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      // Nunca 4xx por problema nosso: a app apaga da fila e o SMS não volta.
      console.error('falha a gravar:', e.message);
      return json(res, 503, { erro: 'indisponível' });
    }
  }

  // 1.1 API de leitura, para o sistema do cliente. Sem sessão: autentica-se com
  //     a chave dele, tem de funcionar a partir de um servidor.
  if (url.pathname === '/api/v1/transferencias') {
    const cliente = porChave(req, 'api_hash');
    if (!cliente) return json(res, 401, { erro: 'chave inválida' });
    if (!cliente.ativo) return json(res, 403, { erro: 'cliente desativado' });
    if (req.method !== 'GET') return json(res, 405, { erro: 'só GET' });

    /*
     * Paginação por `recebido_em`, nunca por `momento`.
     *
     * `momento` é o relógio do telemóvel e os registos chegam fora de ordem e com
     * atraso (BACKOFFICE §4): um cliente que paginasse por `momento` saltava por
     * cima de tudo o que chegasse tarde e nunca mais o via. `recebido_em` é do
     * servidor e só cresce, por isso serve de cursor.
     */
    const desde = Number(url.searchParams.get('desde')) || 0;
    const limite = Math.min(Math.max(Number(url.searchParams.get('limite')) || 100, 1), 500);
    const itens = db.prepare(
      `SELECT tid, iban_ultimos5, valor_texto, valor, estado, momento, recebido_em
       FROM transferencias
       WHERE cliente_id = ? AND recebido_em > ?
       ORDER BY recebido_em ASC LIMIT ?`
    ).all(cliente.id, desde, limite);

    return json(res, 200, {
      cliente: cliente.nome,
      itens: itens.map((t) => ({
        tid: t.tid,
        estado: t.estado,
        valor: t.valor_texto,          // como veio no SMS
        valor_numerico: t.valor,       // já interpretado — ver BACKOFFICE §4
        iban_ultimos5: t.iban_ultimos5,
        momento: t.momento,
        recebido_em: t.recebido_em,
      })),
      // Guardar e mandar de volta no pedido seguinte. Sem itens, repete-se o mesmo.
      proximo_desde: itens.length ? itens[itens.length - 1].recebido_em : desde,
      ha_mais: itens.length === limite,
    });
  }

  // 1.2 Pedir uma transferência por API, em vez de por SMS. Mesma chave da
  //     leitura: é o mesmo sistema do cliente a falar connosco.
  if (url.pathname === '/api/v1/ordens' || url.pathname.startsWith('/api/v1/ordens/')) {
    const cliente = porChave(req, 'api_hash');
    if (!cliente) return json(res, 401, { erro: 'chave inválida' });
    if (!cliente.ativo) return json(res, 403, { erro: 'cliente desativado' });
    expirarOrdens();

    // Estado de uma ordem, pela referência que o cliente escolheu.
    if (req.method === 'GET' && url.pathname !== '/api/v1/ordens') {
      const ref = decodeURIComponent(url.pathname.slice('/api/v1/ordens/'.length));
      const o = db.prepare('SELECT * FROM ordens WHERE cliente_id = ? AND ref = ?').get(cliente.id, ref);
      return o ? json(res, 200, ordemPublica(o)) : json(res, 404, { erro: 'ordem não existe' });
    }

    if (req.method === 'GET') {
      const desde = Number(url.searchParams.get('desde')) || 0;
      const itens = db.prepare(
        'SELECT * FROM ordens WHERE cliente_id = ? AND id > ? ORDER BY id ASC LIMIT 100'
      ).all(cliente.id, desde);
      return json(res, 200, {
        itens: itens.map(ordemPublica),
        proximo_desde: itens.length ? itens[itens.length - 1].id : desde,
      });
    }

    if (req.method !== 'POST') return json(res, 405, { erro: 'só GET ou POST' });

    const { erro, ordem } = validarOrdem(JSON.parse(await corpoDe(req, 4096)));
    if (erro) return json(res, 400, { erro });

    // Repetir com a mesma `ref` devolve a ordem que já existe, sem criar outra:
    // um cliente que não recebeu a resposta pode tentar de novo sem transferir
    // duas vezes. 201 quando é nova, 200 quando já lá estava.
    const { ordem: guardada, nova } = criarOrdem(cliente.id, ordem);
    return json(res, nova ? 201 : 200, ordemPublica(guardada));
  }

  // 1.3 O telemóvel pergunta se há trabalho. Autentica-se com o token da app,
  //     o mesmo do webhook — é o mesmo telemóvel, não vale a pena outro segredo.
  //
  //     Long-poll: o servidor segura o pedido até haver ordem ou até `espera`
  //     segundos. Sem isto era ou um pedido por segundo (bateria) ou minutos de
  //     atraso numa transferência. Não há push porque o telemóvel está atrás de
  //     NAT em dados móveis — ninguém lhe liga de fora.
  if (url.pathname === '/api/telemovel/ordens') {
    const cliente = porChave(req, 'token_hash');
    if (!cliente) return json(res, 401, { erro: 'token inválido' });
    // Desativar é decisão nossa e reversível: 503 para o telemóvel continuar a
    // tentar, tal como no webhook.
    if (!cliente.ativo) return json(res, 503, { erro: 'cliente desativado' });
    if (req.method !== 'GET') return json(res, 405, { erro: 'só GET' });

    // Mesma regra do webhook: quem está ao pé do SIM é quem sabe de que cliente
    // é este telemóvel. Assim um telemóvel registado noutro cliente recebe as
    // ordens desse, e não as do dono do token.
    const numero = normalizarNumero(url.searchParams.get('numero'));
    const { clienteId } = atribuir(url.searchParams.get('numero'), cliente.id);

    const espera = Math.min(Math.max(Number(url.searchParams.get('espera')) || 0, 0), 25);
    const ate = Date.now() + espera * 1000;
    for (;;) {
      const ordem = tomarOrdem(clienteId, numero);
      if (ordem) return json(res, 200, ordem);
      if (req.destroyed || Date.now() >= ate) break;
      await dormir(1000);
    }
    if (req.destroyed) return;          // o telemóvel desistiu: não há a quem responder
    res.writeHead(204);                 // 204 não leva corpo
    return res.end();
  }

  // 1.4 O telemóvel desistiu de uma ordem que levou (ver falharOrdem). Mesmo
  //     token e mesma regra do número que o pedido acima, para chegar ao mesmo
  //     cliente a quem a ordem foi entregue.
  const falha = /^\/api\/telemovel\/ordens\/(\d+)\/falha$/.exec(url.pathname);
  if (falha) {
    const cliente = porChave(req, 'token_hash');
    if (!cliente) return json(res, 401, { erro: 'token inválido' });
    if (!cliente.ativo) return json(res, 503, { erro: 'cliente desativado' });
    if (req.method !== 'POST') return json(res, 405, { erro: 'só POST' });

    const { motivo, numero } = JSON.parse(await corpoDe(req, 1024)) || {};
    if (!MOTIVOS_DO_TELEMOVEL.has(motivo)) return json(res, 400, { erro: 'motivo inválido' });
    const { clienteId } = atribuir(numero, cliente.id);
    // 200 mesmo que já não estivesse entregue: repetir o aviso tem de ser inofensivo.
    return json(res, 200, { ok: true, fechada: falharOrdem(Number(falha[1]), clienteId, motivo) });
  }

  // 2. Login.
  if (req.method === 'POST' && url.pathname === '/entrar') {
    if (travado(ip)) return json(res, 429, { erro: 'demasiadas tentativas' });
    const form = new URLSearchParams(await corpoDe(req, 1024));
    const cliente = db.prepare('SELECT * FROM clientes WHERE nome = ?')
      .get((form.get('cliente') || '').trim());

    if (!cliente || !cliente.ativo || !confere(form.get('senha') || '', cliente.senha)) {
      falhou(ip);
      res.writeHead(303, { Location: '/?erro=1' });
      return res.end();
    }
    const sid = randomBytes(24).toString('hex');
    sessoes.set(sid, { id: cliente.id, nome: cliente.nome, admin: !!cliente.admin });
    res.writeHead(303, {
      Location: cliente.admin ? '/admin' : '/',
      'Set-Cookie': `sessao=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`
        + (porHttps(req) ? '; Secure' : ''),
    });
    return res.end();
  }

  // 3. Estáticos, antes da sessão: a página de login também precisa da folha de
  //    estilo, e não há aqui dado nenhum para proteger.
  if (ESTATICOS[url.pathname]) {
    const [tipo, corpo] = ESTATICOS[url.pathname];
    res.writeHead(200, { 'Content-Type': `${tipo}; charset=utf-8` });
    return res.end(corpo);
  }

  // 4. Tudo o resto exige sessão.
  const sid = /(?:^|;\s*)sessao=([^;]+)/.exec(req.headers.cookie || '')?.[1] || '';
  const sessao = sessoes.get(sid);

  if (!sessao) {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN.replace('<!--erro-->',
        url.searchParams.has('erro')
          ? '<p class="erro" data-t="login.erro">Credenciais inválidas.</p>' : ''));
    }
    return json(res, 401, { erro: 'sessão inválida' });
  }

  if (url.pathname === '/sair') {
    sessoes.delete(sid);
    res.writeHead(303, { Location: '/', 'Set-Cookie': 'sessao=; Path=/; Max-Age=0' });
    return res.end();
  }

  const html = (corpo) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(corpo);
  };

  // `?cliente=` é como o admin espreita o painel de um cliente; sem isso vê a gestão.
  if (url.pathname === '/') {
    return html(sessao.admin && !url.searchParams.has('cliente') ? ADMIN : PAINEL);
  }
  if (url.pathname === '/admin') {
    if (!sessao.admin) return json(res, 403, { erro: 'sem permissão' });
    return html(ADMIN);
  }
  if (url.pathname === '/programadores') return html(PROGRAMADORES);

  /** O que o programador do cliente precisa de saber, já com os dados dele. */
  if (url.pathname === '/api/integracao') {
    const pedido = Number(url.searchParams.get('cliente'));
    if (!sessao.admin && pedido && pedido !== sessao.id) return json(res, 403, { erro: 'sem permissão' });
    const alvo = sessao.admin && pedido ? pedido : sessao.id;
    const c = db.prepare(
      'SELECT nome, formato_sms, formato_api, api_hash IS NOT NULL AS tem_chave FROM clientes WHERE id = ?'
    ).get(alvo);
    if (!c) return json(res, 404, { erro: 'cliente não existe' });
    return json(res, 200, {
      cliente: c.nome,
      formato_sms: c.formato_sms,
      formato_api: c.formato_api,
      tem_chave: !!c.tem_chave,
      numeros: numerosDe(alvo),
    });
  }

  // O cliente gera a sua própria chave de leitura — é dele, e já está autenticado.
  if (req.method === 'POST' && url.pathname === '/api/chave') {
    const p = JSON.parse(await corpoDe(req, 1024).catch(() => '{}'));
    const pedido = Number(p.cliente);
    if (!sessao.admin && pedido && pedido !== sessao.id) return json(res, 403, { erro: 'sem permissão' });
    const alvo = sessao.admin && pedido ? pedido : sessao.id;
    if (db.prepare('SELECT admin FROM clientes WHERE id = ?').get(alvo)?.admin) {
      return json(res, 400, { erro: 'o administrador não tem API de leitura' });
    }
    // Gerar outra invalida a anterior: o sistema do cliente pára até ser trocada.
    return json(res, 200, { chave: novaChaveApi(alvo) });
  }

  // O admin pode espreitar um cliente; um cliente só se vê a si.
  if (url.pathname === '/api/transferencias') {
    const pedido = Number(url.searchParams.get('cliente'));
    const alvo = sessao.admin && pedido ? pedido : sessao.id;
    if (!sessao.admin && pedido && pedido !== sessao.id) return json(res, 403, { erro: 'sem permissão' });
    const c = db.prepare('SELECT nome, criado_em FROM clientes WHERE id = ?').get(alvo);
    if (!c) return json(res, 404, { erro: 'cliente não existe' });
    // criado_em: distingue "nunca enviou nada ainda" de "deixou de enviar".
    return json(res, 200, {
      cliente: c.nome,
      criado_em: c.criado_em,
      ...consultar(alvo, Object.fromEntries(url.searchParams)),
    });
  }

  // As ordens por API, para o painel: o que falhou e se o cliente foi avisado.
  if (url.pathname === '/api/ordens') {
    const pedido = Number(url.searchParams.get('cliente'));
    if (!sessao.admin && pedido && pedido !== sessao.id) return json(res, 403, { erro: 'sem permissão' });
    const alvo = sessao.admin && pedido ? pedido : sessao.id;
    expirarOrdens();
    return json(res, 200, ordensDoPainel(alvo));
  }

  // Ordens de resultado incerto: o administrador vê o extrato e decide. Só aqui
  // se fecha uma `a_verificar` à mão, e é isso que dispara o callback.
  if (url.pathname === '/api/a-verificar') {
    if (!sessao.admin) return json(res, 403, { erro: 'sem permissão' });
    expirarOrdens();

    if (req.method === 'GET') return json(res, 200, { itens: ordensAVerificar() });

    if (req.method === 'POST') {
      const p = JSON.parse(await corpoDe(req, 1024));
      if (p.resultado !== 'sucesso' && p.resultado !== 'falha') {
        return json(res, 400, { erro: 'resultado tem de ser sucesso ou falha' });
      }
      const tid = String(p.tid ?? '').trim();
      if (tid && !TID_VALIDO.test(tid)) return json(res, 400, { erro: 'TID inválido' });
      // 409 e não 200: quem carregou no botão tem de saber que não foi a decisão
      // dele que ficou (o SMS chegou entretanto, ou outra janela decidiu antes).
      return decidirOrdem(Number(p.id), p.resultado, tid)
        ? json(res, 200, { ok: true })
        : json(res, 409, { erro: 'a ordem já não está a verificar' });
    }
  }

  // Um callback de mentira, assinado como os verdadeiros, para o programador do
  // cliente testar o recetor sem transferir dinheiro. Devolve só o status HTTP:
  // o corpo da resposta é do sistema dele e não tem de passar por aqui.
  if (req.method === 'POST' && url.pathname === '/api/callback-teste') {
    const p = JSON.parse(await corpoDe(req, 2048));
    const pedido = Number(p.cliente);
    if (!sessao.admin && pedido && pedido !== sessao.id) return json(res, 403, { erro: 'sem permissão' });
    const alvo = sessao.admin && pedido ? pedido : sessao.id;
    const c = db.prepare('SELECT api_hash FROM clientes WHERE id = ? AND admin = 0').get(alvo);
    if (!c) return json(res, 404, { erro: 'cliente não existe' });
    if (!c.api_hash) return json(res, 400, { erro: 'sem chave: a assinatura precisa dela' });
    if (!urlNotificacaoValida(p.url)) return json(res, 400, { erro: 'notify_url inválido' });

    const resultado = p.resultado === 'falha' ? 'falha' : 'sucesso';
    const agora = Date.now();
    const corpo = {
      ref: 'TESTE-CALLBACK',
      id: 0,
      sequencia: 'Transferir',
      campos: { valor: '1', iban: 'AO06…00000' },
      estado: resultado,
      motivo: resultado === 'falha' ? MOTIVO.NAO_RECOLHIDA : null,
      tid: resultado === 'sucesso' ? 'TESTE.0000.000000' : null,
      criado_em: agora - 30000,
      entregue_em: resultado === 'sucesso' ? agora - 25000 : null,
    };
    return json(res, 200, { status: await enviarCallback(p.url, corpo, c.api_hash), corpo });
  }

  // Transferências vindas de telemóveis que ninguém reclamou, e a sua resolução.
  if (url.pathname === '/api/por-atribuir') {
    if (!sessao.admin) return json(res, 403, { erro: 'sem permissão' });

    if (req.method === 'GET') return json(res, 200, { itens: porAtribuir() });

    if (req.method === 'POST') {
      const p = JSON.parse(await corpoDe(req, 4096));
      const destino = db.prepare('SELECT id, nome FROM clientes WHERE id = ? AND admin = 0')
        .get(Number(p.cliente));
      if (!destino) return json(res, 404, { erro: 'cliente não existe' });

      const t = db.prepare('SELECT numero_origem FROM transferencias WHERE tid = ?').get(String(p.tid));
      if (!t) return json(res, 404, { erro: 'transferência não existe' });

      // Registar o número ao mesmo tempo é o que evita repetir isto a cada
      // transferência do mesmo telemóvel. Só se o número ainda for de ninguém.
      const registar = !!p.registarNumero && !!t.numero_origem && !validarNumeroLivre(t.numero_origem);

      // As irmãs têm de ser recolhidas antes de qualquer UPDATE: tanto registar o
      // número como marcar esta linha as tiram da lista de porAtribuir().
      const n = normalizarNumero(t.numero_origem);
      const irmas = registar
        ? porAtribuir().filter((o) => normalizarNumero(o.numero_origem) === n && o.tid !== p.tid)
        : [];

      const mover = db.prepare('UPDATE transferencias SET cliente_id = ?, atribuido_por = ? WHERE tid = ?');
      // 'manual' só na que foi escolhida à mão; as outras seguem a regra do número.
      mover.run(destino.id, 'manual', String(p.tid));
      for (const outra of irmas) mover.run(destino.id, 'numero', outra.tid);
      if (registar) registarNumero(destino.id, t.numero_origem);

      return json(res, 200, { ok: true, cliente: destino.nome, movidas: 1 + irmas.length, registar });
    }
  }

  // 4. Administração de clientes.
  if (url.pathname === '/api/clientes') {
    if (!sessao.admin) return json(res, 403, { erro: 'sem permissão' });

    if (req.method === 'GET') return json(res, 200, { clientes: listarClientes() });

    if (req.method === 'POST') {
      const p = JSON.parse(await corpoDe(req, 4096));

      if (p.accao === 'criar') {
        const nome = validarNome(p.nome);
        if (!nome) return json(res, 400, { erro: 'nome inválido' });
        if (String(p.senha || '').length < 8) return json(res, 400, { erro: 'senha com menos de 8 caracteres' });
        if (db.prepare('SELECT 1 FROM clientes WHERE nome = ?').get(nome)) {
          return json(res, 409, { erro: 'já existe um cliente com esse nome' });
        }
        // O número é opcional na criação mas é o caminho normal: regista-se já o
        // SIM do telemóvel que vai trabalhar para este cliente.
        const numero = String(p.numero || '').trim();
        if (numero) {
          const erroNumero = validarNumeroLivre(numero);
          if (erroNumero) return json(res, 409, { erro: erroNumero });
        }

        const { lastInsertRowid } = db.prepare(
          'INSERT INTO clientes (nome, senha, criado_em) VALUES (?, ?, ?)'
        ).run(nome, cifrar(p.senha), Date.now());
        const id = Number(lastInsertRowid);
        if (numero) registarNumero(id, numero);

        // O token em claro aparece uma única vez, aqui.
        return json(res, 200, { id, nome, numero, token: novoToken(id) });
      }

      const alvo = db.prepare('SELECT * FROM clientes WHERE id = ?').get(Number(p.id));
      if (!alvo) return json(res, 404, { erro: 'cliente não existe' });
      if (alvo.admin) return json(res, 400, { erro: 'o administrador não se gere por aqui' });

      if (p.accao === 'token') {
        // O número vai junto: a faixa mostra a configuração completa da app.
        return json(res, 200, {
          token: novoToken(alvo.id),
          numero: numerosDe(alvo.id).map((n) => n.bruto).join(', '),
        });
      }

      if (p.accao === 'estado') {
        db.prepare('UPDATE clientes SET ativo = ? WHERE id = ?').run(p.ativo ? 1 : 0, alvo.id);
        // Desativar fecha a sessão aberta; o webhook passa a devolver 503.
        if (!p.ativo) fecharSessoes(alvo.id);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'senha') {
        if (String(p.senha || '').length < 8) return json(res, 400, { erro: 'senha com menos de 8 caracteres' });
        db.prepare('UPDATE clientes SET senha = ? WHERE id = ?').run(cifrar(p.senha), alvo.id);
        fecharSessoes(alvo.id);   // quem estava dentro volta a entrar com a senha nova
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'renomear') {
        const nome = validarNome(p.nome);
        if (!nome) return json(res, 400, { erro: 'nome inválido' });
        if (db.prepare('SELECT 1 FROM clientes WHERE nome = ? AND id <> ?').get(nome, alvo.id)) {
          return json(res, 409, { erro: 'já existe um cliente com esse nome' });
        }
        // O nome é o utilizador do login: mudá-lo obriga a avisar o cliente.
        db.prepare('UPDATE clientes SET nome = ? WHERE id = ?').run(nome, alvo.id);
        fecharSessoes(alvo.id);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'formato') {
        const exemplo = String(p.formato ?? '').trim();
        if (exemplo.length > 500) return json(res, 400, { erro: 'exemplo demasiado longo' });
        // Um SMS com "TID:" é lido como confirmação e nunca dispara a sequência
        // (SmsTrigger verifica a confirmação primeiro). Apanha-se já aqui.
        if (/TID:/i.test(exemplo)) {
          return json(res, 400, { erro: 'o exemplo não pode conter "TID:" — a app leria isso como uma confirmação' });
        }
        db.prepare('UPDATE clientes SET formato_sms = ? WHERE id = ?').run(exemplo || null, alvo.id);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'formatoApi') {
        const exemplo = String(p.formato ?? '').trim();
        if (!exemplo) {
          db.prepare('UPDATE clientes SET formato_api = NULL WHERE id = ?').run(alvo.id);
          return json(res, 200, { ok: true });
        }
        if (exemplo.length > 500) return json(res, 400, { erro: 'exemplo demasiado longo' });

        // Validado pelo mesmo validador do endpoint real, com uma ref de mentira:
        // um exemplo que o painel aceitasse mas a API recusasse seria pior do que
        // não ter exemplo nenhum — o programador do cliente copia-o tal e qual.
        const corpo = (() => { try { return JSON.parse(exemplo); } catch { return null; } })();
        if (!corpo) return json(res, 400, { erro: 'não é JSON válido' });
        const { erro } = validarOrdem({ ...corpo, ref: 'EXEMPLO' });
        if (erro) return json(res, 400, { erro });

        db.prepare('UPDATE clientes SET formato_api = ? WHERE id = ?').run(exemplo, alvo.id);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'chaveApi') return json(res, 200, { chave: novaChaveApi(alvo.id) });

      if (p.accao === 'numero') {
        const bruto = String(p.numero || '').trim();
        const erroNumero = validarNumeroLivre(bruto);
        if (erroNumero) return json(res, 409, { erro: erroNumero });
        registarNumero(alvo.id, bruto);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'tirarNumero') {
        // Não mexe nas transferências já atribuídas: o que passou, passou.
        const n = normalizarNumero(p.numero);
        db.prepare('DELETE FROM numeros WHERE numero = ? AND cliente_id = ?').run(n, alvo.id);
        return json(res, 200, { ok: true });
      }

      if (p.accao === 'remover') {
        // Registos financeiros não se apagam por engano: com histórico só se desativa.
        const { n } = db.prepare('SELECT COUNT(*) n FROM transferencias WHERE cliente_id = ?').get(alvo.id);
        if (n > 0) {
          return json(res, 409, {
            erro: `${alvo.nome} tem ${n} transferência(s) no histórico. Desativa em vez de remover.`,
          });
        }
        db.prepare('DELETE FROM clientes WHERE id = ?').run(alvo.id);
        fecharSessoes(alvo.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 400, { erro: 'acção desconhecida' });
    }
  }

  json(res, 404, { erro: 'não existe' });
}

const server = http.createServer((req, res) => {
  tratar(req, res).catch((e) => {
    console.error(req.method, req.url, '→', e.message);   // nunca o corpo: são dados financeiros
    if (!res.headersSent) json(res, e instanceof SyntaxError ? 400 : 503, { erro: 'pedido inválido' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Painel em http://localhost:${PORT}`));
  // Expira ordens de telemóveis mortos e repete callbacks falhados. `unref`: não
  // é isto que segura o processo.
  setInterval(() => { expirarOrdens(); notificarPendentes(); }, NOTIF_BASE_MS).unref();
}

module.exports = {
  paraNumero, validar, consultar, resumo, cifrar, confere, novoToken,
  normalizarNumero, atribuir, registarNumero, porAtribuir, carteiras, db, server,
  validarOrdem, criarOrdem, tomarOrdem, falharOrdem, expirarOrdens, ORDEM_TIMEOUT_MS, ordensDoPainel, MOTIVO,
  notificarPendentes, NOTIF_MAX_TENTATIVAS, decidirOrdem, ordensAVerificar, estadoPublico,
};
