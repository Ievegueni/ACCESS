/*
 * Tradução das páginas viradas para o cliente (painel, integração, entrada).
 * O painel de administração fica só em português — é interno.
 *
 * O português é a fonte: vive no HTML e este ficheiro só tem o chinês. Assim não
 * há duas cópias do texto a divergirem, e uma chave sem tradução mostra o
 * original em vez de mostrar a chave.
 */

const ZH = {
  // --- comuns ---
  'link.integracao': '对接说明',
  'link.sair': '退出',
  'link.clientes': '← 客户列表',
  'link.transferencias': '← 转账记录',

  // --- entrada ---
  'login.titulo': '转账管理面板',
  'login.nota': '请使用我们提供给您的客户名称和密码登录。',
  'login.cliente': '客户名称',
  'login.senha': '密码',
  'login.entrar': '登录',
  'login.erro': '账号或密码错误。',

  // --- painel ---
  'painel.titulo': '转账记录',
  'heroi.total': '成功转账总额',
  'est.24h': '最近 24 小时',
  'est.30d': '最近 30 天',
  'est.rever': '待核查',
  'est.semReceber': '距上次接收',
  'est.carteira': '钱包余额',
  'cart.de': '数据时间：',
  'cart.semSaldo': '余额尚未知',
  'cart.semSinal': '从未发送过任何信息',
  'cart.recebido': '距上次接收',
  'filtro.estado': '状态',
  'filtro.todos': '全部',
  'filtro.sucesso': '成功',
  'filtro.arever': '待核查',
  'filtro.de': '开始日期',
  'filtro.ate': '结束日期',
  'filtro.filtrar': '筛选',
  'filtro.limpar': '清除',
  'col.momento': '交易时间',
  'col.valor': '金额',
  'col.iban': 'IBAN 后五位',
  'col.estado': '状态',
  'col.telemovel': '来源号码',
  'col.tid': '交易号',
  'col.recebido': '接收时间',
  'painel.vazio': '该时间段内没有转账记录。',
  'pill.sucesso': '成功',
  'pill.arever': '待核查',
  'sub.uma': '笔转账',
  'sub.varias': '笔转账',
  'sub.arever': '笔待核查',
  'marca.mao': '手动',
  'marca.token': '凭令牌',
  'marca.mao.titulo': '由管理员手动归属',
  'marca.token.titulo': '号码未登记 — 依令牌归属',
  'dur.nunca': '从未',
  'dur.agora': '刚刚',
  'dur.min': ' 分钟',
  'dur.h': ' 小时',
  'dur.dias': ' 天',

  // --- integração ---
  'dev.titulo': '系统对接',
  'dev.intro': '本页面面向客户方的开发人员。分为两部分：<b>发起</b>提现 —— 可通过接口或短信 —— 以及<b>通过接口读取</b>交易结果。',
  'dev.idx0': '1 · 接口发起',
  'dev.idx1': '2 · 短信发起',
  'dev.idx2': '3 · 短信规则',
  'dev.idx3': '4 · 读取结果',
  'dev.idx4': '5 · 错误码',

  // --- integração: disparar por API ---
  'dev.api.h': '1 · 通过接口发起提现',
  'dev.api.nota': '<code>POST /api/v1/ordens</code> —— 推荐方式。与短信不同，接口会给出回应：贵方能确认请求已被受理，可随时查询状态，也不会在途中丢失。',
  'dev.api.p1.t': '贵方系统创建一条指令',
  'dev.api.p1.d': '一次 <code>POST</code>，带上贵方的参考号与提现数值。立即返回 <code>201</code>，指令进入队列。',
  'dev.api.p2.t': '设备在数秒内取走',
  'dev.api.p2.d': '设备始终在等待新任务。投递无需贵方做任何事。',
  'dev.api.p3.t': '转账被执行',
  'dev.api.p3.d': '由我方完成。耗时数秒至数十秒。',
  'dev.api.p4.t': '指令以交易号收尾',
  'dev.api.p4.d': '可按参考号查询状态，也可通过第 4 节的接口读取确认 —— 两处的 <code>tid</code> 是同一个。',
  'dev.api.h.chave': '密钥',
  'dev.api.chave.nota': '与读取接口用的是同一把 <code>ak_…</code> 密钥 —— <a href="#ler">在第 4 节生成</a>。',
  'dev.api.h.pedir': '发起请求',
  'dev.api.campo': '字段',
  'dev.api.obrig': '必填',
  'dev.sim': '是',
  'dev.nao': '否',
  'dev.api.c.ref': '贵方的提现参考号。字母、数字与 <code>. _ -</code>，最长 64 个字符',
  'dev.api.c.seq': '操作名称，须与设备上配置的完全一致。名称不对时，指令会被受理但永远不会执行',
  'dev.api.c.campos': '该操作所需的数值：<code>valor</code>、<code>iban</code> …… 最多 10 个',
  'dev.api.c.numero': '指定由哪台设备执行。不填则贵方任一台设备都可以',
  'dev.api.h.estado': '查询状态',
  'dev.api.est': '状态',
  'dev.api.s.pendente': '排队中，尚未被取走',
  'dev.api.s.pendente.f': '等待。',
  'dev.api.s.entregue': '正在执行',
  'dev.api.s.entregue.f': '等待。',
  'dev.api.s.concluida': '已确认，带 <code>tid</code>',
  'dev.api.s.concluida.f': '到第 4 节查看该笔转账的 <code>estado</code>。',
  'dev.api.s.expirada': '十分钟内未收到确认',
  'dev.api.s.expirada.f': '不要盲目重发 —— 先核查。',
  'dev.api.r1.t': '<code>ref</code> 是贵方防重复的保障',
  'dev.api.r1.d': '用相同的 <code>ref</code> 重复同一个 <code>POST</code>，返回的是已存在的那条指令（<code>200</code> 而非 <code>201</code>），<b>不会</b>再转一次账。若响应在贵方网络中丢失，尽管重试 —— 只要 <code>ref</code> 不变。',
  'dev.api.r2.t': '贵方无需自建队列',
  'dev.api.r2.d': '与短信不同，可以连续创建多条指令：它们会排队，并按到达顺序逐条执行。',
  'dev.api.c.notify': '贵方的 <code>https://</code> 地址。指令变为 <code>concluida</code> 或 <code>expirada</code> 时，我方向该地址发送 <code>POST</code>，内容与状态查询的返回相同',
  'dev.api.r5.t': '填写 <code>notify_url</code> 后无需轮询状态',
  'dev.api.r5.d': '请返回 <code>2xx</code> 表示已收到。若返回其他状态码，或 10 秒内无响应，我方将从 30 秒起按加倍间隔重试，最多 8 次（约 2 小时）。同一通知可能收到多次：请按 <code>ref</code> 去重。请求头 <code>X-Assinatura</code> 是请求体的 HMAC-SHA256（十六进制），密钥为贵方 <code>ak_</code> 密钥的 SHA-256（十六进制）—— 请先校验再信任内容。',
  'dev.api.r3.t': '<code>expirada</code> 不会自动重发',
  'dev.api.r3.d': '它表示指令已被取走，但十分钟内没有收到确认。该操作可能已经执行完毕，只是确认丢失了 —— 所以我方绝不自动重发。创建新指令之前，请先到第 4 节的列表中核查这笔转账是否已经发生。',
  'dev.api.r4.t': '受理不等于已执行',
  'dev.api.r4.d': '<code>201</code> 只说明指令已被记录，仅此而已。只有当状态变为 <code>concluida</code> 并带上 <code>tid</code> 时才有结果。在此之前不要把提现当作已完成。',

  'dev.h1': '2 · 通过短信发起',
  'dev.h1.nota': '供已经在用的客户。贵方系统向下方号码发送一条短信，由该短信触发转账。它不会有任何回应：短信若丢失，没有人会知道。建议优先使用第 1 节的接口。',
  'dev.p1.t': '用户点击提现',
  'dev.p1.d': '在贵方系统内，与现在的流程一致。',
  'dev.p2.t': '贵方系统发送短信',
  'dev.p2.d': '发送至下方号码，使用贵方现有的短信网关即可。就是一条普通短信。',
  'dev.p3.t': '转账被执行',
  'dev.p3.d': '由我方完成，无需贵方介入。耗时数秒至数十秒。',
  'dev.p4.t': '结果可供读取',
  'dev.p4.d': '包含交易号、金额与状态。通过第 4 节的接口读取。',
  'dev.h.paraonde': '发送至何处',
  'dev.h.oque': '发送什么内容',

  'dev.h2': '3 · 短信规则',
  'dev.h2.nota': '共五条。其中前三条一旦违反，请求会被静默忽略 —— 不会返回任何错误，短信只是不起作用。',
  'dev.r1.t': '必须包含触发关键词',
  'dev.r1.d': '匹配时不区分大小写，只要短信中含有该关键词即可。缺少它，短信会被忽略。',
  'dev.r2.t': '字段格式为 <code>标签: 值</code>',
  'dev.r2.d': '每个字段都会传递给设备上配置的流程。可以写在同一行，也可以分行。',
  'dev.r3.t': '短信必须以最后一个值结尾',
  'dev.r3.d': '一个字段的值会一直延伸到下一个标签或短信末尾。结尾处多余的文字 —— 签名、"谢谢" —— 都会并入最后一个字段，转账金额就会出错。',
  'dev.errado': '错误',
  'dev.certo': '正确',
  'dev.r3.mau': '金额变成 <code>5000 Obrigado!</code>',
  'dev.r3.bom': '金额为 <code>5000</code>',
  'dev.r4.t': '绝不能包含 <code>TID:</code>',
  'dev.r4.d': '该文本用于标识一条交易确认。含有它的请求会被当作确认记录归档，转账根本不会启动。',
  'dev.r5.t': '同一时间只能有一笔请求',
  'dev.r5.d': '设备一次只处理一笔。若前一笔尚未完成时又收到第二条短信，不会启动新的转账：第二条的数值会被并入正在进行的那一笔。请在收到上一笔的确认后再发送下一笔 —— 贵方侧保持单条队列。',
  'dev.h.miudezas': '其他细节',
  'dev.m1': '长短信可分条发送 —— 会被重新拼接。',
  'dev.m2': '标签不区分大小写，支持带重音的字母。',
  'dev.m3': '设备须开机、有网络且应用处于启用状态。设备关机时短信会丢失，不会排队等待。',

  'dev.h3': '4 · 读取交易结果',
  'dev.h3.nota': '<code>GET /api/v1/transferencias</code> —— 返回贵方的交易记录，最早的在前，以便完整遍历而不遗漏。',
  'dev.h.chave': '密钥',
  'dev.h.pedido': '请求',
  'dev.h.resposta': '响应',
  'dev.par.parametro': '参数',
  'dev.par.omissao': '默认值',
  'dev.par.notas': '说明',
  'dev.par.desde': '返回 <code>recebido_em</code> <b>大于</b> 此值的记录',
  'dev.par.limite': '最大 500',
  'dev.r6.t': '请按 <code>proximo_desde</code> 翻页，不要按日期',
  'dev.r6.d': '保存响应中的 <code>proximo_desde</code>，在下一次请求时作为 <code>desde</code> 传入。只要 <code>ha_mais</code> 为 <code>true</code>，就立即再请求一次。',
  'dev.r7.t': '不要按 <code>momento</code> 排序',
  'dev.r7.d': '<code>momento</code> 是交易发生时的设备时间。记录可能乱序抵达，有时会延迟数小时 —— 网络中断时确认会滞留在设备上。若按 <code>momento</code> 翻页，迟到的记录会被跳过且再也读不到。<code>recebido_em</code> 由服务器生成，只增不减。',
  'dev.r8.t': '<code>tid</code> 是主键',
  'dev.r8.d': '它是交易的唯一标识。用它把确认结果关联到贵方系统中的提现，并避免重复处理同一笔。',
  'dev.r9.t': '<code>estado: "falha"</code> 意为"待核查"，不等于"未转账"',
  'dev.r9.d': '<code>sucesso</code> 是确定的。<code>falha</code> 表示交易存在，但确认结果未判定为成功 —— 可能确实失败，也可能是尚未见过的回执文本。请勿仅凭此向用户退款：请先与我们核实。',

  'dev.h4': '5 · 接口错误码',
  'dev.e.codigo': '状态码',
  'dev.e.significa': '含义',
  'dev.e.fazer': '处理方式',
  'dev.e400': '指令格式有误',
  'dev.e400.f': '响应会指出是哪个字段。改正后再重试。',
  'dev.e401': '密钥无效或缺失',
  'dev.e401.f': '检查 <code>Authorization</code> 请求头。不要重试。',
  'dev.e403': '访问已被暂停',
  'dev.e403.f': '请联系管理员。不要重试。',
  'dev.e404': '指令不存在',
  'dev.e404.f': '该 <code>ref</code> 从未被创建。判定丢失前请先核对。',
  'dev.e405': '请求方法错误',
  'dev.e405.f': '读取用 <code>GET</code>，创建指令用 <code>POST</code>。',
  'dev.e503': '服务暂时不可用',
  'dev.e503.f': '稍后重试，并逐步延长等待时间。',

  // --- integração: blocos construídos em JS ---
  'dev.numeros.um': '这台设备负责执行贵方的提现请求。',
  'dev.numeros.varios': '这些设备都可以使用 —— 但请求只会由收到短信的那一台执行。',
  'dev.numeros.nenhum.t': '尚未登记任何号码',
  'dev.numeros.nenhum.d': '没有号码就无处发送短信。请联系面板管理员。',
  'dev.api.formato.nota': '这是贵方场景的实际请求：复制后替换其中的数值。流程名称必须保持原样。',
  'dev.api.formato.nenhum.t': '上面的请求只是通用示例',
  'dev.api.formato.nenhum.d': '贵方场景的流程名称与字段尚未发布。请向面板管理员索取 —— 名称不对时，指令会被受理但永远不会执行。',
  'dev.formato.nota':'请复制此示例并替换其中的数值。固定文本必须保持原样。',
  'dev.formato.nenhum.t': '尚未设定短信格式',
  'dev.formato.nenhum.d': '格式取决于设备上配置的流程。请向面板管理员索取，由其在此发布。',
  'dev.chave.existe': '密钥已存在。无法再次查看 —— 若已遗失，请生成新的（旧密钥会立即失效）。',
  'dev.chave.nenhuma': '尚未生成密钥。密钥只会显示一次。',
  'dev.chave.gerar': '生成密钥',
  'dev.chave.outra': '生成新密钥',
  'dev.chave.confirma': '确定生成新密钥吗？\n\n如果已存在密钥，旧密钥会立即失效，贵方系统将中断直到更换为止。',
  'dev.chave.titulo': '读取密钥',
  'dev.chave.aviso': '请立即复制，之后不会再显示。',
};

const IDIOMAS = { pt: 'Português', zh: '简体中文' };

let idioma = localStorage.getItem('idioma') || 'pt';

/** Traduz uma cadeia construída em JS. O português é o que vai no código. */
const t = (chave, pt) => (idioma === 'zh' && ZH[chave]) || pt;

/** Locale das datas. Declarada com `function` de propósito: o admin não carrega
 *  este ficheiro e testa a existência dela em `window`. */
function localeData() { return idioma === 'zh' ? 'zh-CN' : 'pt-PT'; }
function traduzir(chave, pt) { return t(chave, pt); }

function aplicarTraducao() {
  document.documentElement.lang = idioma === 'zh' ? 'zh-Hans' : 'pt';
  for (const el of document.querySelectorAll('[data-t]')) {
    // O original só é guardado à primeira: depois disso o DOM já pode estar traduzido.
    if (el.dataset.original === undefined) el.dataset.original = el.innerHTML;
    const zh = ZH[el.dataset.t];
    el.innerHTML = idioma === 'zh' && zh ? zh : el.dataset.original;
  }
  for (const el of document.querySelectorAll('[data-tph]')) {
    if (el.dataset.originalPh === undefined) el.dataset.originalPh = el.placeholder;
    const zh = ZH[el.dataset.tph];
    el.placeholder = idioma === 'zh' && zh ? zh : el.dataset.originalPh;
  }
}

/** Selector no cabeçalho. Injetado aqui para não repetir markup em cada página. */
function montarSeletorIdioma(aoMudar) {
  // A página de entrada não tem cabeçalho: cai no primeiro `.links` que houver.
  const links = document.querySelector('header .links') || document.querySelector('.links');
  if (!links) return;
  const sel = document.createElement('select');
  sel.className = 'seletorIdioma';
  sel.setAttribute('aria-label', 'Idioma / 语言');
  sel.innerHTML = Object.entries(IDIOMAS)
    .map(([k, nome]) => `<option value="${k}">${nome}</option>`).join('');
  sel.value = idioma;
  sel.onchange = () => {
    idioma = sel.value;
    localStorage.setItem('idioma', idioma);
    aplicarTraducao();
    aoMudar?.();
  };
  links.prepend(sel);
}

aplicarTraducao();
