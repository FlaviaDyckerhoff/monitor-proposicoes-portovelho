// Triagem de possível interesse, não associação de cliente nem notificação.
// Escopo: proposições municipais de Porto Velho, cliente 4UM/Opportunity.
function normalizar(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function avaliarInteresse4um(proposicao) {
  const texto = normalizar(proposicao?.ementa);
  const motivos = [];
  if (/\bbr[\s.\-–—]*364\b/.test(texto)) motivos.push('BR-364');
  if (/\bfaixa\s+(?:de\s+dominio|nao\s+edificavel)\b/.test(texto)) motivos.push('faixa de domínio / não edificável');
  if (/\bpedagio\b|\bconcess(?:ao|oes)\s+(?:de\s+)?rodovia|\bconcessionaria\s+(?:de\s+)?rodovia|\bseguranca\s+rodoviaria\b|\bacesso\s+rodoviario\b/.test(texto)) motivos.push('operação / concessão rodoviária');
  if (/\b4um\b|\bnova\s*364\b/.test(texto)) motivos.push('referência nominal ao cliente / operação');
  return motivos.length ? { cliente: '4UM/Opportunity', classificacao: 'Interesse potencial — conferir', motivos } : null;
}

module.exports = { avaliarInteresse4um };
