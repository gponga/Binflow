/**
 * N6 (journal write-ahead) y N8 (recuperación tras un cuelgue).
 * Uso: node tests/crash-recovery.test.js [carpeta-temporal]
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var engine = require('../plugin/com.binflow.organizer/engine');

var CATS = { '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Images': ['jpg', 'png', 'psd'], 'Z_Others': ['txt'] };
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-crash-'));
var passed = 0, n = 0;

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function dir(name) { var d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); return d; }
function snap(proj, items) {
    return { projectPath: path.join(proj, 'P.prproj'), projectFolder: proj, assetsFolderName: '01 Assets', categories: CATS, items: items };
}
function media(id, file) { return { nodeId: id, name: path.basename(file), kind: 'media', mediaPath: file, binPath: [] }; }
function journal(sessionDir) {
    return fs.readFileSync(path.join(sessionDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}
/** Sesión como la dejaría un cuelgue: estado running, escrita por «otro» proceso. */
function crashedSession(plan, entries) {
    var d = path.join(plan.logDir, 'sessions', '2026-11-19T10-00-00-000Z-abcdef');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ id: 'x', status: 'running', pid: 1, createdAt: '2026-11-19T10:00:00.000Z', projectPath: plan.projectPath, projectFolder: plan.projectFolder, assetsDir: plan.assetsDir }));
    fs.writeFileSync(path.join(d, 'journal.jsonl'), entries.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n');
    return d;
}
/** Hace fallar la apertura del journal a partir de la llamada número `from`. */
function breakJournal(from) {
    var orig = fs.openSync, calls = 0;
    fs.openSync = function (p) {
        if (/journal\.jsonl$/.test(String(p)) && ++calls >= from) { var e = new Error('ENOSPC: disco lleno'); e.code = 'ENOSPC'; throw e; }
        return orig.apply(fs, arguments);
    };
    return function () { fs.openSync = orig; };
}

async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; }
}

(async function main() {
    console.log('N6/N8 — ' + base);

    await test('N6 el intent se escribe ANTES de mover y la confirmación después', async function () {
        var P = dir('n6a');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var r = await engine.execute(plan);
        var j = journal(r.sessionDir);
        var iIntent = j.findIndex(function (e) { return e.type === 'intent' && e.kind === 'move'; });
        var iMove = j.findIndex(function (e) { return e.type === 'move'; });
        assert.ok(iIntent >= 0 && iMove > iIntent, JSON.stringify(j));
        assert.deepStrictEqual(j[iIntent].relinks, [{ nodeId: 'a', from: path.join(P, 'raw/a.mp4') }]);
        engine.finalizeSession(r.sessionDir);
    });

    await test('N6 si el journal no se puede escribir, NO se mueve nada y se detiene', async function () {
        var P = dir('n6b');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a'); write(path.join(P, 'raw/b.mp4'), 'b');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4')), media('b', path.join(P, 'raw/b.mp4'))]));
        var session = await engine.createSession(plan);
        var restore = breakJournal(1);
        var r;
        try { r = await engine.execute(plan, null, session); } finally { restore(); }
        assert.ok(r.aborted && /registro de deshacer/.test(r.aborted));
        assert.strictEqual(r.relinks.length, 0);
        assert.ok(fs.existsSync(path.join(P, 'raw/a.mp4')) && fs.existsSync(path.join(P, 'raw/b.mp4')), 'nada movido');
        assert.ok(r.errors.some(function (e) { return e.skipped; }), 'el resto se marca como no hecho');
        assert.strictEqual(engine.finalizeSession(r.sessionDir).empty, true);
    });

    await test('N6 si falla la confirmación: se re-enlaza igual, se detiene y deshacer lo devuelve', async function () {
        var P = dir('n6c');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a'); write(path.join(P, 'raw/b.mp4'), 'b');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4')), media('b', path.join(P, 'raw/b.mp4'))]));
        var session = await engine.createSession(plan);
        var restore = breakJournal(2); // 1.º intent bien; falla la confirmación del primero
        var r;
        try { r = await engine.execute(plan, null, session); } finally { restore(); }
        assert.ok(r.aborted);
        assert.strictEqual(r.relinks.length, 1, 'el archivo movido se re-enlaza en Premiere para no quedar offline');
        var movedTo = r.relinks[0].to;
        assert.ok(fs.existsSync(movedTo));
        var fin = engine.finalizeSession(r.sessionDir);
        assert.strictEqual(fin.empty, false, 'la sesión con un intent sin confirmar no se borra');
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.restored, 1);
        assert.strictEqual(u.relinks.length, 1);
        assert.strictEqual(u.relinks[0].current, movedTo);
        assert.ok(fs.existsSync(path.join(P, 'raw/a.mp4')) && fs.existsSync(path.join(P, 'raw/b.mp4')));
    });

    await test('N8 cuelgue tras crear el hardlink: deshacer quita el enlace y el original sigue intacto', async function () {
        var P = dir('n8a');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'contenido');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var dest = path.join(plan.assetsDir, 'Videos/a.mp4');
        write(dest, ''); fs.unlinkSync(dest); fs.linkSync(path.join(P, 'raw/a.mp4'), dest);
        crashedSession(plan, [{ type: 'intent', op: 0, kind: 'move', source: path.join(P, 'raw/a.mp4'), dest: dest, relinks: [{ nodeId: 'a', from: path.join(P, 'raw/a.mp4') }] }]);
        var blocked = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        assert.ok(blocked.blocked && /interrumpió/.test(blocked.blockReason), 'no deja organizar encima');
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.ok(!fs.existsSync(dest));
        assert.strictEqual(fs.readFileSync(path.join(P, 'raw/a.mp4'), 'utf8'), 'contenido');
        assert.strictEqual(u.relinks.length, 0, 'no se llegó a re-enlazar nada');
        assert.ok(u.interrupted);
        engine.completeUndo(u.sessionDir, { ok: true });
        assert.strictEqual(engine.findInterrupted(plan.logDir, plan.projectPath).length, 0);
        assert.strictEqual((await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]))).blocked, false);
    });

    await test('N8 cuelgue con reserva de 0 bytes y temporal .binflow-partial: se limpian ambos', async function () {
        var P = dir('n8b');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'contenido');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var dest = path.join(plan.assetsDir, 'Videos/a.mp4');
        write(dest, '');
        write(dest + '.123-0a1b2c3d.binflow-partial', 'cont');
        write(dest + '.notas.binflow-partial', 'del usuario');
        crashedSession(plan, [{ type: 'intent', op: 0, kind: 'move', source: path.join(P, 'raw/a.mp4'), dest: dest, relinks: [] }]);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.cleaned.length, 2, JSON.stringify(u.cleaned));
        assert.ok(!fs.existsSync(dest) && !fs.existsSync(dest + '.123-0a1b2c3d.binflow-partial'));
        assert.ok(fs.existsSync(dest + '.notas.binflow-partial'), 'un archivo del usuario con nombre parecido no se toca');
        assert.ok(fs.existsSync(path.join(P, 'raw/a.mp4')));
    });

    await test('N8 cuelgue tras mover del todo: deshacer lo devuelve y re-enlaza desde el intent', async function () {
        var P = dir('n8c');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'contenido');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var dest = path.join(plan.assetsDir, 'Videos/a.mp4');
        write(dest, 'contenido'); fs.unlinkSync(path.join(P, 'raw/a.mp4'));
        crashedSession(plan, [{ type: 'intent', op: 0, kind: 'move', source: path.join(P, 'raw/a.mp4'), dest: dest, relinks: [{ nodeId: 'a', from: path.join(P, 'raw/a.mp4') }] }]);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.restored, 1);
        assert.ok(fs.existsSync(path.join(P, 'raw/a.mp4')) && !fs.existsSync(dest));
        assert.deepStrictEqual(u.relinks, [{ nodeId: 'a', path: path.join(P, 'raw/a.mp4'), current: dest }]);
    });

    await test('N8 copia externa cortada: se borra si el original existe y se conserva si no', async function () {
        var P = dir('n8d'), ext = dir('n8d-ext');
        write(path.join(P, 'P.prproj'), 'x');
        write(path.join(ext, 'e1.mp4'), 'uno'); write(path.join(ext, 'e2.mp4'), 'dos');
        var plan = await engine.buildPlan(snap(P, [media('e1', path.join(ext, 'e1.mp4')), media('e2', path.join(ext, 'e2.mp4'))]));
        var d1 = path.join(plan.assetsDir, 'Videos/e1.mp4'), d2 = path.join(plan.assetsDir, 'Videos/e2.mp4');
        write(d1, 'uno'); write(d2, 'dos'); fs.unlinkSync(path.join(ext, 'e2.mp4'));
        crashedSession(plan, [
            { type: 'intent', op: 0, kind: 'copy', source: path.join(ext, 'e1.mp4'), dest: d1, relinks: [{ nodeId: 'e1', from: path.join(ext, 'e1.mp4') }] },
            { type: 'intent', op: 1, kind: 'copy', source: path.join(ext, 'e2.mp4'), dest: d2, relinks: [{ nodeId: 'e2', from: path.join(ext, 'e2.mp4') }] }
        ]);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.ok(!fs.existsSync(d1), 'copia con original presente: se borra');
        assert.ok(fs.existsSync(d2), 'copia sin original: es la única, se conserva');
        assert.strictEqual(u.kept.length, 1);
        assert.deepStrictEqual(u.relinks.map(function (r) { return r.nodeId; }), ['e1']);
    });

    await test('N8 operación que falló con normalidad: no se borra el archivo ajeno del destino', async function () {
        var P = dir('n8e');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'contenido');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var dest = path.join(plan.assetsDir, 'Videos/a.mp4');
        write(dest, ''); // archivo vacío ajeno que apareció a la vez
        crashedSession(plan, [
            { type: 'intent', op: 0, kind: 'move', source: path.join(P, 'raw/a.mp4'), dest: dest, relinks: [] },
            { type: 'failed', op: 0 }
        ]);
        await engine.undo(plan.logDir, plan.projectPath);
        assert.ok(fs.existsSync(dest), 'el archivo ajeno sigue');
    });

    await test('N8 caso dudoso (en los dos sitios con distinto contenido): no se toca y se puede reintentar', async function () {
        var P = dir('n8f');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'uno');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var dest = path.join(plan.assetsDir, 'Videos/a.mp4');
        write(dest, 'otro');
        crashedSession(plan, [{ type: 'intent', op: 0, kind: 'move', source: path.join(P, 'raw/a.mp4'), dest: dest, relinks: [{ nodeId: 'a', from: path.join(P, 'raw/a.mp4') }] }]);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.failed.length, 1);
        assert.strictEqual(u.relinks.length, 0);
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'otro');
        assert.strictEqual(fs.readFileSync(path.join(P, 'raw/a.mp4'), 'utf8'), 'uno');
    });

    await test('N8 una sesión en curso de este mismo proceso no cuenta como interrumpida', async function () {
        var P = dir('n8g');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var s = await engine.createSession(plan);
        assert.strictEqual(engine.findInterrupted(plan.logDir, plan.projectPath).length, 0);
        await engine.execute(plan, null, s);
        assert.strictEqual(engine.findInterrupted(plan.logDir, plan.projectPath).length, 0, 'entre execute y finalize tampoco');
        engine.finalizeSession(s.dir);
        assert.strictEqual(engine.findInterrupted(plan.logDir, plan.projectPath).length, 0);
    });

    await test('N7 session.json manipulado (assets/proyecto en otra parte): Deshacer no toca nada', async function () {
        var P = dir('n7a'), victim = dir('n7a-victima');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a');
        write(path.join(victim, 'importante.mp4'), 'no tocar');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var r = await engine.execute(plan); engine.finalizeSession(r.sessionDir);
        var metaFile = path.join(r.sessionDir, 'session.json');
        var good = fs.readFileSync(metaFile, 'utf8');
        var cases = [
            { projectFolder: '/', assetsDir: victim },
            { projectFolder: path.dirname(path.dirname(victim)), assetsDir: path.join(path.dirname(path.dirname(victim)), 'x') },
            { assetsDir: path.join(P, 'raw', 'sub') },
            { assetsDir: path.join(victim, 'x') }
        ];
        fs.appendFileSync(path.join(r.sessionDir, 'journal.jsonl'), JSON.stringify({ type: 'copy', op: 99, source: '/nada', dest: path.join(victim, 'importante.mp4'), sha256: 'x' }) + '\n');
        for (var c = 0; c < cases.length; c++) {
            var meta = Object.assign(JSON.parse(good), cases[c]);
            fs.writeFileSync(metaFile, JSON.stringify(meta));
            await assert.rejects(function () { return engine.undo(plan.logDir, plan.projectPath); }, /no corresponde a este proyecto/, JSON.stringify(cases[c]));
        }
        assert.ok(fs.existsSync(path.join(victim, 'importante.mp4')));
        fs.writeFileSync(metaFile, good);
    });

    await test('N7 carpeta de sesiones sustituida por un enlace simbólico fuera del LOG: se rechaza', async function () {
        var P = dir('n7b'), elsewhere = dir('n7b-fuera');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw/a.mp4'), 'a');
        var plan = await engine.buildPlan(snap(P, [media('a', path.join(P, 'raw/a.mp4'))]));
        var r = await engine.execute(plan); engine.finalizeSession(r.sessionDir);
        var sessions = path.join(plan.logDir, 'sessions');
        fs.renameSync(sessions, path.join(elsewhere, 'sessions'));
        fs.symlinkSync(path.join(elsewhere, 'sessions'), sessions);
        await assert.rejects(function () { return engine.undo(plan.logDir, plan.projectPath); }, /fuera del LOG/);
    });

    await test('N7 «organizar desde la carpeta superior» sigue pudiéndose deshacer', async function () {
        var root = dir('n7c'), P = path.join(root, 'Premiere');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(root, 'Media/a.mp4'), 'a');
        var s = snap(P, [media('a', path.join(root, 'Media/a.mp4'))]);
        s.projectFolder = root;
        var plan = await engine.buildPlan(s);
        var r = await engine.execute(plan); engine.finalizeSession(r.sessionDir);
        assert.ok(!fs.existsSync(path.join(root, 'Media/a.mp4')));
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.restored, 1);
        assert.ok(fs.existsSync(path.join(root, 'Media/a.mp4')));
    });

    await test('Cancelar entre archivos: lo hecho queda registrado y el resto intacto', async function () {
        var P = dir('cx1');
        write(path.join(P, 'P.prproj'), 'x');
        ['a', 'b', 'c'].forEach(function (x) { write(path.join(P, 'raw/' + x + '.mp4'), x); });
        var plan = await engine.buildPlan(snap(P, ['a', 'b', 'c'].map(function (x) { return media(x, path.join(P, 'raw/' + x + '.mp4')); })));
        var signal = { cancelled: false };
        var r = await engine.execute(plan, function (cur) { if (cur === 2) signal.cancelled = true; }, null, signal);
        assert.ok(r.cancelled);
        // Se canceló mientras iba el 2.º: ese termina de forma segura y el 3.º no se toca.
        assert.strictEqual(r.relinks.length, 2);
        assert.strictEqual(r.errors.filter(function (e) { return e.skipped; }).length, 1);
        assert.strictEqual(fs.readdirSync(path.join(P, 'raw')).length, 1, 'el tercero sigue en su sitio');
        engine.finalizeSession(r.sessionDir);
        var u = await engine.undo(plan.logDir, plan.projectPath);
        assert.strictEqual(u.restored, 2);
        assert.strictEqual(fs.readdirSync(path.join(P, 'raw')).length, 3);
    });

    await test('Cancelar a mitad de una copia grande: sin temporales, sin destino y el original intacto', async function () {
        var P = dir('cx2'), ext = dir('cx2-ext');
        write(path.join(P, 'P.prproj'), 'x');
        var big = Buffer.alloc(40 * 1024 * 1024, 7);
        write(path.join(ext, 'grande.mp4'), big);
        var plan = await engine.buildPlan(snap(P, [media('g', path.join(ext, 'grande.mp4'))]));
        var signal = { cancelled: false };
        var origRead = fs.createReadStream, reads = 0;
        fs.createReadStream = function () {
            var st = origRead.apply(fs, arguments);
            if (++reads === 2) st.on('data', function () { signal.cancelled = true; }); // 2.ª lectura = la copia
            return st;
        };
        var r;
        try { r = await engine.execute(plan, null, null, signal); } finally { fs.createReadStream = origRead; }
        assert.ok(r.cancelled, JSON.stringify(r.errors));
        assert.strictEqual(r.relinks.length, 0);
        var videos = path.join(plan.assetsDir, 'Videos');
        assert.deepStrictEqual(fs.existsSync(videos) ? fs.readdirSync(videos) : [], [], 'ni destino ni .binflow-partial');
        assert.strictEqual(fs.statSync(path.join(ext, 'grande.mp4')).size, big.length);
        assert.strictEqual(engine.finalizeSession(r.sessionDir).empty, true, 'nada que deshacer');
    });

    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
