// Formatação partilhada entre o painel do cliente e o do administrador.

// As datas seguem o idioma escolhido; os valores nunca. São kwanzas, e trocar o
// separador decimal faria 1.500,50 parecer outro número.
// useGrouping 'always': em pt-PT o agrupamento só entra a partir de 5 dígitos, e
// a coluna ficava com "25 000" ao lado de "1500,5".
const fmtNum = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 2, useGrouping: 'always' });

// O painel de administração não carrega o i18n.js, daí a alternativa.
const locale = () => (window.localeData ? window.localeData() : 'pt-PT');
const tr = (chave, pt) => (window.traduzir ? window.traduzir(chave, pt) : pt);

const data = (ms) => (ms
  ? new Intl.DateTimeFormat(locale(), { dateStyle: 'short', timeStyle: 'short' }).format(ms)
  : '—');

/** Escapa texto vindo da BD antes de entrar em innerHTML (nomes, números). */
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Um valor em kwanzas, com a moeda separada para poder ser esbatida.
 *
 * [original] é o texto tal como veio no SMS: fica no `title`, porque é ele a
 * fonte e o número formatado é já uma interpretação nossa (ver BACKOFFICE §4).
 */
function montante(valor, original) {
  if (valor == null && !original) return '—';
  const corpo = valor == null ? esc(original) : fmtNum.format(valor);
  const titulo = original && original !== corpo ? ` title="no SMS: ${esc(original)}"` : '';
  return `<span${titulo}>${corpo}<span class="moeda">Kz</span></span>`;
}

/** Só para totais onde não há texto original (agregados calculados). */
const kz = (v) => montante(v ?? 0);

function duracao(ms) {
  if (ms == null) return tr('dur.nunca', 'nunca');
  const m = Math.floor(ms / 60000);
  if (m < 1) return tr('dur.agora', 'agora mesmo');
  if (m < 60) return m + tr('dur.min', ' min');
  const h = Math.floor(m / 60);
  return h < 48 ? h + tr('dur.h', ' h') : Math.floor(h / 24) + tr('dur.dias', ' dias');
}

/** Uma estatística secundária da faixa de topo. */
const estatistica = (etiqueta, valor, classe = '') =>
  `<div class="estatistica ${classe}">
     <span class="etiqueta">${etiqueta}</span>
     <b class="valor">${valor}</b>
   </div>`;

/**
 * Silêncio prolongado: o telemóvel pode estar sem rede, reiniciado, ou a app morta
 * pela gestão de bateria. É o sintoma que mais facilmente passa despercebido, porque
 * é indistinguível de "não houve transferências".
 *
 * `silencio_ms` a null significa "nunca chegou nada". Num cliente acabado de criar
 * isso é normal — só é sinal de avaria se já passou tempo desde que foi criado.
 */
function gravidade(saude, criado_em) {
  const silencio = saude.silencio_ms ?? (criado_em ? Date.now() - criado_em : null);
  if (silencio == null || silencio > 24 * 3600e3) return 'grave';
  return silencio > 6 * 3600e3 ? 'alerta' : '';
}

/** O estado da ligação, já pronto a mostrar: {texto, classe}. */
function cartaoSaude(saude, criado_em) {
  return { texto: duracao(saude.silencio_ms), classe: gravidade(saude, criado_em) };
}
