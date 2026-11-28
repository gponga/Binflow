/**
 * BinFlow engine — ejecución y deshacer por sesiones.
 *
 * Cada organización es una «sesión» en <proyecto>/LOG/<nombre.prproj>/sessions/<id>/:
 *   session.json   proyecto al que pertenece y estado (running, done, partial-undo, undone)
 *   journal.jsonl  write-ahead: antes de tocar un archivo se apunta su «intent» (origen, destino
 *                  y re-enlaces) con fsync; al terminar, la entrada de confirmación (move/copy/...).
 *                  Si el panel o Premiere se cuelgan a mitad, el intent permite reconciliar el disco.
 *   bins.json      movimientos de BIN (lo escribe ext.jsx)
 *   undone.json    operaciones ya deshechas (permite reintentar un deshacer a medias)
 * Deshacer siempre actúa sobre la última sesión no deshecha DEL MISMO .prproj.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var fsu = require('./fsutil');

function sessionsDir(logDir) { return path.join(logDir, 'sessions'); }

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJSON(file, data) {
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

function readJournal(dir) {
    var file = path.join(dir, 'journal.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(function (line) {
        try { return JSON.parse(line); } catch (e) { return null; }
    }).filter(Boolean);
}

/** Añade una línea al journal y la fuerza a disco (fsync) antes de seguir. */
function append(dir, entry) {
    var fd = fs.openSync(path.join(dir, 'journal.jsonl'), 'a');
    try {
        fs.writeSync(fd, JSON.stringify(entry) + '\n');
        try { fs.fsyncSync(fd); } catch (e) { if (e.code !== 'ENOTSUP' && e.code !== 'EINVAL') throw e; }
    } finally {
        fs.closeSync(fd);
    }
}

// Sesiones que este proceso tiene abiertas (no son «interrumpidas» aunque su estado sea running).
var active = {};

function journalError(e) {
    var err = new Error('No se puede escribir el registro de deshacer (' + (e.code || e.message) + '). Se ha detenido para no hacer cambios que no se puedan deshacer.');
    err.code = 'EJOURNAL';
    err.cause = e;
    return err;
}

/** Temporales propios (<dest>.<pid>-<hex8>.binflow-partial) que dejó una operación sobre dest. */
async function removePartials(dest) {
    var dir = path.dirname(dest), base = path.basename(dest), removed = [];
    var names;
    try { names = fs.readdirSync(dir); } catch (e) { return removed; }
    var re = /^\.\d+-[0-9a-f]{8}\.binflow-partial$/i;
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n.length <= base.length || n.slice(0, base.length) !== base || !re.test(n.slice(base.length))) continue;
        try {
            var full = path.join(dir, n);
            if (!fs.lstatSync(full).isFile()) continue;
            fs.unlinkSync(full);
            removed.push(full);
        } catch (ignore) {}
    }
    return removed;
}

/**
 * Reconcilia una operación de disco apuntada (intent) pero no confirmada: el proceso se cortó a mitad.
 * Devuelve { state: 'done' | 'none' | 'ambiguous', entry?, cleaned: [], message? }.
 *   done      la operación llegó a hacerse: se deshace como una confirmada.
 *   none      no llegó a hacerse; se limpian reservas vacías y temporales.
 *   ambiguous no se puede saber con seguridad: no se toca nada.
 */
async function reconcile(intent, meta) {
    var out = { state: 'none', cleaned: [] };
    if (!fsu.isWithin(intent.dest, meta.assetsDir)) return { state: 'ambiguous', cleaned: [], message: 'Ruta fuera de assets en el registro; no se toca: ' + intent.dest };
    out.cleaned = await removePartials(intent.dest);
    var st = function (p) { try { return fs.lstatSync(p); } catch (e) { return null; } };
    var s = st(intent.source), d = st(intent.dest);
    if (intent.kind === 'move') {
        if (!fsu.isWithin(intent.source, meta.projectFolder)) return { state: 'ambiguous', cleaned: out.cleaned, message: 'Ruta fuera del proyecto en el registro; no se toca: ' + intent.source };
        if (d && !s) { out.state = 'done'; out.entry = { type: 'move', source: intent.source, dest: intent.dest, op: intent.op, reconciled: true }; return out; }
        if (s && !d) return out;
        if (s && d) {
            if (s.ino === d.ino && s.dev === d.dev) { fs.unlinkSync(intent.dest); out.cleaned.push(intent.dest); return out; } // hardlink a medias
            if (d.isFile() && d.size === 0 && s.size > 0) { fs.unlinkSync(intent.dest); out.cleaned.push(intent.dest); return out; } // reserva vacía
            // N21: copia entre volúmenes publicada y verificada, pero el origen aún sin borrar: son idénticos.
            // El original está; la copia sobra y la operación se trata como «no llegó a hacerse».
            if (s.isFile() && d.isFile() && s.size === d.size) {
                var sameBytes = false;
                try { sameBytes = (await fsu.fingerprint(intent.source)).sha256 === (await fsu.fingerprint(intent.dest)).sha256; } catch (ignore) {}
                if (sameBytes) { fs.unlinkSync(intent.dest); out.cleaned.push(intent.dest); return out; }
            }
            return { state: 'ambiguous', cleaned: out.cleaned, message: 'El archivo está en los dos sitios y no son el mismo: ' + intent.dest };
        }
        return { state: 'ambiguous', cleaned: out.cleaned, message: 'No está ni en el origen ni en el destino: ' + intent.source };
    }
    if (intent.kind === 'copy') {
        if (!d) return out;
        if (d.isFile() && d.size === 0 && s && s.size > 0) { fs.unlinkSync(intent.dest); out.cleaned.push(intent.dest); return out; }
        var destSha = (await fsu.fingerprint(intent.dest)).sha256;
        var srcSha = null;
        try { if (s) srcSha = (await fsu.fingerprint(intent.source)).sha256; } catch (ignore) {}
        // Si el original ya no existe, la copia se trata como confirmada: el deshacer normal la conservará.
        if (!s || srcSha === destSha) { out.state = 'done'; out.entry = { type: 'copy', source: intent.source, dest: intent.dest, sha256: destSha, op: intent.op, reconciled: true }; return out; }
        return { state: 'ambiguous', cleaned: out.cleaned, message: 'La copia no coincide con el original: ' + intent.dest };
    }
    return out; // duplicate / relink: no hubo cambio de disco
}

/**
 * Nombres de sesión de más antigua a más reciente. N13: el orden lo da el contador `seq` de session.json,
 * no el reloj (con el reloj atrás, el nombre con la fecha ya no sirve). Las sesiones antiguas sin `seq`
 * cuentan como 0 y se ordenan entre sí por nombre.
 */
function orderedSessions(logDir) {
    var dir = sessionsDir(logDir);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(function (n) { return n.charAt(0) !== '.'; }).map(function (n) {
        var meta = readJSON(path.join(dir, n, 'session.json'), null);
        return { name: n, dir: path.join(dir, n), meta: meta, seq: meta && Number(meta.seq) > 0 ? Number(meta.seq) : 0 };
    }).sort(function (a, b) { return a.seq - b.seq || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
}

/** Crea la carpeta de sesión. Se borra al final si no se hizo nada. */
async function createSession(plan) {
    var seq = orderedSessions(plan.logDir).reduce(function (m, x) { return Math.max(m, x.seq); }, 0) + 1;
    var id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    var dir = path.join(sessionsDir(plan.logDir), id);
    await fsu.mkdirp(dir);
    writeJSON(path.join(dir, 'session.json'), {
        id: id, seq: seq, status: 'running', pid: process.pid, createdAt: new Date().toISOString(), engine: plan.engineVersion,
        projectPath: plan.projectPath, projectFolder: plan.projectFolder, assetsDir: plan.assetsDir
    });
    active[dir] = true;
    return { id: id, dir: dir };
}

/**
 * Ejecuta las operaciones de disco del plan dentro de una sesión.
 * Devuelve { relinks: [{nodeId, from, to}], done, errors, sessionDir, copiedBytes }.
 */
async function execute(plan, progress, session, signal) {
    if (!plan || plan.blocked) throw new Error(plan && plan.blockReason ? plan.blockReason : 'Plan bloqueado.');
    progress = progress || function () {};
    session = session || await createSession(plan);
    var result = { relinks: [], done: [], errors: [], sessionDir: session.dir, copiedBytes: 0 };
    var sourceDirs = [];
    var ops = plan.ops.filter(function (op) { return op.type !== 'none'; });

    // Orígenes aún pendientes: un destino «idéntico» que todavía se va a mover no se puede reutilizar.
    var pending = {};
    ops.forEach(function (op) { if (op.type === 'move') pending[fsu.key(op.source)] = (pending[fsu.key(op.source)] || 0) + 1; });
    var avoid = function (p) { return !!pending[fsu.key(p)]; };

    for (var i = 0; i < ops.length; i++) {
        var op = ops[i];
        if (signal && signal.cancelled && !result.aborted) { result.cancelled = true; result.aborted = 'Cancelado por el usuario.'; }
        if (result.aborted) {
            result.errors.push({ source: op.source, dest: op.dest, message: result.cancelled ? 'No se hizo: cancelado.' : 'No se hizo: se detuvo porque no se puede escribir el registro de deshacer.', skipped: true });
            continue;
        }
        progress(i + 1, ops.length, (op.type === 'copy' ? 'Copiando ' : 'Organizando ') + path.basename(op.source));
        var intentWritten = false;
        try {
            var finalDest = op.dest, kind = null, choice = null;
            if (op.type === 'move' || op.type === 'copy') {
                if (!fsu.isWithin(op.dest, plan.assetsDir)) throw new Error('Destino fuera de assets: ' + op.dest);
                // N18: primero se valida (resuelve enlaces simbólicos aunque la carpeta aún no exista), después se crea.
                await fsu.assertInside(path.dirname(op.dest), plan.projectFolder, 'El destino');
                await fsu.mkdirp(path.dirname(op.dest));
            }
            if (op.type === 'move') {
                if (!fsu.isWithin(op.source, plan.projectFolder)) throw new Error('Origen fuera del proyecto: ' + op.source);
                await fsu.assertInside(path.dirname(op.source), plan.projectFolder, 'El origen');
                if (!(await fsu.exists(op.source))) throw new Error('El origen ya no existe.');
                choice = await fsu.chooseDestination(op.source, path.dirname(op.dest), path.basename(op.dest), avoid);
                finalDest = choice.path;
                // Ya hay una copia idéntica en destino: el original se deja donde está (no se borra nada).
                kind = choice.same ? 'relink' : (choice.identical ? 'duplicate' : 'move');
            } else if (op.type === 'copy') {
                choice = await fsu.chooseDestination(op.source, path.dirname(op.dest), path.basename(op.dest), avoid);
                finalDest = choice.path;
                kind = choice.identical ? 'duplicate' : 'copy';
            } else if (op.type === 'keep') {
                finalDest = op.source;
            } else {
                kind = 'relink';
            }
            var relinks = op.type === 'keep' || op.noRelink ? [] : (op.nodeIds || []).map(function (nodeId) {
                return { nodeId: nodeId, from: op.relinkFrom === undefined ? op.source : op.relinkFrom, to: finalDest };
            });

            // 1) Write-ahead: sin intent en disco no se toca nada.
            if (kind && (kind === 'move' || kind === 'copy' || relinks.length)) {
                try {
                    append(session.dir, { type: 'intent', op: i, kind: kind, source: op.source, dest: finalDest, relinks: relinks.map(function (r) { return { nodeId: r.nodeId, from: r.from }; }) });
                } catch (je) { throw journalError(je); }
                intentWritten = true;
            }

            // 2) La operación.
            var entry = null;
            if (kind === 'duplicate') {
                entry = { type: 'duplicate', source: op.source, dest: finalDest };
            } else if (kind === 'move') {
                var moved = await fsu.moveFile(op.source, finalDest, signal);
                entry = { type: 'move', source: op.source, dest: finalDest, method: moved.method, size: moved.size };
                sourceDirs.push(path.dirname(op.source));
            } else if (kind === 'copy') {
                var fp = await fsu.copyVerified(op.source, finalDest, signal);
                entry = { type: 'copy', source: op.source, dest: finalDest, sha256: fp.sha256, size: fp.size };
                result.copiedBytes += fp.size;
            }

            // 3) Confirmación. Si falla, lo hecho ya está cubierto por el intent: Premiere se re-enlaza igual
            //    (si no, el medio quedaría desconectado) y se detiene el resto.
            try {
                if (entry) { entry.op = i; append(session.dir, entry); }
                relinks.forEach(function (r) { append(session.dir, { type: 'relink', nodeId: r.nodeId, from: r.from, to: r.to, op: i }); });
            } catch (ce) {
                var jerr = journalError(ce);
                result.aborted = jerr.message;
                result.errors.push({ source: op.source, dest: finalDest, message: jerr.message, journal: true });
            }
            relinks.forEach(function (r) { result.relinks.push(r); });
            if (op.type === 'move' && pending[fsu.key(op.source)]) pending[fsu.key(op.source)]--;
            result.done.push({ type: entry ? entry.type : op.type, reason: op.reason, source: op.source, dest: finalDest, size: op.size, manual: !!op.manual });
        } catch (e) {
            if (op.type === 'move' && pending[fsu.key(op.source)]) pending[fsu.key(op.source)]--;
            if (e.code === 'EJOURNAL') result.aborted = e.message;
            if (e.code === 'ECANCELED') { result.cancelled = true; result.aborted = 'Cancelado por el usuario.'; e.skipped = true; }
            if (e.code !== 'EJOURNAL' && intentWritten) { try { append(session.dir, { type: 'failed', op: i }); } catch (ignore) {} }
            result.errors.push({ source: op.source, dest: op.dest, message: e.code === 'ECANCELED' ? 'No se hizo: cancelado.' : (e.message || String(e)), journal: e.code === 'EJOURNAL', skipped: e.code === 'ECANCELED' });
        }
    }

    progress(ops.length, ops.length, 'Limpiando carpetas vacías');
    await fsu.pruneEmptyDirs(sourceDirs, plan.projectFolder);
    return result;
}

/** Cierra la sesión: si no cambió nada se elimina (así no tapa un deshacer anterior). */
function finalizeSession(sessionDir, info) {
    info = info || {};
    var journal = readJournal(sessionDir);
    var bins = readJSON(path.join(sessionDir, 'bins.json'), { entries: [] });
    delete active[sessionDir];
    var diskChanges = journal.filter(function (e) { return e.type === 'move' || e.type === 'copy'; }).length;
    var unconfirmed = pendingIntents(journal).length;
    var relinkChanges = journal.filter(function (e) { return e.type === 'relink' && e.from && fsu.key(e.from) !== fsu.key(e.to); }).length;
    var binChanges = (bins.entries || []).length;
    if (!diskChanges && !relinkChanges && !binChanges && !unconfirmed) {
        fs.readdirSync(sessionDir).forEach(function (n) { fs.unlinkSync(path.join(sessionDir, n)); });
        fs.rmdirSync(sessionDir);
        return { empty: true };
    }
    var meta = readJSON(path.join(sessionDir, 'session.json'), {});
    meta.status = 'done';
    meta.finishedAt = new Date().toISOString();
    meta.premiereError = info.premiereError || null;
    meta.counts = { disk: diskChanges, relinks: relinkChanges, bins: binChanges, unconfirmed: unconfirmed };
    writeJSON(path.join(sessionDir, 'session.json'), meta);
    return { empty: false, counts: meta.counts };
}

/** Intents de disco sin confirmación ni fallo registrado. */
function pendingIntents(journal) {
    var closed = {};
    journal.forEach(function (e) { if (e.type === 'move' || e.type === 'copy' || e.type === 'duplicate' || e.type === 'failed') closed[e.op] = true; });
    return journal.filter(function (e) { return e.type === 'intent' && (e.kind === 'move' || e.kind === 'copy') && !closed[e.op]; });
}

/**
 * Sesiones de ese .prproj que se quedaron a medias (el panel o Premiere se cerraron organizando).
 * Las abiertas por este mismo proceso no cuentan.
 */
function findInterrupted(logDir, projectPath) {
    return orderedSessions(logDir).map(function (x) {
        var sdir = x.dir, meta = x.meta;
        if (!meta || meta.status !== 'running' || active[sdir]) return null;
        if (projectPath && fsu.key(meta.projectPath || '') !== fsu.key(projectPath)) return null;
        return { dir: sdir, meta: meta };
    }).filter(Boolean);
}

/**
 * N7: no se fía de session.json. Las rutas que usa Deshacer deben poder deducirse del propio .prproj:
 *   projectFolder = carpeta del .prproj o la superior (opción «organizar desde la carpeta superior»)
 *   assetsDir     = hija directa de projectFolder
 *   la sesión     = dentro del LOG de ese .prproj, también tras resolver enlaces simbólicos
 */
async function validateSession(sessionDir, logDir, meta, projectPath) {
    var bad = function (why) { throw new Error('La sesión de deshacer no corresponde a este proyecto (' + why + '); no se toca nada.'); };
    if (!meta.projectFolder || !meta.assetsDir) bad('faltan datos');
    var own = path.dirname(path.resolve(projectPath));
    var folder = path.resolve(meta.projectFolder);
    if (fsu.key(folder) !== fsu.key(own) && fsu.key(folder) !== fsu.key(path.dirname(own))) bad('carpeta de proyecto inesperada');
    if (require('./plan').isUnsafeRoot(folder)) bad('carpeta de proyecto no permitida');
    if (fsu.key(path.dirname(path.resolve(meta.assetsDir))) !== fsu.key(folder)) bad('carpeta de assets inesperada');
    var realLog = await fsu.realDir(logDir), realSession = await fsu.realDir(sessionDir);
    if (!fsu.isWithin(realSession, realLog)) bad('la sesión está fuera del LOG');
    await fsu.assertInside(meta.assetsDir, folder, 'La carpeta de assets');
}

/** Última sesión que se puede deshacer para ese .prproj (o null). */
function latestSession(logDir, projectPath) {
    var all = orderedSessions(logDir).reverse();
    for (var i = 0; i < all.length; i++) {
        var sdir = all[i].dir, meta = all[i].meta;
        if (!meta) continue;
        if (meta.status === 'undone') continue;
        if (projectPath && fsu.key(meta.projectPath || '') !== fsu.key(projectPath)) continue;
        return { dir: sdir, meta: meta };
    }
    return null;
}

/**
 * Deshace los cambios de disco de la última sesión de ese proyecto.
 * Solo devuelve re-enlaces de los archivos que realmente han vuelto a su sitio.
 * Lo que falla queda pendiente y se puede reintentar.
 */
async function undo(logDir, projectPath) {
    if (!logDir || !projectPath) throw new Error('Falta el proyecto para deshacer.');
    var session = latestSession(logDir, projectPath);
    if (!session) throw new Error('No hay una organización que deshacer en este proyecto.');
    var meta = session.meta;
    await validateSession(session.dir, logDir, meta, projectPath);
    fsu.setCaseSensitive(fsu.detectCaseSensitive(meta.projectFolder));

    var journal = readJournal(session.dir);
    var undoneFile = path.join(session.dir, 'undone.json');
    var undone = readJSON(undoneFile, { ops: [] });
    var undoneSet = {};
    undone.ops.forEach(function (n) { undoneSet[n] = true; });

    var restored = 0, failed = [], dirs = [], kept = [], cleaned = [];
    var opStatus = {}; // op → true (de vuelta) | false (falló) | 'kept' | 'none' (nunca llegó a hacerse)
    var diskEntries = journal.filter(function (e) { return e.type === 'move' || e.type === 'copy'; });

    // Operaciones cortadas a mitad (cuelgue): se reconcilian con lo que hay en disco.
    var intents = pendingIntents(journal);
    for (var k = 0; k < intents.length; k++) {
        var it = intents[k];
        if (undoneSet[it.op]) { opStatus[it.op] = true; continue; }
        try {
            var rec = await reconcile(it, meta);
            cleaned = cleaned.concat(rec.cleaned);
            if (rec.state === 'done') diskEntries.push(rec.entry);
            else if (rec.state === 'none') { opStatus[it.op] = 'none'; undoneSet[it.op] = true; }
            else { opStatus[it.op] = false; failed.push({ path: it.dest, message: rec.message }); }
        } catch (re) {
            opStatus[it.op] = false;
            failed.push({ path: it.dest, message: re.message || String(re) });
        }
    }
    diskEntries.sort(function (a, b) { return b.op - a.op; });
    for (var i = 0; i < diskEntries.length; i++) {
        var e = diskEntries[i];
        if (undoneSet[e.op]) { opStatus[e.op] = true; continue; }
        try {
            if (!fsu.isWithin(e.dest, meta.assetsDir)) throw new Error('Ruta fuera de assets en el registro; no se toca: ' + e.dest);
            if (e.type === 'move') {
                if (!fsu.isWithin(e.source, meta.projectFolder)) throw new Error('Ruta fuera del proyecto en el registro; no se toca: ' + e.source);
                if (!(await fsu.exists(e.dest))) throw new Error('Ya no está en ' + e.dest);
                await fsu.assertInside(path.dirname(e.source), meta.projectFolder, 'El origen');
                await fsu.moveFile(e.dest, e.source);
            } else if (await fsu.exists(e.dest)) {
                var fp = await fsu.fingerprint(e.dest);
                if (fp.sha256 !== e.sha256) throw new Error('La copia se ha modificado desde entonces; no se borra: ' + e.dest);
                // Solo se borra la copia si el original externo sigue existiendo y es idéntico:
                // si el usuario borró el original, la copia del proyecto es la única que queda.
                var originalOk = false;
                try { originalOk = (await fsu.exists(e.source)) && (await fsu.fingerprint(e.source)).sha256 === e.sha256; } catch (ignore) {}
                if (!originalOk) {
                    kept.push({ path: e.dest, original: e.source });
                    undoneSet[e.op] = true;      // resuelto: no se reintenta
                    opStatus[e.op] = 'kept';     // y Premiere sigue apuntando a la copia
                    continue;
                }
                await fsu.unlink(e.dest);
            }
            dirs.push(path.dirname(e.dest));
            undoneSet[e.op] = true;
            opStatus[e.op] = true;
            restored++;
        } catch (err) {
            opStatus[e.op] = false;
            failed.push({ path: e.dest, message: err.message || String(err) });
        }
    }
    await fsu.pruneEmptyDirs(dirs, meta.projectFolder);
    writeJSON(undoneFile, { ops: Object.keys(undoneSet).map(Number) });

    // Re-enlaces de vuelta solo si su archivo volvió (o si no hubo cambio de disco para esa operación).
    // Si la confirmación no llegó al journal, los re-enlaces salen del intent.
    var relinks = [], skipped = 0, withRelinkEntries = {};
    var relinkEntries = journal.filter(function (r) { return r.type === 'relink' && r.from; });
    relinkEntries.forEach(function (r) { withRelinkEntries[r.op] = true; });
    journal.forEach(function (e) {
        if (e.type === 'intent' && !withRelinkEntries[e.op]) (e.relinks || []).forEach(function (r) { if (r.from) relinkEntries.push({ nodeId: r.nodeId, from: r.from, to: e.dest, op: e.op }); });
    });
    relinkEntries.forEach(function (r) {
        if (opStatus[r.op] === false) { skipped++; return; }
        if (opStatus[r.op] === 'kept' || opStatus[r.op] === 'none') return;
        relinks.push({ nodeId: r.nodeId, path: r.from, current: r.to });
    });
    return { sessionDir: session.dir, relinks: relinks, restored: restored, failed: failed, kept: kept, cleaned: cleaned, relinksSkipped: skipped, createdAt: meta.createdAt, interrupted: meta.status === 'running' };
}

/** Entradas de disco (move/copy) confirmadas en los journals de todas las sesiones de ese LOG. */
function sessionJournalEntries(logDir) {
    var out = [];
    orderedSessions(logDir).forEach(function (s) {
        readJournal(s.dir).forEach(function (e) { if (e.type === 'move' || e.type === 'copy') out.push(e); });
    });
    return out;
}

/** Marca la sesión como deshecha si disco y Premiere terminaron bien; si no, queda para reintentar. */
function completeUndo(sessionDir, info) {
    info = info || {};
    var meta = readJSON(path.join(sessionDir, 'session.json'), {});
    meta.status = info.ok ? 'undone' : 'partial-undo';
    meta.undoneAt = new Date().toISOString();
    writeJSON(path.join(sessionDir, 'session.json'), meta);
    return meta.status;
}

module.exports = {
    createSession: createSession,
    execute: execute,
    finalizeSession: finalizeSession,
    latestSession: latestSession,
    findInterrupted: findInterrupted,
    undo: undo,
    completeUndo: completeUndo,
    sessionJournalEntries: sessionJournalEntries
};
