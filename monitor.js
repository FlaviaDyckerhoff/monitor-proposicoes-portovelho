const fs = require('fs');
const https = require('https');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
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

async function enviarEmail(novas) {
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
      ementa: (p.ementa || '-').substring(0, 250),
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

    await enviarEmail(novas);

    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  } else {
    console.log('✅ Sem novidades. Nada a enviar.');
    estado.ultima_execucao = new Date().toISOString();
    salvarEstado(estado);
  }
})();
