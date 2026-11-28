/**
 * Pruebas de la lógica de la interfaz (ui/ui-logic.js): textos, pantallas y bloqueos.
 * Uso: node tests/ui-logic.test.js [carpeta-temporal]
 * Usa planes reales del motor (carpetas sintéticas) además de planes escritos a mano.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var engine = require('../plugin/com.binflow.organizer/engine');
var UI = require('../plugin/com.binflow.organizer/ui/ui-logic');

var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-ui-'));
var passed = 0;
var CATS = { '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Music & SFX': ['wav', 'mp3'], 'Images': ['jpg', 'png'], 'Z_Others': ['txt'] };

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}
function realSnapshot(name, extraItems) {
    var proj = path.join(base, name, 'Proyecto');
    write(path.join(proj, 'Edicion.prproj'), 'prproj');
    write(path.join(proj, 'Brutos', 'A001.mp4'), 'a001');
    write(path.join(proj, 'guion.txt'), 'x');
    var items = [{ nodeId: 'n1', name: 'A001.mp4', kind: 'media', mediaPath: path.join(proj, 'Brutos', 'A001.mp4'), binPath: [] }].concat(extraItems || []);
    return { proj: proj, snapshot: { projectPath: path.join(proj, 'Edicion.prproj'), projectFolder: proj, assetsFolderName: '01 Assets', categories: CATS, items: items } };
}
function allText(info) { return JSON.stringify(info); }

(async function main() {
    console.log('BinFlow UI — pruebas en ' + base);

    await test('formato de tamaños y plurales', function () {
        assert.strictEqual(UI.sizeText(0), '0 B');
        assert.strictEqual(UI.sizeText(1536), '1,5 KB');
        assert.strictEqual(UI.sizeText(1.2 * 1024 * 1024 * 1024), '1,2 GB');
        assert.strictEqual(UI.plural(1, 'archivo', 'archivos'), 'archivo');
        assert.strictEqual(UI.plural(3, 'archivo', 'archivos'), 'archivos');
    });

    await test('errores de sistema en lenguaje de persona', function () {
        assert.ok(/permiso/.test(UI.humanError({ code: 'EACCES', message: 'x' })));
        assert.ok(/lleno/.test(UI.humanError({ message: 'ENOSPC: no space' })));
        assert.strictEqual(UI.humanError(new Error('algo raro')), 'algo raro');
    });

    await test('cada blockCode del motor tiene su pantalla (nada cae en «Hay un problema» genérico)', function () {
        var src = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'com.binflow.organizer', 'engine', 'plan.js'), 'utf8');
        var codes = {};
        src.replace(/blockCode = '([a-z-]+)'/g, function (m, c) { codes[c] = true; return m; });
        var list = Object.keys(codes);
        assert.ok(list.length >= 8, 'el motor tiene al menos 8 códigos: ' + list.join(','));
        list.forEach(function (c) {
            if (c === 'interrupted') return; // tiene su propia pantalla «Recuperar» (prueba siguiente)
            var info = UI.problemInfo({ blockCode: c, blockReason: 'motivo ' + c, unreadable: ['/a/b.mov'], missing: [{ name: 'x.mov', path: '/p/x.mov' }], ambiguous: [], otherProjects: [{ path: '/p/o.prproj', error: 'dañado' }], ops: [], summary: {} });
            assert.notStrictEqual(info.title, 'Hay un problema', 'sin pantalla propia: ' + c);
            assert.ok(info.actions.length >= 1, 'sin botones: ' + c);
            assert.ok(info.actions.some(function (a) { return !a.soon; }), 'solo botones inactivos: ' + c);
        });
    });

    await test('faltan medios: título, nombres y rutas originales a la vista; salida inactiva «Próximamente»', async function () {
        var g = realSnapshot('missing', [
            { nodeId: 'n2', name: 'Entrevista_C.mov', kind: 'media', mediaPath: '/Volumes/Rodaje/Entrevista_C.mov', binPath: [] },
            { nodeId: 'n3', name: 'Cartela.psd', kind: 'media', mediaPath: '/Volumes/Descargas/Cartela.psd', binPath: [] }
        ]);
        var plan = await engine.buildPlan(g.snapshot);
        assert.strictEqual(plan.blockCode, 'unresolved');
        assert.strictEqual(UI.classifyPlan(plan, 'both'), 'problem');
        var info = UI.problemInfo(plan);
        assert.strictEqual(info.title, 'Faltan 2 medios en el disco');
        assert.deepStrictEqual(info.list.map(function (x) { return x.name; }), ['Entrevista_C.mov', 'Cartela.psd']);
        assert.deepStrictEqual(info.list.map(function (x) { return x.path; }), ['/Volumes/Rodaje/Entrevista_C.mov', '/Volumes/Descargas/Cartela.psd']);
        var soon = info.actions.filter(function (a) { return a.soon; });
        assert.strictEqual(soon.length, 1);
        assert.strictEqual(soon[0].id, 'soon-ignore-missing');
        assert.ok(info.actions.some(function (a) { return a.id === 'analyze' && !a.soon; }));
        assert.strictEqual(info.safety, false);
    });

    await test('en «solo bins» los faltantes no bloquean (como hoy) y salen como etiqueta', async function () {
        var g = realSnapshot('missing-bin', [{ nodeId: 'n2', name: 'Falta.mov', kind: 'media', mediaPath: '/Volumes/X/Falta.mov', binPath: [] }]);
        var plan = await engine.buildPlan(g.snapshot);
        assert.strictEqual(UI.classifyPlan(plan, 'bin'), 'result');
        var r = UI.resultInfo(plan, 'bin', {});
        assert.ok(r.chips.some(function (c) { return /1 medios sin resolver/.test(c); }));
    });

    await test('plan sin problemas: números, Antes/Después y botón principal', async function () {
        var g = realSnapshot('ok');
        var plan = await engine.buildPlan(g.snapshot);
        assert.strictEqual(plan.blocked, false);
        assert.strictEqual(UI.classifyPlan(plan, 'both'), 'result');
        var r = UI.resultInfo(plan, 'both', {});
        assert.strictEqual(r.title, 'Así quedará tu proyecto');
        assert.strictEqual(r.primary, 'Organizar');
        assert.ok(r.numbers.length >= 2);
        assert.ok(r.tree, 'hay árbol');
        assert.ok(r.tree.before.length >= 1);
        assert.ok(r.tree.after.some(function (a) { return a.count >= 1; }));
        assert.ok(r.tree.after.some(function (a) { return a.unused; }), 'los sin usar aparecen aparte');
        assert.strictEqual(UI.resultInfo(plan, 'analysis', {}).primary, 'Generar informe');
        assert.strictEqual(UI.resultInfo(plan, 'bin', {}).primary, 'Organizar bins');
        assert.strictEqual(UI.resultInfo(plan, 'bin', {}).tree, null, 'sin árbol si no se mueven archivos');
    });

    await test('archivos externos: nombre, ruta y tamaño en la vista previa', async function () {
        var ext = path.join(base, 'ext-externo');
        write(path.join(ext, 'tema.wav'), new Array(2000).join('x'));
        var g = realSnapshot('ext', [{ nodeId: 'n9', name: 'tema.wav', kind: 'media', mediaPath: path.join(ext, 'tema.wav'), binPath: [] }]);
        var plan = await engine.buildPlan(g.snapshot);
        var r = UI.resultInfo(plan, 'both', {});
        var card = r.cards.filter(function (c) { return c.list; })[0];
        assert.ok(card, 'tarjeta de externos');
        assert.strictEqual(card.list[0].name, 'tema.wav');
        assert.strictEqual(card.list[0].path, path.join(ext, 'tema.wav'));
        assert.ok(/KB|B$/.test(card.list[0].size));
        assert.ok(/se copiar/.test(card.title));
        assert.strictEqual(UI.resultInfo(plan, 'bin', {}).cards.filter(function (c) { return c.list; }).length, 0, 'en solo bins no se copia nada');
    });

    await test('organización interrumpida: siempre a «recuperar», en cualquier modo', function () {
        var plan = { blocked: true, blockCode: 'interrupted', blockReason: 'x', ops: [], summary: {} };
        ['both', 'bin', 'finder', 'analysis'].forEach(function (m) { assert.strictEqual(UI.classifyPlan(plan, m), 'recover'); });
    });

    await test('avisos (otro .prproj, versiones): «Entendido» en vez de casilla; solo en modos con disco', function () {
        var plan = { blocked: false, confirmations: ['Estas carpetas son de otros proyectos de Premiere y NO se tocarán: Spot30.'], ops: [], summary: {}, otherProjects: [{ path: '/p/Spot30/a.prproj', excluded: '/p/Spot30' }] };
        assert.strictEqual(UI.classifyPlan(plan, 'both'), 'notice');
        assert.strictEqual(UI.classifyPlan(plan, 'both', { confirmed: true }), 'result');
        assert.strictEqual(UI.classifyPlan(plan, 'bin'), 'result');
        assert.strictEqual(UI.classifyPlan(plan, 'analysis'), 'result');
        assert.ok(UI.resultInfo(plan, 'both', {}).chips.some(function (c) { return /Otro proyecto/.test(c); }));
    });

    await test('bloqueos de seguridad reales llevan «safety»; los avisos no', function () {
        ['unsafe-root', 'outside', 'too-many-files', 'unreadable-project'].forEach(function (c) { assert.strictEqual(UI.problemInfo({ blockCode: c, blockReason: 'x', otherProjects: [], ops: [] }).safety, true, c); });
        ['unreadable', 'unresolved', 'no-space'].forEach(function (c) { assert.strictEqual(UI.problemInfo({ blockCode: c, blockReason: 'x', unreadable: [], missing: [], ambiguous: [], ops: [] }).safety, false, c); });
    });

    await test('poco espacio: cuenta los MB del motor y lista lo que se copiaría', function () {
        var plan = { blockCode: 'no-space', blockReason: 'No hay espacio suficiente para copiar los medios externos (1200 MB necesarios, 800 MB libres).',
            ops: [{ type: 'copy', source: '/Volumes/Archivo/tema.wav', size: 1048576 * 600 }, { type: 'move', source: '/a', size: 1 }], summary: {} };
        var info = UI.problemInfo(plan);
        assert.ok(/1,2 GB/.test(info.body) && /800 MB/.test(info.body), info.body);
        assert.strictEqual(info.list.length, 1);
        assert.strictEqual(info.list[0].path, '/Volumes/Archivo/tema.wav');
        assert.ok(info.actions.some(function (a) { return a.soon && a.id === 'soon-no-copy'; }));
    });

    await test('ilegibles: cuenta y lista; el botón «Apartar» queda como Próximamente', function () {
        var info = UI.problemInfo({ blockCode: 'unreadable', blockReason: 'x', unreadable: ['/a/1.mov', '/a/2.mov', '/a/3.wav'] });
        assert.strictEqual(info.title, 'No puedo leer 3 archivos');
        assert.strictEqual(info.list.length, 3);
        assert.ok(info.actions.some(function (a) { return a.soon && /Ilegibles/.test(a.label); }));
        assert.strictEqual(UI.problemInfo({ blockCode: 'unreadable', unreadable: ['/a/1.mov'] }).title, 'No puedo leer 1 archivo');
    });

    await test('proyecto distinto (N9) y error de análisis tienen sus botones', function () {
        var c = UI.changedProjectInfo('Spot_Verano_v3.prproj', 'Cliente_B.prproj');
        assert.ok(/Cliente_B/.test(c.body));
        assert.deepStrictEqual(c.actions.map(function (a) { return a.id; }), ['analyze', 'home']);
        var e = UI.errorInfo(new Error('No hay ningún proyecto abierto.'));
        assert.strictEqual(e.body, 'No hay ningún proyecto abierto.');
        assert.strictEqual(e.actions[0].id, 'analyze');
    });

    await test('resultado final: éxito, avisos, Premiere sin actualizar y análisis', function () {
        var ok = UI.doneInfo({ done: [{ type: 'move' }, { type: 'move' }, { type: 'copy' }], errors: [], copiedBytes: 10 }, { stats: { binMoved: 4, relinked: 3 } }, null, null, 'both');
        assert.strictEqual(ok.problems, 0);
        assert.strictEqual(ok.title, 'Proyecto organizado');
        assert.strictEqual(ok.moved, 2); assert.strictEqual(ok.copied, 1); assert.strictEqual(ok.showSave, true);
        var bad = UI.doneInfo({ done: [{ type: 'move' }], errors: [{ source: '/a/x.mov', message: 'EACCES' }] }, { stats: {} }, null, 'Premiere no recibió todos los cambios (1 de 2).', 'both');
        assert.ok(bad.problems >= 2); assert.strictEqual(bad.undoFirst, true);
        assert.ok(/deshacerlo/.test(bad.text));
        assert.ok(bad.lines.some(function (l) { return /No se pudo: x.mov/.test(l.title) && /permiso/.test(l.text); }));
        var an = UI.doneInfo(null, null, null, null, 'analysis');
        assert.strictEqual(an.title, 'Informe generado'); assert.strictEqual(an.showSave, false);
        var cancelled = UI.doneInfo({ done: [{ type: 'move' }], errors: [], cancelled: true }, null, null, null, 'both');
        assert.strictEqual(cancelled.cancelled, true);
    });

    await test('deshacer: éxito y parcial; botón del inicio según sesiones', function () {
        var okU = UI.undoInfo({ failed: [], restored: 12, cleaned: ['a'], kept: [] }, { status: 'SUCCESS', relinked: 3, binsRestored: 2 });
        assert.strictEqual(okU.ok, true); assert.ok(/12 archivos devueltos/.test(okU.text));
        var partial = UI.undoInfo({ failed: [{ message: 'no está' }], restored: 1, cleaned: [], kept: [] }, { status: 'SUCCESS' });
        assert.strictEqual(partial.ok, false); assert.ok(/Reintentar deshacer/.test(partial.text));
        var s = { meta: { createdAt: '2026-11-21T18:42:00Z', status: 'done' } };
        assert.strictEqual(UI.undoButton(null, false), null);
        assert.strictEqual(UI.undoButton(s, true).kind, 'recover');
        assert.strictEqual(UI.undoButton({ meta: { createdAt: s.meta.createdAt, status: 'partial-undo' } }, false).kind, 'retry');
        assert.strictEqual(UI.undoButton(s, false).kind, 'undo');
    });

    await test('los textos no sacan tecnicismos ni rutas sin pedirlas', async function () {
        var g = realSnapshot('texts');
        var plan = await engine.buildPlan(g.snapshot);
        var text = allText(UI.resultInfo(plan, 'both', {}));
        ['EACCES', 'ENOENT', 'sha256', 'journal', 'blockCode', 'undefined', 'NaN', '[object'].forEach(function (w) { assert.ok(text.indexOf(w) === -1, 'aparece «' + w + '»'); });
    });

    await test('modo CEP mixto: con window, document y module a la vez, BinFlowUI se registra igualmente', function () {
        var vm = require('vm');
        var code = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'com.binflow.organizer', 'ui', 'ui-logic.js'), 'utf8');
        var win = {};
        var sandbox = { window: win, document: {}, module: { exports: {} } };
        sandbox.exports = sandbox.module.exports;
        vm.runInNewContext(code, sandbox);
        assert.ok(win.BinFlowUI && typeof win.BinFlowUI.problemInfo === 'function', 'window.BinFlowUI sin definir (patrón UMD roto en CEP)');
        assert.strictEqual(typeof win.BinFlowUI.sizeText, 'function');
    });

    await test('modo navegador (sin module) y modo Node (sin window) también funcionan', function () {
        var vm = require('vm');
        var code = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'com.binflow.organizer', 'ui', 'ui-logic.js'), 'utf8');
        var win = {};
        vm.runInNewContext(code, { window: win, document: {} });
        assert.ok(win.BinFlowUI, 'navegador');
        var mod = { exports: {} };
        vm.runInNewContext(code, { module: mod });
        assert.strictEqual(typeof mod.exports.humanError, 'function', 'Node');
        assert.strictEqual(typeof UI.humanError, 'function', 'require real');
    });

    await test('modos: bins y archivos es el valor por defecto (primero en la lista)', function () {
        assert.strictEqual(UI.MODES[0].id, 'both');
        assert.deepStrictEqual(UI.MODES.map(function (m) { return m.id; }), ['both', 'bin', 'finder']);
        assert.ok(UI.touchesDisk('both') && UI.touchesDisk('finder') && !UI.touchesDisk('bin') && !UI.touchesDisk('analysis'));
        assert.ok(UI.touchesBins('both') && UI.touchesBins('bin') && !UI.touchesBins('finder'));
    });

    await test('v2.4.1 gráficos de Adobe: la vista previa avisa con nombre y ruta; en «solo bins» no; apagado, vuelve el aviso antiguo', async function () {
        var g = realSnapshot('gfx', [{ nodeId: 'g1', name: 'Titulo.aegraphic', kind: 'media', mediaPath: path.join(base, 'gfx', 'Proyecto', 'Rot', 'Titulo.aegraphic'), binPath: [] }]);
        write(path.join(g.proj, 'Rot', 'Titulo.aegraphic'), 'g');
        var plan = await engine.buildPlan(g.snapshot);
        var r = UI.resultInfo(plan, 'both', {});
        var card = r.cards.filter(function (c) { return c.kind === 'warn'; })[0];
        assert.ok(card, 'hay tarjeta de aviso');
        assert.strictEqual(card.title, 'Este gráfico de Adobe quedará sin conexión en Premiere');
        assert.ok(/relinkarlos a mano/.test(card.text));
        assert.strictEqual(card.list[0].name, 'Titulo.aegraphic');
        assert.strictEqual(card.list[0].path, path.join(g.proj, 'Rot', 'Titulo.aegraphic'));
        assert.ok(/Pasará a: .*Graphics|Pasará a: .*Titulo\.aegraphic/.test(card.list[0].note));
        assert.ok(r.chips.some(function (c) { return /1 gráfico de Adobe sin conexión/.test(c); }));
        assert.ok(!r.chips.some(function (c) { return /se quedan donde están/.test(c); }));
        assert.ok(!UI.resultInfo(plan, 'bin', {}).cards.some(function (c) { return c.kind === 'warn'; }), 'en solo bins no se mueve nada');
        var off = await engine.buildPlan(g.snapshot, { moveManual: false });
        var ro = UI.resultInfo(off, 'both', {});
        assert.ok(!ro.cards.some(function (c) { return c.kind === 'warn'; }));
        assert.ok(ro.chips.some(function (c) { return /1 se quedan donde están/.test(c); }));
        assert.ok(ro.details.some(function (d) { return /Se deja donde está: Titulo\.aegraphic/.test(d); }));
    });

    await test('v2.5.0 actualizaciones: textos de «Novedades» y mensajes cortos', function () {
        var check = { status: 'available', latest: { version: '2.5.9' }, changelog: [
            { version: '2.5.9', date: '2026-11-24', features: ['A'], improvements: ['B'] }, { version: '2.5.5', date: '', features: [], improvements: ['C'] }] };
        var u = UI.updateInfo(check, '2.5.0');
        assert.strictEqual(u.title, 'Hay una versión nueva');
        assert.strictEqual(u.sub, 'BinFlow 2.5.9 (tú tienes la 2.5.0).');
        assert.strictEqual(u.pill, 'Hay una versión nueva: 2.5.9');
        assert.deepStrictEqual(u.versions.map(function (v) { return v.version; }), ['2.5.9', '2.5.5']);
        assert.strictEqual(u.empty, false);
        assert.ok(/copia de la versión actual/.test(u.note) && /cerrar Premiere/.test(u.note));
        assert.strictEqual(UI.updateInfo({ latest: { version: '2.6.0' }, changelog: [] }, '2.5.0').empty, true);
        // Al día, sin red o con error al comprobar: ningún texto (ni «estás al día»).
        assert.strictEqual(UI.updateMessage('current', '2.5.0'), '');
        assert.strictEqual(UI.updateMessage('error'), '');
        var src = require('fs').readFileSync(path.join(__dirname, '..', 'plugin', 'com.binflow.organizer', 'main.js'), 'utf8');
        assert.ok(!/Buscar actualizaciones|update-check|Ya tienes la última/.test(src), 'sin entrada de Ajustes ni mensaje «al día»');
        assert.ok(/data-act="update-view"/.test(src) && /r\.status === 'available'/.test(src), 'la franja solo sale con status available');
        assert.ok(/Tu versión sigue igual/.test(UI.updateMessage('failed', 'sha256 mal')));
        assert.ok(/Tu versión sigue igual\. \(Sin permiso/.test(UI.updateMessage('failed', 'EACCES: x')));
    });

    console.log('\n' + passed + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
