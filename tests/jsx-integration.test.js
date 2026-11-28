/**
 * Integración ext.jsx + motor con un Premiere simulado (API mínima de ProjectItem/File/Folder).
 * No sustituye a la UAT en Premiere real, pero comprueba la lógica de BINs, relink y deshacer.
 * Uso: node tests/jsx-integration.test.js [carpeta-temporal]
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var engine = require('../plugin/com.binflow.organizer/engine');

var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-jsx-'));
var passed = 0;

// ------------------------------------------------------------ Premiere simulado
var nextId = 1;
function Item(name, type, mediaPath, isSeq) {
    this.name = name; this.type = type; this.nodeId = String(nextId++); this.parent = null;
    this._media = mediaPath || ''; this._seq = !!isSeq; this._kids = [];
    var self = this;
    this.children = { get numItems() { return self._kids.length; } };
    this._sync();
}
Item.prototype._sync = function () { var c = this.children; Object.keys(c).forEach(function (k) { if (/^\d+$/.test(k)) delete c[k]; }); this._kids.forEach(function (k, i) { c[i] = k; }); };
Item.prototype.add = function (child) { child.parent = this; this._kids.push(child); this._sync(); return child; };
Item.prototype.getMediaPath = function () { return this._media; };
Item.prototype.changeMediaPath = function (p) { if (!fs.existsSync(p)) throw new Error('no existe'); this._media = p; return true; };
Item.prototype.canChangeMediaPath = function () { return !/\.mogrt$/i.test(this._media); };
Item.prototype.isSequence = function () { return this._seq; };
Item.prototype.createBin = function (name) { return this.add(new Item(name, 2)); };
Item.prototype.moveBin = function (target) {
    var p = this.parent; p._kids.splice(p._kids.indexOf(this), 1); p._sync(); target.add(this);
};

function FileMock(p) { this._p = path.resolve(String(p)); }
Object.defineProperty(FileMock.prototype, 'exists', { get: function () { return fs.existsSync(this._p); } });
Object.defineProperty(FileMock.prototype, 'fsName', { get: function () { return this._p; } });
Object.defineProperty(FileMock.prototype, 'parent', { get: function () { return new FolderMock(path.dirname(this._p)); } });
Object.defineProperty(FileMock.prototype, 'length', { get: function () { return fs.statSync(this._p).size; } });
FileMock.prototype.open = function (mode) { this._mode = mode; this._buf = mode === 'r' ? fs.readFileSync(this._p, 'utf8') : ''; return true; };
FileMock.prototype.read = function () { return this._buf; };
FileMock.prototype.write = function (s) { this._buf += s; };
FileMock.prototype.close = function () { if (this._mode === 'w') fs.writeFileSync(this._p, this._buf); };
FileMock.prototype.rename = function (n) { fs.renameSync(this._p, path.join(path.dirname(this._p), n)); return true; };
FileMock.prototype.remove = function () { fs.unlinkSync(this._p); return true; };
FileMock.decode = function (s) { try { return decodeURIComponent(s); } catch (e) { return s; } };
function FolderMock(p) { this._p = path.resolve(String(p)); }
Object.defineProperty(FolderMock.prototype, 'exists', { get: function () { return fs.existsSync(this._p); } });
Object.defineProperty(FolderMock.prototype, 'fsName', { get: function () { return this._p; } });
FolderMock.prototype.create = function () { fs.mkdirSync(this._p, { recursive: true }); return true; };

function loadJSX(app) {
    var src = fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/host/ext.jsx'), 'utf8');
    var fn = new Function('app', 'File', 'Folder', '$', 'system', src + '\nreturn gpOrganizer;');
    return fn(app, FileMock, FolderMock, { os: 'Macintosh OS 15' }, { callSystem: function () { return ''; } });
}

function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }

function binPaths(root) {
    var out = {};
    (function walk(bin, p) {
        bin._kids.forEach(function (k) {
            if (k.type === 2) walk(k, p.concat(k.name));
            else out[k.name] = { bin: p.join('/'), media: k._media };
        });
    })(root, []);
    return out;
}

async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; }
}

(async function main() {
    console.log('Integración ext.jsx + motor (Premiere simulado) — ' + base);
    var proj = path.join(base, 'Cliente', 'Proyecto');
    write(path.join(proj, 'Edicion.prproj'), 'x');
    write(path.join(proj, 'Brutos', 'Dia 1', 'A001.mp4'), 'a1');
    write(path.join(proj, 'Brutos', 'Dia 1', 'A002.mp4'), 'a2');
    write(path.join(proj, 'Brutos', 'Dia 1', 'A003.mp4'), 'a3');
    write(path.join(proj, 'Brutos', 'Dia 1', 'A004.mp4'), 'a4');
    write(path.join(proj, 'Brutos', 'sonido.wav'), 's');
    write(path.join(proj, 'Varios', 'logo.png'), 'png');
    write(path.join(proj, 'Varios', 'logo.psd'), 'psd');
    write(path.join(proj, 'Varios', 'musica.mp3'), 'mp3');
    write(path.join(proj, 'notas.txt'), 'notas');
    write(path.join(proj, 'Titulo.mogrt'), 'mogrt');

    var root = new Item('root', 3);
    var brutos = root.add(new Item('Brutos', 2));
    var dia1 = brutos.add(new Item('Dia 1', 2));
    dia1.add(new Item('A001.mp4', 1, path.join(proj, 'Brutos/Dia 1/A001.mp4')));
    dia1.add(new Item('A002.mp4', 1, path.join(proj, 'Brutos/Dia 1/A002.mp4')));
    dia1.add(new Item('A003.mp4', 1, path.join(proj, 'Brutos/Dia 1/A003.mp4')));
    dia1.add(new Item('A004.mp4', 1, path.join(proj, 'Brutos/Dia 1/A004.mp4')));
    brutos.add(new Item('sonido.wav', 1, path.join(proj, 'Brutos/sonido.wav')));
    var varios = root.add(new Item('Varios', 2));
    varios.add(new Item('logo.png', 1, path.join(proj, 'Varios/logo.png')));
    varios.add(new Item('musica.mp3', 1, path.join(proj, 'Varios/musica.mp3')));
    root.add(new Item('Montaje', 1, '', true));
    root.add(new Item('Titulo', 1, path.join(proj, 'Titulo.mogrt')));
    var app = { project: { path: path.join(proj, 'Edicion.prproj'), name: 'Edicion.prproj', rootItem: root, save: function () { this.saved = true; } } };
    var g = loadJSX(app);
    var before = binPaths(root);
    var snapshot, plan, result, applied;

    await test('getProjectSnapshot devuelve ítems con BIN y tipo', function () {
        snapshot = JSON.parse(g.getProjectSnapshot('Estándar', JSON.stringify({ assetsFolderName: '01 Assets' })));
        assert.strictEqual(snapshot.status, 'SUCCESS', snapshot.message);
        var bySeq = snapshot.items.filter(function (i) { return i.kind === 'sequence'; });
        assert.strictEqual(bySeq.length, 1);
        assert.deepStrictEqual(snapshot.items.filter(function (i) { return i.name === 'A001.mp4'; })[0].binPath, ['Brutos', 'Dia 1']);
    });

    await test('motor + applyOrganization: disco y BINs con la misma estructura', async function () {
        plan = await engine.buildPlan(snapshot);
        assert.strictEqual(plan.blocked, false, plan.blockReason);
        result = await engine.execute(plan);
        assert.deepStrictEqual(result.errors, []);
        applied = JSON.parse(g.applyOrganization(JSON.stringify({
            projectPath: snapshot.projectPath,
            relinks: result.relinks.map(function (r) { return { nodeId: r.nodeId, to: r.to }; }),
            binMoves: plan.binMoves, items: plan.items.map(function (i) { return { nodeId: i.nodeId, targetBin: i.targetBin }; }),
            organizeBins: true, categories: Object.keys(snapshot.categories), binsDir: result.sessionDir
        })));
        engine.finalizeSession(result.sessionDir);
        assert.strictEqual(applied.status, 'SUCCESS', JSON.stringify(applied));
        var now = binPaths(root);
        assert.strictEqual(now['A001.mp4'].bin, 'Videos/Brutos/Dia 1');
        assert.strictEqual(now['A001.mp4'].media, path.join(proj, '01 Assets/Videos/Brutos/Dia 1/A001.mp4'));
        assert.strictEqual(now['sonido.wav'].bin, 'Videos/Brutos');
        assert.strictEqual(now['logo.png'].bin, 'Images');
        assert.strictEqual(now['musica.mp3'].bin, 'Music & SFX');
        assert.strictEqual(now['Montaje'].bin, '_Secuencias');
        assert.ok(fs.existsSync(path.join(proj, '01 Assets/Images/logo.psd')), 'PSD junto al PNG');
        assert.ok(fs.existsSync(path.join(proj, '01 Assets/_No usados/Z_Others/notas.txt')));
        // v2.4.1: los gráficos de Adobe se mueven; Premiere no los re-enlaza, así que quedan apuntando a la ruta vieja (sin conexión).
        assert.strictEqual(now['Titulo'].media, path.join(proj, 'Titulo.mogrt'), 'mogrt no se re-enlaza');
        assert.ok(!fs.existsSync(path.join(proj, 'Titulo.mogrt')), 'el mogrt se movió');
        assert.ok(plan.manual.length === 1 && plan.manual[0].offline, 'avisado como sin conexión');
        assert.ok(fs.existsSync(plan.manual[0].dest), 'el mogrt está en su destino');
        Object.keys(now).forEach(function (k) { if (now[k].media && k !== 'Titulo') assert.ok(fs.existsSync(now[k].media), 'offline: ' + k); });
        assert.ok(app.project.saved);
    });

    await test('BIN mixto vacío va a (Carpetas Vacias)', function () {
        var now = binPaths(root);
        assert.ok(root._kids.some(function (k) { return k.name === '(Carpetas Vacias)' && k._kids.some(function (c) { return c.name === 'Varios'; }); }));
        assert.ok(!root._kids.some(function (k) { return k.name === 'Brutos'; }), 'Brutos se movió entero');
        assert.ok(now);
    });

    await test('deshacer: disco, rutas y BINs vuelven al estado inicial', async function () {
        var undone = await engine.undo(plan.logDir, snapshot.projectPath);
        assert.deepStrictEqual(undone.failed, []);
        var r = JSON.parse(g.applyUndo(JSON.stringify({ projectPath: snapshot.projectPath, relinks: undone.relinks, binsDir: undone.sessionDir })));
        engine.completeUndo(undone.sessionDir, { ok: r.status === 'SUCCESS' });
        assert.strictEqual(r.status, 'SUCCESS', JSON.stringify(r));
        var now = binPaths(root);
        Object.keys(before).forEach(function (k) {
            assert.strictEqual(now[k].bin, before[k].bin, 'BIN de ' + k);
            assert.strictEqual(now[k].media, before[k].media, 'ruta de ' + k);
        });
        assert.ok(fs.existsSync(path.join(proj, 'Varios/logo.psd')));
        assert.ok(fs.existsSync(path.join(proj, 'Titulo.mogrt')), 'el mogrt vuelve a su sitio');
        assert.ok(!fs.existsSync(path.join(proj, '01 Assets/Images')), 'carpetas creadas eliminadas al deshacer');
    });

    await test('proyecto sin guardar: error legible', function () {
        var g2 = loadJSX({ project: { path: '', rootItem: root } });
        var r = JSON.parse(g2.getProjectSnapshot('Estándar', '{}'));
        assert.strictEqual(r.status, 'ERROR');
        assert.ok(/Guarda el proyecto/.test(r.message));
    });

    await test('JSON malicioso en importProfile/parseConfig no se ejecuta', function () {
        var cfg = g.parseConfig('{"a":1});app.hacked=true;({"b":2');
        assert.deepStrictEqual(cfg, {});
        assert.ok(!app.hacked);
    });

    await test('applyOrganization con payload ilegible devuelve ERROR (no un SUCCESS vacío)', function () {
        var r = JSON.parse(g.applyOrganization('{roto'));
        assert.strictEqual(r.status, 'ERROR');
        var r2 = JSON.parse(g.applyOrganization(JSON.stringify({ organizeBins: false })));
        assert.strictEqual(r2.status, 'ERROR');
    });

    await test('N9 applyOrganization/applyUndo con otro proyecto abierto: ERROR sin tocar nada', function () {
        var r = JSON.parse(g.applyOrganization(JSON.stringify({ projectPath: '/otro/Otro.prproj', relinks: [{ nodeId: 'x', to: '/tmp/x' }], organizeBins: false })));
        assert.strictEqual(r.status, 'ERROR');
        assert.ok(/no es el que se analiz/.test(r.message || r.error || JSON.stringify(r)), JSON.stringify(r));
        var u = JSON.parse(g.applyUndo(JSON.stringify({ projectPath: '/otro/Otro.prproj', relinks: [], binsDir: '/tmp' })));
        assert.strictEqual(u.status, 'ERROR');
    });

    await test('deshacer BINs con proyecto reabierto (nodeId nuevos) usa nombre y ruta', async function () {
        var p2 = await engine.buildPlan(JSON.parse(g.getProjectSnapshot('Estándar', '{}')));
        var r2 = await engine.execute(p2);
        g.applyOrganization(JSON.stringify({ projectPath: snapshot.projectPath, relinks: r2.relinks.map(function (r) { return { nodeId: r.nodeId, to: r.to }; }), binMoves: p2.binMoves,
            items: p2.items.map(function (i) { return { nodeId: i.nodeId, targetBin: i.targetBin }; }), organizeBins: true, categories: [], binsDir: r2.sessionDir }));
        engine.finalizeSession(r2.sessionDir);
        // Simula reabrir: todos los nodeId cambian
        (function renumber(bin) { bin._kids.forEach(function (k) { k.nodeId = 'nuevo-' + k.nodeId; if (k.type === 2) renumber(k); }); })(root);
        var u = await engine.undo(p2.logDir, snapshot.projectPath);
        var r = JSON.parse(g.applyUndo(JSON.stringify({ projectPath: snapshot.projectPath, relinks: u.relinks, binsDir: u.sessionDir })));
        assert.strictEqual(r.status, 'SUCCESS', JSON.stringify(r));
        var now = binPaths(root);
        Object.keys(before).forEach(function (k) { assert.strictEqual(now[k].bin, before[k].bin, k); assert.strictEqual(now[k].media, before[k].media, k); });
    });

    await test('jsxArg del panel + JSON de ExtendScript: U+2028, acentos y comillas llegan intactos', function () {
        var mainSrc = fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/main.js'), 'utf8');
        var fnSrc = /function jsxArg\(value\) \{[\s\S]*?\n    \}/.exec(mainSrc)[0];
        var jsxArg = new Function(fnSrc + '; return jsxArg;')();
        var payload = { to: '/Vol/Día 1/a\u2028b "c" \\ \'d\'.mov', n: [1] };
        var literal = jsxArg(payload);
        assert.ok(/^[\x20-\x7e]*$/.test(literal), 'solo ASCII imprimible');
        var src = fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/host/ext.jsx'), 'utf8');
        var J = new Function('JSON', '$', 'File', 'Folder', 'app', 'system', src + ';return JSON;')({}, { os: 'Mac' });
        var received = eval(literal);               // lo que hace evalScript con el literal
        assert.deepStrictEqual(J.parse(received), payload);
    });

    await test('CSInterface oficial: SystemPath y getSystemPath funcionan', function () {
        var vm = require('vm');
        var ctx = { window: { __adobe_cep__: { getSystemPath: function () { return 'file:///Volumes/x/Library/Application%20Support/Adobe/CEP/extensions/com.binflow.organizer'; }, getHostEnvironment: function () { return JSON.stringify({ appName: 'PPRO' }); } } }, navigator: { userAgent: 'Mac', platform: 'MacIntel', appVersion: '5.0 (Macintosh; Intel Mac OS X 15_0)' } };
        ctx.window.navigator = ctx.navigator;
        vm.createContext(ctx);
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/lib/CSInterface.js'), 'utf8') + ';this.CSInterface=CSInterface;this.SystemPath=SystemPath;', ctx);
        var p = new ctx.CSInterface().getSystemPath(ctx.SystemPath.EXTENSION);
        assert.strictEqual(p, '/Volumes/x/Library/Application Support/Adobe/CEP/extensions/com.binflow.organizer');
        var mainSrc = fs.readFileSync(path.join(__dirname, '../plugin/com.binflow.organizer/main.js'), 'utf8');
        var used = {}; mainSrc.replace(/csInterface\.(\w+)\(/g, function (m, fn) { used[fn] = true; });
        Object.keys(used).forEach(function (fn) { assert.strictEqual(typeof ctx.CSInterface.prototype[fn], 'function', 'CSInterface.' + fn + ' no existe'); });
    });

    await test('N20 sin projectPath en la orden del panel: ERROR (la protección ya no falla «abierta»)', function () {
        var r = JSON.parse(g.applyOrganization(JSON.stringify({ relinks: [], organizeBins: false })));
        assert.strictEqual(r.status, 'ERROR');
        assert.ok(/Faltan datos del proyecto/.test(r.message), JSON.stringify(r));
        var u = JSON.parse(g.applyUndo(JSON.stringify({ relinks: [], binsDir: '/tmp' })));
        assert.strictEqual(u.status, 'ERROR');
        assert.ok(/Faltan datos del proyecto/.test(u.message), JSON.stringify(u));
    });

    await test('N23 deshacer con dos ítems que comparten ruta: cada uno se vuelve a enlazar una vez', function () {
        var d = path.join(base, 'n23'); var proj2 = path.join(d, 'P');
        write(path.join(proj2, 'E.prproj'), 'x');
        write(path.join(proj2, '01 Assets', 'Videos', 'x.mov'), 'x');
        write(path.join(proj2, 'orig1', 'x.mov'), 'x'); write(path.join(proj2, 'orig2', 'x.mov'), 'x');
        var shared = path.join(proj2, '01 Assets', 'Videos', 'x.mov');
        var r2 = new Item('root', 3); var a = r2.add(new Item('x1', 1, shared)); var b = r2.add(new Item('x2', 1, shared));
        var g2 = loadJSX({ project: { path: path.join(proj2, 'E.prproj'), name: 'E.prproj', rootItem: r2, save: function () {} } });
        var res = JSON.parse(g2.applyUndo(JSON.stringify({ projectPath: path.join(proj2, 'E.prproj'), relinks: [
            { nodeId: 'viejo1', path: path.join(proj2, 'orig1', 'x.mov'), current: shared },
            { nodeId: 'viejo2', path: path.join(proj2, 'orig2', 'x.mov'), current: shared }] })));
        assert.strictEqual(res.status, 'SUCCESS', JSON.stringify(res));
        assert.strictEqual(a._media, path.join(proj2, 'orig1', 'x.mov'));
        assert.strictEqual(b._media, path.join(proj2, 'orig2', 'x.mov'));
    });

    await test('N16 el snapshot incluye los proxies enlazados', function () {
        var d = path.join(base, 'n16'); var proj2 = path.join(d, 'P');
        write(path.join(proj2, 'E.prproj'), 'x'); write(path.join(proj2, 'a.mp4'), 'a'); write(path.join(proj2, 'Proxies', 'a_proxy.mp4'), 'p');
        var r2 = new Item('root', 3); var it = r2.add(new Item('a.mp4', 1, path.join(proj2, 'a.mp4')));
        it.hasProxy = function () { return true; }; it.getProxyPath = function () { return path.join(proj2, 'Proxies', 'a_proxy.mp4'); };
        r2.add(new Item('b.mp4', 1, path.join(proj2, 'a.mp4'))); // sin proxy (sin métodos): no debe romper
        var g2 = loadJSX({ project: { path: path.join(proj2, 'E.prproj'), name: 'E.prproj', rootItem: r2, save: function () {} } });
        var snap2 = JSON.parse(g2.getProjectSnapshot('Estándar', '{}'));
        assert.deepStrictEqual(snap2.proxyPaths, [path.join(proj2, 'Proxies', 'a_proxy.mp4')]);
    });

    console.log('\n' + passed + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
})();
