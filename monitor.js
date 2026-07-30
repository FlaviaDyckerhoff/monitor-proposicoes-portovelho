const fs = require('fs');
const https = require('https');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const CONTROLE03_FORCE_LATEST = String(process.env.CONTROLE03_FORCE_LATEST || '').trim() === '1';
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'RO - Porto Velho';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';
const API_BASE = 'https://sapl.portovelho.ro.leg.br/api';
const SITE_BASE = 'https://sapl.portovelho.ro.leg.br';
const PAGE_SIZE = 100;
const LOOKBACK_DAYS = parseInt(process.env.LOOKBACK_DAYS || '30', 10);
const SAFETY_DAYS = parseInt(process.env.SAFETY_DAYS || '3', 10);
const API_TIMEOUT_MS = parseInt(process.env.API_TIMEOUT_MS || '60000', 10);
const DRY_RUN = process.env.DRY_RUN === '1';

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO)) {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  }
  return { proposicoes_vistas: [] };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function formatarDataISO(data) {
  return data.toISOString().slice(0, 10);
}

function calcularDataCorte(estado) {
  const override = process.env.DATA_CORTE;
  if (override) return override;

  const dataBase = estado.ultima_execucao ? new Date(estado.ultima_execucao) : new Date();
  if (Number.isNaN(dataBase.getTime())) {
    const fallback = new Date();
    fallback.setDate(fallback.getDate() - LOOKBACK_DAYS);
    return formatarDataISO(fallback);
  }

  dataBase.setDate(dataBase.getDate() - SAFETY_DAYS);

  const limite = new Date();
  limite.setDate(limite.getDate() - LOOKBACK_DAYS);

  return formatarDataISO(dataBase > limite ? dataBase : limite);
}

function buscarJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: API_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'monitor-proposicoes-portovelho/1.0',
      },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 300)}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`JSON inválido: ${error.message}. Resposta: ${body.substring(0, 300)}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout depois de ${API_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
  });
}

function montarUrlMateria(ano, dataCorte, pagina) {
  const params = new URLSearchParams({
    ano: String(ano),
    page: String(pagina),
    page_size: String(PAGE_SIZE),
    data_apresentacao__gte: dataCorte,
  });
  return `${API_BASE}/materia/materialegislativa/?${params.toString()}`;
}

async function buscarProposicoes(estado) {
  const ano = new Date().getFullYear();
  const dataCorte = calcularDataCorte(estado);

  console.log(`🔍 Buscando proposições de ${ano} desde ${dataCorte}...`);

  const primeiraPagina = await buscarJson(montarUrlMateria(ano, dataCorte, 1));
  const totalPages = primeiraPagina.pagination?.total_pages || 1;
  const totalEntries = primeiraPagina.pagination?.total_entries || primeiraPagina.count || '?';
  const lista = [...(primeiraPagina.results || [])];

  for (let page = 2; page <= totalPages; page += 1) {
    const pagina = await buscarJson(montarUrlMateria(ano, dataCorte, page));
    lista.push(...(pagina.results || []));
  }

  console.log(`📊 ${lista.length} proposições recebidas (total: ${totalEntries}, páginas: ${totalPages})`);
  return lista;
}

function normalizarData(str) {
  if (!str) return '-';
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const [y, m, d] = str.substring(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return str;
}

// "Projeto de Lei nº 42 de 2026" → "PROJETO DE LEI"
function extrairTipo(str) {
  if (!str) return 'OUTRO';
  const match = str.match(/^(.+?)\s+n[ºo°]/i);
  return match ? match[1].trim().toUpperCase() : str.split(' ')[0].toUpperCase();
}

function normalizarEmenta(str) {
  return String(str || '-')
    .replace(/\s+/g, ' ')
    .trim() || '-';
}

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}

function radar03NumeroPartes(p) {
  const numeroRaw = String(p?.numero ?? '').trim();
  const anoRaw = String(p?.ano ?? '').trim();
  if (!numeroRaw) return null;
  const numeroInt = parseInt(numeroRaw, 10);
  if (!Number.isFinite(numeroInt)) return null;
  return { numero: numeroRaw, numeroInt, ano: anoRaw };
}

function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL',
    'PROJETO LEI': 'PL',
    'PROJETO DE LEI ORDINARIA': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC',
    'PROPOSTA DE EMENDA A LEI ORGANICA': 'PELO',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR',
    'REQUERIMENTO': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF',
    'REQUERIMENTO DE INFORMACOES': 'REQINF',
    'INDICACAO': 'IND',
    'INDICACOES': 'IND',
    'PEDIDO DE PROVIDENCIAS': 'PP',
    'MOCAO': 'MOC',
    'VETO': 'VETO',
  };
  return mapa[normal] || normal || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || ''),
      ementa: String(p?.ementa || '').trim(),
      link: String(p?.link || '').trim(),
    };
    let atual = porTipo.get(tipo);
    if (!atual || itemCaptado.numeroInt > atual.numeroInt) porTipo.set(tipo, itemCaptado);
  });
  return Array.from(porTipo.values());
}

function radar03BlocoEmail(novas) {
  return radar03AgruparNovidades(novas)
    .map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : ''))
    .join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link);
  return item ? String(item.link || '') : '';
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou invalido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: 'RO-PORTO-VELHO', regiao: 'Norte', responsavel: 'fabi/maria', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      let item = casa.items.find(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      if (!item) {
        item = { tipo: rec.tipo, base: 0, mon: rec.numeroInt, radar03Id: rec.id || '' };
        casa.items.push(item);
      }
      const base = Number.parseInt(String(item.base || item.mon || 0), 10) || 0;
      item.tipo = rec.tipo;
      item.mon = rec.numeroInt;
      item.delta = rec.numeroInt === base ? 0 : 1;
      item.sentido = rec.numeroInt === base ? 'bate com o controle' : 'captado na fonte';
      item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
      item.ementa = rec.ementa || item.ementa || '';
      item.link = rec.link || item.link || '';
      item.radar03Id = rec.id || item.radar03Id || '';
      item.listaReal03 = true;
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: radar03BlocoEmail(novas),
      fonte: 'monitor-proposicoes-portovelho',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST',
      headers: radar03AuthHeaders(),
      body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + radar03BlocoEmail(novas));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return RADAR03_URL + '?' + params.toString();
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return '<div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">' +
    '<div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>' +
    '<div style="margin-bottom:9px;color:#166534">' + radar03Escape(CASA_RADAR03) + ' · ' + radar03Escape(bloco) + '</div>' +
    '<a href="' + radar03Escape(radar03ReviewUrl(novas)) + '" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>' +
    '<span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>' +
    '</div>';
}

async function enviarEmail(novas) {
  if (CONTROLE03_FORCE_LATEST) {
    console.log('📌 Modo Controle 03: email de novidades não enviado.');
    return;
  }

  if (process.env.DRY_RUN_EMAIL === '1') {
    console.log('[DRY_RUN_EMAIL] Bloco Controle 03: ' + radar03BlocoEmail(novas));
    console.log(renderRadar03EmailButton(novas));
    return;
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    if (!porTipo[p.tipo]) porTipo[p.tipo] = [];
    porTipo[p.tipo].push(p);
  });

  const blocos = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `
      <tr>
        <td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;
          color:#7b2d00;font-size:13px;border-top:2px solid #7b2d00">
          ${tipo} — ${porTipo[tipo].length} proposição(ões)
        </td>
      </tr>`;
    const rows = porTipo[tipo].map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap;font-size:13px">
          ${p.numero}/${p.ano}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;color:#888;font-size:12px;white-space:nowrap">
          ${p.data}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:13px">
          ${p.ementa}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          <a href="${p.link}" style="color:#7b2d00;font-weight:bold;text-decoration:none" target="_blank">
            Abrir proposição
          </a>
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:860px;margin:0 auto">
      <h2 style="color:#7b2d00;border-bottom:2px solid #7b2d00;padding-bottom:8px">
        🏛️ Câmara Municipal de Porto Velho — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666;margin-top:0">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      ${renderRadar03EmailButton(novas)}
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#7b2d00;color:white">
            <th style="padding:10px;text-align:left;white-space:nowrap">Número/Ano</th>
            <th style="padding:10px;text-align:left;white-space:nowrap">Data</th>
            <th style="padding:10px;text-align:left">Ementa</th>
            <th style="padding:10px;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${blocos}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Pesquisa completa: <a href="https://sapl.portovelho.ro.leg.br/materia/pesquisar-materia">SAPL da Câmara Municipal de Porto Velho</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Porto Velho" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Porto Velho: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

(async () => {
  console.log('🚀 Iniciando monitor Câmara Porto Velho...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const proposicoesRaw = await buscarProposicoes(estado);

  if (proposicoesRaw.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  const novas = proposicoesRaw
    .filter(p => !idsVistos.has(String(p.id)))
    .map(p => ({
      id: String(p.id),
      tipo: extrairTipo(p.__str__),
      numero: String(p.numero),
      ano: String(p.ano),
      data: normalizarData(p.data_apresentacao),
      ementa: normalizarEmenta(p.ementa),
      link: `${SITE_BASE}${p.link_detail_backend}`,
    }));

  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    novas.sort((a, b) => {
      if (a.tipo < b.tipo) return -1;
      if (a.tipo > b.tipo) return 1;
      return (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0);
    });

    if (DRY_RUN) {
      console.log('🧪 DRY_RUN=1: email e gravação de estado não serão executados.');
      novas.forEach(p => console.log(`- ${p.tipo} ${p.numero}/${p.ano} — ${p.data} — ${p.link}`));
      process.exit(0);
    }

    if (process.env.DRY_RUN_EMAIL === '1') {
      console.log('🧪 DRY_RUN_EMAIL=1: sincronização Controle 03 ignorada.');
    } else {
      await sincronizarRadar03(novas);
    }
    await enviarEmail(novas);

    if (process.env.DRY_RUN_EMAIL === '1') {
      console.log('🧪 DRY_RUN_EMAIL=1: estado local preservado.');
      process.exit(0);
    }

    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    if (process.env.DRY_RUN_EMAIL === '1') {
      console.log('🧪 DRY_RUN_EMAIL=1: estado local preservado.');
      process.exit(0);
    }
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
