/**
 * BinFlow engine — actualizador (v2.5.0). Solo Node, sin dependencias; Node antiguo de CEP (sin fs.promises).
 *
 * checkForUpdate(): descarga latest.json y dice si hay versión nueva. Nunca lanza ni molesta: ante cualquier fallo devuelve {status:'error'}.
 * installUpdate(): SOLO se llama con un clic. Descarga el zip, comprueba sha256, extrae, valida, instala con copia de seguridad
 *                  y vuelta atrás automática. Solo macOS (usa «unzip» del sistema).
 *
 * Seguridad: solo https://github.com/gponga/Binflow/... y https://raw.githubusercontent.com/gponga/Binflow/... (también en cada redirección).
 * Excepción acotada: GitHub redirige las descargas de una Release a un host de almacenamiento propio (objects/release-assets.githubusercontent.com);
 * ese host se acepta SOLO como destino de una redirección que viene de https://github.com/gponga/Binflow/releases/download/... (nunca como dirección inicial).
 * No hay tokens ni claves. El sha256 viaja por el mismo canal que el zip: protege de descargas corruptas, no de un repo comprometido.
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var childProcess = require('child_process');

var LATEST_URL = 'https://raw.githubusercontent.com/gponga/Binflow/main/latest.json';
var BUNDLE_DIR = 'com.binflow.organizer';
var MAX_JSON = 256 * 1024;
var MAX_ZIP = 60 * 1024 * 1024;
var MAX_REDIRECTS = 5;
var CHECK_TIMEOUT_MS = 6000;
var DOWNLOAD_TIMEOUT_MS = 60000;
var REQUIRED_FILES = ['CSXS/manifest.xml', 'index.html', 'main.js', 'ui/ui-logic.js', 'host/ext.jsx', 'engine/index.js', 'engine/version.js'];
var REQUIRED_DIRS = ['engine', 'fonts'];

// ------------------------------------------------------------ versiones y URLs

/** Compara «a.b.c» numéricamente. Devuelve 1, 0, -1, o null si alguna no es una versión válida. */
function compareVersions(a, b) {
    var pa = parseVersion(a), pb = parseVersion(b);
    if (!pa || !pb) return null;
    for (var i = 0; i < 3; i++) {
        if (pa[i] > pb[i]) return 1;
        if (pa[i] < pb[i]) return -1;
    }
    return 0;
}

function parseVersion(v) {
    var m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(String(v === undefined || v === null ? '' : v).trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

var RELEASE_PREFIX = '/gponga/binflow/releases/download/';
var RELEASE_STORAGE_HOSTS = ['objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

function plainHttps(u) {
    return !!u && u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443');
}

/**
 * Política de URLs de producción: https y solo el repositorio gponga/Binflow en github.com o raw.githubusercontent.com.
 * `from` (opcional) es la URL desde la que se redirige: solo con ella se admite el host de almacenamiento de Releases.
 */
function allowUrl(u, from) {
    if (!plainHttps(u)) return false;
    var host = String(u.hostname).toLowerCase();
    if (RELEASE_STORAGE_HOSTS.indexOf(host) !== -1) {
        return plainHttps(from) && String(from.hostname).toLowerCase() === 'github.com' && String(from.pathname).toLowerCase().indexOf(RELEASE_PREFIX) === 0;
    }
    if (host !== 'github.com' && host !== 'raw.githubusercontent.com') return false;
    return u.pathname.toLowerCase().indexOf('/gponga/binflow/') === 0;
}

// ------------------------------------------------------------ red

function httpModuleFor(u) { return u.protocol === 'http:' ? require('http') : require('https'); }

/**
 * GET con límites: sigue redirecciones validando cada salto, corta por tamaño y por tiempo.
 * sink: función (res, done) que consume la respuesta y llama a done(err, value).
 */
function request(urlString, opts, sink) {
    var allow = opts.allowUrl || allowUrl;
    return new Promise(function (resolve, reject) {
        var hops = 0, finished = false, timer = null, activeReq = null;
        function fail(err) { if (finished) return; finished = true; clearTimeout(timer); try { if (activeReq) activeReq.abort(); } catch (ignore) {} reject(err); }
        function ok(v) { if (finished) return; finished = true; clearTimeout(timer); resolve(v); }
        function arm() { clearTimeout(timer); timer = setTimeout(function () { fail(new Error('Tiempo de espera agotado.')); }, opts.timeoutMs); }
        function go(target, from) {
            var u;
            try { u = new (require('url').URL)(target); } catch (e) { return fail(new Error('Dirección no válida.')); }
            if (!allow(u, from)) return fail(new Error('Dirección no permitida: ' + u.hostname));
            arm();
            activeReq = httpModuleFor(u).get({
                protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
                headers: { 'User-Agent': 'BinFlow-updater', 'Accept': '*/*' }
            }, function (res) {
                var code = res.statusCode;
                if (code >= 300 && code < 400 && res.headers.location) {
                    res.resume();
                    if (++hops > MAX_REDIRECTS) return fail(new Error('Demasiadas redirecciones.'));
                    var next;
                    try { next = new (require('url').URL)(res.headers.location, u).toString(); } catch (e) { return fail(new Error('Redirección no válida.')); }
                    return go(next, u);
                }
                if (code !== 200) { res.resume(); return fail(new Error('El servidor respondió ' + code + '.')); }
                res.on('data', arm);
                sink(res, function (err, value) { if (err) fail(err); else ok(value); });
            });
            activeReq.on('error', function (e) { fail(e); });
        }
        go(urlString);
    });
}

function getJson(urlString, opts) {
    return request(urlString, { allowUrl: opts.allowUrl, timeoutMs: opts.timeoutMs || CHECK_TIMEOUT_MS }, function (res, done) {
        var chunks = [], size = 0;
        res.on('data', function (c) {
            size += c.length;
            if (size > MAX_JSON) { done(new Error('Respuesta demasiado grande.')); res.destroy(); return; }
            chunks.push(c);
        });
        res.on('end', function () {
            try { done(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { done(new Error('JSON no válido.')); }
        });
        res.on('error', done);
    });
}

function download(urlString, file, opts) {
    return request(urlString, { allowUrl: opts.allowUrl, timeoutMs: opts.timeoutMs || DOWNLOAD_TIMEOUT_MS }, function (res, done) {
        var hash = crypto.createHash('sha256'), size = 0, out = fs.createWriteStream(file, { flags: 'wx' }), over = false;
        res.on('data', function (c) {
            size += c.length;
            if (size > (opts.maxBytes || MAX_ZIP)) { over = true; res.destroy(); out.destroy(); done(new Error('El archivo es demasiado grande.')); return; }
            hash.update(c); out.write(c);
        });
        res.on('end', function () { if (!over) out.end(function () { done(null, { sha256: hash.digest('hex'), size: size }); }); });
        res.on('error', function (e) { out.destroy(); done(e); });
        out.on('error', function (e) { done(e); });
    });
}

// ------------------------------------------------------------ consulta

/** Valida y normaliza latest.json. Devuelve null si no sirve. */
function parseLatest(raw, allow) {
    if (!raw || typeof raw !== 'object') return null;
    if (!parseVersion(raw.version)) return null;
    var url;
    try { url = new (require('url').URL)(String(raw.url || '')); } catch (e) { return null; }
    if (!(allow || allowUrl)(url)) return null;
    if (!/^[0-9a-f]{64}$/i.test(String(raw.sha256 || ''))) return null;
    var changelog = [];
    (Array.isArray(raw.changelog) ? raw.changelog : []).forEach(function (c) {
        if (!c || !parseVersion(c.version)) return;
        function list(v) { return (Array.isArray(v) ? v : []).filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim().slice(0, 300); }).slice(0, 30); }
        changelog.push({ version: String(c.version).trim(), date: typeof c.date === 'string' ? c.date.slice(0, 20) : '', features: list(c.features), improvements: list(c.improvements) });
    });
    return {
        version: String(raw.version).trim(), date: typeof raw.date === 'string' ? raw.date.slice(0, 20) : '',
        url: url.toString(), sha256: String(raw.sha256).toLowerCase(),
        size: typeof raw.size === 'number' && raw.size > 0 ? raw.size : null, changelog: changelog
    };
}

/**
 * ¿Hay versión nueva? Nunca lanza.
 * Devuelve { status: 'available', latest, changelog } | { status: 'current', latest } | { status: 'error', message }.
 * changelog = entradas de las versiones posteriores a la instalada y hasta la última, de la más nueva a la más antigua.
 */
async function checkForUpdate(currentVersion, opts) {
    opts = opts || {};
    try {
        var raw = await getJson(opts.url || LATEST_URL, opts);
        var latest = parseLatest(raw, opts.allowUrl);
        if (!latest) return { status: 'error', message: 'latest.json no es válido.' };
        var cmp = compareVersions(latest.version, currentVersion);
        if (cmp === null) return { status: 'error', message: 'Versión no válida.' };
        if (cmp <= 0) return { status: 'current', latest: latest };
        var entries = latest.changelog.filter(function (c) {
            return compareVersions(c.version, currentVersion) === 1 && compareVersions(c.version, latest.version) <= 0;
        }).sort(function (a, b) { return compareVersions(b.version, a.version); });
        return { status: 'available', latest: latest, changelog: entries };
    } catch (e) {
        return { status: 'error', message: e && e.message ? e.message : String(e) };
    }
}

// ------------------------------------------------------------ disco

function mkdirp(dir) {
    if (fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir));
    fs.mkdirSync(dir);
}

function rmrf(target) {
    var st;
    try { st = fs.lstatSync(target); } catch (e) { return; }
    if (st.isDirectory() && !st.isSymbolicLink()) {
        try { fs.chmodSync(target, 448); } catch (ignore) {}
        fs.readdirSync(target).forEach(function (n) { rmrf(path.join(target, n)); });
        fs.rmdirSync(target);
    } else fs.unlinkSync(target);
}

function isJunk(name) { return name === '.DS_Store' || name.indexOf('._') === 0; }

/** Lista relativa de archivos (sin basura de macOS). Lanza si hay enlaces simbólicos o tipos raros. */
function listTree(root) {
    var out = [];
    (function walk(dir, rel) {
        fs.readdirSync(dir).forEach(function (name) {
            if (isJunk(name)) return;
            var full = path.join(dir, name), r = rel ? rel + '/' + name : name, st = fs.lstatSync(full);
            if (st.isSymbolicLink()) throw new Error('El paquete contiene un enlace simbólico: ' + r);
            if (st.isDirectory()) { out.push(r + '/'); walk(full, r); }
            else if (st.isFile()) out.push(r);
            else throw new Error('El paquete contiene un archivo no permitido: ' + r);
        });
    })(root, '');
    return out.sort();
}

function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

function copyTree(src, dest) {
    mkdirp(dest);
    fs.readdirSync(src).forEach(function (name) {
        if (isJunk(name)) return;
        var s = path.join(src, name), d = path.join(dest, name), st = fs.lstatSync(s);
        if (st.isSymbolicLink()) throw new Error('Enlace simbólico en el paquete: ' + name);
        if (st.isDirectory()) copyTree(s, d);
        else if (st.isFile()) { fs.writeFileSync(d, fs.readFileSync(s)); fs.chmodSync(d, st.mode & 511); }
    });
}

/** Equivalente a «diff -r»: mismos archivos y mismo contenido. Devuelve null si coincide, o el motivo. */
function diffTrees(a, b) {
    var la = listTree(a), lb = listTree(b);
    if (la.join('\n') !== lb.join('\n')) return 'la lista de archivos no coincide';
    for (var i = 0; i < la.length; i++) {
        if (la[i].slice(-1) === '/') continue;
        if (sha256File(path.join(a, la[i])) !== sha256File(path.join(b, la[i]))) return 'difiere ' + la[i];
    }
    return null;
}

function readManifest(dir) {
    var text = fs.readFileSync(path.join(dir, 'CSXS', 'manifest.xml'), 'utf8');
    var id = /ExtensionBundleId="([^"]*)"/.exec(text);
    var ver = /ExtensionBundleVersion="([^"]*)"/.exec(text);
    return { id: id ? id[1] : null, version: ver ? ver[1] : null };
}

function checkRequired(dir) {
    var missing = [];
    REQUIRED_FILES.forEach(function (f) { if (!fs.existsSync(path.join(dir, f))) missing.push(f); });
    REQUIRED_DIRS.forEach(function (d) { var p = path.join(dir, d); if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) missing.push(d + '/'); });
    return missing;
}

// ------------------------------------------------------------ zip (unzip del sistema, validado antes y después)

function run(cmd, args) {
    return new Promise(function (resolve, reject) {
        childProcess.execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60000 }, function (err, stdout, stderr) {
            if (err) reject(new Error((stderr || err.message || 'Falló ' + cmd).toString().split('\n')[0])); else resolve(String(stdout));
        });
    });
}

/** Comprueba los nombres y los tipos del zip ANTES de extraer: sin «..», sin rutas absolutas, sin enlaces, todo dentro de com.binflow.organizer/. */
async function inspectZip(zipFile) {
    var names = (await run('/usr/bin/unzip', ['-Z1', zipFile])).split('\n').filter(Boolean);
    if (!names.length) throw new Error('El paquete está vacío.');
    names.forEach(function (n) {
        if (n.indexOf('\\') !== -1 || n.charAt(0) === '/' || /(^|\/)\.\.(\/|$)/.test(n) || /^[A-Za-z]:/.test(n) || n.indexOf('\0') !== -1) throw new Error('El paquete tiene una ruta no permitida: ' + n);
        var top = n.split('/')[0];
        if (top !== BUNDLE_DIR && top !== '__MACOSX') throw new Error('El paquete tiene archivos fuera de ' + BUNDLE_DIR + ': ' + n);
    });
    var long = (await run('/usr/bin/unzip', ['-Z', zipFile])).split('\n');
    long.forEach(function (line) {
        var c = line.charAt(0);
        if (c === 'l' || c === 'b' || c === 'c' || c === 'p' || c === 's') throw new Error('El paquete contiene enlaces o archivos especiales.');
    });
    return names;
}

// ------------------------------------------------------------ instalación

function stamp() { return String(Date.now()); }

/**
 * Instala la versión indicada. Solo con clic del usuario.
 * info = latest (de checkForUpdate). opts: { installDir (carpeta de la extensión en uso), currentVersion, allowUrl, onProgress, tmpRoot, hooks }
 * Devuelve { ok:true, version, backupDir } o lanza un Error con mensaje legible; en ese caso la versión instalada queda intacta.
 */
async function installUpdate(info, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    if (!info || !parseVersion(info.version) || !info.url || !/^[0-9a-f]{64}$/i.test(info.sha256 || '')) throw new Error('Los datos de la actualización no son válidos.');
    if ((opts.platform || process.platform) !== 'darwin') throw new Error('La actualización automática solo funciona en Mac por ahora. Instala la versión nueva a mano.');
    var installDir = opts.installDir ? path.resolve(opts.installDir) : null;
    if (!installDir || !fs.existsSync(installDir)) throw new Error('No encuentro la carpeta donde está instalado BinFlow.');
    if (fs.lstatSync(installDir).isSymbolicLink()) throw new Error('BinFlow está instalado como enlace (modo desarrollo); no se actualiza solo.');
    var parent = path.dirname(installDir);
    var current = readManifest(installDir);
    if (!current.id || !parseVersion(current.version)) throw new Error('No se puede leer la versión instalada.');
    var currentVersion = opts.currentVersion || current.version;
    if (compareVersions(info.version, currentVersion) !== 1) throw new Error('Ya tienes esta versión o una más nueva.');
    try { fs.accessSync(parent, fs.constants.W_OK); } catch (e) { throw new Error('No tengo permiso para escribir en la carpeta de extensiones.'); }

    var work = fs.mkdtempSync(path.join(opts.tmpRoot || os.tmpdir(), 'binflow-update-'));
    var staging = path.join(parent, '.' + path.basename(installDir) + '.nuevo.' + process.pid + '.' + stamp());
    var backup = path.join(parent, '.' + path.basename(installDir) + '.anterior.' + current.version + '.' + stamp());
    var swapped = false, movedOld = false;
    try {
        // 1) Descargar y comprobar sha256.
        progress('Descargando…');
        var zipFile = path.join(work, 'update.zip');
        var got = await download(info.url, zipFile, opts);
        if (got.sha256 !== String(info.sha256).toLowerCase()) throw new Error('La descarga no coincide con la huella esperada (sha256). No se ha instalado nada.');
        if (info.size && got.size !== info.size) throw new Error('La descarga no tiene el tamaño esperado. No se ha instalado nada.');

        // 2) Inspeccionar y extraer.
        progress('Comprobando el paquete…');
        await inspectZip(zipFile);
        var extractDir = path.join(work, 'x');
        mkdirp(extractDir);
        await run('/usr/bin/unzip', ['-q', '-o', zipFile, BUNDLE_DIR + '/*', '-d', extractDir]);
        var src = path.join(extractDir, BUNDLE_DIR);
        if (!fs.existsSync(src)) throw new Error('El paquete no contiene ' + BUNDLE_DIR + '.');
        listTree(src); // lanza si hay enlaces o archivos raros

        // 3) Validar contenido.
        var next = readManifest(src);
        if (next.id !== current.id) throw new Error('El paquete es de otra extensión (' + next.id + '). No se ha instalado.');
        if (next.version !== info.version) throw new Error('La versión del paquete (' + next.version + ') no coincide con la anunciada (' + info.version + ').');
        if (compareVersions(next.version, currentVersion) !== 1) throw new Error('El paquete no es más nuevo que la versión instalada.');
        var missing = checkRequired(src);
        if (missing.length) throw new Error('Al paquete le faltan archivos imprescindibles: ' + missing.join(', '));

        // 4) Copia a una carpeta temporal junto al destino y verificación (como instalar_plugin.sh).
        progress('Instalando…');
        copyTree(src, staging);
        var why = diffTrees(src, staging);
        if (why) throw new Error('La copia no es idéntica al paquete (' + why + '). No se ha cambiado nada.');

        // 5) Sustitución: la anterior solo se aparta, nunca se borra antes de tener la nueva en su sitio.
        fs.renameSync(installDir, backup); movedOld = true;
        if (opts.hooks && opts.hooks.afterBackup) opts.hooks.afterBackup();
        fs.renameSync(staging, installDir); swapped = true;
        if (opts.hooks && opts.hooks.afterSwap) opts.hooks.afterSwap();
        var check = readManifest(installDir);
        if (check.id !== current.id || check.version !== info.version || checkRequired(installDir).length) throw new Error('La instalación no quedó bien.');
    } catch (e) {
        // Vuelta atrás: la versión anterior vuelve a su sitio.
        try {
            if (swapped) { rmrf(installDir); }
            if (movedOld && !fs.existsSync(installDir)) fs.renameSync(backup, installDir);
        } catch (rb) {
            try { rmrf(work); } catch (ignore) {}
            throw new Error((e.message || String(e)) + ' Además no pude restaurar la versión anterior: está en «' + backup + '».');
        }
        try { rmrf(staging); } catch (ignore) {}
        try { rmrf(work); } catch (ignore) {}
        var err = new Error((e && e.message) || String(e));
        err.rolledBack = true;
        throw err;
    }
    try { rmrf(work); } catch (ignore) {}
    // Solo se conserva la copia de seguridad más reciente (la de esta actualización).
    try {
        fs.readdirSync(parent).forEach(function (n) {
            var full = path.join(parent, n);
            if (n.indexOf('.' + path.basename(installDir) + '.anterior.') === 0 && full !== backup) rmrf(full);
        });
    } catch (ignore) { /* limpieza opcional */ }
    return { ok: true, version: info.version, backupDir: backup };
}

module.exports = {
    LATEST_URL: LATEST_URL,
    compareVersions: compareVersions,
    allowUrl: allowUrl,
    parseLatest: parseLatest,
    checkForUpdate: checkForUpdate,
    installUpdate: installUpdate
};
