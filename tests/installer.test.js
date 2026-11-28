/**
 * BinFlow — pruebas del instalador (installer/instalar_plugin.sh). Solo carpetas temporales (--target); nunca toca el Premiere real.
 * Uso: node tests/installer.test.js [carpeta-temporal]
 */
'use strict';
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var INSTALLER = path.join(ROOT, 'installer', 'instalar_plugin.sh');
var PLUGIN = path.join(ROOT, 'plugin', 'com.binflow.organizer');
var base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'binflow-inst-'));
var passed = 0, n = 0;

async function test(name, fn) {
    n++;
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { console.log('  ✗ ' + name + '\n    ' + (e.stack || e).split('\n').slice(0, 4).join('\n    ')); process.exitCode = 1; }
}
function rm(p) { cp.execFileSync('rm', ['-rf', p]); }
function run(args, input, cwd) {
    var r = cp.spawnSync('bash', [INSTALLER].concat(args), { input: input === undefined ? '' : input, cwd: cwd || os.tmpdir(), encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function fresh(name) {
    var t = path.join(base, name); rm(t); fs.mkdirSync(t, { recursive: true });
    return t;
}
function mkOld(t) {
    var old = path.join(t, 'com.gponga.organizer');
    fs.mkdirSync(path.join(old, 'CSXS'), { recursive: true });
    fs.writeFileSync(path.join(old, 'CSXS', 'manifest.xml'), '<old/>');
    return old;
}
function hidden(t) { return fs.readdirSync(t).filter(function (x) { return /^\.com\.gponga\.organizer\.antigua\./.test(x); }); }

(async function () {
    console.log('BinFlow instalador — pruebas en ' + base);

    await test('instala desde el repositorio (plugin en ../plugin) con --target, y es idéntico a la fuente', function () {
        var t = fresh('basico');
        var r = run(['--target', t, '--no-debug', '--conservar-antigua']);
        assert.strictEqual(r.code, 0, r.out);
        cp.execFileSync('diff', ['-r', '-x', '.DS_Store', '-x', '._*', PLUGIN, path.join(t, 'com.binflow.organizer')]);
        assert.ok(/Instalación completada/.test(r.out));
    });

    await test('no hay antigua: no pregunta nada', function () {
        var t = fresh('sin-antigua');
        var r = run(['--target', t, '--no-debug']);
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(!/versión antigua/.test(r.out), r.out);
    });

    await test('antigua + respuesta «n»: se queda donde está (nunca borra sin confirmar)', function () {
        var t = fresh('ask-no'), old = mkOld(t);
        var r = run(['--target', t, '--no-debug'], 'n\n');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(fs.existsSync(path.join(old, 'CSXS', 'manifest.xml')), 'la antigua sigue ahí');
        assert.deepStrictEqual(hidden(t), []);
        assert.ok(/DOS paneles/.test(r.out));
    });

    await test('antigua + sin respuesta (stdin vacío / sin terminal): no se toca', function () {
        var t = fresh('ask-eof'), old = mkOld(t);
        var r = run(['--target', t, '--no-debug'], '');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(fs.existsSync(old));
        assert.deepStrictEqual(hidden(t), []);
    });

    await test('antigua + respuesta «s»: se aparta a una carpeta oculta (no se borra) y queda solo el panel nuevo', function () {
        var t = fresh('ask-si'), old = mkOld(t);
        var r = run(['--target', t, '--no-debug'], 's\n');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(!fs.existsSync(old), 'la antigua ya no está con su nombre');
        var h = hidden(t); assert.strictEqual(h.length, 1, r.out);
        assert.ok(fs.existsSync(path.join(t, h[0], 'CSXS', 'manifest.xml')), 'su contenido se conserva');
        assert.ok(fs.existsSync(path.join(t, 'com.binflow.organizer', 'CSXS', 'manifest.xml')));
    });

    await test('--quitar-antigua aparta sin preguntar; --conservar-antigua no pregunta y la deja', function () {
        var t = fresh('flag-si'), old = mkOld(t);
        assert.strictEqual(run(['--target', t, '--no-debug', '--quitar-antigua']).code, 0);
        assert.ok(!fs.existsSync(old)); assert.strictEqual(hidden(t).length, 1);
        var t2 = fresh('flag-no'), old2 = mkOld(t2);
        var r = run(['--target', t2, '--no-debug', '--conservar-antigua'], 's\n');
        assert.strictEqual(r.code, 0, r.out);
        assert.ok(fs.existsSync(old2)); assert.deepStrictEqual(hidden(t2), []);
    });

    await test('si la instalación nueva falla, la antigua no se toca', function () {
        var t = fresh('falla'), old = mkOld(t);
        var src = path.join(base, 'src-incompleta'); rm(src); fs.mkdirSync(path.join(src, 'installer'), { recursive: true });
        fs.copyFileSync(INSTALLER, path.join(src, 'installer', 'instalar_plugin.sh'));
        fs.mkdirSync(path.join(src, 'plugin', 'com.binflow.organizer', 'CSXS'), { recursive: true });
        fs.writeFileSync(path.join(src, 'plugin', 'com.binflow.organizer', 'CSXS', 'manifest.xml'), 'ExtensionBundleVersion="9.9.9"');
        var r = cp.spawnSync('bash', [path.join(src, 'installer', 'instalar_plugin.sh'), '--target', t, '--no-debug', '--quitar-antigua'], { encoding: 'utf8' });
        assert.notStrictEqual(r.status, 0);
        assert.ok(fs.existsSync(path.join(old, 'CSXS', 'manifest.xml')), 'la antigua intacta');
        assert.deepStrictEqual(hidden(t), []);
    });

    await test('el LEEME y el instalador no se instalan dentro del panel; el plugin no trae logos personales ni tests', function () {
        var t = fresh('limpio');
        run(['--target', t, '--no-debug']);
        var inst = path.join(t, 'com.binflow.organizer');
        assert.ok(!fs.existsSync(path.join(inst, 'tests')) && !fs.existsSync(path.join(inst, 'assets')));
    });

    console.log('\n' + passed + '/' + n + ' pruebas correctas' + (process.exitCode ? ' — HAY FALLOS' : ''));
    process.exit(process.exitCode || 0);
})();
