/**
 * v2.4.1: los gráficos de Adobe (.aegraphic, .mogrt, .aep, .aet, .prgraphic, .c4d) se mueven como el resto.
 * Premiere no los re-enlaza (changeMediaPath), así que quedan sin conexión: el plan los lista y no se envían re-enlaces.
 * Uso: node tests/graphics-move.test.js [carpeta-temporal]
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var engine = require('../plugin/com.binflow.organizer/engine');
var report = require('../plugin/com.binflow.organizer/engine/report');

var CATS = { '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Graphics': ['aegraphic', 'mogrt', 'aep', 'aet', 'prgraphic', 'c4d'], 'Z_Others': ['txt'] };
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-gfx-'));
var passed = 0, n = 0;

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content === undefined ? 'x' + file : content); }
function dir(name) { var d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); return d; }
function snap(proj, items) { return { projectPath: path.join(proj, 'E.prproj'), projectFolder: proj, assetsFolderName: '01 Assets', categories: CATS, items: items }; }
function media(id, file) { return { nodeId: id, name: path.basename(file), kind: 'media', mediaPath: file, binPath: [] }; }
async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}

(async function main() {
    console.log('BinFlow gráficos de Adobe — pruebas en ' + base);

    await test('por defecto: un .aegraphic interno se mueve a su categoría y se lista como sin conexión', async function () {
        var P = dir('a1'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Rot', 'Titulo.aegraphic'), 'g'); write(path.join(P, 'Rot', 'clip.mp4'), 'v');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(P, 'Rot', 'Titulo.aegraphic')), media('v1', path.join(P, 'Rot', 'clip.mp4'))]));
        assert.strictEqual(plan.moveManual, true);
        var op = plan.ops.filter(function (o) { return /Titulo/.test(o.source); })[0];
        assert.strictEqual(op.type, 'move');
        assert.strictEqual(path.relative(P, op.dest), path.join('01 Assets', 'Graphics', 'Titulo.aegraphic'));
        assert.deepStrictEqual(plan.manual.map(function (m) { return [m.name, m.type, m.offline, m.moved]; }), [['Titulo.aegraphic', 'move', true, true]]);
        assert.strictEqual(plan.manual[0].path, path.join(P, 'Rot', 'Titulo.aegraphic'));
        assert.strictEqual(plan.manual[0].dest, op.dest);
        assert.strictEqual(plan.summary.kept, 0);
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        assert.deepStrictEqual(r.errors, []);
        assert.ok(fs.existsSync(op.dest) && !fs.existsSync(path.join(P, 'Rot', 'Titulo.aegraphic')));
        // Sin re-enlace para el gráfico (Premiere lo rechazaría y contaría como error); el vídeo sí se re-enlaza.
        assert.deepStrictEqual(r.relinks.map(function (x) { return x.nodeId; }), ['v1']);
    });

    await test('todas las extensiones de Adobe se mueven (aegraphic, mogrt, aep, aet, prgraphic, c4d)', async function () {
        var P = dir('a2'); write(path.join(P, 'E.prproj'), 'P');
        var exts = ['aegraphic', 'mogrt', 'aep', 'aet', 'prgraphic', 'c4d'];
        var items = exts.map(function (x, i) { var f = path.join(P, 'src', 'g' + i + '.' + x); write(f, x); return media('g' + i, f); });
        var plan = await engine.buildPlan(snap(P, items));
        assert.strictEqual(plan.manual.length, 6);
        assert.ok(plan.ops.every(function (o) { return o.type === 'move' && /Graphics/.test(o.dest); }));
    });

    await test('externo: se copia, el original no se toca y no se anuncia como sin conexión', async function () {
        var P = dir('a3'), X = dir('a3-ext'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(X, 'Lower.mogrt'), 'mogrt-ext');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(X, 'Lower.mogrt'))]));
        assert.strictEqual(plan.ops[0].type, 'copy');
        assert.deepStrictEqual(plan.manual.map(function (m) { return [m.type, m.offline, m.moved]; }), [['copy', false, true]]);
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(fs.readFileSync(path.join(X, 'Lower.mogrt'), 'utf8'), 'mogrt-ext');
        assert.strictEqual(fs.readFileSync(plan.ops[0].dest, 'utf8'), 'mogrt-ext');
        assert.deepStrictEqual(r.relinks, []);
    });

    await test('externo con copia idéntica ya dentro del proyecto (reused): se mueve esa copia sin re-enlace', async function () {
        var P = dir('a4'), X = dir('a4-ext'); write(path.join(P, 'E.prproj'), 'P');
        write(path.join(X, 'Lower.mogrt'), 'igual'); write(path.join(P, 'viejo', 'Lower.mogrt'), 'igual');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(X, 'Lower.mogrt'))]));
        var op = plan.ops[0];
        assert.strictEqual(op.state, 'reused'); assert.strictEqual(op.type, 'move'); assert.strictEqual(op.source, path.join(P, 'viejo', 'Lower.mogrt'));
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        assert.deepStrictEqual(r.errors, []);
        assert.deepStrictEqual(r.relinks, []);
        assert.ok(fs.existsSync(op.dest) && !fs.existsSync(path.join(P, 'viejo', 'Lower.mogrt')));
        assert.ok(fs.existsSync(path.join(X, 'Lower.mogrt')), 'el externo no se toca');
    });

    await test('interruptor apagado (moveManual:false): se queda donde está, como antes', async function () {
        var P = dir('a5'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Rot', 'Titulo.aegraphic'), 'g');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(P, 'Rot', 'Titulo.aegraphic'))]), { moveManual: false });
        assert.strictEqual(plan.moveManual, false);
        assert.strictEqual(plan.ops[0].type, 'keep');
        assert.deepStrictEqual(plan.manual.map(function (m) { return [m.type, m.offline, m.moved]; }), [['keep', false, false]]);
        assert.strictEqual(plan.summary.kept, 1);
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        assert.ok(fs.existsSync(path.join(P, 'Rot', 'Titulo.aegraphic')));
        assert.deepStrictEqual(r.relinks, []);
    });

    await test('Deshacer: el gráfico vuelve a su sitio exacto', async function () {
        var P = dir('a6'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Rot', 'Titulo.aegraphic'), 'g'); write(path.join(P, 'Rot', 'clip.mp4'), 'v');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(P, 'Rot', 'Titulo.aegraphic')), media('v1', path.join(P, 'Rot', 'clip.mp4'))]));
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.deepStrictEqual(u.failed, []);
        engine.completeUndo(u.sessionDir, { ok: true });
        assert.strictEqual(fs.readFileSync(path.join(P, 'Rot', 'Titulo.aegraphic'), 'utf8'), 'g');
        assert.ok(!fs.existsSync(path.join(P, '01 Assets', 'Graphics')), 'carpeta creada eliminada');
        assert.deepStrictEqual(u.relinks.map(function (x) { return x.nodeId; }), ['v1'], 'solo el vídeo pide re-enlace al deshacer');
    });

    await test('Cancelar: lo no hecho queda en su sitio y lo hecho se deshace', async function () {
        var P = dir('a7'); write(path.join(P, 'E.prproj'), 'P');
        ['a', 'b', 'c'].forEach(function (x) { write(path.join(P, 'src', x + '.aegraphic'), x); });
        var plan = await engine.buildPlan(snap(P, ['a', 'b', 'c'].map(function (x) { return media(x, path.join(P, 'src', x + '.aegraphic')); })));
        var signal = { cancelled: false };
        var r = await engine.execute(plan, function (cur) { if (cur === 2) signal.cancelled = true; }, null, signal);
        assert.ok(r.cancelled);
        assert.strictEqual(fs.readdirSync(path.join(P, 'src')).length, 1, 'el tercero sigue en su sitio');
        engine.finalizeSession(r.sessionDir);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.deepStrictEqual(u.failed, []);
        assert.strictEqual(fs.readdirSync(path.join(P, 'src')).length, 3);
    });

    await test('otra versión del proyecto que usa el gráfico: pide confirmación como cualquier medio compartido', async function () {
        var P = dir('a8'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Rot', 'Titulo.aegraphic'), 'g');
        write(path.join(P, 'E_v2.prproj'), zlib.gzipSync(Buffer.from('<x><ActualMediaFilePath>' + path.join(P, 'Rot', 'Titulo.aegraphic') + '</ActualMediaFilePath></x>')));
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(P, 'Rot', 'Titulo.aegraphic'))]));
        assert.strictEqual(plan.blocked, false);
        assert.ok(plan.confirmations.some(function (c) { return /también los usan otros \(E_v2\.prproj/.test(c); }), 'aviso de medio compartido');
        assert.strictEqual(plan.ops[0].type, 'move');
    });

    await test('informe HTML: lista origen → destino y qué hacer en Premiere; JSON con plan.manual', async function () {
        var P = dir('a9'), X = dir('a9-ext'); write(path.join(P, 'E.prproj'), 'P');
        write(path.join(P, 'Rot', 'Titulo.aegraphic'), 'g'); write(path.join(X, 'Lower.mogrt'), 'm');
        var plan = await engine.buildPlan(snap(P, [media('g1', path.join(P, 'Rot', 'Titulo.aegraphic')), media('g2', path.join(X, 'Lower.mogrt'))]));
        var r = await engine.execute(plan);
        engine.finalizeSession(r.sessionDir);
        var out = await report.writeReports(plan, r);
        var html = fs.readFileSync(out.htmlPath, 'utf8');
        assert.ok(/re-enlazar a mano/.test(html) && /Vincular medio/.test(html));
        assert.ok(html.indexOf('Rot/Titulo.aegraphic') !== -1 || html.indexOf('Rot' + path.sep + 'Titulo.aegraphic') !== -1, 'origen');
        assert.ok(/Graphics[\/\\]Titulo\.aegraphic/.test(html), 'destino');
        assert.ok(/Sin conexión: re-enlazar/.test(html) && /Sigue enlazado al original/.test(html));
        var json = JSON.parse(fs.readFileSync(out.jsonPath, 'utf8'));
        assert.strictEqual(json.plan.manual.length, 2);
    });

    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
