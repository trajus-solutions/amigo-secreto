// Teste de ponta a ponta: node test.js  (sobe o servidor num diretório temporário)
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amigo-test-'));
const srv = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: dir }, stdio: 'inherit' });

let cookie = '';
async function call(method, p, body, { admin = true, raw = false } = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...(admin && cookie ? { Cookie: cookie } : {}) },
    body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && sc.startsWith('sid=')) cookie = sc.split(';')[0];
  return { status: r.status, data: raw ? await r.text() : await r.json() };
}

(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }

  // admin protegido
  assert.equal((await call('GET', '/api/admin/state', null, { admin: false })).status, 401);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'curta' })).status, 400);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'senha-forte-123' })).status, 200);
  assert.equal((await call('POST', '/api/admin/setup', { password: 'outra-senha-123' })).status, 403);

  // participantes + exclusões
  const names = ['Ana', 'Bruno', 'Carla', 'Daniel', 'Eva', 'Fabio', 'Gabi', 'Hugo'];
  assert.deepEqual((await call('POST', '/api/admin/participants', { names: names.join('\n') + '\nana' })).data.skipped, ['ana']);
  let st = (await call('GET', '/api/admin/state')).data;
  const id = Object.fromEntries(st.people.map((p) => [p.name, p.id]));
  await call('POST', '/api/admin/exclusions', { a: id.Ana, b: id.Bruno });
  await call('POST', '/api/admin/exclusions', { a: id.Carla, b: id.Daniel });
  assert.equal((await call('POST', '/api/claim', { participant_id: id.Ana }, { admin: false })).status, 409, 'não pode sortear antes de liberar');

  // crianças: grupo à parte, só sorteia entre elas
  // mover de grupo: Hugo vira criança (exclusões dele somem) e volta a adulto
  assert.equal((await call('POST', `/api/admin/participants/${id.Hugo}/group`, { grupo: 'criancas' })).status, 200);
  assert.equal((await call('GET', '/api/admin/state')).data.people.find((p) => p.name === 'Hugo').grp, 'criancas');
  assert.equal((await call('POST', `/api/admin/participants/${id.Hugo}/group`, { grupo: 'adultos' })).status, 200);
  assert.equal((await call('POST', `/api/admin/participants/${id.Hugo}/group`, { grupo: 'bichos' })).status, 400);
  const kids = ['Lia', 'Davi', 'Teo', 'Miguel'];
  const NOTA = 'Esta criança não come doce. Sugestão: frutas (uva, melancia, banana etc.)';
  await call('POST', '/api/admin/participants', { names: 'Lia\nDavi', grupo: 'criancas' });
  assert.equal((await call('POST', '/api/admin/participants', { names: 'X', grupo: 'bichos' })).status, 400, 'grupo inválido');
  assert.equal((await call('POST', '/api/admin/start', { avoidSwap: true })).status, 400, 'grupo com menos de 3 é recusado');
  await call('POST', '/api/admin/participants', { names: `Teo\nMiguel | ${NOTA}`, grupo: 'criancas' });
  st = (await call('GET', '/api/admin/state')).data;
  for (const p of st.people) id[p.name] = p.id;
  assert.equal((await call('POST', '/api/admin/exclusions', { a: id.Ana, b: id.Lia })).status, 400, 'exclusão entre grupos é recusada');
  assert.equal((await call('POST', '/api/admin/exclusions', { a: id.Lia, b: id.Davi })).status, 200, 'irmãos');

  assert.equal((await call('POST', '/api/admin/start', { avoidSwap: true })).status, 200);
  assert.equal((await call('POST', '/api/admin/participants', { names: 'Zé' })).status, 409, 'lista travada');

  // estado público não vaza resultado
  const pub = (await call('GET', '/api/state', null, { admin: false })).data;
  assert.deepEqual(pub.pending.map((p) => p.name).sort(), [...names, ...kids].sort(), 'lista única com adultos e crianças');
  assert.ok(!JSON.stringify(pub).includes('gives_to') && !JSON.stringify(pub).includes('não come doce'), 'estado público não vaza nada');
  assert.ok(!JSON.stringify((await call('GET', '/api/admin/state')).data).includes('gives_to'), 'admin não vê quem tirou quem');

  // todos sorteiam; embaralha a ordem
  const order = [...names].sort(() => Math.random() - 0.5);
  const result = {};
  for (const n of order) {
    const r = await call('POST', '/api/claim', { participant_id: id[n] }, { admin: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.tipo, 'Amigo Xícara');
    assert.equal(r.data.note, null);
    result[n] = r.data.friend;
    // segunda consulta é recusada e não devolve o resultado
    const again = await call('POST', '/api/claim', { participant_id: id[n] }, { admin: false });
    assert.equal(again.status, 409);
    assert.ok(!JSON.stringify(again.data).includes(result[n]));
    assert.equal((await call('GET', '/api/admin/audit', null, { raw: true })).status, 404, 'auditoria só no fim');
  }
  assert.equal((await call('GET', '/api/state', null, { admin: false })).data.pending.length, 4, 'só as crianças faltam');
  assert.equal((await call('GET', '/api/state', null, { admin: false })).data.finished, false);

  // crianças sorteiam (só entre elas), pela MESMA lista
  const kidResult = {};
  for (const n of [...kids].sort(() => Math.random() - 0.5)) {
    const r = await call('POST', '/api/claim', { participant_id: id[n] }, { admin: false });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.tipo, 'Amigo Doce');
    assert.equal(r.data.note, r.data.friend === 'Miguel' ? NOTA : null, 'observação só para quem tirou o Miguel');
    kidResult[n] = r.data.friend;
    assert.equal((await call('POST', '/api/claim', { participant_id: id[n] }, { admin: false })).status, 409);
    if (Object.keys(kidResult).length < kids.length)
      assert.equal((await call('GET', '/api/admin/audit', null, { raw: true })).status, 404, 'auditoria só quando TODOS os grupos terminarem');
  }
  assert.deepEqual(Object.values(kidResult).sort(), [...kids].sort(), 'cada criança tirada exatamente uma vez, só entre crianças');
  for (const [g, r] of Object.entries(kidResult)) { assert.notEqual(g, r); assert.notEqual(kidResult[r], g, 'sem troca direta'); }
  assert.ok(kidResult.Lia !== 'Davi' && kidResult.Davi !== 'Lia', 'irmãos não se tiram');

  // regras do sorteio
  const received = Object.values(result);
  assert.equal(new Set(received).size, 8, 'ninguém tirado duas vezes');
  for (const [g, r] of Object.entries(result)) {
    assert.notEqual(g, r, 'ninguém tira a si mesmo');
    assert.notEqual(result[r], g, 'sem troca direta (avoidSwap)');
  }
  const bad = (a, b) => assert.ok(result[a] !== b && result[b] !== a, `${a}/${b} proibidos`);
  bad('Ana', 'Bruno'); bad('Carla', 'Daniel');

  // auditoria
  st = (await call('GET', '/api/admin/state')).data;
  assert.ok(st.finished && st.audit);
  const audit = await call('GET', '/api/admin/audit', null, { raw: true });
  assert.equal(audit.status, 200);
  for (const [g, r] of Object.entries({ ...result, ...kidResult })) assert.ok(new RegExp(`${g}\\s+->\\s+${r}\\s`).test(audit.data), `auditoria: ${g} -> ${r}`);
  assert.ok(audit.data.includes('GRUPO: ADULTOS (8)') && audit.data.includes('GRUPO: CRIANÇAS (4)'), 'auditoria por grupo');
  assert.equal((await call('GET', '/api/admin/audit', null, { admin: false, raw: true })).status, 401);
  console.log('\n' + audit.data);

  // liberar de novo mostra o MESMO resultado
  await call('POST', `/api/admin/release/${id.Ana}`);
  const again = await call('POST', '/api/claim', { participant_id: id.Ana }, { admin: false });
  assert.equal(again.data.friend, result.Ana);

  console.log('OK: todos os testes passaram');
})().catch((e) => { console.error('FALHOU:', e); process.exitCode = 1; }).finally(() => { srv.kill(); setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 300); });
