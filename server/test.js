// node server/test.js  — sem framework, falha com exit != 0
process.env.ADMIN_PASS ||= 'admin-teste';
process.env.DB_PATH = ':memory:';

const assert = require('node:assert/strict');
const {
  paraNumero, validar, consultar, resumo, cifrar, confere, novoToken,
  normalizarNumero, atribuir, registarNumero, porAtribuir, db,
} = require('./server.js');

// --- formato angolano: ponto é milhares, vírgula é decimal -----------------
assert.equal(paraNumero('500'), 500);
assert.equal(paraNumero('1.500'), 1500);
assert.equal(paraNumero('1.500,50'), 1500.5);
assert.equal(paraNumero('1500,50'), 1500.5);
assert.equal(paraNumero('12,5'), 12.5);
assert.equal(paraNumero(null), null);
assert.equal(paraNumero('abc'), null);

// --- validação do payload --------------------------------------------------
const bom = { tid: 'MP260921.2313.B09562', iban_ultimos5: '10219', valor: '500', estado: 'sucesso', momento: 1758496380000 };
assert.equal(validar(bom).erro, undefined);
assert.ok(validar({ ...bom, tid: 'a b' }).erro);
assert.ok(validar({ ...bom, estado: 'talvez' }).erro);
assert.ok(validar({ ...bom, momento: 'ontem' }).erro);
assert.ok(validar({ ...bom, valor: '<script>' }).erro);
assert.equal(validar({ ...bom, iban_ultimos5: null, valor: null }).erro, undefined);
assert.equal(validar({ ...bom, numero: '+244 923 456 789' }).erro, undefined);
assert.ok(validar({ ...bom, numero: 'o meu telemovel' }).erro);
assert.equal(validar(bom).registo.numero_origem, null, 'sem numero no payload fica null');

// --- números de telemóvel: a mesma SIM escrita de todas as maneiras ---------
assert.equal(normalizarNumero('+244 923 456 789'), '923456789');
assert.equal(normalizarNumero('00244923456789'), '923456789');
assert.equal(normalizarNumero('923456789'), '923456789');
assert.equal(normalizarNumero('923-456-789'), '923456789');
assert.equal(normalizarNumero('(244) 923.456.789'), '923456789');
assert.equal(normalizarNumero('12345678'), null, 'dígitos a menos não é número');
assert.equal(normalizarNumero(''), null);
assert.equal(normalizarNumero(null), null);

// --- senhas ----------------------------------------------------------------
const h = cifrar('segredo-longo');
assert.ok(confere('segredo-longo', h));
assert.ok(!confere('segredo-long', h));
assert.notEqual(h, cifrar('segredo-longo'), 'sal diferente a cada vez');

// --- clientes --------------------------------------------------------------
assert.ok(db.prepare("SELECT 1 FROM clientes WHERE nome='admin' AND admin=1").get(), 'admin criado ao arrancar');

const criar = (nome) => Number(db.prepare('INSERT INTO clientes (nome, senha, criado_em) VALUES (?,?,?)')
  .run(nome, cifrar('12345678'), Date.now()).lastInsertRowid);
const a = criar('Cliente A');
const b = criar('Cliente B');

const t1 = novoToken(a);
const t2 = novoToken(a);
assert.notEqual(t1, t2, 'gerar token novo invalida o anterior');
assert.equal(db.prepare('SELECT COUNT(*) n FROM clientes WHERE token_hash = ?')
  .get(require('node:crypto').createHash('sha256').update(t1).digest('hex')).n, 0, 'token antigo já não encontra cliente');

// --- atribuição: de quem é a transferência ---------------------------------
registarNumero(a, '+244 923 456 789');

// O número manda: a transferência é de quem tem aquele SIM, mesmo que o token
// pertença a outro cliente (telemóvel partilhado a servir vários tenants).
assert.deepEqual(atribuir('923456789', b), { clienteId: a, por: 'numero' });
assert.deepEqual(atribuir('+244 923-456-789', b), { clienteId: a, por: 'numero' },
  'a forma como foi escrito não pode mudar o resultado');

// Sem número, ou de um telemóvel ainda não registado, fica com o dono do token —
// não se perde, e aparece em "por atribuir".
assert.deepEqual(atribuir(null, b), { clienteId: b, por: 'token' });
assert.deepEqual(atribuir('999888777', b), { clienteId: b, por: 'token' });
assert.deepEqual(atribuir('lixo', b), { clienteId: b, por: 'token' });

// Um número só pode servir um cliente, senão não identifica ninguém.
assert.throws(() => registarNumero(b, '923 456 789'), 'o mesmo número em dois clientes');

// --- transferências: isolamento por cliente --------------------------------
const gravar = (clienteId, p, por = 'token') => {
  const r = validar(p).registo;
  db.prepare(`INSERT INTO transferencias
      (tid, cliente_id, iban_ultimos5, valor_texto, valor, estado, momento, recebido_em,
       numero_origem, atribuido_por)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tid) DO NOTHING`)
    .run(r.tid, clienteId, r.iban_ultimos5, r.valor_texto, r.valor, r.estado, r.momento,
         Date.now(), r.numero_origem, por);
};

const agora = Date.now();
gravar(a, { ...bom, tid: 'AAA111.0001', valor: '500', momento: agora });
gravar(a, { ...bom, tid: 'AAA111.0001', valor: '500', momento: agora });        // reenvio: inofensivo
gravar(a, { ...bom, tid: 'AAA111.0002', valor: '1.500', estado: 'falha', momento: agora - 1000 });
gravar(b, { ...bom, tid: 'BBB222.0001', valor: '9.000', momento: agora - 2000 });

const rA = consultar(a, {});
assert.equal(rA.itens.length, 2, 'dedupe por tid');
assert.equal(rA.itens[0].tid, 'AAA111.0001', 'ordena por momento desc');
assert.equal(rA.total.v, 500, 'saldo do A não inclui o B nem a falha');
assert.equal(rA.rever, 1);
assert.ok(rA.saude.silencio_ms < 5000);

const rB = consultar(b, {});
assert.equal(rB.itens.length, 1, 'cliente B só vê o seu');
assert.equal(rB.total.v, 9000);
assert.equal(rB.rever, 0);

assert.equal(consultar(a, { estado: 'falha' }).itens.length, 1);
assert.equal(resumo(criar('Cliente C')).total.v, 0, 'cliente sem registos não rebenta');
assert.equal(resumo(criar('Cliente D')).saude.silencio_ms, null);

// --- webhook ao vivo: é aqui que se vê o código de resposta, que decide se a app
//     guarda ou descarta o payload ---------------------------------------------
const { server } = require('./server.js');

server.listen(0, async () => {
  const P = `http://localhost:${server.address().port}`;
  const envia = (token, corpo) => fetch(P + '/webhooks/transferencias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  }).then((r) => r.status);

  const p = (tid) => ({ ...bom, tid });
  assert.equal(await envia(t2, p('CCC333.0001')), 200);
  assert.equal(await envia(t2, p('CCC333.0001')), 200, 'reenvio devolve 200');
  assert.equal(await envia('nao-existe', p('CCC333.0002')), 401, 'token desconhecido: 4xx, a app descarta');
  assert.equal(await envia(t2, { ...bom, tid: 'x' }), 400, 'payload mau: 4xx');

  // Cliente desativado tem de dar 503: com 4xx a app apagava da fila e o SMS não volta.
  db.prepare('UPDATE clientes SET ativo = 0 WHERE id = ?').run(a);
  assert.equal(await envia(t2, p('CCC333.0003')), 503, 'desativado: 5xx, a app mantém em fila');
  db.prepare('UPDATE clientes SET ativo = 1 WHERE id = ?').run(a);
  assert.equal(await envia(t2, p('CCC333.0003')), 200, 'reativado: entrega');

  // --- gestão de clientes: o que protege o histórico --------------------------
  const login = await fetch(P + '/entrar', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'cliente=admin&senha=' + process.env.ADMIN_PASS,
  });
  assert.equal(login.headers.get('location'), '/admin');
  const cookieAdmin = login.headers.get('set-cookie').split(';')[0];
  assert.ok(!login.headers.get('set-cookie').includes('Secure'), 'em http local, sem Secure');

  // Atrás de um proxy TLS o cookie tem de sair com Secure, senão podia voltar
  // numa ligação em claro.
  const viaProxy = await fetch(P + '/entrar', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Proto': 'https' },
    body: 'cliente=admin&senha=' + process.env.ADMIN_PASS,
  });
  assert.match(viaProxy.headers.get('set-cookie'), /; Secure$/);

  const admin = (corpo) => fetch(P + '/api/clientes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify(corpo),
  });

  // Remover um cliente com histórico tem de ser recusado: são registos financeiros.
  assert.equal((await admin({ accao: 'remover', id: a })).status, 409);
  // Sem histórico, remove.
  const vazio = criar('Para Remover');
  assert.equal((await admin({ accao: 'remover', id: vazio })).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM clientes WHERE id = ?').get(vazio), undefined);

  // O admin não se gere pela lista de clientes.
  const idAdmin = db.prepare("SELECT id FROM clientes WHERE nome='admin'").get().id;
  assert.equal((await admin({ accao: 'remover', id: idAdmin })).status, 400);

  assert.equal((await admin({ accao: 'renomear', id: b, nome: 'Cliente A' })).status, 409, 'nome duplicado');
  assert.equal((await admin({ accao: 'renomear', id: b, nome: '<script>' })).status, 400);
  assert.equal((await admin({ accao: 'renomear', id: b, nome: 'Cliente B2' })).status, 200);
  assert.equal(db.prepare('SELECT nome FROM clientes WHERE id = ?').get(b).nome, 'Cliente B2');

  // --- atribuição ponta-a-ponta ----------------------------------------------
  // O token é de A; o número é de B. Ganha o número: é quem está ao pé do SIM.
  const nB = '924 111 222';
  assert.equal((await admin({ accao: 'numero', id: b, numero: nB })).status, 200);
  assert.equal((await admin({ accao: 'numero', id: a, numero: nB })).status, 409,
    'o mesmo número não pode servir dois clientes');

  assert.equal(await envia(t2, { ...bom, tid: 'NUM111.0001', numero: '+244 924 111 222' }), 200);
  const doB = db.prepare('SELECT cliente_id, atribuido_por FROM transferencias WHERE tid = ?').get('NUM111.0001');
  assert.equal(doB.cliente_id, b, 'atribuída ao dono do número, não ao dono do token');
  assert.equal(doB.atribuido_por, 'numero');

  // Telemóvel desconhecido: fica com o dono do token e entra na lista a resolver.
  assert.equal(await envia(t2, { ...bom, tid: 'NUM111.0002', numero: '930 000 001' }), 200);
  assert.equal(await envia(t2, { ...bom, tid: 'NUM111.0003', numero: '930-000-001' }), 200);
  const pendentes = porAtribuir().map((t) => t.tid);
  assert.deepEqual(pendentes.sort(), ['NUM111.0002', 'NUM111.0003']);

  // Resolver uma delas a registar o número arrasta as irmãs do mesmo telemóvel.
  const r = await fetch(P + '/api/por-atribuir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookieAdmin },
    body: JSON.stringify({ tid: 'NUM111.0002', cliente: b, registarNumero: true }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).movidas, 2, 'as duas do mesmo número vão juntas');
  assert.equal(porAtribuir().length, 0, 'a lista fica vazia');
  for (const tid of ['NUM111.0002', 'NUM111.0003']) {
    assert.equal(db.prepare('SELECT cliente_id FROM transferencias WHERE tid = ?').get(tid).cliente_id, b);
  }

  // A partir daqui o telemóvel é conhecido e a atribuição é automática.
  assert.equal(await envia(t2, { ...bom, tid: 'NUM111.0004', numero: '930 000 001' }), 200);
  assert.equal(db.prepare('SELECT atribuido_por FROM transferencias WHERE tid = ?')
    .get('NUM111.0004').atribuido_por, 'numero');

  // E um cliente continua a ver só o que é seu, seja como foi atribuído.
  assert.ok(consultar(b, {}).itens.some((t) => t.tid === 'NUM111.0001'));
  assert.ok(!consultar(a, {}).itens.some((t) => t.tid.startsWith('NUM111')));

  // --- API de leitura do cliente ---------------------------------------------
  const chave = (await (await admin({ accao: 'chaveApi', id: b })).json()).chave;
  assert.match(chave, /^ak_[0-9a-f]{48}$/);

  const lerApi = (qs = '', k = chave) => fetch(`${P}/api/v1/transferencias${qs}`, {
    headers: { Authorization: `Bearer ${k}` },
  });

  assert.equal((await lerApi('', 'ak_errada')).status, 401);
  assert.equal((await fetch(P + '/api/v1/transferencias')).status, 401, 'sem cabeçalho');
  assert.equal((await fetch(P + '/api/v1/transferencias', {
    method: 'POST', headers: { Authorization: `Bearer ${chave}` },
  })).status, 405);

  // A chave do B não vê nada do A: é o isolamento que a API tem de garantir.
  const pagina = await (await lerApi()).json();
  assert.equal(pagina.cliente, 'Cliente B2');
  assert.ok(pagina.itens.length > 0);
  assert.ok(pagina.itens.every((t) => t.tid !== 'AAA111.0001'), 'nada do cliente A');
  assert.deepEqual(Object.keys(pagina.itens[0]).sort(),
    ['estado', 'iban_ultimos5', 'momento', 'recebido_em', 'tid', 'valor', 'valor_numerico'],
    'a forma do item é contrato público — mudá-la parte a integração do cliente');

  // Ordem crescente por recebido_em, que é o que torna o cursor utilizável.
  const recebidos = pagina.itens.map((t) => t.recebido_em);
  assert.deepEqual(recebidos, [...recebidos].sort((x, y) => x - y), 'por recebido_em ASC');
  assert.equal(new Set(recebidos).size, recebidos.length,
    'recebido_em tem de ser único, senão a paginação perde registos na fronteira');

  // Percorrer com limite 1 tem de devolver exatamente tudo, sem repetir nem saltar.
  const todos = [];
  let cursor = 0;
  for (let i = 0; i < 50; i++) {
    const p = await (await lerApi(`?desde=${cursor}&limite=1`)).json();
    if (!p.itens.length) break;
    todos.push(...p.itens.map((t) => t.tid));
    cursor = p.proximo_desde;
  }
  assert.deepEqual(todos, pagina.itens.map((t) => t.tid), 'paginar 1 a 1 dá o mesmo conjunto');
  assert.equal(new Set(todos).size, todos.length, 'sem repetições');

  // Cursor no fim: nada de novo, e o cursor não recua.
  const vazia = await (await lerApi(`?desde=${cursor}`)).json();
  assert.equal(vazia.itens.length, 0);
  assert.equal(vazia.proximo_desde, cursor, 'sem itens, o cursor fica onde estava');
  assert.equal(vazia.ha_mais, false);

  // Desativado não lê: a chave continua válida mas o acesso está suspenso.
  await admin({ accao: 'estado', id: b, ativo: false });
  assert.equal((await lerApi()).status, 403);
  await admin({ accao: 'estado', id: b, ativo: true });

  // Gerar outra chave mata a anterior de imediato.
  const chaveNova = (await (await admin({ accao: 'chaveApi', id: b })).json()).chave;
  assert.notEqual(chaveNova, chave);
  assert.equal((await lerApi('', chave)).status, 401, 'a chave antiga morre');
  assert.equal((await lerApi('', chaveNova)).status, 200);

  // --- formato do SMS de pedido -----------------------------------------------
  assert.equal((await admin({ accao: 'formato', id: b, formato: 'levantar iban: AO06x valor: 5000' })).status, 200);
  // Um exemplo com "TID:" seria lido pela app como confirmação e nunca dispararia.
  assert.equal((await admin({ accao: 'formato', id: b, formato: 'levantar TID: 123' })).status, 400);
  assert.equal((await admin({ accao: 'formato', id: b, formato: 'x'.repeat(501) })).status, 400);
  assert.equal(db.prepare('SELECT formato_sms FROM clientes WHERE id = ?').get(b).formato_sms,
    'levantar iban: AO06x valor: 5000', 'o exemplo recusado não substituiu o bom');

  server.close();
  console.log('ok');
});
