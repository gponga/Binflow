/**
 * BinFlow engine — utilidades de disco.
 * Node puro (compatible con el Node de CEP 9+: sin fs.promises ni mkdir recursivo).
 * Ninguna operación sobrescribe un archivo existente.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

/** Versión con promesa de fs[name]; se resuelve en cada llamada (permite simular fallos en pruebas). */
function promisify(name) {
    return function () {
        var args = Array.prototype.slice.call(arguments);
        return new Promise(function (resolve, reject) {
            args.push(function (err, value) { if (err) reject(err); else resolve(value); });
            fs[name].apply(fs, args);
        });
    };
}

var stat = promisify('stat');
var lstat = promisify('lstat');
var readdir = promisify('readdir');
var rename = promisify('rename');
var link = promisify('link');
var unlink = promisify('unlink');
var rmdir = promisify('rmdir');
var mkdir = promisify('mkdir');
var copyFile = promisify('copyFile');
var utimes = promisify('utimes');

var PLATFORM_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';
var CASE_INSENSITIVE = PLATFORM_INSENSITIVE;

/** Fuerza (true/false) o restablece (null/undefined) la distinción de mayúsculas del volumen de trabajo. */
function setCaseSensitive(value) {
    CASE_INSENSITIVE = value === true ? false : (value === false ? true : PLATFORM_INSENSITIVE);
}

/**
 * Comprueba si la carpeta está en un volumen que distingue mayúsculas (p. ej. APFS con distinción).
 * N28: prueba hasta 5 nombres (solo letras ASCII, para no confundirse con ß o acentos) y exige que
 * todos coincidan. Para cada nombre, la variante con las mayúsculas invertidas:
 *   - no existe → el volumen distingue;
 *   - existe y es el mismo archivo (mismo inodo) → no distingue;
 *   - existe y es otro archivo → distingue (dos archivos que solo se diferencian en mayúsculas).
 * Devuelve true / false, o null si no se puede saber o hay dudas (se usa el valor de la plataforma).
 */
function detectCaseSensitive(dir) {
    try {
        var names = fs.readdirSync(dir), votes = [];
        for (var i = 0; i < names.length && votes.length < 5; i++) {
            var n = names[i];
            var swapped = n.replace(/[A-Za-z]/g, function (c) { return c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(); });
            if (swapped === n) continue;
            var a = fs.lstatSync(path.join(dir, n)), b;
            try { b = fs.lstatSync(path.join(dir, swapped)); }
            catch (e) { if (e.code === 'ENOENT') { votes.push(true); continue; } return null; }
            votes.push(!(a.ino === b.ino && a.dev === b.dev));
        }
        if (!votes.length) return null;
        return votes.every(function (v) { return v === votes[0]; }) ? votes[0] : null;
    } catch (e) { return null; }
}

/** Clave de comparación: ruta absoluta, NFC (macOS guarda NFD) y sin mayúsculas si el FS no las distingue. */
function key(p) {
    var resolved = path.resolve(String(p)).normalize('NFC');
    return CASE_INSENSITIVE ? resolved.toLowerCase() : resolved;
}

function nameKey(name) {
    var n = String(name).normalize('NFC');
    return CASE_INSENSITIVE ? n.toLowerCase() : n;
}

function isWithin(child, parent) {
    var c = key(child), p = key(parent);
    if (c === p) return true;
    var sep = path.sep;
    return c.indexOf(p.slice(-1) === sep ? p : p + sep) === 0;
}

function exists(p) {
    return lstat(p).then(function () { return true; }, function (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
        throw e;
    });
}

function eexist(p) {
    var e = new Error('Ya existe: ' + p);
    e.code = 'EEXIST';
    return e;
}

async function mkdirp(dir) {
    try {
        await mkdir(dir);
    } catch (e) {
        if (e.code === 'EEXIST') {
            var s = await stat(dir);
            if (!s.isDirectory()) throw e;
            return;
        }
        if (e.code !== 'ENOENT') throw e;
        var parent = path.dirname(dir);
        if (parent === dir) throw e;
        await mkdirp(parent);
        try { await mkdir(dir); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; }
    }
}

var hashCache = {};

/** Error de cancelación pedida por el usuario (signal = { cancelled: bool }). */
function cancelledError() {
    var e = new Error('Cancelado por el usuario.');
    e.code = 'ECANCELED';
    return e;
}
function checkCancel(signal) { if (signal && signal.cancelled) throw cancelledError(); }

function sha256(file, signal) {
    return new Promise(function (resolve, reject) {
        var hash = crypto.createHash('sha256');
        var stream = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
        stream.on('error', reject);
        stream.on('data', function (chunk) {
            if (signal && signal.cancelled) { stream.destroy(); reject(cancelledError()); return; }
            hash.update(chunk);
        });
        stream.on('end', function () { resolve(hash.digest('hex')); });
    });
}

/** Huella {size, sha256} con caché por ruta+tamaño+mtime. */
async function fingerprint(file, signal) {
    var s = await stat(file);
    var cacheKey = key(file) + '|' + s.size + '|' + s.mtime.getTime();
    if (!hashCache[cacheKey]) hashCache[cacheKey] = { size: s.size, sha256: await sha256(file, signal) };
    return hashCache[cacheKey];
}

/** Copia por bloques que se puede cortar entre bloque y bloque. El destino se crea en exclusiva. */
function streamCopy(source, dest, signal) {
    return new Promise(function (resolve, reject) {
        var done = false;
        function fail(e) { if (done) return; done = true; rs.destroy(); ws.destroy(); reject(e); }
        var rs = fs.createReadStream(source, { highWaterMark: 8 * 1024 * 1024 });
        var ws = fs.createWriteStream(dest, { flags: 'wx' });
        rs.on('error', fail);
        ws.on('error', fail);
        rs.on('data', function () { if (signal.cancelled) fail(cancelledError()); });
        ws.on('close', function () { if (!done) { done = true; resolve(); } });
        rs.pipe(ws);
    });
}

async function sameContent(a, b) {
    var sa = await stat(a), sb = await stat(b);
    if (sa.size !== sb.size) return false;
    if (sa.ino && sa.ino === sb.ino && sa.dev === sb.dev) return true;
    return (await fingerprint(a)).sha256 === (await fingerprint(b)).sha256;
}

/**
 * Elige destino sin pisar nada. Si ya hay un archivo idéntico lo reutiliza;
 * si hay otro distinto añade __<hash10>.
 * avoid(path) → true marca rutas ocupadas que no se pueden reutilizar (p. ej. origen de otra operación pendiente).
 */
async function chooseDestination(source, destDir, name, avoid) {
    avoid = avoid || function () { return false; };
    var base = name || path.basename(source);
    var dest = path.join(destDir, base);
    if (!(await exists(dest))) return { path: dest, identical: false };
    if (key(dest) === key(source)) return { path: dest, identical: true, same: true };
    if (!avoid(dest) && (await lstat(dest)).isFile() && await sameContent(source, dest)) return { path: dest, identical: true };
    var ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
    var digest = (await fingerprint(source)).sha256.slice(0, 10);
    var counter = 1;
    for (;;) {
        var candidate = path.join(destDir, stem + '__' + digest + (counter > 1 ? '_' + counter : '') + ext);
        if (!(await exists(candidate))) return { path: candidate, identical: false };
        if (!avoid(candidate) && (await lstat(candidate)).isFile() && await sameContent(source, candidate)) return { path: candidate, identical: true };
        counter++;
    }
}

function tempName(dest) {
    return dest + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.binflow-partial';
}

/** Reserva el nombre creando un archivo vacío en exclusiva: falla si ya existe. */
function reserve(dest) {
    return new Promise(function (resolve, reject) {
        fs.open(dest, 'wx', function (err, fd) {
            if (err) { reject(err.code === 'EEXIST' ? eexist(dest) : err); return; }
            fs.close(fd, function () { resolve(); });
        });
    });
}

/** Fuerza a disco el contenido de un archivo (fsync). Los sistemas que no lo admiten no son un error. */
function fsyncFile(file) {
    var fd = fs.openSync(file, 'r+');
    try {
        try { fs.fsyncSync(fd); } catch (e) { if (e.code !== 'ENOTSUP' && e.code !== 'EINVAL') throw e; }
    } finally { fs.closeSync(fd); }
}

/** Copia a un temporal único, verifica SHA-256 y publica sin sobrescribir. */
async function copyVerified(source, dest, signal) {
    await mkdirp(path.dirname(dest));
    if (await exists(dest)) throw eexist(dest);
    var tmp = tempName(dest);
    var before = await fingerprint(source, signal);
    try {
        // Con signal se copia por bloques para poder cancelar a mitad de un archivo grande.
        if (signal) await streamCopy(source, tmp, signal);
        else await copyFile(source, tmp, fs.constants.COPYFILE_EXCL);
        var s = await stat(source);
        try { await utimes(tmp, s.atime, s.mtime); } catch (ignore) { /* sin fechas no es crítico */ }
        var copied = await sha256(tmp, signal);
        var after = await fingerprint(source, signal);
        if (copied !== before.sha256 || after.sha256 !== before.sha256) throw new Error('La copia no coincide con el original: ' + source);
        checkCancel(signal);
        fsyncFile(tmp); // N22: el contenido está en disco antes de que el destino exista con su nombre definitivo
        await publish(tmp, dest);
    } catch (e) {
        if (await exists(tmp)) await unlink(tmp);
        throw e;
    }
    return before;
}

/**
 * Publica tmp en dest sin sobrescribir nunca.
 * Con hardlinks: link() es atómico y falla si dest existe.
 * Sin hardlinks (exFAT, FAT, SMB): se reserva dest en exclusiva ('wx') y solo entonces
 * se renombra encima de esa reserva, que es nuestra.
 */
async function publish(tmp, dest) {
    try {
        await link(tmp, dest);
        await unlink(tmp);
        return;
    } catch (e) {
        if (e.code === 'EEXIST') throw eexist(dest);
    }
    await reserve(dest);
    try {
        await rename(tmp, dest);
    } catch (e2) {
        await unlink(dest).catch(function () {});
        throw e2;
    }
}

/** Mueve sin sobrescribir; entre volúmenes, copia verificada + borrado. */
async function moveFile(source, dest, signal) {
    await mkdirp(path.dirname(dest));
    if (await exists(dest)) throw eexist(dest);
    var before = await stat(source);
    var linked = false;
    try {
        await link(source, dest);
        linked = true;
    } catch (e) {
        if (e.code === 'EEXIST') throw eexist(dest);
        if (e.code === 'EXDEV') return moveAcrossDevices(source, dest, signal);
    }
    if (linked) {
        var info = await stat(dest);
        if (info.ino !== before.ino || info.size !== before.size) {
            await unlink(dest);
            throw new Error('El archivo movido no se pudo verificar: ' + dest);
        }
        try {
            await unlink(source);
        } catch (unlinkError) {
            // No dejar el archivo en dos sitios: se retira el enlace recién creado.
            await unlink(dest).catch(function () {});
            throw unlinkError;
        }
        return { method: 'link', size: before.size };
    }
    // Sin hardlinks: reserva exclusiva + rename sobre la reserva (nunca sobre un archivo ajeno).
    await reserve(dest);
    try {
        await rename(source, dest);
    } catch (e2) {
        await unlink(dest).catch(function () {});
        if (e2.code === 'EXDEV') return moveAcrossDevices(source, dest, signal);
        throw e2;
    }
    var renamed = await stat(dest);
    if (renamed.size !== before.size) throw new Error('El archivo movido no se pudo verificar: ' + dest);
    return { method: 'rename', size: before.size };
}

async function moveAcrossDevices(source, dest, signal) {
    var fp = await copyVerified(source, dest, signal);
    try {
        fsyncFile(dest); // N22: nunca se borra el origen hasta que el destino esté en disco
        await unlink(source);
    } catch (e) {
        await unlink(dest).catch(function () {});
        throw e;
    }
    return { method: 'copy+delete', size: fp.size, sha256: fp.sha256 };
}

var realpathAsync = promisify('realpath');

/** Ruta real del directorio existente más cercano (resuelve enlaces simbólicos). */
async function realDir(dir) {
    var current = path.resolve(dir);
    var rest = [];
    for (;;) {
        try {
            var real = await realpathAsync(current);
            return rest.length ? path.join.apply(path, [real].concat(rest.reverse())) : real;
        } catch (e) {
            if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
            var parent = path.dirname(current);
            if (parent === current) throw e;
            rest.push(path.basename(current));
            current = parent;
        }
    }
}

/** Lanza si dir (resolviendo enlaces) no queda dentro de root (también resuelto). */
async function assertInside(dir, root, label) {
    var realRoot = await realDir(root), realTarget = await realDir(dir);
    if (!isWithin(realTarget, realRoot)) {
        var e = new Error((label || 'La ruta') + ' sale de la carpeta del proyecto (enlace simbólico): ' + dir);
        e.code = 'EOUTSIDE';
        throw e;
    }
}

/**
 * Recorre una carpeta sin seguir enlaces simbólicos.
 * skipDir(name, fullPath) y skipFile(name, fullPath) deciden qué se ignora.
 */
async function walk(root, skipDir, skipFile, limit, errors) {
    var files = [];
    errors = errors || [];
    var stack = [root];
    while (stack.length) {
        var dir = stack.pop();
        var entries;
        try { entries = await readdir(dir); } catch (e) { errors.push({ path: dir, code: e.code, message: e.message }); continue; }
        for (var i = 0; i < entries.length; i++) {
            var name = entries[i];
            var full = path.join(dir, name);
            var info;
            try { info = await lstat(full); } catch (e) { errors.push({ path: full, code: e.code, message: e.message }); continue; }
            if (info.isSymbolicLink()) continue;
            if (info.isDirectory()) {
                if (!skipDir(name, full)) stack.push(full);
            } else if (info.isFile()) {
                if (skipFile(name, full)) continue;
                files.push({ path: full, name: name, size: info.size, mtime: info.mtime.getTime() });
                if (limit && files.length > limit) {
                    var err = new Error('Demasiados archivos (más de ' + limit + ').');
                    err.code = 'ETOOMANY';
                    throw err;
                }
            }
        }
    }
    return files;
}

/** Borra carpetas que se han quedado vacías (o solo con .DS_Store) subiendo hasta stopAt. */
async function pruneEmptyDirs(dirs, stopAt) {
    var sorted = dirs.slice().sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < sorted.length; i++) {
        var dir = sorted[i];
        while (dir && isWithin(dir, stopAt) && key(dir) !== key(stopAt)) {
            var entries;
            try { entries = await readdir(dir); } catch (e) { break; }
            if (entries.length === 1 && entries[0] === '.DS_Store') {
                try { await unlink(path.join(dir, '.DS_Store')); entries = []; } catch (e) { break; }
            }
            if (entries.length) break;
            try { await rmdir(dir); } catch (e) { break; }
            dir = path.dirname(dir);
        }
    }
}

module.exports = {
    key: key,
    nameKey: nameKey,
    setCaseSensitive: setCaseSensitive,
    detectCaseSensitive: detectCaseSensitive,
    fsyncFile: fsyncFile,
    isWithin: isWithin,
    exists: exists,
    mkdirp: mkdirp,
    sha256: sha256,
    fingerprint: fingerprint,
    chooseDestination: chooseDestination,
    copyVerified: copyVerified,
    moveFile: moveFile,
    walk: walk,
    pruneEmptyDirs: pruneEmptyDirs,
    realDir: realDir,
    assertInside: assertInside,
    stat: stat,
    unlink: unlink,
    cancelledError: cancelledError
};
