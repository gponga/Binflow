/**
 * Regresión de los hallazgos de la auditoría independiente (2026-11-18).
 * Cada prueba reproduce el ataque o fallo que encontró el auditor y comprueba que ya no ocurre.
 * Uso: node tests/audit-fixes.test.js [carpeta-temporal]
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var zlib = require('zlib');
var engine = require('../plugin/com.binflow.organizer/engine');
var fsu = require('../plugin/com.binflow.organizer/engine/fsutil');

var CATS = { '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Music & SFX': ['wav', 'mp3'], 'Images': ['jpg', 'png', 'psd'], 'Docs': ['pdf'], 'Z_Others': ['txt'] };
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-audit-'));
var passed = 0, n = 0;

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function dir(name) { var d = path.join(base, name); fs.mkdirSync(d, { recursive: true }); return d; }
function snap(proj, prproj, items, cats) {
    return { projectPath: path.join(proj, prproj), projectFolder: proj, assetsFolderName: '01 Assets', categories: cats || CATS, items: items };
}
function media(id, file, bin) { return { nodeId: id, name: path.basename(file), kind: 'media', mediaPath: file, binPath: bin || [] }; }
async function run(plan) { var r = await engine.execute(plan); engine.finalizeSession(r.sessionDir); return r; }

async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 3).join('\n    ')); process.exitCode = 1; }
}

(async function main() {
    console.log('Regresión de la auditoría — ' + base);

    await test('#2 LOG por proyecto: deshacer en A no toca B (misma carpeta padre)', async function () {
        var parent = dir('h2');
        var A = path.join(parent, 'A'), B = path.join(parent, 'B');
        write(path.join(A, 'A.prproj'), 'x'); write(path.join(A, 'raw', 'a.mp4'), 'a');
        write(path.join(B, 'B.prproj'), 'x'); write(path.join(B, 'raw', 'b.mp4'), 'b');
        var pa = await engine.buildPlan(snap(A, 'A.prproj', [media('a', path.join(A, 'raw/a.mp4'))]));
        var pb = await engine.buildPlan(snap(B, 'B.prproj', [media('b', path.join(B, 'raw/b.mp4'))]));
        assert.notStrictEqual(pa.logDir, pb.logDir);
        assert.ok(fsu.isWithin(pa.logDir, A) && fsu.isWithin(pb.logDir, B), 'LOG dentro de cada proyecto');
        await run(pa); await run(pb);
        var u = await engine.undo(pa.logDir, path.join(A, 'A.prproj'));
        assert.ok(u.relinks.every(function (r) { return r.nodeId === 'a'; }));
        assert.ok(fs.existsSync(path.join(A, 'raw/a.mp4')));
        assert.ok(fs.existsSync(path.join(B, '01 Assets/Videos/b.mp4')), 'B sigue organizado');
        await assert.rejects(function () { return engine.undo(pa.logDir, path.join(B, 'B.prproj')); }, /No hay una organización/);
    });

    await test('#3 una segunda ejecución sin cambios no borra el deshacer de la primera', async function () {
        var P = dir('h3');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw', 'c.mp4'), 'c');
        var s1 = snap(P, 'P.prproj', [media('c', path.join(P, 'raw/c.mp4'))]);
        var r1 = await run(await engine.buildPlan(s1));
        var s2 = snap(P, 'P.prproj', [media('c', r1.relinks[0].to, ['Videos'])]);
        var p2 = await engine.buildPlan(s2);
        var r2 = await engine.execute(p2);
        assert.strictEqual(engine.finalizeSession(r2.sessionDir).empty, true, 'la sesión vacía se descarta');
        var u = await engine.undo(p2.logDir, s1.projectPath);
        assert.strictEqual(u.restored, 1);
        assert.ok(fs.existsSync(path.join(P, 'raw/c.mp4')));
    });

    await test('#4 deshacer a medias: no re-enlaza lo que no volvió y se puede reintentar', async function () {
        var P = dir('h4');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw', 'b.mp4'), 'b'); write(path.join(P, 'raw', 'd.mp4'), 'd');
        var s = snap(P, 'P.prproj', [media('b', path.join(P, 'raw/b.mp4')), media('d', path.join(P, 'raw/d.mp4'))]);
        var plan = await engine.buildPlan(s);
        await run(plan);
        write(path.join(P, 'raw', 'b.mp4'), 'OTRO');                       // aparece otro b.mp4 en el origen
        var u = await engine.undo(plan.logDir, s.projectPath);
        assert.strictEqual(u.failed.length, 1);
        assert.ok(!u.relinks.some(function (r) { return r.nodeId === 'b'; }), 'b no se re-enlaza al archivo ajeno');
        assert.ok(u.relinks.some(function (r) { return r.nodeId === 'd'; }));
        engine.completeUndo(u.sessionDir, { ok: false });
        assert.strictEqual(fs.readFileSync(path.join(P, 'raw/b.mp4'), 'utf8'), 'OTRO', 'el archivo ajeno sigue intacto');
        fs.renameSync(path.join(P, 'raw/b.mp4'), path.join(P, 'b-ajeno.mp4'));
        var retry = await engine.undo(plan.logDir, s.projectPath);
        assert.deepStrictEqual(retry.failed, []);
        assert.strictEqual(retry.restored, 1, 'solo repite lo pendiente');
        assert.ok(retry.relinks.some(function (r) { return r.nodeId === 'b'; }));
        assert.strictEqual(fs.readFileSync(path.join(P, 'raw/b.mp4'), 'utf8'), 'b');
    });

    await test('#5 otros proyectos: subcarpeta excluida y versiones hermanas protegidas', async function () {
        var P = dir('h5');
        write(path.join(P, 'Edicion.prproj'), 'x');
        write(path.join(P, 'clip.mp4'), 'clip');
        write(path.join(P, 'ClienteX', 'X.prproj'), 'x');
        write(path.join(P, 'ClienteX', 'media', 'entrevista.mp4'), 'e');
        write(path.join(P, 'solo-v1.mp4'), 'v1');
        var xml = '<Project><Media><ActualMediaFilePath>' + path.join(P, 'solo-v1.mp4').replace(/&/g, '&amp;') + '</ActualMediaFilePath></Media></Project>';
        fs.writeFileSync(path.join(P, 'Edicion_v1.prproj'), zlib.gzipSync(Buffer.from(xml)));
        var plan = await engine.buildPlan(snap(P, 'Edicion.prproj', [media('c', path.join(P, 'clip.mp4'))]));
        assert.ok(!plan.ops.some(function (o) { return o.source.indexOf('ClienteX') !== -1; }), 'no toca el subproyecto');
        var v1 = plan.unused.filter(function (u) { return u.name === 'solo-v1.mp4'; })[0];
        assert.strictEqual(v1.reason, 'otra versión');
        assert.ok(!plan.ops.some(function (o) { return o.source === v1.source; }), 'el medio de la otra versión no se mueve');
        assert.strictEqual(plan.confirmations.length, 2, 'pide confirmación');
    });

    await test('#7 sin hardlinks: si el destino aparece a mitad, no se sobrescribe', async function () {
        var D = dir('h7');
        write(path.join(D, 'src.mov'), 'MIO');
        var dest = path.join(D, 'dst', 'src.mov');
        var realLink = fs.link;
        fs.link = function (a, b, cb) { write(dest, 'AJENO'); var e = new Error('ENOTSUP'); e.code = 'ENOTSUP'; cb(e); };
        try { await assert.rejects(function () { return fsu.moveFile(path.join(D, 'src.mov'), dest); }, /Ya existe/); }
        finally { fs.link = realLink; }
        assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'AJENO');
        assert.strictEqual(fs.readFileSync(path.join(D, 'src.mov'), 'utf8'), 'MIO');
        // Y el caso normal sin hardlinks sí funciona
        fs.link = function (a, b, cb) { var e = new Error('ENOTSUP'); e.code = 'ENOTSUP'; cb(e); };
        try { await fsu.moveFile(path.join(D, 'src.mov'), path.join(D, 'ok', 'src.mov')); }
        finally { fs.link = realLink; }
        assert.strictEqual(fs.readFileSync(path.join(D, 'ok', 'src.mov'), 'utf8'), 'MIO');
    });

    await test('#8 registro manipulado: rutas fuera del proyecto se rechazan', async function () {
        var P = dir('h8'), victim = dir('h8-victima');
        write(path.join(victim, 'tesis.docx'), 'tesis');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'raw', 'a.mp4'), 'a');
        var s = snap(P, 'P.prproj', [media('a', path.join(P, 'raw/a.mp4'))]);
        var plan = await engine.buildPlan(s);
        var r = await run(plan);
        var hash = (await fsu.fingerprint(path.join(victim, 'tesis.docx'))).sha256;
        fs.appendFileSync(path.join(r.sessionDir, 'journal.jsonl'), JSON.stringify({ type: 'copy', source: '/x', dest: path.join(victim, 'tesis.docx'), sha256: hash, op: 99 }) + '\n');
        var u = await engine.undo(plan.logDir, s.projectPath);
        assert.ok(fs.existsSync(path.join(victim, 'tesis.docx')), 'la víctima sigue ahí');
        assert.ok(u.failed.some(function (f) { return /fuera de assets/.test(f.message); }));
    });

    await test('#9 «01 Assets» como enlace simbólico hacia fuera: bloqueado', async function () {
        var P = dir('h9'), outside = dir('h9-fuera');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'a.mp4'), 'a');
        fs.symlinkSync(outside, path.join(P, '01 Assets'));
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('a', path.join(P, 'a.mp4'))]));
        assert.strictEqual(plan.blocked, true);
        assert.ok(/enlace simbólico/.test(plan.blockReason));
    });

    await test('#9b subcarpeta de assets como symlink: la operación falla sin sacar archivos', async function () {
        var P = dir('h9b'), outside = dir('h9b-fuera');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'a.mp4'), 'a');
        fs.mkdirSync(path.join(P, '01 Assets'));
        fs.symlinkSync(outside, path.join(P, '01 Assets', 'Videos'));
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('a', path.join(P, 'a.mp4'))]));
        var r = await engine.execute(plan);
        assert.strictEqual(r.errors.length, 1);
        assert.deepStrictEqual(fs.readdirSync(outside), []);
        assert.ok(fs.existsSync(path.join(P, 'a.mp4')));
    });

    await test('#10 destino idéntico que aún se va a mover: el medio no queda offline', async function () {
        var P = dir('h10');
        write(path.join(P, 'P.prproj'), 'x');
        write(path.join(P, 'x.mp4'), 'IGUAL');
        write(path.join(P, '01 Assets', 'Videos', 'x.mp4'), 'IGUAL');
        var s = snap(P, 'P.prproj', [media('x', path.join(P, 'x.mp4')), media('f', path.join(P, '01 Assets/Videos/x.mp4'), ['Brutos'])]);
        var r = await run(await engine.buildPlan(s));
        r.relinks.forEach(function (rl) { assert.ok(fs.existsSync(rl.to), rl.nodeId + ' offline: ' + rl.to); });
    });

    await test('#11 regla «fuente»: clips de cámara con el mismo nombre no se mezclan', async function () {
        var P = dir('h11');
        write(path.join(P, 'P.prproj'), 'x');
        write(path.join(P, 'Tarjeta1', 'C0001.mp4'), 't1');
        write(path.join(P, 'Tarjeta2', 'C0001.mp4'), 't2');
        write(path.join(P, 'Musica', 'C0001.wav'), 'w');
        write(path.join(P, 'logo.png'), 'png'); write(path.join(P, 'logo.psd'), 'psd');
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('a', path.join(P, 'Tarjeta1/C0001.mp4')), media('l', path.join(P, 'logo.png'))]));
        var u = {}; plan.unused.forEach(function (x) { u[path.relative(P, x.source)] = x; });
        assert.strictEqual(u[path.join('Tarjeta2', 'C0001.mp4')].reason, 'no usado');
        assert.strictEqual(u[path.join('Musica', 'C0001.wav')].reason, 'no usado');
        assert.strictEqual(u['logo.psd'].reason, 'fuente');
    });

    await test('#15 carpeta ilegible: bloquea en vez de ignorarla', async function () {
        var P = dir('h15');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'cerrada', 'z.txt'), 'z');
        fs.chmodSync(path.join(P, 'cerrada'), 0);
        try {
            var plan = await engine.buildPlan(snap(P, 'P.prproj', []));
            assert.strictEqual(plan.blocked, true);
            assert.strictEqual(plan.unreadable.length, 1);
        } finally { fs.chmodSync(path.join(P, 'cerrada'), 0o755); }
    });

    await test('#16 proyecto en subcarpeta: propone la carpeta superior', async function () {
        var root = dir('h16');
        var prem = path.join(root, 'Premiere');
        write(path.join(prem, 'P.prproj'), 'x'); write(path.join(root, 'Media', 'm.mp4'), 'm');
        var plan = await engine.buildPlan(snap(prem, 'P.prproj', [media('m', path.join(root, 'Media/m.mp4'))]));
        assert.strictEqual(plan.suggestedRoot, root);
        var s2 = snap(prem, 'P.prproj', [media('m', path.join(root, 'Media/m.mp4'))]); s2.projectFolder = root;
        var p2 = await engine.buildPlan(s2);
        assert.strictEqual(p2.ops.filter(function (o) { return o.type === 'move'; }).length, 1, 'ahora se mueve en vez de copiarse');
        assert.ok(!p2.ops.some(function (o) { return /P\.prproj$/.test(o.source); }));
        assert.ok(fsu.isWithin(p2.logDir, prem), 'el LOG sigue junto al .prproj');
    });

    await test('#17 un archivo del usuario llamado *.binflow-partial se conserva', async function () {
        var P = dir('h17');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'c.wav.binflow-partial'), 'mio');
        var plan = await engine.buildPlan(snap(P, 'P.prproj', []));
        await run(plan);
        assert.ok(fs.existsSync(path.join(P, '01 Assets', '_No usados', 'Z_Others', 'c.wav.binflow-partial')));
    });

    await test('#18 si no se puede borrar el origen, no queda el archivo duplicado', async function () {
        var D = dir('h18');
        write(path.join(D, 'src', 'a.mov'), 'a');
        var realUnlink = fs.unlink, first = true;
        fs.unlink = function (p, cb) { if (first && /src[\/\\]a\.mov$/.test(p)) { first = false; var e = new Error('EACCES'); e.code = 'EACCES'; return cb(e); } return realUnlink(p, cb); };
        try { await assert.rejects(function () { return fsu.moveFile(path.join(D, 'src', 'a.mov'), path.join(D, 'dst', 'a.mov')); }); }
        finally { fs.unlink = realUnlink; }
        assert.ok(fs.existsSync(path.join(D, 'src', 'a.mov')));
        assert.ok(!fs.existsSync(path.join(D, 'dst', 'a.mov')));
    });

    await test('#19 categoría con nombre reservado (LOG) no se esconde', async function () {
        var P = dir('h19');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'k.mp4'), 'k');
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('k', path.join(P, 'k.mp4'))], { 'LOG': ['mp4'] }));
        assert.ok(/LOG \(categoría\)/.test(plan.ops[0].dest), plan.ops[0].dest);
    });

    await test('espacio insuficiente: bloquea antes de copiar', async function () {
        var P = dir('h20'), ext = dir('h20-ext');
        write(path.join(P, 'P.prproj'), 'x');
        write(path.join(ext, 'enorme.mov'), Buffer.alloc(4096));
        var s = snap(P, 'P.prproj', [media('e', path.join(ext, 'enorme.mov'))]);
        var full = await engine.buildPlan(s, { freeSpace: function () { return 1024; } });
        assert.strictEqual(full.blocked, true);
        assert.ok(/espacio/.test(full.blockReason));
        var ok = await engine.buildPlan(s, { freeSpace: function () { return 10 * 1024 * 1024 * 1024; } });
        assert.strictEqual(ok.blocked, false);
    });

    // ---------------------------------------------------------------- Re-auditoría (2026-11-19)
    await test('N1 deshacer NO borra la copia si el original externo ya no existe', async function () {
        var P = dir('n1'), ext = dir('n1-descargas');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(ext, 'musica.mp3'), 'unica');
        var s = snap(P, 'P.prproj', [media('m', path.join(ext, 'musica.mp3'))]);
        var plan = await engine.buildPlan(s);
        var r = await run(plan);
        var copy = r.relinks[0].to;
        fs.unlinkSync(path.join(ext, 'musica.mp3'));                       // el usuario borra el original
        var u = await engine.undo(plan.logDir, s.projectPath);
        assert.ok(fs.existsSync(copy), 'la única copia sigue existiendo');
        assert.strictEqual(u.kept.length, 1);
        assert.ok(!u.relinks.some(function (x) { return x.nodeId === 'm'; }), 'Premiere sigue apuntando a la copia');
        assert.deepStrictEqual(u.failed, []);
    });

    await test('N1b con el original intacto, deshacer sí retira la copia', async function () {
        var P = dir('n1b'), ext = dir('n1b-ext');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(ext, 'm.mp3'), 'm');
        var s = snap(P, 'P.prproj', [media('m', path.join(ext, 'm.mp3'))]);
        var plan = await engine.buildPlan(s);
        var r = await run(plan);
        var u = await engine.undo(plan.logDir, s.projectPath);
        assert.ok(!fs.existsSync(r.relinks[0].to));
        assert.strictEqual(u.kept.length, 0);
    });

    await test('N2 la carpeta superior no se propone si contiene otros trabajos', async function () {
        var T = dir('n2-Trabajos');
        write(path.join(T, 'ClienteA', 'Premiere', 'A.prproj'), 'x');
        write(path.join(T, 'ClienteA', 'Media', 'a.mp4'), 'a');
        write(path.join(T, 'ClienteB', 'Premiere', 'B.prproj'), 'x');
        write(path.join(T, 'ClienteB', 'Media', 'b.mp4'), 'b');
        write(path.join(T, 'Biblioteca', 'tema.mp3'), 't');
        var prem = path.join(T, 'ClienteA', 'Premiere');
        var p1 = await engine.buildPlan(snap(prem, 'A.prproj', [media('a', path.join(T, 'ClienteA/Media/a.mp4')), media('t', path.join(T, 'Biblioteca/tema.mp3'))]));
        assert.strictEqual(p1.suggestedRoot, path.join(T, 'ClienteA'), 'propone ClienteA (solo este trabajo)');
        // Si ClienteA contuviera otro trabajo, no se propone
        write(path.join(T, 'ClienteA', 'Spot30', 'Premiere', 'spot.prproj'), 'x');
        var p2 = await engine.buildPlan(snap(prem, 'A.prproj', [media('a', path.join(T, 'ClienteA/Media/a.mp4'))]));
        assert.strictEqual(p2.suggestedRoot, null);
    });

    await test('N2b subproyecto en Trabajo/Premiere: se excluye el trabajo entero (también su Media)', async function () {
        var P = dir('n2b');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'clip.mp4'), 'c');
        write(path.join(P, 'Spot30', 'Premiere', 'spot.prproj'), 'x');
        write(path.join(P, 'Spot30', 'Media', 'spot_bruto.mp4'), 's');
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('c', path.join(P, 'clip.mp4'))]));
        assert.ok(!plan.ops.some(function (o) { return o.source.indexOf('Spot30') !== -1; }), 'Spot30/Media no se toca');
        assert.ok(plan.confirmations.some(function (c) { return /Spot30/.test(c) && /NO se tocarán/.test(c); }));
    });

    await test('N3 ruta rota en otro disco: no se «recupera» por nombre; dentro del proyecto pide confirmación', async function () {
        var P = dir('n3');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'Tarjeta_B', 'C0001.MP4'), 'B');
        var fuera = await engine.buildPlan(snap(P, 'P.prproj', [media('c', '/Volumes/DiscoDesconectado/Tarjeta_A/C0001.MP4')]));
        assert.strictEqual(fuera.missing.length, 1);
        assert.strictEqual(fuera.blocked, true);
        var dentro = await engine.buildPlan(snap(P, 'P.prproj', [media('c', path.join(P, 'vieja', 'C0001.MP4'))]));
        assert.strictEqual(dentro.recovered.length, 1);
        assert.ok(dentro.confirmations.some(function (c) { return /encontrado por nombre/.test(c); }));
    });

    await test('N4 un .prproj hermano ilegible bloquea (no se dejan sus medios offline)', async function () {
        var P = dir('n4');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'b_roll.mp4'), 'b');
        fs.writeFileSync(path.join(P, 'P_v1.prproj'), Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02]));   // gzip corrupto
        var plan = await engine.buildPlan(snap(P, 'P.prproj', []));
        assert.strictEqual(plan.blocked, true);
        assert.ok(/P_v1\.prproj/.test(plan.blockReason));
    });

    await test('N4b entidades XML con emoji en rutas de otros proyectos', function () {
        var D = dir('n4b');
        var file = path.join(D, 'x.prproj');
        fs.writeFileSync(file, '<a><ActualMediaFilePath>/v/fiesta &#x1F389; &amp; más.mp4</ActualMediaFilePath></a>');
        assert.deepStrictEqual(require('../plugin/com.binflow.organizer/engine/plan').readProjectMediaPaths(file), ['/v/fiesta 🎉 & más.mp4']);
    });

    await test('N5 medio compartido con un subproyecto: se avisa con el nombre del proyecto', async function () {
        var P = dir('n5');
        write(path.join(P, 'P.prproj'), 'x'); write(path.join(P, 'logo.png'), 'l');
        var xml = '<x><ActualMediaFilePath>' + path.join(P, 'logo.png') + '</ActualMediaFilePath></x>';
        write(path.join(P, 'Spot30', 'spot.prproj'), zlib.gzipSync(Buffer.from(xml)));
        var plan = await engine.buildPlan(snap(P, 'P.prproj', [media('l', path.join(P, 'logo.png'))]));
        assert.ok(plan.confirmations.some(function (c) { return /spot\.prproj: 1/.test(c) && /offline/.test(c); }), JSON.stringify(plan.confirmations));
    });

    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
