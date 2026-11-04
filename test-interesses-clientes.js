const test = require('node:test');
const assert = require('node:assert/strict');
const { avaliarInteresse4um } = require('./interesses-clientes');
test('BR-364 e variantes recebem possível interesse, não vínculo confirmado', () => {
  for (const nome of ['BR-364', 'BR 364', 'BR364', 'BR–364', 'br.364']) {
    const r = avaliarInteresse4um({ ementa: `Reduz faixa não edificável da Rodovia Federal ${nome}.` });
    assert.equal(r.cliente, '4UM/Opportunity');
    assert.equal(r.classificacao, 'Interesse potencial — conferir');
    assert.ok(r.motivos.includes('BR-364'));
  }
});
test('pedágio e concessão rodoviária são possíveis interesses', () => {
  for (const ementa of ['Institui regras de pedágio.', 'Dispõe sobre a concessão rodoviária e acesso rodoviário.', 'Uso da faixa de domínio.']) {
    assert.ok(avaliarInteresse4um({ ementa }));
  }
});
test('assuntos alheios e números parecidos não recebem indicação', () => {
  for (const ementa of ['Institui o dia da educação.', 'Dispõe sobre a BR-3640.', 'Altera o artigo 364 da lei.', 'Concessão de bolsa de estudos.', 'Altera a linha de ônibus urbana.']) {
    assert.equal(avaliarInteresse4um({ ementa }), null);
  }
});
test('referência nominal à Nova364 é triagem, não associação', () => {
  assert.ok(avaliarInteresse4um({ ementa: 'Solicita esclarecimentos da Nova364.' }));
});
