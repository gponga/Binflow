/**
 * Regresión de los arreglos del motor tras la auditoría v2.3.0 (encargo 04).
 * Cada prueba parte del repro de la auditoría y comprueba el arreglo.
 * Uso: node tests/motor-fixes.test.js [carpeta-temporal]
 * (N20 y N23, que usan ext.jsx, están en jsx-integration.test.js.)
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var engine = require('../plugin/com.binflow.organizer/engine');
var fsu = require('../plugin/com.binflow.organizer/engine/fsutil');

var CATS = { '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Images': ['exr', 'dpx', 'png', 'jpg'], 'Docs': ['pdf'], 'Z_Others': ['txt', 'cube'] };
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-motor-'));
var passed = 0, n = 0;

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content === undefined ? 'x' + file : content); }
function dir(name) { var d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); return d; }
function snap(proj, prproj, items, extra) {
    var s = { projectPath: path.join(proj, prproj), projectFolder: proj, assetsFolderName: '01 Assets', categories: CATS, items: items };
    Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
    return s;
}
function media(id, file, bin) { return { nodeId: id, name: path.basename(file), kind: 'media', mediaPath: file, binPath: bin || [] }; }
async function run(plan) { var r = await engine.execute(plan); engine.finalizeSession(r.sessionDir); return r; }
function listFiles(root) {
    var out = [];
    (function w(d) { fs.readdirSync(d).forEach(function (name) { var f = path.join(d, name); if (fs.lstatSync(f).isDirectory()) w(f); else out.push(path.relative(root, f)); }); })(root);
    return out.sort();
}
function frame(i) { return 'plate.' + ('000' + i).slice(-4) + '.exr'; }

async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}

(async function main() {
    console.log('Arreglos del motor (encargo 04) — ' + base);

    // ------------------------------------------------------------ N17
    await test('N17 dos organizaciones seguidas: el informe de la primera sigue ahí con la ruta original', async function () {
        var P = dir('n17'); var prproj = path.join(P, 'E.prproj');
        write(prproj, 'P'); write(path.join(P, 'Media', 'a.mp4')); write(path.join(P, 'Media', 'viejo.txt'));
        var itA = media('n1', path.join(P, 'Media', 'a.mp4'));
        var p1 = await engine.buildPlan(snap(P, 'E.prproj', [itA]));
        var r1 = await run(p1); var rep1 = await engine.writeReports(p1, r1);
        var pdf1 = fs.readFileSync(rep1.pdfPath, 'latin1');
        var html1 = fs.readFileSync(rep1.htmlPath, 'utf8'), json1 = fs.readFileSync(rep1.jsonPath, 'utf8');
        assert.ok(/Media\/viejo\.txt/.test(pdf1), 'el primer PDF recoge la ruta original de viejo.txt');

        write(path.join(P, 'Media', 'b.mp4'));
        var p2 = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', r1.relinks[0].to, ['Videos']), media('n2', path.join(P, 'Media', 'b.mp4'))]));
        var r2 = await run(p2); var rep2 = await engine.writeReports(p2, r2);
        assert.notStrictEqual(rep2.pdfPath, rep1.pdfPath); assert.notStrictEqual(rep2.htmlPath, rep1.htmlPath); assert.notStrictEqual(rep2.jsonPath, rep1.jsonPath);
        assert.strictEqual(fs.readFileSync(rep1.pdfPath, 'latin1'), pdf1, 'el PDF 1 no se ha tocado');
        assert.strictEqual(fs.readFileSync(rep1.htmlPath, 'utf8'), html1);
        assert.strictEqual(fs.readFileSync(rep1.jsonPath, 'utf8'), json1);
        assert.ok(/No usados_/.test(path.basename(rep1.pdfPath)));
        assert.ok(html1.indexOf(path.basename(rep1.pdfPath)) !== -1, 'el HTML nombra su PDF');
    });

    await test('N17 dos informes en el mismo segundo no se pisan (y el JSON va sin sangría)', async function () {
        var P = dir('n17b'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'x.txt'));
        var pl = await engine.buildPlan(snap(P, 'E.prproj', []));
        var a = await engine.writeReports(pl, null), b = await engine.writeReports(pl, null), c = await engine.writeReports(pl, null);
        var set = {}; [a, b, c].forEach(function (r) { [r.htmlPath, r.jsonPath, r.pdfPath].forEach(function (f) { assert.ok(!set[f], 'repetido: ' + f); set[f] = true; assert.ok(fs.existsSync(f)); }); });
        var json = fs.readFileSync(a.jsonPath, 'utf8');
        assert.ok(json.indexOf('\n') === -1, 'JSON compacto');
        assert.ok(JSON.parse(json).plan);
    });

    // ------------------------------------------------------------ N14
    await test('N14 secuencia de imágenes dentro del proyecto: se mueve entera y solo se re-enlaza el primer fotograma', async function () {
        var P = dir('n14a'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 5; i++) write(path.join(P, 'Plate', frame(i)));
        write(path.join(P, 'Plate', 'otra.0001.png'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Plate', frame(1)))]));
        assert.ok(plan.sequences.length === 1 && plan.sequences[0].count === 5 && plan.sequences[0].moved);
        var result = await run(plan);
        assert.deepStrictEqual(result.errors, []);
        var files = listFiles(P).filter(function (f) { return f.indexOf('LOG') !== 0; });
        for (i = 1; i <= 5; i++) assert.ok(files.indexOf('01 Assets/Images/' + frame(i)) !== -1, 'fotograma ' + i + ' en Images: ' + files);
        assert.ok(files.every(function (f) { return f.indexOf('plate.') === -1 || f.indexOf('_No usados') === -1; }), 'ningún fotograma en _No usados');
        assert.ok(files.indexOf('01 Assets/_No usados/Images/otra.0001.png') !== -1, 'otra secuencia distinta sigue siendo «sin uso»');
        assert.strictEqual(result.relinks.length, 1);
        assert.strictEqual(result.relinks[0].to, path.join(P, '01 Assets/Images', frame(1)));
        // Deshacer devuelve toda la secuencia a su sitio.
        await engine.undo(plan.logDir, plan.projectPath);
        for (i = 1; i <= 5; i++) assert.ok(fs.existsSync(path.join(P, 'Plate', frame(i))), 'deshecho ' + i);
    });

    await test('N14 secuencia externa: se copia entera a assets', async function () {
        var P = dir('n14b/Spot'); var X = dir('n14b/fuera'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 4; i++) write(path.join(X, frame(i)));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(X, frame(1)))]));
        assert.strictEqual(plan.ops.filter(function (o) { return o.type === 'copy'; }).length, 4);
        var result = await run(plan);
        assert.deepStrictEqual(result.errors, []);
        for (i = 1; i <= 4; i++) { assert.ok(fs.existsSync(path.join(P, '01 Assets/Images', frame(i)))); assert.ok(fs.existsSync(path.join(X, frame(i))), 'los originales no se tocan'); }
        assert.strictEqual(result.relinks.length, 1);
    });

    await test('N14 si el destino ya tiene un fotograma distinto: no se mueve y se avisa', async function () {
        var P = dir('n14c'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 3; i++) write(path.join(P, 'Plate', frame(i)));
        write(path.join(P, '01 Assets', 'Images', frame(2)), 'OTRO CONTENIDO');
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Plate', frame(1)))]));
        assert.ok(plan.warnings.some(function (w) { return /Secuencia/.test(w) && /No se mueve/.test(w); }), JSON.stringify(plan.warnings));
        assert.strictEqual(plan.ops.filter(function (o) { return /plate\./.test(o.source); }).length, 0);
        await run(plan);
        for (i = 1; i <= 3; i++) assert.ok(fs.existsSync(path.join(P, 'Plate', frame(i))), 'sigue en su sitio ' + i);
    });

    await test('N14 clips numerados (C0001.mp4, C0002.mp4) NO son una secuencia', async function () {
        var P = dir('n14d'); write(path.join(P, 'E.prproj'), 'P');
        write(path.join(P, 'Raw', 'C0001.mp4')); write(path.join(P, 'Raw', 'C0002.mp4'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Raw', 'C0001.mp4'))]));
        assert.strictEqual(plan.sequences.length, 0);
        await run(plan);
        assert.ok(fs.existsSync(path.join(P, '01 Assets/_No usados/Videos/C0002.mp4')));
    });

    // ------------------------------------------------------------ N16
    await test('N16 lo que referencia el .prproj guardado (proxy, LUT) o el snapshot (proxyPaths) no se mueve', async function () {
        var P = dir('n16'); var prproj = path.join(P, 'E.prproj');
        write(path.join(P, 'a.mp4')); write(path.join(P, 'Proxies', 'a_proxy.mp4')); write(path.join(P, 'luts', 'look.cube')); write(path.join(P, 'suelto.txt'));
        var xml = '<x><ActualMediaFilePath>' + path.join(P, 'luts', 'look.cube') + '</ActualMediaFilePath></x>';
        fs.writeFileSync(prproj, zlib.gzipSync(Buffer.from(xml)));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'a.mp4'))], { proxyPaths: [path.join(P, 'Proxies', 'a_proxy.mp4')] }));
        var moved = plan.ops.map(function (o) { return path.basename(o.source); });
        assert.ok(moved.indexOf('look.cube') === -1 && moved.indexOf('a_proxy.mp4') === -1, 'no se mueven: ' + moved);
        assert.ok(moved.indexOf('suelto.txt') !== -1, 'lo realmente sin uso sí');
        var u = plan.unused.filter(function (x) { return x.reason === 'usado por el proyecto'; }).map(function (x) { return x.name; }).sort();
        assert.deepStrictEqual(u, ['a_proxy.mp4', 'look.cube']);
    });

    // ------------------------------------------------------------ N15
    await test('N15 proyecto en .../Adobe/Premiere Pro/<versión>: preferencias y perfiles se quedan donde están', async function () {
        var P = path.join(dir('n15'), 'Documents', 'Adobe', 'Premiere Pro', '25.0');
        write(path.join(P, 'Mio.prproj'), 'P'); write(path.join(P, 'Clip.mp4'));
        write(path.join(P, 'Profile-Demo', 'Mac', 'Layouts', 'Editing.xml')); write(path.join(P, 'Profile-Demo', 'Settings.txt'));
        write(path.join(P, 'Layouts', 'x.xml')); write(path.join(P, 'ajustes.txt'));
        var plan = await engine.buildPlan(snap(P, 'Mio.prproj', [media('n1', path.join(P, 'Clip.mp4'))]));
        assert.ok(plan.warnings.some(function (w) { return /carpeta de Premiere/.test(w); }));
        var moved = plan.ops.map(function (o) { return path.relative(P, o.source); });
        assert.deepStrictEqual(moved, ['Clip.mp4'], 'solo el medio usado: ' + moved);
        await run(plan);
        assert.ok(fs.existsSync(path.join(P, 'Profile-Demo', 'Settings.txt')) && fs.existsSync(path.join(P, 'Layouts', 'x.xml')) && fs.existsSync(path.join(P, 'ajustes.txt')));
    });

    await test('N15 una carpeta Profile-… nunca se analiza, esté donde esté el proyecto', async function () {
        var P = dir('n15b'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'a.mp4')); write(path.join(P, 'Profile-Ana', 'prefs.txt'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'a.mp4'))]));
        assert.ok(plan.ops.every(function (o) { return o.source.indexOf('Profile-Ana') === -1; }));
    });

    // ------------------------------------------------------------ N18
    await test('N18 enlace simbólico en assets: no se crea ninguna carpeta fuera del proyecto', async function () {
        var P = dir('n18/Spot'); var outside = dir('n18/FUERA'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Brutos', 'a.mp4'));
        fs.mkdirSync(path.join(P, '01 Assets'), { recursive: true }); fs.symlinkSync(outside, path.join(P, '01 Assets', 'Videos'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Brutos', 'a.mp4'), ['Brutos'])]));
        var result = await engine.execute(plan);
        assert.ok(result.errors.length >= 1 && /enlace simb/.test(result.errors[0].message), JSON.stringify(result.errors));
        assert.deepStrictEqual(fs.readdirSync(outside), [], 'FUERA sigue vacía');
        assert.ok(fs.existsSync(path.join(P, 'Brutos', 'a.mp4')));
    });

    // ------------------------------------------------------------ N19
    await test('N19 plan bloqueado: los BINs y el motivo salen igualmente (modo solo BINs)', async function () {
        var home = os.homedir();
        var plan = await engine.buildPlan({ projectPath: path.join(home, 'x.prproj'), projectFolder: home, assetsFolderName: '01 Assets', categories: CATS,
            items: [media('n1', '/x/a.mp4', ['Brutos'])] });
        assert.strictEqual(plan.blocked, true);
        assert.strictEqual(plan.blockCode, 'unsafe-root');
        assert.ok(plan.blockReason.length > 10);
        assert.strictEqual(plan.items.length, 1);
        assert.strictEqual(plan.binMoves.length, 1);
    });

    // ------------------------------------------------------------ N21
    await test('N21 cuelgue con origen y destino idénticos: se borra la copia y se trata como «no llegó a hacerse»', async function () {
        var P = dir('n21'); var pr = path.join(P, 'E.prproj'); write(pr, 'P'); write(path.join(P, 'Media', 'a.mp4'), 'contenido');
        var pl = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Media', 'a.mp4'))]));
        var ses = await engine.createSession(pl); var dest = pl.ops[0].dest;
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(pl.ops[0].source, dest);
        fs.appendFileSync(path.join(ses.dir, 'journal.jsonl'), JSON.stringify({ type: 'intent', op: 0, kind: 'move', source: pl.ops[0].source, dest: dest, relinks: [{ nodeId: 'n1', from: pl.ops[0].source }] }) + '\n');
        var r = await engine.undo(engine.logDirFor(pr), pr);
        assert.deepStrictEqual(r.failed, []);
        assert.ok(fs.existsSync(pl.ops[0].source), 'el original sigue');
        assert.ok(!fs.existsSync(dest), 'la copia sobra y se ha borrado');
        assert.strictEqual(r.relinks.length, 0, 'no hay nada que re-enlazar');
    });

    await test('N21 si los dos archivos NO son idénticos sigue siendo ambiguo y no se toca nada', async function () {
        var P = dir('n21b'); var pr = path.join(P, 'E.prproj'); write(pr, 'P'); write(path.join(P, 'Media', 'a.mp4'), 'contenido');
        var pl = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Media', 'a.mp4'))]));
        var ses = await engine.createSession(pl); var dest = pl.ops[0].dest;
        fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'OTRO contenido');
        fs.appendFileSync(path.join(ses.dir, 'journal.jsonl'), JSON.stringify({ type: 'intent', op: 0, kind: 'move', source: pl.ops[0].source, dest: dest, relinks: [] }) + '\n');
        var r = await engine.undo(engine.logDirFor(pr), pr);
        assert.strictEqual(r.failed.length, 1);
        assert.ok(fs.existsSync(dest) && fs.existsSync(pl.ops[0].source));
    });

    // ------------------------------------------------------------ N22
    await test('N22 copia entre volúmenes: fsync del temporal antes de publicar y del destino antes de borrar el origen', async function () {
        var D = dir('n22'); write(path.join(D, 'src', 'a.bin'), 'datos'); fs.mkdirSync(path.join(D, 'dst'));
        var events = [];
        var o = { link: fs.link, rename: fs.rename, unlink: fs.unlink, fsync: fs.fsyncSync };
        fs.link = function (a, b, cb) { var e = new Error('simulado'); e.code = 'EXDEV'; cb(e); };
        fs.rename = function (a, b, cb) { events.push('rename'); return o.rename.call(fs, a, b, cb); };
        fs.unlink = function (p, cb) { events.push('unlink:' + path.basename(p)); return o.unlink.call(fs, p, cb); };
        fs.fsyncSync = function (fd) { events.push('fsync'); return o.fsync.call(fs, fd); };
        try { await fsu.moveFile(path.join(D, 'src', 'a.bin'), path.join(D, 'dst', 'a.bin')); }
        finally { fs.link = o.link; fs.rename = o.rename; fs.unlink = o.unlink; fs.fsyncSync = o.fsync; }
        var iRename = events.indexOf('rename'), iUnlinkSrc = events.indexOf('unlink:a.bin');
        assert.ok(iRename > 0 && events.slice(0, iRename).indexOf('fsync') !== -1, 'fsync antes de publicar: ' + events);
        assert.ok(iUnlinkSrc > iRename && events.slice(iRename, iUnlinkSrc).indexOf('fsync') !== -1, 'fsync antes de borrar el origen: ' + events);
        assert.ok(fs.existsSync(path.join(D, 'dst', 'a.bin')) && !fs.existsSync(path.join(D, 'src', 'a.bin')));
    });

    // ------------------------------------------------------------ N10
    await test('N10 el margen de espacio es proporcional (no 200 MB fijos) y cuenta los movimientos a otro disco', async function () {
        var P = dir('n10/Spot'); var X = dir('n10/fuera'); write(path.join(P, 'E.prproj'), 'P');
        fs.writeFileSync(path.join(X, 'big.mov'), Buffer.alloc(1024 * 1024));
        var it = [media('n1', path.join(X, 'big.mov'))];
        var tight = await engine.buildPlan(snap(P, 'E.prproj', it), { freeSpace: function () { return 1.2 * 1024 * 1024; } });
        assert.strictEqual(tight.blocked, false, 'con 1,2 MB libres para copiar 1 MB cabe (antes se bloqueaba por el margen fijo)');
        var full = await engine.buildPlan(snap(P, 'E.prproj', it), { freeSpace: function () { return 1.05 * 1024 * 1024; } });
        assert.strictEqual(full.blocked, true); assert.strictEqual(full.blockCode, 'no-space');

        // Movimiento que cruza discos (simulado: el origen «está en otro dispositivo»).
        var Q = dir('n10b/Spot'); write(path.join(Q, 'E.prproj'), 'P'); fs.writeFileSync(path.join(Q, 'big.mov'), Buffer.alloc(1024 * 1024));
        var realStat = fs.statSync;
        fs.statSync = function (p) { var st = realStat.apply(fs, arguments); if (/big\.mov$/.test(String(p))) st.dev = 987654; return st; };
        var cross;
        try { cross = await engine.buildPlan(snap(Q, 'E.prproj', [media('n1', path.join(Q, 'big.mov'))]), { freeSpace: function () { return 1.05 * 1024 * 1024; } }); }
        finally { fs.statSync = realStat; }
        assert.strictEqual(cross.summary.bytesCrossDevice, 1024 * 1024);
        assert.strictEqual(cross.blocked, true, 'un movimiento entre discos necesita espacio en el destino');
    });

    // ------------------------------------------------------------ N11
    await test('N11 respaldo por nombre: si el registro sabe el tamaño del original y no coincide, no se recupera', async function () {
        var P = dir('n11'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Media', 'C0001.MP4'), '12345');
        var p1 = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Media', 'C0001.MP4'))]));
        var r1 = await run(p1); var moved = r1.relinks[0].to;
        // El usuario aparta el archivo a mano y deja otro con el mismo nombre pero distinto.
        fs.unlinkSync(moved); write(path.join(P, 'Otros', 'C0001.MP4'), '123456789-OTRO-PLANO');
        var p2 = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', moved, ['Videos'])]));
        assert.strictEqual(p2.blocked, true);
        assert.strictEqual(p2.missing.length, 1); assert.ok(/tama/.test(p2.missing[0].note), JSON.stringify(p2.missing));
        assert.ok(!p2.recovered);
        // Con el mismo tamaño sí se recupera (y se pide confirmar).
        fs.unlinkSync(path.join(P, 'Otros', 'C0001.MP4')); write(path.join(P, 'Otros', 'C0001.MP4'), '12345');
        var p3 = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', moved, ['Videos'])]));
        assert.strictEqual(p3.blocked, false); assert.strictEqual(p3.recovered.length, 1); assert.strictEqual(p3.recovered[0].verified, true);
    });

    await test('N11 sin registro previo se recupera pero el aviso dice que no se pudo comprobar', async function () {
        var P = dir('n11b'); write(path.join(P, 'E.prproj'), 'P'); write(path.join(P, 'Otros', 'C0001.MP4'), 'x');
        var p = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Media', 'C0001.MP4'))]));
        assert.strictEqual(p.recovered.length, 1); assert.strictEqual(p.recovered[0].verified, false);
        assert.ok(p.confirmations.some(function (c) { return /solo coincide el nombre/.test(c); }), JSON.stringify(p.confirmations));
    });

    // ------------------------------------------------------------ N13
    await test('N13 el orden de las sesiones no depende del reloj (contador en session.json)', async function () {
        var P = dir('n13'); var pr = path.join(P, 'E.prproj'); write(pr, 'P'); write(path.join(P, 'Media', 'a.mp4')); write(path.join(P, 'Media', 'b.mp4'));
        var p1 = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Media', 'a.mp4'))]));
        var s1 = await engine.createSession(p1); await engine.execute(p1, null, s1); engine.finalizeSession(s1.dir);
        // «Reloj atrás»: la primera sesión pasa a tener un nombre con fecha futura.
        var renamed = path.join(path.dirname(s1.dir), '9999-12-31T00-00-00-000Z-aaaaaa'); fs.renameSync(s1.dir, renamed);
        var p2 = await engine.buildPlan(snap(P, 'E.prproj', [media('n2', path.join(P, 'Media', 'b.mp4'))]));
        var s2 = await engine.createSession(p2); await engine.execute(p2, null, s2); engine.finalizeSession(s2.dir);
        var meta2 = JSON.parse(fs.readFileSync(path.join(s2.dir, 'session.json'), 'utf8'));
        assert.strictEqual(meta2.seq, 2);
        var latest = engine.latestSession(p2.logDir, pr);
        assert.strictEqual(latest.dir, s2.dir, 'Deshacer ofrece la última sesión, no la de nombre «más nuevo»');
    });

    // ------------------------------------------------------------ APFS con distinción de mayúsculas
    await test('Mayúsculas: key() distingue A/a cuando el volumen las distingue, y se detecta mirando la carpeta', function () {
        var D = dir('case'); write(path.join(D, 'Abc.txt'));
        try {
            fsu.setCaseSensitive(true);
            assert.notStrictEqual(fsu.key('/x/A.mov'), fsu.key('/x/a.mov'));
            assert.notStrictEqual(fsu.nameKey('A.mov'), fsu.nameKey('a.mov'));
            fsu.setCaseSensitive(false);
            assert.strictEqual(fsu.key('/x/A.mov'), fsu.key('/x/a.mov'));
        } finally { fsu.setCaseSensitive(null); }
        var realLstat = fs.lstatSync;
        try {
            fs.lstatSync = function (p) { if (path.basename(String(p)) !== 'Abc.txt') { var e = new Error('no'); e.code = 'ENOENT'; throw e; } return realLstat.apply(fs, arguments); };
            assert.strictEqual(fsu.detectCaseSensitive(D), true, 'el nombre con otra capitalización no existe: distingue');
            fs.lstatSync = function () { return {}; };
            assert.strictEqual(fsu.detectCaseSensitive(D), false, 'existe con otra capitalización: no distingue');
        } finally { fs.lstatSync = realLstat; }
    });

    // ------------------------------------------------------------ Segunda ronda (re-auditoría)
    await test('N24 un fotograma que usa otra versión del proyecto no viaja con la secuencia', async function () {
        var P = dir('n24'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 6; i++) write(path.join(P, 'Plate', frame(i)));
        var xml = '<x><ActualMediaFilePath>' + path.join(P, 'Plate', frame(6)) + '</ActualMediaFilePath></x>';
        write(path.join(P, 'E_v2.prproj'), zlib.gzipSync(Buffer.from(xml)));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Plate', frame(1)))]));
        assert.ok(!plan.ops.some(function (o) { return /0006/.test(o.source); }), 'el 6 lo usa la v2: no se mueve');
        assert.ok(plan.ops.some(function (o) { return o.reason === 'secuencia' && /0002/.test(o.source); }), 'el resto de la secuencia 1-5 sí');
        // Y lo mismo con lo que referencia el propio .prproj guardado.
        var Q = dir('n24b'); fs.writeFileSync(path.join(Q, 'E.prproj'), zlib.gzipSync(Buffer.from('<x><ActualMediaFilePath>' + path.join(Q, 'Plate', frame(4)) + '</ActualMediaFilePath></x>')));
        for (i = 1; i <= 5; i++) write(path.join(Q, 'Plate', frame(i)));
        var plan2 = await engine.buildPlan(snap(Q, 'E.prproj', [media('n1', path.join(Q, 'Plate', frame(1)))]));
        assert.ok(!plan2.ops.some(function (o) { return /0004/.test(o.source); }));
    });

    await test('N25 una carpeta de fotos numeradas con una usada NO se trata como secuencia', async function () {
        var P = dir('n25'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 6; i++) write(path.join(P, 'Fotos', 'IMG_000' + i + '.jpg'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'Fotos', 'IMG_0003.jpg'))]));
        assert.strictEqual(plan.sequences.length, 0);
        assert.deepStrictEqual(plan.ops.filter(function (o) { return o.reason === 'secuencia'; }), []);
        assert.strictEqual(plan.ops.filter(function (o) { return /_No usados/.test(o.dest); }).length, 5, 'las otras 5 van a _No usados');
        assert.ok(plan.warnings.some(function (w) { return /no parece una secuencia/.test(w); }), JSON.stringify(plan.warnings));
    });

    await test('N25 imágenes sueltas con números sin rellenar (logo1, logo2, logo10) y pares de fotogramas no son secuencia', async function () {
        var P = dir('n25b'); write(path.join(P, 'E.prproj'), 'P');
        ['logo1.png', 'logo2.png', 'logo3.png', 'logo10.png'].forEach(function (f) { write(path.join(P, 'g', f)); });
        write(path.join(P, 'x', frame(1))); write(path.join(P, 'x', frame(2)));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'g', 'logo1.png')), media('n2', path.join(P, 'x', frame(1)))]));
        assert.strictEqual(plan.sequences.length, 0, JSON.stringify(plan.sequences));
        assert.ok(plan.ops.some(function (o) { return /logo2/.test(o.source) && /_No usados/.test(o.dest); }));
        assert.ok(plan.ops.some(function (o) { return /0002/.test(o.source) && /_No usados/.test(o.dest); }), 'solo 2 fotogramas: duda → solo el usado');
    });

    await test('N25 fotos con números rellenos y consecutivos que empiezan en la usada SÍ son secuencia (png)', async function () {
        var P = dir('n25c'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 4; i++) write(path.join(P, 'S', 'anim.000' + i + '.png'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'S', 'anim.0001.png'))]));
        assert.strictEqual(plan.sequences.length, 1); assert.strictEqual(plan.sequences[0].count, 4);
    });

    await test('N26 dos secuencias con los mismos nombres: no se mueven ni se parten con __hash', async function () {
        var P = dir('n26'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 3; i++) { write(path.join(P, 'A', frame(i)), 'A' + i); write(path.join(P, 'B', frame(i)), 'B' + i); }
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('a', path.join(P, 'A', frame(1))), media('b', path.join(P, 'B', frame(1)))]));
        assert.ok(plan.warnings.some(function (w) { return /otra secuencia del plan/.test(w); }), JSON.stringify(plan.warnings));
        var r = await run(plan);
        var files = listFiles(P).filter(function (f) { return f.indexOf('LOG') !== 0; });
        assert.ok(!files.some(function (f) { return /__[0-9a-f]{10}/.test(f); }), 'ningún fotograma con __hash: ' + files);
        for (i = 1; i <= 3; i++) assert.ok(files.indexOf('B/' + frame(i)) !== -1 || files.indexOf('A/' + frame(i)) !== -1);
    });

    await test('N27 el informe ya no promete «LUT»', function () {
        var src = fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/engine/report.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/engine/plan.js'), 'utf8');
        assert.ok(!/LUT/.test(src));
    });

    await test('N28 detectCaseSensitive prueba varios nombres, entiende a.mov/A.mov y duda si no coinciden', function () {
        var D = dir('n28'); write(path.join(D, 'x.txt'));
        var rl = fs.lstatSync, rd = fs.readdirSync;
        try {
            function enoent() { var e = new Error('x'); e.code = 'ENOENT'; return e; }
            // Volumen que distingue y tiene a.mov y A.mov a la vez (inodos distintos).
            fs.readdirSync = function () { return ['a.mov', 'A.mov']; };
            fs.lstatSync = function (p) { var b = path.basename(p); if (b === 'a.mov') return { ino: 1, dev: 1 }; if (b === 'A.mov') return { ino: 2, dev: 1 }; throw enoent(); };
            assert.strictEqual(fsu.detectCaseSensitive(D), true);
            // Volumen que no distingue: la variante es el mismo archivo.
            fs.lstatSync = function () { return { ino: 7, dev: 1 }; };
            assert.strictEqual(fsu.detectCaseSensitive(D), false);
            // Nombres que no coinciden entre sí: se duda.
            fs.readdirSync = function () { return ['a.mov', 'b.mov']; };
            fs.lstatSync = function (p) { var b = path.basename(p); if (b === 'a.mov' || b === 'b.mov' || b === 'B.MOV') return { ino: 1, dev: 1 }; throw enoent(); };
            assert.strictEqual(fsu.detectCaseSensitive(D), null);
            // Solo nombres sin letras ASCII (ß): no se sabe.
            fs.readdirSync = function () { return ['ß.mov'.replace(/[a-z]/g, '') ]; };
            assert.strictEqual(fsu.detectCaseSensitive(D), null);
        } finally { fs.lstatSync = rl; fs.readdirSync = rd; }
    });

    // ------------------------------------------------------------ Tercera ronda
    await test('N30 una secuencia con un fotograma que falta se mueve entera (los huecos se admiten)', async function () {
        var P = dir('n30'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 100; i++) if (i !== 11) write(path.join(P, 'S', 'p.' + ('0000' + i).slice(-4) + '.exr'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'S', 'p.0001.exr'))]));
        assert.strictEqual(plan.sequences.length, 1); assert.strictEqual(plan.sequences[0].count, 99); assert.strictEqual(plan.sequences[0].gaps, true);
        assert.strictEqual(plan.ops.filter(function (o) { return /_No usados/.test(o.dest); }).length, 0, 'ninguno a _No usados');
        var w = plan.warnings.filter(function (x) { return /se mueven juntas/.test(x); })[0];
        assert.ok(w && /99 archivos, con huecos/.test(w), JSON.stringify(plan.warnings));
        var r = await run(plan);
        assert.deepStrictEqual(r.errors, []); assert.strictEqual(r.relinks.length, 1);
    });

    await test('N30 con el fotograma 2 perdido también se agrupa (formato de fotogramas con relleno)', async function () {
        var P = dir('n30b'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 100; i++) if (i !== 2) write(path.join(P, 'S', 'p.' + ('0000' + i).slice(-4) + '.exr'));
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'S', 'p.0001.exr'))]));
        assert.strictEqual(plan.sequences[0].count, 100 - 1);
        assert.strictEqual(plan.ops.filter(function (o) { return /_No usados/.test(o.dest); }).length, 0);
    });

    await test('N30 un patrón de ≥10 archivos que no se agrupa NO va a _No usados sin confirmación', async function () {
        var P = dir('n30c'); write(path.join(P, 'E.prproj'), 'P');
        for (var i = 1; i <= 12; i++) write(path.join(P, 'S', 'p.' + ('0000' + i).slice(-4) + '.exr'));
        // El usado está a mitad: hay números menores, no se agrupa (N32).
        var plan = await engine.buildPlan(snap(P, 'E.prproj', [media('n1', path.join(P, 'S', 'p.0005.exr'))]));
        assert.strictEqual(plan.sequences.length, 0);
        assert.ok(plan.confirmations.some(function (c) { return /12 archivos con el patrón/.test(c) && /NO se agrupan/.test(c); }), JSON.stringify(plan.confirmations));
        // Fotos sueltas numeradas (≥10): también pide confirmar.
        var Q = dir('n30d'); write(path.join(Q, 'E.prproj'), 'P');
        for (i = 1; i <= 12; i++) write(path.join(Q, 'F', 'IMG_' + ('0000' + i).slice(-4) + '.jpg'));
        var plan2 = await engine.buildPlan(snap(Q, 'E.prproj', [media('n1', path.join(Q, 'F', 'IMG_0004.jpg'))]));
        assert.ok(plan2.confirmations.some(function (c) { return /12 archivos con el patrón/.test(c); }), JSON.stringify(plan2.confirmations));
    });

    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
