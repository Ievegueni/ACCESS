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
  'dev.intro': '本页面面向客户方的开发人员。分为两部分：<b>通过短信触发</b>提现，以及<b>通过接口读取</b>交易结果。',
  'dev.idx1': '1 · 触发',
  'dev.idx2': '2 · 短信规则',
  'dev.idx3': '3 · 读取结果',
  'dev.idx4': '4 · 错误码',

  'dev.h1': '1 · 触发一笔提现',
  'dev.h1.nota': '当最终用户点击<b>提现</b>时，贵方系统向下方号码发送一条短信。这条短信即是触发指令 —— 没有用于发起提现的接口。',
  'dev.p1.t': '用户点击提现',
  'dev.p1.d': '在贵方系统内，与现在的流程一致。',
  'dev.p2.t': '贵方系统发送短信',
  'dev.p2.d': '发送至下方号码，使用贵方现有的短信网关即可。就是一条普通短信。',
  'dev.p3.t': '转账被执行',
  'dev.p3.d': '由我方完成，无需贵方介入。耗时数秒至数十秒。',
  'dev.p4.t': '结果可供读取',
  'dev.p4.d': '包含交易号、金额与状态。通过第 3 节的接口读取。',
  'dev.h.paraonde': '发送至何处',
  'dev.h.oque': '发送什么内容',

  'dev.h2': '2 · 短信规则',
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

  'dev.h3': '3 · 读取交易结果',
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

  'dev.h4': '4 · 接口错误码',
  'dev.e.codigo': '状态码',
  'dev.e.significa': '含义',
  'dev.e.fazer': '处理方式',
  'dev.e401': '密钥无效或缺失',
  'dev.e401.f': '检查 <code>Authorization</code> 请求头。不要重试。',
  'dev.e403': '访问已被暂停',
  'dev.e403.f': '请联系管理员。不要重试。',
  'dev.e405': '请求方法错误',
  'dev.e405.f': '仅支持 <code>GET</code>。',
  'dev.e503': '服务暂时不可用',
  'dev.e503.f': '稍后重试，并逐步延长等待时间。',

  // --- integração: blocos construídos em JS ---
  'dev.numeros.um': '这台设备负责执行贵方的提现请求。',
  'dev.numeros.varios': '这些设备都可以使用 —— 但请求只会由收到短信的那一台执行。',
  'dev.numeros.nenhum.t': '尚未登记任何号码',
  'dev.numeros.nenhum.d': '没有号码就无处发送短信。请联系面板管理员。',
  'dev.formato.nota': '请复制此示例并替换其中的数值。固定文本必须保持原样。',
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
