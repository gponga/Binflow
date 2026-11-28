/**
 * v2.5.0: actualizador (engine/updater.js) contra un servidor HTTP local simulado. Sin red real, sin tocar Premiere.
 * Uso: node tests/updater.test.js [carpeta-temporal]
 * Necesita macOS (usa «unzip» del sistema) y python3 para fabricar zips maliciosos.
 */
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var crypto = require('crypto');
var cp = require('child_process');
var updater = require('../plugin/com.binflow.organizer/engine/updater');

var SRC = path.join(__dirname, '..', 'plugin', 'com.binflow.organizer');
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-upd-'));
var passed = 0, n = 0;

async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function rm(p) { cp.execFileSync('rm', ['-rf', p]); }
function copy(from, to) { fs.mkdirSync(path.dirname(to), { recursive: true }); cp.execFileSync('cp', ['-R', from, to]); }
function tree(dir) {
    var out = {};
    (function w(d) { fs.readdirSync(d).forEach(function (x) { var f = path.join(d, x), st = fs.lstatSync(f); if (st.isDirectory()) w(f); else out[path.relative(dir, f)] = sha(fs.readFileSync(f)); }); })(dir);
    return out;
}
function setVersion(dir, v) {
    var m = path.join(dir, 'CSXS', 'manifest.xml');
    fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace(/(ExtensionBundleVersion|Version)="2\.\d+\.\d+"/g, function (s, k) { return k + '="' + v + '"'; }));
    fs.writeFileSync(path.join(dir, 'engine', 'version.js'), "module.exports = '" + v + "';\n");
}
function zipDir(dir, out) { cp.execFileSync('zip', ['-qry', out, path.basename(dir)], { cwd: path.dirname(dir) }); }
function pyZip(out, entries) {
    // entries: [{name, data, symlink}]
    var script = 'import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor e in json.loads(sys.argv[2]):\n  i=zipfile.ZipInfo(e["name"])\n  if e.get("symlink"): i.external_attr=0o120777<<16\n  else: i.external_attr=0o100644<<16\n  z.writestr(i,e["data"])\nz.close()';
    cp.execFileSync('python3', ['-c', script, out, JSON.stringify(entries)]);
}

// Paquete «bueno» 2.5.9 a partir del código real.
var PKG = path.join(base, 'pkg');
rm(PKG); copy(SRC, path.join(PKG, 'com.binflow.organizer')); setVersion(path.join(PKG, 'com.binflow.organizer'), '2.5.9');
var GOOD_ZIP = path.join(base, 'good.zip'); rm(GOOD_ZIP); zipDir(path.join(PKG, 'com.binflow.organizer'), GOOD_ZIP);

var routes = {};
var server, PORT;
function allowLocal(u) { return u.protocol === 'http:' && u.hostname === '127.0.0.1' && String(u.port) === String(PORT); }
function url(p) { return 'http://127.0.0.1:' + PORT + p; }
function latestJson(over) {
    var zip = fs.readFileSync(GOOD_ZIP);
    var o = { version: '2.5.9', date: '2026-11-24', url: url('/good.zip'), sha256: sha(zip), size: zip.length, changelog: [
        { version: '2.5.9', date: '2026-11-24', features: ['Botón Actualizar'], improvements: ['Más rápido'] },
        { version: '2.5.5', date: '2026-11-20', features: ['Intermedia'], improvements: [] },
        { version: '2.4.0', date: '2026-11-01', features: ['Vieja'], improvements: [] }] };
    Object.keys(over || {}).forEach(function (k) { o[k] = over[k]; });
    return o;
}
function serve(p, body, type) { routes[p] = function (req, res) { res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }); res.end(body); }; }

function installed(name, version) {
    var dir = path.join(base, name, 'extensions', 'com.binflow.organizer');
    rm(path.join(base, name)); copy(SRC, dir); setVersion(dir, version || '2.5.0');
    return dir;
}
function leftovers(dir) { return fs.readdirSync(path.dirname(dir)).filter(function (x) { return x.indexOf('.com.binflow.organizer.nuevo') === 0; }); }
function backups(dir) { return fs.readdirSync(path.dirname(dir)).filter(function (x) { return x.indexOf('.com.binflow.organizer.anterior') === 0; }); }
async function mustFail(p, re) {
    try { await p; } catch (e) { if (re) assert.ok(re.test(e.message), e.message); return e; }
    assert.fail('debía fallar');
}
async function info() { var r = await updater.checkForUpdate('2.5.0', { url: url('/latest.json'), allowUrl: allowLocal, timeoutMs: 2000 }); assert.strictEqual(r.status, 'available', JSON.stringify(r)); return r.latest; }

(async function main() {
    await new Promise(function (resolve) {
        server = http.createServer(function (req, res) { var h = routes[req.url.split('?')[0]]; if (h) h(req, res); else { res.writeHead(404); res.end(); } });
        server.listen(0, '127.0.0.1', function () { PORT = server.address().port; resolve(); });
    });
    console.log('BinFlow actualizador — pruebas en ' + base + ' (servidor simulado en el puerto ' + PORT + ')');

    await test('versiones: comparación numérica (2.10.0 > 2.9.9) y entradas no válidas', function () {
        assert.strictEqual(updater.compareVersions('2.10.0', '2.9.9'), 1);
        assert.strictEqual(updater.compareVersions('2.5.0', '2.5.0'), 0);
        assert.strictEqual(updater.compareVersions('2.4.1', '2.5.0'), -1);
        ['', 'x', '2.5', '2.5.0-beta', null, undefined, '2.5.0.1'].forEach(function (v) { assert.strictEqual(updater.compareVersions(v, '2.5.0'), null, String(v)); });
    });

    await test('URLs: solo https y gponga/Binflow en github.com o raw.githubusercontent.com', function () {
        var U = require('url').URL, ok = function (s) { return updater.allowUrl(new U(s)); };
        assert.ok(ok('https://raw.githubusercontent.com/gponga/Binflow/main/latest.json'));
        assert.ok(ok('https://github.com/gponga/Binflow/raw/main/releases/BinFlow-2.5.0.zip'));
        ['http://raw.githubusercontent.com/gponga/Binflow/main/latest.json', 'https://raw.githubusercontent.com/otro/Binflow/main/latest.json',
            'https://evil.com/gponga/Binflow/x.zip', 'https://raw.githubusercontent.com.evil.com/gponga/Binflow/x', 'https://user@github.com/gponga/Binflow/x',
            'https://github.com:8443/gponga/Binflow/x', 'https://objects.githubusercontent.com/gponga/Binflow/x', 'https://github.com/gponga/Binflow-malo/x', 'ftp://github.com/gponga/Binflow/x'
        ].forEach(function (s) { assert.ok(!ok(s), 'debía rechazar ' + s); });
        assert.ok(/^https:\/\/raw\.githubusercontent\.com\/gponga\/Binflow\//.test(updater.LATEST_URL));
    });

    await test('sin red: silencio (status error, no lanza) y rápido', async function () {
        var t = Date.now();
        var r = await updater.checkForUpdate('2.5.0', { url: 'http://127.0.0.1:1/latest.json', allowUrl: function () { return true; }, timeoutMs: 2000 });
        assert.strictEqual(r.status, 'error');
        assert.ok(Date.now() - t < 3000);
    });

    await test('servidor que no responde: timeout corto, sin colgar', async function () {
        routes['/slow.json'] = function () { /* nunca responde */ };
        var t = Date.now();
        var r = await updater.checkForUpdate('2.5.0', { url: url('/slow.json'), allowUrl: allowLocal, timeoutMs: 300 });
        assert.strictEqual(r.status, 'error'); assert.ok(Date.now() - t < 2000);
    });

    await test('JSON roto, vacío o con campos inválidos: error silencioso', async function () {
        serve('/broken.json', '{"version": "2.5.9", '); serve('/empty.json', ''); serve('/arr.json', '[1,2]');
        serve('/nover.json', JSON.stringify(latestJson({ version: 'abc' }))); serve('/nosha.json', JSON.stringify(latestJson({ sha256: 'zz' })));
        serve('/badhost.json', JSON.stringify(latestJson({ url: 'https://evil.com/gponga/Binflow/x.zip' })));
        for (var p of ['/broken.json', '/empty.json', '/arr.json', '/nover.json', '/nosha.json', '/badhost.json', '/missing.json']) {
            var r = await updater.checkForUpdate('2.5.0', { url: url(p), allowUrl: function (u) { return allowLocal(u) || u.hostname === 'evil.com' ? allowLocal(u) : false; }, timeoutMs: 1000 });
            assert.strictEqual(r.status, 'error', p);
        }
    });

    await test('respuesta enorme: se corta', async function () {
        serve('/big.json', Buffer.alloc(400 * 1024, 120));
        assert.strictEqual((await updater.checkForUpdate('2.5.0', { url: url('/big.json'), allowUrl: allowLocal })).status, 'error');
    });

    await test('versión igual o menor: al día, sin aviso', async function () {
        serve('/latest.json', JSON.stringify(latestJson()));
        var o = { url: url('/latest.json'), allowUrl: allowLocal };
        assert.strictEqual((await updater.checkForUpdate('2.5.9', o)).status, 'current');
        assert.strictEqual((await updater.checkForUpdate('3.0.0', o)).status, 'current');
    });

    await test('versión mayor: aviso con el changelog de las intermedias (la 2.4.0 ya instalada no sale), de la más nueva a la más antigua', async function () {
        var r = await updater.checkForUpdate('2.5.0', { url: url('/latest.json'), allowUrl: allowLocal });
        assert.strictEqual(r.status, 'available');
        assert.strictEqual(r.latest.version, '2.5.9');
        assert.deepStrictEqual(r.changelog.map(function (c) { return c.version; }), ['2.5.9', '2.5.5']);
        assert.deepStrictEqual(r.changelog[0].features, ['Botón Actualizar']);
        assert.deepStrictEqual(r.changelog[0].improvements, ['Más rápido']);
    });

    await test('redirección a un host no permitido: se rechaza', async function () {
        routes['/redir.json'] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/latest.json' }); res.end(); };
        var r = await updater.checkForUpdate('2.5.0', { url: url('/redir.json'), allowUrl: allowLocal });
        assert.strictEqual(r.status, 'error'); assert.ok(/no permitida/.test(r.message), r.message);
        routes['/redir2.json'] = function (req, res) { res.writeHead(302, { Location: '/latest.json' }); res.end(); };
        assert.strictEqual((await updater.checkForUpdate('2.5.0', { url: url('/redir2.json'), allowUrl: allowLocal })).status, 'available', 'redirección al mismo host permitido: sí');
        routes['/loop.json'] = function (req, res) { res.writeHead(302, { Location: '/loop.json' }); res.end(); };
        assert.strictEqual((await updater.checkForUpdate('2.5.0', { url: url('/loop.json'), allowUrl: allowLocal })).status, 'error');
    });

    // ------------------------------------------------------------ instalación
    await test('éxito: instala la nueva, deja copia de la anterior, sin restos temporales', async function () {
        serve('/good.zip', fs.readFileSync(GOOD_ZIP));
        var dir = installed('ok'), before = tree(dir);
        var r = await updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'engine', 'version.js'), 'utf8').trim(), "module.exports = '2.5.9';");
        assert.ok(/ExtensionBundleVersion="2\.5\.9"/.test(fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8')));
        assert.deepStrictEqual(tree(dir), tree(path.join(PKG, 'com.binflow.organizer')), 'idéntica al paquete');
        assert.deepStrictEqual(tree(r.backupDir), before, 'la copia de seguridad es la versión anterior exacta');
        assert.deepStrictEqual(leftovers(dir), []);
        assert.strictEqual(backups(dir).length, 1);
        assert.strictEqual(r.backupDir.indexOf(path.dirname(dir) + path.sep + '.'), 0, 'copia oculta (CEP no la carga)');
    });

    await test('solo se conserva la copia de seguridad más reciente', async function () {
        var dir = installed('two', '2.5.0');
        var i1 = await info();
        await updater.installUpdate(i1, { installDir: dir, allowUrl: allowLocal });
        // segunda actualización: 2.6.0
        var pkg2 = path.join(base, 'pkg2'); rm(pkg2); copy(path.join(PKG, 'com.binflow.organizer'), path.join(pkg2, 'com.binflow.organizer')); setVersion(path.join(pkg2, 'com.binflow.organizer'), '2.6.0');
        var z2 = path.join(base, 'good2.zip'); rm(z2); zipDir(path.join(pkg2, 'com.binflow.organizer'), z2);
        serve('/good2.zip', fs.readFileSync(z2));
        var info2 = JSON.parse(JSON.stringify(i1)); info2.version = '2.6.0'; info2.url = url('/good2.zip'); info2.sha256 = sha(fs.readFileSync(z2)); info2.size = fs.statSync(z2).size;
        await updater.installUpdate(info2, { installDir: dir, allowUrl: allowLocal });
        assert.strictEqual(backups(dir).length, 1);
        assert.ok(/anterior\.2\.5\.9\./.test(backups(dir)[0]), backups(dir)[0]);
    });

    async function failCase(name, prepare, re, extra) {
        await test(name, async function () {
            var dir = installed('f-' + name.replace(/\W+/g, '').slice(0, 20)), before = tree(dir);
            var inf = await prepare(await info());
            var e = await mustFail(updater.installUpdate(inf, Object.assign({ installDir: dir, allowUrl: allowLocal }, extra || {})), re);
            assert.deepStrictEqual(tree(dir), before, 'la versión instalada queda intacta');
            assert.deepStrictEqual(leftovers(dir), []); assert.deepStrictEqual(backups(dir), []);
            return e;
        });
    }

    await failCase('sha256 incorrecto', function (i) { i.sha256 = sha('otra cosa'); return i; }, /huella|sha256/);
    await failCase('tamaño distinto al anunciado', function (i) { i.size = i.size + 1; return i; }, /tamaño/);
    await failCase('descarga demasiado grande', function (i) { return i; }, /demasiado grande/, { maxBytes: 1000 });
    await failCase('zip con ruta ../ (zip-slip)', function (i) {
        var z = path.join(base, 'evil1.zip'); rm(z);
        pyZip(z, [{ name: 'com.binflow.organizer/CSXS/manifest.xml', data: 'x' }, { name: '../evil.txt', data: 'pwn' }]);
        serve('/evil1.zip', fs.readFileSync(z)); i.url = url('/evil1.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /ruta no permitida/);
    await failCase('zip con ruta absoluta', function (i) {
        var z = path.join(base, 'evil2.zip'); rm(z);
        pyZip(z, [{ name: '/tmp/evil.txt', data: 'pwn' }]);
        serve('/evil2.zip', fs.readFileSync(z)); i.url = url('/evil2.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /ruta no permitida/);
    await failCase('zip con enlace simbólico', function (i) {
        var z = path.join(base, 'evil3.zip'); rm(z);
        pyZip(z, [{ name: 'com.binflow.organizer/CSXS/manifest.xml', data: 'x' }, { name: 'com.binflow.organizer/main.js', data: '/etc/passwd', symlink: true }]);
        serve('/evil3.zip', fs.readFileSync(z)); i.url = url('/evil3.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /enlaces/);
    await failCase('zip con archivos fuera de com.binflow.organizer', function (i) {
        var z = path.join(base, 'evil4.zip'); rm(z);
        pyZip(z, [{ name: 'otra/cosa.txt', data: 'x' }]);
        serve('/evil4.zip', fs.readFileSync(z)); i.url = url('/evil4.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /fuera de/);
    await failCase('zip que no es zip', function (i) {
        serve('/junk.zip', 'esto no es un zip'); i.url = url('/junk.zip'); i.sha256 = sha('esto no es un zip'); i.size = null; return i;
    }, null);
    await failCase('manifest con otro ExtensionBundleId', function (i) {
        var d = path.join(base, 'pkgid'); rm(d); copy(path.join(PKG, 'com.binflow.organizer'), path.join(d, 'com.binflow.organizer'));
        var m = path.join(d, 'com.binflow.organizer', 'CSXS', 'manifest.xml'); fs.writeFileSync(m, fs.readFileSync(m, 'utf8').replace('ExtensionBundleId="com.binflow.organizer"', 'ExtensionBundleId="com.otro.panel"'));
        var z = path.join(base, 'otroid.zip'); rm(z); zipDir(path.join(d, 'com.binflow.organizer'), z);
        serve('/otroid.zip', fs.readFileSync(z)); i.url = url('/otroid.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /otra extensión/);
    await failCase('la versión del paquete no coincide con la anunciada', function (i) { i.version = '2.5.8'; return i; }, /no coincide con la anunciada/);
    await failCase('paquete a medias (faltan archivos)', function (i) {
        var d = path.join(base, 'pkgmiss'); rm(d); copy(path.join(PKG, 'com.binflow.organizer'), path.join(d, 'com.binflow.organizer'));
        rm(path.join(d, 'com.binflow.organizer', 'fonts'));
        var z = path.join(base, 'miss.zip'); rm(z); zipDir(path.join(d, 'com.binflow.organizer'), z);
        serve('/miss.zip', fs.readFileSync(z)); i.url = url('/miss.zip'); i.sha256 = sha(fs.readFileSync(z)); i.size = null; return i;
    }, /faltan archivos/);

    await test('versión igual o menor a la instalada: no se instala', async function () {
        var dir = installed('same', '2.5.9'), before = tree(dir);
        await mustFail(updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal }), /Ya tienes/);
        assert.deepStrictEqual(tree(dir), before);
    });

    await test('fallo a mitad (tras apartar la anterior): vuelta atrás, versión anterior intacta', async function () {
        var dir = installed('mid1'), before = tree(dir);
        var e = await mustFail(updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal, hooks: { afterBackup: function () { throw new Error('corte simulado'); } } }), /corte simulado/);
        assert.ok(e.rolledBack);
        assert.deepStrictEqual(tree(dir), before); assert.deepStrictEqual(leftovers(dir), []); assert.deepStrictEqual(backups(dir), []);
    });

    await test('fallo tras colocar la nueva: vuelta atrás, versión anterior intacta', async function () {
        var dir = installed('mid2'), before = tree(dir);
        var e = await mustFail(updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal, hooks: { afterSwap: function () { throw new Error('corte simulado 2'); } } }), /corte simulado 2/);
        assert.ok(e.rolledBack);
        assert.deepStrictEqual(tree(dir), before); assert.deepStrictEqual(leftovers(dir), []); assert.deepStrictEqual(backups(dir), []);
    });

    await test('sin permiso de escritura en extensions/: error legible, nada cambia', async function () {
        if (process.getuid && process.getuid() === 0) return;
        var dir = installed('ro'), before = tree(dir), parent = path.dirname(dir);
        fs.chmodSync(parent, 365);
        try { await mustFail(updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal }), /permiso/); }
        finally { fs.chmodSync(parent, 493); }
        assert.deepStrictEqual(tree(dir), before);
    });

    await test('no macOS: mensaje claro; instalación como enlace (desarrollo): se niega', async function () {
        var dir = installed('plat'), before = tree(dir);
        await mustFail(updater.installUpdate(await info(), { installDir: dir, allowUrl: allowLocal, platform: 'win32' }), /solo funciona en Mac/);
        var link = path.join(base, 'plat', 'extensions', 'enlace'); fs.symlinkSync(dir, link);
        await mustFail(updater.installUpdate(await info(), { installDir: link, allowUrl: allowLocal }), /enlace/);
        assert.deepStrictEqual(tree(dir), before);
    });

    await test('datos de actualización inválidos: se rechazan antes de descargar', async function () {
        var dir = installed('inv');
        await mustFail(updater.installUpdate({ version: 'x', url: 'a', sha256: 'b' }, { installDir: dir }), /no son válidos/);
        await mustFail(updater.installUpdate(null, { installDir: dir }), /no son válidos/);
    });

    await test('descarga desde un host no permitido (producción): se rechaza sin tocar nada', async function () {
        var dir = installed('prod'), before = tree(dir), i = await info();
        i.url = 'https://evil.com/gponga/Binflow/x.zip';
        await mustFail(updater.installUpdate(i, { installDir: dir }), /no permitida/);
        assert.deepStrictEqual(tree(dir), before);
    });

    await test('publicar_version.sh: zip y latest.json válidos (sin basura ni tests), y el actualizador los acepta e instala', async function () {
        var rel = path.join(base, 'release-src'); rm(rel); fs.mkdirSync(rel);
        var PLG = path.join(rel, 'plugin', 'com.binflow.organizer');
        copy(SRC, PLG);
        copy(path.join(__dirname, '..', 'installer'), path.join(rel, 'installer'));
        fs.mkdirSync(path.join(rel, 'tools'));
        ['publicar_version.sh', 'changelog-publico.json'].forEach(function (f) { fs.copyFileSync(path.join(__dirname, '..', 'tools', f), path.join(rel, 'tools', f)); });
        fs.chmodSync(path.join(rel, 'tools', 'publicar_version.sh'), 493);
        fs.writeFileSync(path.join(PLG, '.DS_Store'), 'x'); fs.writeFileSync(path.join(PLG, '._main.js'), 'x');
        fs.writeFileSync(path.join(PLG, '.debug'), 'x'); fs.mkdirSync(path.join(PLG, 'tests')); fs.writeFileSync(path.join(PLG, 'tests', 't.js'), 'x');
        var out = cp.execFileSync('bash', [path.join(rel, 'tools', 'publicar_version.sh')], { cwd: os.tmpdir() }).toString();
        assert.ok(/Esto NO sube nada/.test(out));
        var ver = fs.readFileSync(path.join(SRC, 'engine', 'version.js'), 'utf8').match(/'([\d.]+)'/)[1];
        var dirOut = path.join(rel, '_salida'), zip = path.join(dirOut, 'BinFlow-' + ver + '.zip');
        var names = cp.execFileSync('unzip', ['-Z1', zip]).toString();
        assert.ok(!/\.DS_Store|\._|\.debug|tests\//.test(names), names);
        assert.ok(/^com\.binflow\.organizer\/CSXS\/manifest\.xml$/m.test(names));
        assert.ok(!/^(?!com\.binflow\.organizer\/)./m.test(names), 'todo dentro de com.binflow.organizer/');
        var lj = JSON.parse(fs.readFileSync(path.join(dirOut, 'latest.json'), 'utf8'));
        assert.strictEqual(lj.version, ver); assert.strictEqual(lj.sha256, sha(fs.readFileSync(zip))); assert.strictEqual(lj.size, fs.statSync(zip).size);
        assert.strictEqual(lj.url, 'https://github.com/gponga/Binflow/releases/download/v' + ver + '/BinFlow-' + ver + '.zip');
        assert.ok(updater.parseLatest(lj), 'el actualizador acepta su propio latest.json');
        assert.ok(lj.changelog.some(function (c) { return c.version === ver; }));
        // No se pisa una publicación existente
        var again; try { cp.execFileSync('bash', [path.join(rel, 'tools', 'publicar_version.sh')], { cwd: rel, stdio: 'pipe' }); } catch (e) { again = e; }
        assert.ok(again, 'debía negarse a sobrescribir');
        // Instalación real del zip publicado sobre una versión anterior (servidor local).
        serve('/pub.zip', fs.readFileSync(zip));
        var dir = installed('pub', '2.4.0');
        var i = JSON.parse(JSON.stringify(lj)); i.url = url('/pub.zip');
        var r = await updater.installUpdate(i, { installDir: dir, allowUrl: allowLocal });
        assert.strictEqual(r.version, ver);
        assert.deepStrictEqual(tree(dir), tree(PLG) && (function () { var t = tree(PLG); delete t['.DS_Store']; delete t['._main.js']; delete t['.debug']; Object.keys(t).forEach(function (k) { if (k.indexOf('tests' + path.sep) === 0) delete t[k]; }); return t; })());
    });


    // ------------------------------------------------------------ zip de instalación a mano
    await test('publicar_version.sh: el zip de instalación trae .command, instalador, LEEME y plugin limpio (sin tests ni basura)', function () {
        var rel = path.join(base, 'release-src');
        var ver = fs.readFileSync(path.join(SRC, 'engine', 'version.js'), 'utf8').match(/'([\d.]+)'/)[1];
        var zip = path.join(rel, '_salida', 'BinFlow-v' + ver + '.zip');
        var names = cp.execFileSync('unzip', ['-Z1', zip]).toString().split('\n').filter(Boolean);
        var root = 'BinFlow-v' + ver + '/';
        ['Instalar BinFlow.command', 'instalar_plugin.sh', 'LEEME.txt', 'com.binflow.organizer/CSXS/manifest.xml'].forEach(function (f) { assert.ok(names.indexOf(root + f) !== -1, 'falta ' + f); });
        assert.ok(names.every(function (x) { return x.indexOf(root) === 0; }), 'todo dentro de ' + root);
        assert.ok(!names.some(function (x) { return /\.DS_Store|\/\._|\.debug|tests\//.test(x); }));
        var tmp = path.join(base, 'inst-unzip'); rm(tmp); fs.mkdirSync(tmp);
        cp.execFileSync('unzip', ['-q', zip, '-d', tmp]);
        var cmdMode = fs.statSync(path.join(tmp, root, 'Instalar BinFlow.command')).mode & 0o111;
        assert.ok(cmdMode, 'el .command es ejecutable');
        assert.ok(fs.readFileSync(path.join(tmp, root, 'LEEME.txt'), 'utf8').indexOf(ver) !== -1, 'el LEEME lleva la versión');
    });

    // ------------------------------------------------------------ redirección de Releases (github.com → host de almacenamiento)
    var U = require('url').URL;
    function prod(s) { return new U(s); }
    await test('Releases: el host de almacenamiento solo se acepta como destino de una redirección desde github.com/gponga/Binflow/releases/download/ (https)', function () {
        var rel = prod('https://github.com/gponga/Binflow/releases/download/v2.5.0/BinFlow-2.5.0.zip');
        ['https://objects.githubusercontent.com/github-production-release-asset/1/x?sig=abc', 'https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=abc'].forEach(function (s) {
            assert.ok(updater.allowUrl(prod(s), rel), 'debía aceptar ' + s + ' desde la Release');
            assert.ok(!updater.allowUrl(prod(s)), 'nunca como dirección inicial: ' + s);
        });
        var st = prod('https://objects.githubusercontent.com/x');
        [
            ['desde raw.githubusercontent.com', prod('https://raw.githubusercontent.com/gponga/Binflow/main/latest.json')],
            ['desde github.com pero fuera de releases/download', prod('https://github.com/gponga/Binflow/raw/main/x.zip')],
            ['desde releases/download de otro repo', prod('https://github.com/otro/Binflow/releases/download/v1/x.zip')],
            ['desde un repo parecido', prod('https://github.com/gponga/Binflow-malo/releases/download/v1/x.zip')],
            ['desde http', prod('http://github.com/gponga/Binflow/releases/download/v2.5.0/x.zip')],
            ['desde el propio host de almacenamiento (cadena)', prod('https://objects.githubusercontent.com/y')],
            ['desde otro host', prod('https://evil.com/gponga/Binflow/releases/download/v1/x.zip')],
            ['desde github.com con usuario', prod('https://user@github.com/gponga/Binflow/releases/download/v1/x.zip')],
            ['desde github.com con puerto', prod('https://github.com:8443/gponga/Binflow/releases/download/v1/x.zip')]
        ].forEach(function (c) { assert.ok(!updater.allowUrl(st, c[1]), 'debía rechazar ' + c[0]); });
        ['http://objects.githubusercontent.com/x', 'https://objects.githubusercontent.com:8443/x', 'https://user@objects.githubusercontent.com/x', 'https://objects.githubusercontent.com.evil.com/x', 'https://evilobjects.githubusercontent.com/x', 'https://githubusercontent.com/x', 'https://evil.com/x'].forEach(function (s) {
            assert.ok(!updater.allowUrl(prod(s), rel), 'debía rechazar destino ' + s);
        });
    });

    // El servidor local imita github.com (127.0.0.1) y el almacenamiento (localhost); se traduce a las direcciones reales y se aplica la política REAL.
    function toProd(u) {
        if (!u || String(u.port) !== String(PORT)) return null;
        var host = { '127.0.0.1': 'github.com', 'localhost': 'objects.githubusercontent.com', 'otro.test': 'evil.com' }[u.hostname];
        if (!host) return null;
        return new U('https://' + host + u.pathname + u.search);
    }
    function allowSim(u, from) { var pu = toProd(u); return !!pu && updater.allowUrl(pu, from ? toProd(from) : undefined); }
    var REL_PATH = '/gponga/Binflow/releases/download/v2.5.9/BinFlow-2.5.9.zip';

    async function installVia(pathName, name) {
        var dir = installed(name), before = tree(dir);
        return { dir: dir, before: before, i: latestJson({ url: url(pathName) }) };
    }

    await test('Releases (simulado): github.com/releases/download → 302 → almacenamiento → instala', async function () {
        routes[REL_PATH] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/github-production-release-asset/1/zip?sig=abc' }); res.end(); };
        serve('/github-production-release-asset/1/zip', fs.readFileSync(GOOD_ZIP));
        var t = await installVia(REL_PATH, 'rel-ok');
        var r = await updater.installUpdate(t.i, { installDir: t.dir, allowUrl: allowSim });
        assert.strictEqual(r.ok, true);
        assert.deepStrictEqual(tree(t.dir), tree(path.join(PKG, 'com.binflow.organizer')));
    });

    async function relFail(name, setup, re) {
        await test('Releases (simulado): ' + name, async function () {
            var start = setup();
            var t = await installVia(start, 'rf-' + name.replace(/\W+/g, '').slice(0, 14));
            await mustFail(updater.installUpdate(t.i, { installDir: t.dir, allowUrl: allowSim }), re || /no permitida/);
            assert.deepStrictEqual(tree(t.dir), t.before, 'la versión instalada queda intacta');
            assert.deepStrictEqual(leftovers(t.dir), []);
        });
    }
    await relFail('una ruta cualquiera que no es de la Release se rechaza', function () { serve('/ini-storage', fs.readFileSync(GOOD_ZIP)); return '/ini-storage'; });
    await test('Releases (simulado): el host de almacenamiento no se acepta como dirección inicial (política real)', function () {
        assert.ok(!allowSim(new U('http://localhost:' + PORT + '/x')));
    });
    await relFail('redirección desde una ruta que no es releases/download se rechaza', function () {
        routes['/gponga/Binflow/raw/main/x.zip'] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/zip' }); res.end(); };
        return '/gponga/Binflow/raw/main/x.zip';
    });
    await relFail('redirección desde el repo de otro se rechaza', function () {
        routes['/otro/Binflow/releases/download/v1/x.zip'] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/zip' }); res.end(); };
        return '/otro/Binflow/releases/download/v1/x.zip';
    });
    await relFail('redirección de la Release a otro host se rechaza', function () {
        routes['/gponga/Binflow/releases/download/v1/otro.zip'] = function (req, res) { res.writeHead(302, { Location: 'http://otro.test:' + PORT + '/zip' }); res.end(); };
        return '/gponga/Binflow/releases/download/v1/otro.zip';
    });
    await relFail('cadena almacenamiento → almacenamiento se rechaza', function () {
        routes['/gponga/Binflow/releases/download/v1/cadena.zip'] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/salto2' }); res.end(); };
        routes['/salto2'] = function (req, res) { res.writeHead(302, { Location: 'http://localhost:' + PORT + '/salto3' }); res.end(); };
        return '/gponga/Binflow/releases/download/v1/cadena.zip';
    });
    await relFail('redirección de la Release a un esquema no permitido (ftp) se rechaza', function () {
        routes['/gponga/Binflow/releases/download/v1/http.zip'] = function (req, res) { res.writeHead(302, { Location: 'ftp://localhost/zip' }); res.end(); };
        return '/gponga/Binflow/releases/download/v1/http.zip';
    }, /no permitida|no válida|Dirección/);

    server.close();
    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
    process.exit(process.exitCode || 0);
})();
