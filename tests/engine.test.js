/**
 * Pruebas del motor de disco de BinFlow (sin Premiere).
 * Uso: node tests/engine.test.js [carpeta-temporal]
 * Simula el snapshot que genera ext.jsx y comprueba disco, BINs, informes y deshacer.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var engine = require('../plugin/com.binflow.organizer/engine');
var planLib = require('../plugin/com.binflow.organizer/engine/plan');

var CATEGORIES = {
    '_Secuencias': [],
    'Videos': ['mp4', 'mov', 'mxf'],
    'Music & SFX': ['wav', 'mp3'],
    'Images': ['jpg', 'png', 'psd'],
    'VFX & Motion': ['mogrt', 'aegraphic'],
    'Docs': ['pdf'],
    'Z_Others': ['txt', 'xml']
};

var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-test-'));
var passed = 0;

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

function tree(dir) {
    var out = {};
    (function walk(d) {
        fs.readdirSync(d).forEach(function (n) {
            var f = path.join(d, n);
            if (fs.statSync(f).isDirectory()) walk(f);
            else out[path.relative(dir, f)] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
        });
    })(dir);
    return out;
}

async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}

function fixture(name) {
    var root = path.join(base, name);
    var proj = path.join(root, 'Proyecto');
    var external = path.join(base, name + '_externo');
    write(path.join(proj, 'Edicion.prproj'), 'prproj');
    write(path.join(proj, 'Brutos', 'Dia1', 'A001.mp4'), 'video-a001');
    write(path.join(proj, 'Brutos', 'Dia1', 'A002.mp4'), 'video-a002');
    write(path.join(proj, 'Brutos', 'Dia1', 'A001.xml'), 'sidecar');           // sin uso, en grupo
    write(path.join(proj, 'Brutos', 'Dia2', 'B001.mp4'), 'video-b001');        // carpeta hermana no importada
    write(path.join(proj, 'Brutos', 'ambiente.wav'), 'wav-ambiente');          // 20 % dentro del grupo
    write(path.join(proj, 'logo.png'), 'png');
    write(path.join(proj, 'logo.psd'), 'psd-fuente');                         // fuente sin uso
    write(path.join(proj, 'guion.pdf'), 'pdf');                               // sin uso
    write(path.join(proj, 'Material', 'musica.wav'), 'musica');
    write(path.join(proj, 'Material', 'foto.jpg'), 'foto');
    write(path.join(proj, 'Otra', 'clip.mp4'), 'clip-otra');
    write(path.join(proj, 'Mas', 'clip.mp4'), 'clip-mas');                    // mismo nombre, distinto contenido
    write(path.join(proj, 'Titulo.mogrt'), 'mogrt');
    write(path.join(proj, 'Adobe Premiere Pro Auto-Save', 'Edicion-1.prproj'), 'autosave');
    write(path.join(proj, '.DS_Store'), 'ds');
    write(path.join(external, 'cancion.mp3'), 'mp3-externo');
    write(path.join(external, 'Dron.mov'), 'dron');
    write(path.join(proj, 'ya copiado', 'Dron.mov'), 'dron');                 // copia interna idéntica de un externo

    var items = [
        { nodeId: 'n1', name: 'A001.mp4', kind: 'media', mediaPath: path.join(proj, 'Brutos/Dia1/A001.mp4'), binPath: ['Brutos', 'Dia1'] },
        { nodeId: 'n2', name: 'A002.mp4', kind: 'media', mediaPath: path.join(proj, 'Brutos/Dia1/A002.mp4'), binPath: ['Brutos', 'Dia1'] },
        { nodeId: 'n3', name: 'ambiente.wav', kind: 'media', mediaPath: path.join(proj, 'Brutos/ambiente.wav'), binPath: ['Brutos'] },
        { nodeId: 'n3b', name: 'A001 copia', kind: 'media', mediaPath: path.join(proj, 'Brutos/Dia1/A001.mp4'), binPath: ['Brutos', 'Dia1'] },
        { nodeId: 'n3c', name: 'Toma extra', kind: 'media', mediaPath: path.join(proj, 'Otra/clip.mp4'), binPath: ['Brutos'] },
        { nodeId: 'n3d', name: 'Toma extra 2', kind: 'media', mediaPath: path.join(proj, 'Mas/clip.mp4'), binPath: ['Brutos'] },
        { nodeId: 'n4', name: 'logo.png', kind: 'media', mediaPath: path.join(proj, 'logo.png'), binPath: [] },
        { nodeId: 'n5', name: 'musica.wav', kind: 'media', mediaPath: path.join(proj, 'Material/musica.wav'), binPath: ['Material'] },
        { nodeId: 'n6', name: 'foto.jpg', kind: 'media', mediaPath: path.join(proj, 'Material/foto.jpg'), binPath: ['Material'] },
        { nodeId: 'n7', name: 'cancion.mp3', kind: 'media', mediaPath: path.join(external, 'cancion.mp3'), binPath: ['../../etc'] },
        { nodeId: 'n8', name: 'Dron.mov', kind: 'media', mediaPath: path.join(external, 'Dron.mov'), binPath: [] },
        { nodeId: 'n9', name: 'Titulo', kind: 'media', mediaPath: path.join(proj, 'Titulo.mogrt'), binPath: [] },
        { nodeId: 's1', name: 'Montaje', kind: 'sequence', mediaPath: '', binPath: [] }
    ];
    return { root: root, proj: proj, external: external, snapshot: {
        projectPath: path.join(proj, 'Edicion.prproj'), projectFolder: proj, assetsFolderName: '01 Assets', categories: CATEGORIES, items: items } };
}

(async function main() {
    console.log('BinFlow engine ' + engine.version + ' — pruebas en ' + base);

    var f = fixture('caso1');
    var before = tree(f.root), beforeExternal = tree(f.external);
    var plan;

    await test('plan: no toca el disco', async function () {
        plan = await engine.buildPlan(f.snapshot);
        assert.deepStrictEqual(tree(f.root), before);
        assert.strictEqual(plan.blocked, false, plan.blockReason);
    });

    await test('R3: BIN Brutos (≥80 % vídeo) se conserva bajo Videos con sus sub-BINs', function () {
        var byId = {}; plan.items.forEach(function (i) { byId[i.nodeId] = i.targetBin.join('/'); });
        assert.strictEqual(byId.n1, 'Videos/Brutos/Dia1');
        assert.strictEqual(byId.n3, 'Videos/Brutos', 'el wav (20 %) se queda dentro del grupo');
        assert.deepStrictEqual(plan.binMoves[0], { binPath: ['Brutos'], targetParent: ['Videos'] });
    });

    await test('R3: BIN mixto se disuelve por categoría', function () {
        var byId = {}; plan.items.forEach(function (i) { byId[i.nodeId] = i.targetBin.join('/'); });
        assert.strictEqual(byId.n5, 'Music & SFX');
        assert.strictEqual(byId.n6, 'Images');
        assert.strictEqual(byId.s1, '_Secuencias');
    });

    await test('R2: clasifica fuente, grupo y no usado', function () {
        var u = {}; plan.unused.forEach(function (x) { u[path.relative(f.proj, x.source)] = x; });
        assert.strictEqual(u['logo.psd'].reason, 'fuente');
        assert.strictEqual(path.relative(f.proj, u['logo.psd'].dest), path.join('01 Assets', 'Images', 'logo.psd'));
        assert.strictEqual(u[path.join('Brutos', 'Dia1', 'A001.xml')].reason, 'grupo');
        assert.strictEqual(path.relative(f.proj, u[path.join('Brutos', 'Dia2', 'B001.mp4')].dest), path.join('01 Assets', 'Videos', 'Brutos', 'Dia2', 'B001.mp4'));
        assert.strictEqual(u['guion.pdf'].reason, 'no usado');
        assert.strictEqual(path.relative(f.proj, u['guion.pdf'].dest), path.join('01 Assets', '_No usados', 'Docs', 'guion.pdf'));
        assert.ok(!u['Edicion.prproj'], 'los .prproj no se tocan');
        assert.ok(!Object.keys(u).some(function (k) { return k.indexOf('Auto-Save') !== -1; }), 'auto-save ignorado');
    });

    await test('externos: copia el nuevo y reutiliza el ya copiado', function () {
        var ops = {}; plan.ops.forEach(function (o) { ops[path.basename(o.source)] = o; });
        assert.strictEqual(ops['cancion.mp3'].type, 'copy');
        assert.strictEqual(ops['Dron.mov'].type, 'move'); assert.strictEqual(ops['Dron.mov'].state, 'reused');
    });

    await test('seguridad: nombre de BIN con ../ no escapa de assets', function () {
        var op = plan.ops.filter(function (o) { return path.basename(o.source) === 'cancion.mp3'; })[0];
        assert.ok(op.dest.indexOf(path.join(f.proj, '01 Assets') + path.sep) === 0, op.dest);
    });

    await test('mogrt (v2.4.1): se mueve a su categoría y se avisa; sin re-enlace', function () {
        assert.strictEqual(plan.manual.length, 1);
        assert.strictEqual(plan.manual[0].type, 'move');
        assert.strictEqual(plan.manual[0].offline, true);
        assert.ok(fs.existsSync(path.join(f.proj, 'Titulo.mogrt')), 'el plan no toca el disco');
        var op = plan.ops.filter(function (o) { return path.basename(o.source) === 'Titulo.mogrt'; })[0];
        assert.strictEqual(path.relative(f.proj, op.dest), path.join('01 Assets', 'VFX & Motion', 'Titulo.mogrt'));
    });

    var result;
    await test('ejecutar: sin errores, sin pérdida de archivos', async function () {
        result = await engine.execute(plan);
        assert.deepStrictEqual(result.errors, []);
        engine.finalizeSession(result.sessionDir);
        var after = tree(f.root);
        var beforeHashes = Object.keys(before).map(function (k) { return before[k]; }).sort();
        var afterHashes = Object.keys(after).filter(function (k) { return k.split(path.sep).indexOf('LOG') === -1; }).map(function (k) { return after[k]; });
        beforeHashes.forEach(function (h) { assert.ok(afterHashes.indexOf(h) !== -1, 'falta un archivo con hash ' + h); });
        assert.deepStrictEqual(tree(f.external), beforeExternal, 'los externos no se tocan');
    });

    await test('ejecutar: estructura final en disco', function () {
        var a = path.join(f.proj, '01 Assets');
        ['Videos/Brutos/Dia1/A001.mp4', 'Videos/Brutos/Dia1/A001.xml', 'Videos/Brutos/Dia2/B001.mp4', 'Videos/Brutos/ambiente.wav',
         'Images/logo.png', 'Images/logo.psd', 'Images/foto.jpg', 'Music & SFX/musica.wav', '_No usados/Docs/guion.pdf', 'Music & SFX/_.._etc/cancion.mp3']
            .forEach(function (p) { assert.ok(fs.existsSync(path.join(a, p)), 'falta ' + p); });
        var brutos = fs.readdirSync(path.join(a, 'Videos', 'Brutos'));
        assert.ok(brutos.indexOf('clip.mp4') !== -1 && brutos.some(function (n) { return /^clip__[0-9a-f]{10}\.mp4$/.test(n); }), 'colisión resuelta con sufijo: ' + brutos);
        assert.ok(!fs.existsSync(path.join(f.proj, 'Brutos')), 'carpeta origen vacía eliminada');
        assert.ok(!fs.existsSync(path.join(f.proj, 'Material')));
    });

    await test('relinks: cada ítem apunta a un archivo existente', function () {
        assert.ok(result.relinks.length >= 9);
        result.relinks.forEach(function (r) { assert.ok(fs.existsSync(r.to), r.to); });
        var n3b = result.relinks.filter(function (r) { return r.nodeId === 'n3b'; })[0];
        var n1 = result.relinks.filter(function (r) { return r.nodeId === 'n1'; })[0];
        assert.strictEqual(n3b.to, n1.to, 'dos ítems del mismo medio comparten destino');
    });

    await test('informes: HTML, JSON y PDF válidos', async function () {
        var r = await engine.writeReports(plan, result);
        var pdfBuf = fs.readFileSync(r.pdfPath);
        assert.strictEqual(pdfBuf.slice(0, 8).toString('latin1'), '%PDF-1.4');
        assert.ok(/startxref\n\d+\n%%EOF\n$/.test(pdfBuf.toString('latin1')));
        var xrefAt = Number(/startxref\n(\d+)/.exec(pdfBuf.toString('latin1'))[1]);
        assert.strictEqual(pdfBuf.slice(xrefAt, xrefAt + 4).toString('latin1'), 'xref');
        var html = fs.readFileSync(r.htmlPath, 'utf8');
        assert.ok(html.indexOf('%20') === -1);
        assert.ok(html.indexOf('<script') === -1);
        JSON.parse(fs.readFileSync(r.jsonPath, 'utf8'));
        console.log('    PDF: ' + r.pdfPath);
    });

    await test('idempotente: re-analizar tras organizar no propone movimientos', async function () {
        var map = {}; result.relinks.forEach(function (r) { map[r.nodeId] = r.to; });
        var snap = JSON.parse(JSON.stringify(f.snapshot));
        snap.items.forEach(function (i) { if (map[i.nodeId]) i.mediaPath = map[i.nodeId]; });
        var byId = {}; plan.items.forEach(function (i) { byId[i.nodeId] = i.targetBin; });
        snap.items.forEach(function (i) { i.binPath = byId[i.nodeId]; });
        var again = await engine.buildPlan(snap);
        var moves = again.ops.filter(function (o) { return o.type === 'move' || o.type === 'copy'; });
        assert.deepStrictEqual(moves.map(function (o) { return o.source; }), []);
    });

    await test('deshacer: el disco vuelve exactamente al estado inicial', async function () {
        var u = await engine.undo(plan.logDir, f.snapshot.projectPath);
        assert.deepStrictEqual(u.failed, []);
        engine.completeUndo(u.sessionDir, { ok: true });
        var after = tree(f.root);
        Object.keys(after).forEach(function (k) { if (k.split(path.sep).indexOf('LOG') !== -1) delete after[k]; });
        assert.deepStrictEqual(after, before);
        assert.ok(u.relinks.some(function (r) { return r.nodeId === 'n1' && r.path === path.join(f.proj, 'Brutos/Dia1/A001.mp4'); }));
    });

    await test('bloqueo: medio ausente impide ejecutar', async function () {
        var g = fixture('caso2');
        g.snapshot.items.push({ nodeId: 'x', name: 'perdido.mov', kind: 'media', mediaPath: path.join(g.proj, 'no-existe', 'perdido.mov'), binPath: [] });
        var p = await engine.buildPlan(g.snapshot);
        assert.strictEqual(p.blocked, true);
        assert.strictEqual(p.missing.length, 1);
        await assert.rejects(function () { return engine.execute(p); });
    });

    await test('recuperado: ruta rota con un único archivo del mismo nombre', async function () {
        var g = fixture('caso3');
        g.snapshot.items[0].mediaPath = path.join(g.proj, 'ruta-vieja', 'A001.mp4');
        var p = await engine.buildPlan(g.snapshot);
        assert.strictEqual(p.blocked, false, p.blockReason);
        var op = p.ops.filter(function (o) { return o.nodeIds.indexOf('n1') !== -1; })[0];
        assert.strictEqual(op.state, 'recovered');
    });

    await test('seguridad: proyecto guardado directamente en la carpeta de usuario se bloquea', function () {
        assert.ok(planLib.isUnsafeRoot(os.homedir()));
        assert.ok(planLib.isUnsafeRoot(path.join(os.homedir(), 'Desktop')));
        assert.ok(planLib.isUnsafeRoot('/Volumes/DiscoExterno'));
        assert.ok(!planLib.isUnsafeRoot(path.join(os.homedir(), 'Desktop', 'MiProyecto')));
    });

    await test('seguridad: safeSegment', function () {
        assert.strictEqual(planLib.safeSegment('..'), '_');
        assert.strictEqual(planLib.safeSegment('a/b\\c:d'), 'a_b_c_d');
        assert.strictEqual(planLib.safeSegment('  '), '_');
    });

    await test('no sobrescribe: un archivo que aparece en destino entre plan y ejecución', async function () {
        var g = fixture('caso4');
        var p = await engine.buildPlan(g.snapshot);
        write(path.join(g.proj, '01 Assets', '_No usados', 'Docs', 'guion.pdf'), 'OTRO contenido');
        var r = await engine.execute(p);
        assert.deepStrictEqual(r.errors, []);
        assert.strictEqual(fs.readFileSync(path.join(g.proj, '01 Assets', '_No usados', 'Docs', 'guion.pdf'), 'utf8'), 'OTRO contenido');
        assert.ok(fs.readdirSync(path.join(g.proj, '01 Assets', '_No usados', 'Docs')).length === 2);
    });

    console.log('\n' + passed + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
