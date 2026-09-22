// Painel de transferências — recebe os webhooks da app Access e serve a listagem.
// Multi-cliente: cada cliente tem o seu token de webhook, a sua senha e vê só os
// seus registos. Sem dependências: node:http + node:sqlite (Node 22+).
// Contrato e armadilhas: ../BACKOFFICE.md

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual, randomBytes, scryptSync, createHash } = require('node:crypto');
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
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_hash ON clientes(api_hash)');

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
  const { tid, iban_ultimos5, valor, estado, momento, numero } = corpo;
  if (typeof tid !== 'string' || !TID_VALIDO.test(tid)) return { erro: 'tid inválido' };
  if (estado !== 'sucesso' && estado !== 'falha') return { erro: 'estado inválido' };
  if (!Number.isFinite(momento) || momento <= 0) return { erro: 'momento inválido' };
  if (iban_ultimos5 != null && !/^\d{5}$/.test(String(iban_ultimos5))) {
    return { erro: 'iban_ultimos5 inválido' };
  }
  // Só dígitos, ponto e vírgula — é o que o parser da app extrai. Fecha também a
  // porta a HTML injetado, já que o painel mostra este texto tal como veio.
  if (valor != null && !/^[\d.,]{1,20}$/.test(String(valor))) return { erro: 'valor inválido' };
  // Campo opcional (a app só o envia se estiver configurado). Formato largo de
  // propósito — o que conta é a forma normalizada, não como foi escrito.
  if (numero != null && !/^[\d+()\-. ]{1,25}$/.test(String(numero))) {
    return { erro: 'numero inválido' };
  }
  return {
    registo: {
      tid,
      iban_ultimos5: iban_ultimos5 == null ? null : String(iban_ultimos5),
      valor_texto: valor == null ? null : String(valor),
      valor: paraNumero(valor),
      estado,
      momento,
      numero_origem: numero == null ? null : String(numero).trim() || null,
    },
  };
}

// --- consultas -------------------------------------------------------------

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

  return { itens, numeros: numerosDe(clienteId), ...resumo(clienteId) };
}

const numerosDe = (clienteId) => db.prepare(
  'SELECT numero, bruto FROM numeros WHERE cliente_id = ? ORDER BY criado_em'
).all(clienteId);

function listarClientes() {
  return db.prepare(
    `SELECT id, nome, ativo, admin, criado_em, formato_sms,
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
    const auth = req.headers.authorization || '';
    const cliente = auth.startsWith('Bearer ')
      ? db.prepare('SELECT id, ativo FROM clientes WHERE token_hash = ?').get(hashToken(auth.slice(7)))
      : null;
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
            recebido_em, numero_origem, atribuido_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tid) DO NOTHING`
      ).run(registo.tid, clienteId, registo.iban_ultimos5, registo.valor_texto,
            registo.valor, registo.estado, registo.momento, recebidoEmUnico(),
            registo.numero_origem, por);
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
    const auth = req.headers.authorization || '';
    const cliente = auth.startsWith('Bearer ')
      ? db.prepare('SELECT id, nome, ativo FROM clientes WHERE api_hash = ?').get(hashToken(auth.slice(7)))
      : null;
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
    const c = db.prepare('SELECT nome, formato_sms, api_hash IS NOT NULL AS tem_chave FROM clientes WHERE id = ?').get(alvo);
    if (!c) return json(res, 404, { erro: 'cliente não existe' });
    return json(res, 200, {
      cliente: c.nome,
      formato_sms: c.formato_sms,
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
}

module.exports = {
  paraNumero, validar, consultar, resumo, cifrar, confere, novoToken,
  normalizarNumero, atribuir, registarNumero, porAtribuir, db, server,
};
