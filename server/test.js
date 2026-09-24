// node server/test.js  — sem framework, falha com exit != 0
process.env.ADMIN_PASS ||= 'admin-teste';
process.env.DB_PATH = ':memory:';

const assert = require('node:assert/strict');
const {
  paraNumero, validar, consultar, resumo, cifrar, confere, novoToken,
  normalizarNumero, atribuir, registarNumero, porAtribuir, carteiras, db,
  validarOrdem, expirarOrdens, ORDEM_TIMEOUT_MS, notificarPendentes, NOTIF_MAX_TENTATIVAS,
  ordensDoPainel, MOTIVO,
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

// --- ordens: os campos entram nos passos como {valor}, e os marcadores da app
//     são minúsculas — "VALOR" tem de chegar lá como "valor" -------------------
assert.deepEqual(
  JSON.parse(validarOrdem({ ref: 'r1', sequencia: 'Transferir', campos: { VALOR: '500' } }).ordem.campos),
  { valor: '500' },
);
assert.equal(validarOrdem({ ref: 'r1', sequencia: 'T', numero: '+244 923 456 789' }).ordem.numero, '923456789');
assert.ok(validarOrdem(null).erro);

// --- o valor vai tal e qual para o USSD, que só aceita kwanzas inteiros: "200.00"
//     era escrito assim e a ordem expirava sem TID ----------------------------
const valorDe = (valor) => {
  const r = validarOrdem({ ref: 'r1', sequencia: 'T', campos: { valor } });
  return r.erro ? 'ERRO' : JSON.parse(r.ordem.campos).valor;
};
assert.equal(valorDe('200.00'), '200');
assert.equal(valorDe('200,00'), '200');
assert.equal(valorDe('1.00'), '1');
assert.equal(valorDe('1.0'), '1');
assert.equal(valorDe('500'), '500');
assert.equal(valorDe('0500'), '500');
assert.equal(valorDe(200), '200', 'número JSON também');
assert.equal(valorDe('200.50'), 'ERRO', 'cêntimos não se arredondam em silêncio');
assert.equal(valorDe('1.500'), 'ERRO', 'ponto de milhares é ambíguo');
assert.equal(valorDe('1 500'), 'ERRO');
assert.equal(valorDe('0'), 'ERRO');
assert.equal(valorDe('0.00'), 'ERRO');
assert.equal(valorDe('-5'), 'ERRO');
assert.equal(valorDe('abc'), 'ERRO');
assert.equal(validarOrdem({ ref: 'r1', sequencia: 'T', campos: { iban: 'AO06.0040' } }).erro, undefined,
  'só o valor é normalizado');

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
       numero_origem, numero_norm, atribuido_por, saldo_texto, saldo)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tid) DO NOTHING`)
    .run(r.tid, clienteId, r.iban_ultimos5, r.valor_texto, r.valor, r.estado, r.momento,
         Date.now(), r.numero_origem, r.numero_norm, por, r.saldo_texto, r.saldo);
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

// --- carteiras: quanto resta em cada telemóvel -----------------------------
// Três SIM do mesmo cliente: o painel tem de os separar, senão um telemóvel que
// se cale (ou que fique sem saldo) fica escondido atrás dos outros.
const pool = criar('Cliente Pool');
for (const n of ['931 000 001', '931 000 002', '931 000 003']) registarNumero(pool, n);

const comSaldo = (tid, numero, valor, saldo, quando) =>
  gravar(pool, { ...bom, tid, valor, saldo, numero, momento: quando }, 'numero');

comSaldo('POOL.A1', '931000001', '500', '5000', agora - 3000);
comSaldo('POOL.A2', '931000001', '500', '4500', agora - 1000);   // mais recente do SIM 1
comSaldo('POOL.B1', '+244 931 000 002', '1.000', '12.500,50', agora - 2000);
// O terceiro nunca enviou nada.

const c = carteiras(pool);
assert.equal(c.length, 3, 'uma carteira por número registado');

assert.equal(c[0].saldo, 4500, 'o saldo é o da confirmação mais recente, não a primeira');
assert.equal(c[0].transferencias, 2);
assert.ok(c[0].silencio_ms < 5000);

assert.equal(c[1].saldo, 12500.5, 'formato angolano interpretado');
assert.equal(c[1].saldo_texto, '12.500,50', 'e o texto original fica guardado');
assert.equal(c[1].transferencias, 1, 'a forma como o número foi escrito não separa carteiras');

assert.equal(c[2].saldo, null, 'sem confirmações não se inventa saldo');
assert.equal(c[2].silencio_ms, null, 'null = nunca deu sinal, que não é o mesmo que zero');

// Uma confirmação sem saldo no SMS não apaga o último conhecido.
comSaldo('POOL.A3', '931000001', '100', null, agora - 500);
assert.equal(carteiras(pool)[0].saldo, 4500, 'o saldo conhecido mantém-se');
assert.equal(carteiras(pool)[0].transferencias, 3, 'mas a transferência conta');

// E as carteiras de um cliente nunca somam as de outro.
assert.equal(carteiras(a).length, 1);
assert.equal(carteiras(a)[0].saldo, null, 'o cliente A não vê o saldo do pool');

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

  // --- ordens: o trigger por API ----------------------------------------------
  // O telemóvel com o token t2 é do cliente A; o número 924 111 222 está
  // registado no B. É por aí que se vê a quem pertencem as ordens.
  const chaveA = (await (await admin({ accao: 'chaveApi', id: a })).json()).chave;

  const pedir = (corpo, k = chaveA) => fetch(P + '/api/v1/ordens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
    body: JSON.stringify(corpo),
  });
  const buscar = (qs = '', t = t2) => fetch(`${P}/api/telemovel/ordens${qs}`, {
    headers: { Authorization: `Bearer ${t}` },
  });

  assert.equal((await pedir({ ref: 'x1', sequencia: 'Transferir' }, 'ak_errada')).status, 401);
  assert.equal((await buscar('', 'token-errado')).status, 401);

  const base = { ref: 'PED-001', sequencia: 'Transferir', campos: { valor: '500', iban: 'AO06.0040' } };
  const criada = await pedir(base);
  assert.equal(criada.status, 201);
  const o1 = await criada.json();
  assert.equal(o1.estado, 'pendente');
  assert.deepEqual(o1.campos, { valor: '500', iban: 'AO06.0040' });

  // Repetir a mesma ref não cria outra transferência — é a rede do cliente que
  // pode falhar depois de nós gravarmos, e ele tem de poder tentar de novo.
  const repetida = await pedir({ ...base, campos: { valor: '99999' } });
  assert.equal(repetida.status, 200);
  const o2 = await repetida.json();
  assert.equal(o2.id, o1.id);
  assert.deepEqual(o2.campos, o1.campos, 'a repetição não sobrescreve o que já estava');

  for (const mau of [
    { ...base, ref: 'com espaço' },
    { ...base, ref: '' },
    { ...base, sequencia: '<script>' },
    { ...base, sequencia: '' },
    { ...base, ref: 'PED-002', campos: { 'va lor': '5' } },
    { ...base, ref: 'PED-002', campos: { valor: '<b>' } },
    { ...base, ref: 'PED-002', campos: { valor: 'a\nb' } },
    { ...base, ref: 'PED-002', numero: '123' },
  ]) {
    assert.equal((await pedir(mau)).status, 400, `devia recusar: ${JSON.stringify(mau)}`);
  }

  // O telemóvel do B não pode levar uma ordem do A, mesmo com o token do A:
  // manda o número, tal como no webhook.
  assert.equal((await buscar('?numero=924111222')).status, 204, 'nada para o cliente B');

  const levada = await buscar();
  assert.equal(levada.status, 200);
  const trabalho = await levada.json();
  assert.equal(trabalho.sequencia, 'Transferir');
  assert.deepEqual(trabalho.campos, { valor: '500', iban: 'AO06.0040' });

  // Entregue uma vez é entregue: um segundo telemóvel não repete a transferência.
  assert.equal((await buscar()).status, 204, 'a ordem não sai duas vezes');

  const verOrdem = (ref, k = chaveA) => fetch(`${P}/api/v1/ordens/${ref}`, {
    headers: { Authorization: `Bearer ${k}` },
  }).then((r) => r.json());
  assert.equal((await verOrdem('PED-001')).estado, 'entregue');
  assert.equal((await fetch(`${P}/api/v1/ordens/NAO-EXISTE`, {
    headers: { Authorization: `Bearer ${chaveA}` },
  })).status, 404);

  // A chave do B não vê as ordens do A.
  assert.equal((await fetch(`${P}/api/v1/ordens/PED-001`, {
    headers: { Authorization: `Bearer ${chaveNova}` },
  })).status, 404);

  // A confirmação fecha a ordem: é isto que liga o pedido do cliente ao TID.
  assert.equal(await envia(t2, { ...bom, tid: 'ORD111.0001', ordem_id: trabalho.id }), 200);
  const fechada = await verOrdem('PED-001');
  assert.equal(fechada.estado, 'concluida');
  assert.equal(fechada.tid, 'ORD111.0001');

  // Um ordem_id velho ou de outro cliente não pode rejeitar a transferência: o
  // dinheiro moveu-se e o registo vale mais do que a ligação à ordem.
  assert.equal(await envia(t2, { ...bom, tid: 'ORD111.0002', ordem_id: 999999 }), 200);
  assert.equal(await envia(t2, { ...bom, tid: 'ORD111.0003', ordem_id: 'abc' }), 400, 'mas tem de ser um id');

  // Ordem entregue que nunca deu confirmação expira — e nunca volta a pendente:
  // reenviar uma transferência sozinho é pior do que não a fazer.
  await pedir({ ref: 'PED-TIMEOUT', sequencia: 'Transferir', campos: { valor: '10' } });
  const perdida = (await buscar()).status;
  assert.equal(perdida, 200);
  db.prepare("UPDATE ordens SET entregue_em = ? WHERE ref = 'PED-TIMEOUT'")
    .run(Date.now() - ORDEM_TIMEOUT_MS - 1);
  expirarOrdens();
  const expirada = await verOrdem('PED-TIMEOUT');
  assert.equal(expirada.estado, 'expirada');
  assert.equal(expirada.motivo, MOTIVO.SEM_CONFIRMACAO, 'correu: repetir pode transferir duas vezes');
  assert.equal((await buscar()).status, 204, 'expirada não volta à fila');

  // Pendente que nenhum telemóvel foi buscar também expira: um telemóvel sem rede
  // de madrugada levava-a horas depois e transferia quando já ninguém a queria.
  await pedir({ ref: 'PED-ORFA', sequencia: 'Transferir', campos: { valor: '10' } });
  db.prepare("UPDATE ordens SET criado_em = ? WHERE ref = 'PED-ORFA'").run(Date.now() - ORDEM_TIMEOUT_MS - 1);
  assert.equal((await buscar()).status, 204, 'o telemóvel que volta não a leva');
  const orfa = await verOrdem('PED-ORFA');
  assert.equal(orfa.estado, 'expirada');
  assert.equal(orfa.motivo, MOTIVO.NAO_RECOLHIDA, 'nada correu: repetir é seguro');
  assert.equal(orfa.entregue_em, null);

  // Uma pendente recente fica; só a idade conta.
  await pedir({ ref: 'PED-NOVA', sequencia: 'Transferir', campos: { valor: '11' } });
  expirarOrdens();
  assert.equal((await verOrdem('PED-NOVA')).estado, 'pendente');
  assert.equal((await buscar()).status, 200);

  // Long-poll: o pedido fica à espera e devolve mal a ordem chegue.
  const inicio = Date.now();
  const espera = buscar('?espera=5');
  setTimeout(() => pedir({ ref: 'PED-TARDE', sequencia: 'Transferir', campos: { valor: '7' } }), 300);
  const tarde = await espera;
  assert.equal(tarde.status, 200);
  assert.equal((await tarde.json()).campos.valor, '7');
  assert.ok(Date.now() - inicio < 5000, 'devolveu antes do fim da espera');

  // Uma ordem dirigida a um número só sai por esse telemóvel.
  await pedir({ ref: 'PED-B', sequencia: 'Transferir', campos: { valor: '1' }, numero: '+244 924 111 222' },
    chaveNova);
  assert.equal((await buscar()).status, 204, 'o telemóvel do A não leva a ordem do B');
  assert.equal((await buscar('?numero=924 111 222')).status, 200, 'o do B leva');

  // "Serviço indisponível" antes do valor: o telemóvel repetiu, desistiu e avisa.
  // Fecha já, com um motivo que diz que repetir é seguro, em vez de expirar ao
  // fim de 10 min como sem_confirmacao (que manda não repetir).
  const desistir = (id, corpo, t = t2) => fetch(`${P}/api/telemovel/ordens/${id}/falha`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify(corpo),
  });
  await pedir({ ref: 'PED-INDISP', sequencia: 'Transferir', campos: { valor: '5' } });
  const indisp = await (await buscar()).json();
  assert.equal((await desistir(indisp.id, { motivo: 'sem_confirmacao' })).status, 400,
    'o telemóvel não escolhe os motivos do servidor');
  assert.equal((await desistir(indisp.id, { motivo: 'operador_indisponivel' }, 'token-errado')).status, 401);
  assert.equal((await desistir(indisp.id, { motivo: 'operador_indisponivel', numero: '924111222' })).status, 200);
  assert.equal((await verOrdem('PED-INDISP')).estado, 'entregue', 'um telemóvel do B não fecha a ordem do A');
  const r1 = await (await desistir(indisp.id, { motivo: 'operador_indisponivel' })).json();
  assert.equal(r1.fechada, true);
  const falhou = await verOrdem('PED-INDISP');
  assert.equal(falhou.estado, 'falhada');
  assert.equal(falhou.motivo, MOTIVO.OPERADOR_INDISPONIVEL);
  const r2 = await (await desistir(indisp.id, { motivo: 'operador_indisponivel' })).json();
  assert.equal(r2.fechada, false, 'repetir o aviso é inofensivo');
  // A que já fechou por SMS não é desfeita por um aviso atrasado.
  assert.equal((await desistir(trabalho.id, { motivo: 'operador_indisponivel' })).status, 200);
  assert.equal((await verOrdem('PED-001')).estado, 'concluida');

  // --- notify_url: o painel avisa o cliente quando a ordem fecha ----------------
  assert.equal((await pedir({ ...base, ref: 'N-0', notify_url: 'http://cliente.exemplo/cb' })).status, 400,
    'só https');
  assert.equal((await pedir({ ...base, ref: 'N-0', notify_url: 'isto não é url' })).status, 400);

  // O fetch do servidor é o mesmo deste processo: intercepta só o URL do cliente.
  const fetchReal = globalThis.fetch;
  const avisos = [];
  let respostaCliente = 500;
  globalThis.fetch = async (u, opts) => {
    if (!String(u).startsWith('https://cliente.exemplo/')) return fetchReal(u, opts);
    avisos.push({ corpo: opts.body, assinatura: opts.headers['X-Assinatura'] });
    return new Response(null, { status: respostaCliente });
  };
  try {
    // Ninguém é avisado de nada pendente — só quando fecha.
    await pedir({ ...base, ref: 'N-1', campos: { valor: '3' }, notify_url: 'https://cliente.exemplo/cb' });
    const tn = await (await buscar()).json();
    await notificarPendentes();
    assert.equal(avisos.length, 0, 'entregue ainda não é fim');

    // Concluída: o aviso sai logo, com a assinatura que o cliente sabe calcular.
    respostaCliente = 200;
    assert.equal(await envia(t2, { ...bom, tid: 'NOT111.0001', ordem_id: tn.id }), 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(avisos.length, 1);
    const aviso = JSON.parse(avisos[0].corpo);
    assert.equal(aviso.ref, 'N-1');
    assert.equal(aviso.estado, 'concluida');
    assert.equal(aviso.motivo, null);
    assert.equal(aviso.tid, 'NOT111.0001');
    const { createHash, createHmac } = require('node:crypto');
    const segredo = createHash('sha256').update(chaveA).digest('hex');
    assert.equal(avisos[0].assinatura, createHmac('sha256', segredo).update(avisos[0].corpo).digest('hex'));
    await notificarPendentes();
    assert.equal(avisos.length, 1, 'aceite uma vez, não repete');

    // SMS de falha: o cliente sabe-o pelo callback, sem ter de cruzar o TID.
    await pedir({ ...base, ref: 'N-FALHA', campos: { valor: '3' }, notify_url: 'https://cliente.exemplo/cb' });
    const tf = await (await buscar()).json();
    assert.equal(await envia(t2, { ...bom, tid: 'NOT111.0009', estado: 'falha', ordem_id: tf.id }), 200);
    await new Promise((r) => setTimeout(r, 50));
    const avisoFalha = JSON.parse(avisos.at(-1).corpo);
    assert.equal(avisoFalha.ref, 'N-FALHA');
    assert.equal(avisoFalha.estado, 'falhada');
    assert.equal(avisoFalha.motivo, MOTIVO.FALHA_OPERADOR);
    assert.equal(avisoFalha.tid, 'NOT111.0009', 'o TID vai na mesma, para o cliente verificar');

    // Cliente em baixo: tenta de novo quando chega a hora, e desiste ao fim do limite.
    respostaCliente = 503;
    await pedir({ ...base, ref: 'N-2', campos: { valor: '4' }, notify_url: 'https://cliente.exemplo/cb' });
    await buscar();
    db.prepare("UPDATE ordens SET entregue_em = ? WHERE ref = 'N-2'").run(Date.now() - ORDEM_TIMEOUT_MS - 1);
    expirarOrdens();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(JSON.parse(avisos.at(-1).corpo).estado, 'expirada', 'a expiração também avisa');
    const antes = avisos.length;
    await notificarPendentes();
    assert.equal(avisos.length, antes, 'não repete antes da hora');
    for (let i = 0; i < NOTIF_MAX_TENTATIVAS + 2; i++) {
      db.prepare("UPDATE ordens SET notif_proxima = 0 WHERE ref = 'N-2' AND notif_proxima IS NOT NULL").run();
      await notificarPendentes();
    }
    assert.equal(avisos.length - antes + 1, NOTIF_MAX_TENTATIVAS, 'desiste ao fim do limite');

    // O painel distingue "o cliente recebeu" de "desistimos": sem notificado_em
    // as duas ficavam com notif_proxima a null.
    const painel = ordensDoPainel(db.prepare("SELECT cliente_id FROM ordens WHERE ref = 'N-1'").get().cliente_id);
    const linha = (ref) => painel.itens.find((i) => i.ref === ref);
    assert.equal(linha('N-1').aviso, 'aceite');
    assert.equal(linha('N-2').aviso, 'recusado');
    assert.equal(linha('N-2').motivo, MOTIVO.SEM_CONFIRMACAO);
    assert.equal(linha('N-FALHA').estado, 'falhada');
    assert.equal(linha('PED-001').aviso, null, 'sem notify_url não há aviso');
    assert.equal(linha('PED-001').iban_ultimos5, '.0040', 'só a cauda do IBAN');
    assert.ok(!JSON.stringify(painel).includes('AO06.0040'), 'o IBAN inteiro não sai para o painel');
    assert.ok(painel.falhadas >= 3, 'contagem das últimas 24 h');
  } finally {
    globalThis.fetch = fetchReal;
  }

  // --- formato do pedido por API ----------------------------------------------
  // O que o administrador publica é copiado tal e qual pelo programador do
  // cliente: só é aceite se a API real também o aceitar.
  const formatoApi = (formato) => admin({ accao: 'formatoApi', id: b, formato });
  const bomFormato = '{"sequencia":"Transferir","campos":{"iban":"AO06x","valor":"5000"}}';

  assert.equal((await formatoApi(bomFormato)).status, 200);
  assert.equal(db.prepare('SELECT formato_api FROM clientes WHERE id = ?').get(b).formato_api, bomFormato);

  assert.equal((await formatoApi('sequencia: Transferir')).status, 400, 'não é JSON');
  assert.equal((await formatoApi('{"campos":{"valor":"1"}}')).status, 400, 'sem sequencia');
  assert.equal((await formatoApi('{"sequencia":"<script>"}')).status, 400);
  assert.equal((await formatoApi('{"sequencia":"T","campos":{"valor":"a\\nb"}}')).status, 400);
  assert.equal((await formatoApi('{"sequencia":"T"}' + 'x'.repeat(500))).status, 400);
  assert.equal(db.prepare('SELECT formato_api FROM clientes WHERE id = ?').get(b).formato_api,
    bomFormato, 'nenhum exemplo recusado substituiu o bom');

  // Em branco apaga: a página volta ao exemplo genérico.
  assert.equal((await formatoApi('  ')).status, 200);
  assert.equal(db.prepare('SELECT formato_api FROM clientes WHERE id = ?').get(b).formato_api, null);
  await formatoApi(bomFormato);

  // E um exemplo aceite pelo painel tem mesmo de passar na API real.
  assert.equal((await pedir({ ref: 'DO-FORMATO', ...JSON.parse(bomFormato) }, chaveNova)).status, 201);

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
