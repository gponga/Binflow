/**
 * BinFlow engine — planificación (solo lectura).
 *
 * Entrada: snapshot del proyecto que genera ext.jsx (gpOrganizer.getProjectSnapshot).
 * Salida: plan con las operaciones de disco, el BIN destino de cada ítem y las incidencias.
 *
 * Reglas:
 *  R1  Todo archivo de la carpeta del proyecto se conserva, aunque el proyecto no lo use.
 *  R2  Los archivos sin uso se quedan con su grupo, junto a su versión usada (fuente: logo.psd ↔ logo.png)
 *      o van a <assets>/_No usados/<categoría>/.
 *  R3  Un BIN con ≥80 % de un tipo se conserva entero: BIN Videos/Brutos/... ↔ disco <assets>/Videos/Brutos/...
 */
'use strict';

var path = require('path');
var os = require('os');
var fs = require('fs');
var zlib = require('zlib');
var childProcess = require('child_process');
var fsu = require('./fsutil');

var SEQUENCES = '_Secuencias';
var EMPTY_BIN = '(Carpetas Vacias)';
var OTHERS = 'Z_Others';
var UNUSED_DIR = '_No usados';
var DOMINANCE = 0.8;
var MAX_FILES = 50000;

var SKIP_DIRS = [
    'adobe premiere pro auto-save', 'adobe premiere pro video previews', 'adobe premiere pro audio previews',
    'adobe premiere pro preview files', 'media cache', 'media cache files', 'peak files', 'premieretemp',
    'capture audio', 'capture video', 'premiere composer files',
    'log', 'logs', '_final', '_finales', '_previo', '_previos', 'exportaciones'
];
var SKIP_EXTENSIONS = ['prproj', 'pek', 'cfa', 'prv', 'ims', 'mcdb', 'pkf'];
// Archivos de trabajo que suelen exportarse a otro formato (logo.psd → logo.png): regla «fuente».
var SOURCE_EXTENSIONS = ['psd', 'psb', 'ai', 'eps', 'aep', 'aepx', 'c4d', 'blend', 'afphoto', 'afdesign', 'sketch', 'fig', 'xcf', 'kra', 'indd', 'prproj', 'drp', 'mogrt', 'tif', 'tiff', 'exr', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'raw'];
// Carpetas donde suele guardarse el .prproj dentro de un trabajo (Trabajo/Premiere/x.prproj).
var WORK_SUBFOLDER = /^(premiere|premiere pro|proyecto|proyectos|project|projects|prproj|edicion|edición|montaje|edit)$/i;
// N14: formatos que Premiere importa como secuencia de fotogramas (o clips de varios archivos numerados).
// Solo estos se agrupan: C0001.mp4 / C0002.mp4 son planos distintos, no una secuencia.
// De estos, png/jpg/bmp son casi siempre imágenes sueltas: solo cuentan como secuencia con números rellenos (≥4 dígitos o ceros).
var STILL_EXTENSIONS = ['png', 'jpg', 'jpeg', 'bmp'];
var MIN_SEQUENCE = 3;
var BIG_PATTERN = 10; // un patrón numerado de ≥10 archivos nunca se aparta sin pedir confirmación
var SEQUENCE_EXTENSIONS = ['exr', 'dpx', 'tif', 'tiff', 'png', 'jpg', 'jpeg', 'tga', 'bmp', 'cin', 'sgi', 'r3d'];
// Premiere no permite re-enlazar estos tipos con changeMediaPath.
var MANUAL_EXTENSIONS = ['aegraphic', 'mogrt', 'aep', 'aet', 'prgraphic', 'c4d'];

function extOf(name) {
    var ext = path.extname(String(name || ''));
    return ext ? ext.slice(1).toLowerCase() : '';
}

function stemOf(name) {
    var base = path.basename(String(name || ''));
    var ext = path.extname(base);
    return fsu.nameKey(base.slice(0, base.length - ext.length));
}

/** Convierte un nombre de BIN en un nombre de carpeta seguro (sin / \ : ni ..). */
function safeSegment(name) {
    var clean = String(name || '').normalize('NFC').replace(/[\/\\:\u0000-\u001f\u007f]/g, '_').trim().replace(/^[. ]+/, '').replace(/[. ]+$/, '');
    if (!clean) return '_';
    return clean.length > 200 ? clean.slice(0, 200) : clean;
}

/** Nombre de carpeta de categoría que no choque con carpetas que BinFlow ignora (LOG, _Final…). */
function safeCategory(name) {
    var clean = safeSegment(name);
    var lower = clean.toLowerCase();
    if (SKIP_DIRS.indexOf(lower) !== -1 || lower === UNUSED_DIR.toLowerCase()) return clean + ' (categoría)';
    return clean;
}

function diskSegments(target) {
    return target.map(function (segment, i) { return i === 0 ? safeCategory(segment) : safeSegment(segment); });
}

function decodeXml(value) {
    return value.replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
        .replace(/&#(\d+);/g, function (m, d) { return String.fromCodePoint(Number(d)); })
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Rutas de medios que usa otro .prproj (gzip o XML plano). Lanza si no se puede leer. */
function readProjectMediaPaths(file) {
    var size = fs.statSync(file).size;
    if (size > 300 * 1024 * 1024) throw new Error('demasiado grande para analizarlo');
    var raw = fs.readFileSync(file);
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw, { maxOutputLength: 512 * 1024 * 1024 });
    var xml = raw.toString('utf8');
    var re = /<ActualMediaFilePath>([\s\S]*?)<\/ActualMediaFilePath>/g, m, out = [];
    while ((m = re.exec(xml))) {
        var value = decodeXml(m[1].trim());
        if (value) out.push(value);
    }
    return out;
}

/** N14: «plate.0001.exr» → { prefix: 'plate.', digits: '0001', ext: 'exr' } (null si no acaba en número). */
function seqParts(name) {
    var m = /^(.*?)(\d+)(\.[^.]+)$/.exec(String(name || ''));
    return m ? { prefix: fsu.nameKey(m[1]), digits: m[2], ext: m[3].slice(1).toLowerCase() } : null;
}

function sameSequence(a, b) {
    if (!a || !b || a.prefix !== b.prefix || a.ext !== b.ext) return false;
    return a.digits.length === b.digits.length || (a.digits.charAt(0) !== '0' && b.digits.charAt(0) !== '0');
}

/** Identificador de disco de la carpeta existente más cercana (o null). */
function nearestDev(p) {
    var cur = path.resolve(p);
    for (;;) {
        try { return fs.statSync(cur).dev; } catch (e) {
            var parent = path.dirname(cur);
            if (parent === cur) return null;
            cur = parent;
        }
    }
}

/** Espacio libre (bytes) del volumen que contiene dir, o null si no se puede saber. */
function freeSpace(dir) {
    if (process.platform === 'win32') return null;
    try {
        var out = childProcess.execFileSync('/bin/df', ['-k', dir], { encoding: 'utf8', timeout: 5000 });
        var cols = out.trim().split('\n').pop().trim().split(/\s+/);
        var kb = Number(cols[3]);
        return isFinite(kb) ? kb * 1024 : null;
    } catch (e) { return null; }
}

function fileCategories(categories) {
    var result = [];
    Object.keys(categories || {}).forEach(function (name) {
        if (name !== SEQUENCES && name !== EMPTY_BIN) result.push({ name: name, exts: (categories[name] || []).map(function (e) { return String(e).toLowerCase().replace(/^\./, ''); }) });
    });
    return result;
}

function categoryFor(name, cats) {
    var lower = String(name || '').toLowerCase();
    if (lower.indexOf('proxy') !== -1) return OTHERS;
    var ext = extOf(name);
    for (var i = 0; i < cats.length; i++) if (ext && cats[i].exts.indexOf(ext) !== -1) return cats[i].name;
    return OTHERS;
}

function itemCategory(item, cats) {
    if (item.kind === 'sequence') return SEQUENCES;
    var byPath = item.mediaPath ? categoryFor(path.basename(item.mediaPath), cats) : OTHERS;
    if (byPath !== OTHERS || !item.name) return byPath;
    return categoryFor(item.name, cats);
}

/** N15: ¿la ruta cuelga de .../Adobe/Premiere Pro/ (preferencias, layouts, Profile-…)? */
function isPremiereFolder(folder) {
    var parts = path.resolve(folder).split(path.sep).map(function (p) { return p.normalize('NFC').toLowerCase(); });
    for (var i = 0; i < parts.length - 1; i++) if (parts[i] === 'adobe' && parts[i + 1] === 'premiere pro') return true;
    return false;
}

/** Carpetas donde nunca debe organizarse un proyecto entero. */
function isUnsafeRoot(folder) {
    var home = os.homedir();
    var unsafe = [path.parse(path.resolve(folder)).root, home, '/Volumes', '/Users', '/Applications', '/System', '/Library'];
    ['Desktop', 'Documents', 'Downloads', 'Movies', 'Pictures', 'Music', 'Escritorio', 'Documentos', 'Descargas'].forEach(function (d) { unsafe.push(path.join(home, d)); });
    var k = fsu.key(folder);
    if (unsafe.some(function (u) { return fsu.key(u) === k; })) return true;
    // Raíz de un volumen externo: /Volumes/<disco>
    var parts = path.resolve(folder).split(path.sep).filter(Boolean);
    return parts.length === 2 && parts[0] === 'Volumes';
}

// ---------------------------------------------------------------- BINS (R3)

function buildBinTree(items) {
    var root = { name: '', path: [], children: {}, order: [], items: [] };
    items.forEach(function (item) {
        var node = root;
        (item.binPath || []).forEach(function (segment) {
            if (!node.children[segment]) {
                node.children[segment] = { name: segment, path: node.path.concat(segment), children: {}, order: [], items: [] };
                node.order.push(segment);
            }
            node = node.children[segment];
        });
        node.items.push(item);
    });
    return root;
}

function subtreeCounts(node, cats, acc) {
    acc = acc || { total: 0, byCat: {} };
    node.items.forEach(function (item) {
        if (item.kind !== 'media' && item.kind !== 'sequence') return;
        var cat = itemCategory(item, cats);
        acc.total++;
        acc.byCat[cat] = (acc.byCat[cat] || 0) + 1;
    });
    node.order.forEach(function (name) { subtreeCounts(node.children[name], cats, acc); });
    return acc;
}

function dominantCategory(node, cats) {
    var counts = subtreeCounts(node, cats);
    if (!counts.total) return null;
    var best = null;
    Object.keys(counts.byCat).forEach(function (cat) {
        if (counts.byCat[cat] / counts.total >= DOMINANCE && (!best || counts.byCat[cat] > counts.byCat[best])) best = cat;
    });
    return best;
}

/**
 * Decide el BIN destino de cada ítem.
 * - BIN raíz con nombre de categoría: se respeta; sus sub-BINs son grupos.
 * - BIN con ≥80 % de un tipo: grupo completo bajo esa categoría (también anidado).
 * - BIN mixto: se disuelve; sus ítems van a su categoría y sus sub-BINs se evalúan.
 */
function assignBins(items, cats, categoryNames) {
    var tree = buildBinTree(items);
    var targets = {};
    var binMoves = [];
    var groups = [];

    function setTarget(item, target) { targets[item.nodeId] = target; }

    function assignGroup(node, base) {
        node.items.forEach(function (item) { setTarget(item, base); });
        node.order.forEach(function (name) { assignGroup(node.children[name], base.concat(name)); });
    }

    function dissolve(node) {
        node.items.forEach(function (item) { setTarget(item, [itemCategory(item, cats)]); });
        node.order.forEach(function (name) {
            var child = node.children[name];
            var dom = dominantCategory(child, cats);
            if (dom) {
                binMoves.push({ binPath: child.path, targetParent: [dom] });
                groups.push({ bin: child.path.join('/'), category: dom, items: subtreeCounts(child, cats).total });
                assignGroup(child, [dom, child.name]);
            } else {
                dissolve(child);
            }
        });
    }

    tree.items.forEach(function (item) { setTarget(item, [itemCategory(item, cats)]); });
    tree.order.forEach(function (name) {
        var top = tree.children[name];
        if (name === EMPTY_BIN) { assignGroup(top, [name]); return; }
        if (categoryNames.indexOf(name) !== -1) {
            // BIN de categoría: los ítems sueltos de otro tipo van a su categoría; los sub-BINs se conservan.
            top.items.forEach(function (item) {
                var cat = itemCategory(item, cats);
                setTarget(item, cat === name || item.kind === 'synthetic' ? [name] : [cat]);
            });
            top.order.forEach(function (sub) { assignGroup(top.children[sub], [name, sub]); });
            return;
        }
        var dom = dominantCategory(top, cats);
        if (dom) {
            binMoves.push({ binPath: top.path, targetParent: [dom] });
            groups.push({ bin: top.path.join('/'), category: dom, items: subtreeCounts(top, cats).total });
            assignGroup(top, [dom, name]);
        } else {
            dissolve(top);
        }
    });
    return { targets: targets, binMoves: binMoves, groups: groups };
}

// ---------------------------------------------------------------- PLAN

function shouldSkipDir(assetsDir, skipAll) {
    return function (name, full) {
        if (skipAll) return true; // N15: carpeta de Premiere: nada de lo que cuelga de ella se analiza
        if (name.charAt(0) === '.') return true;
        if (/^Profile-/i.test(name)) return true; // perfil de Premiere (preferencias, layouts)
        if (/\.(app|bundle|fcpbundle|photoslibrary)$/i.test(name)) return true;
        if (SKIP_DIRS.indexOf(name.toLowerCase()) !== -1) return true;
        return false;
    };
}

function shouldSkipFile(name) {
    if (name.charAt(0) === '.') return true;
    if (/\.\d+-[0-9a-f]{8}\.binflow-partial$/i.test(name)) return true; // solo temporales propios
    if (/^(Thumbs\.db|desktop\.ini|Icon\r)$/i.test(name)) return true;
    return SKIP_EXTENSIONS.indexOf(extOf(name)) !== -1;
}

/**
 * Construye el plan. No modifica nada en disco.
 * snapshot = { projectPath, projectFolder, assetsFolderName, categories, items: [{nodeId, name, kind, mediaPath, binPath}] }
 */
async function buildPlan(snapshot, options) {
    options = options || {};
    if (!snapshot || !snapshot.projectFolder) throw new Error('Snapshot sin carpeta de proyecto.');
    var projectFolder = path.resolve(snapshot.projectFolder);
    // APFS con distinción de mayúsculas: se comprueba en la carpeta real en vez de asumirlo por el sistema.
    fsu.setCaseSensitive(fsu.detectCaseSensitive(projectFolder));
    var assetsName = safeSegment(snapshot.assetsFolderName || '01 Assets');
    var assetsDir = path.join(projectFolder, assetsName);
    var projectStem = path.basename(String(snapshot.projectPath || 'Proyecto')).replace(/\.prproj$/i, '');
    // LOG dentro de la carpeta del proyecto y separado por .prproj: nunca se mezcla con otros proyectos.
    var logDir = path.join(snapshot.projectPath ? path.dirname(path.resolve(snapshot.projectPath)) : projectFolder, 'LOG', safeSegment(projectStem));
    var cats = fileCategories(snapshot.categories);
    var categoryNames = Object.keys(snapshot.categories || {});
    if (categoryNames.indexOf(OTHERS) === -1) categoryNames.push(OTHERS);
    var items = (snapshot.items || []).filter(function (it) { return it && it.nodeId; });
    var moveManual = options.moveManual !== false; // gráficos de Adobe (.aegraphic, .mogrt…): se mueven salvo que se pida lo contrario

    var plan = {
        engineVersion: require('./version'),
        createdAt: new Date().toISOString(),
        projectPath: snapshot.projectPath,
        projectFolder: projectFolder,
        assetsDir: assetsDir,
        logDir: logDir,
        ops: [],
        items: [],
        binMoves: [],
        groups: [],
        missing: [],
        ambiguous: [],
        manual: [],
        moveManual: moveManual,
        warnings: [],
        confirmations: [],
        otherProjects: [],
        unreadable: [],
        suggestedRoot: null,
        blocked: false,
        blockReason: ''
    };

    // N19: los BINs se calculan antes de los bloqueos para que el modo «solo BINs» vea el plan y el motivo.
    var bins = assignBins(items, cats, categoryNames);
    plan.binMoves = bins.binMoves;
    plan.groups = bins.groups;
    items.forEach(function (item) {
        plan.items.push({ nodeId: item.nodeId, name: item.name, kind: item.kind, currentBin: item.binPath || [], targetBin: bins.targets[item.nodeId] || item.binPath || [] });
    });

    if (isUnsafeRoot(projectFolder)) {
        plan.blocked = true;
        plan.blockCode = 'unsafe-root';
        plan.blockReason = 'El proyecto está guardado directamente en «' + projectFolder + '». Guárdalo dentro de su propia carpeta antes de organizarlo.';
        return plan;
    }

    // Una organización anterior se cortó a mitad: primero hay que recuperarla (Deshacer).
    var interrupted = require('./execute').findInterrupted(logDir, snapshot.projectPath);
    if (interrupted.length) {
        plan.blocked = true;
        plan.blockCode = 'interrupted';
        plan.interrupted = interrupted.map(function (x) { return { dir: x.dir, createdAt: x.meta.createdAt }; });
        plan.blockReason = 'Una organización anterior (' + new Date(interrupted[interrupted.length - 1].meta.createdAt).toLocaleString() + ') se interrumpió a mitad. Pulsa «Recuperar organización interrumpida» para devolver los archivos a su sitio y limpiar los restos antes de volver a organizar.';
        return plan;
    }

    // --- Archivos de la carpeta
    var files;
    var projectFiles = [];
    var walkErrors = [];
    var skipFile = function (name, full) {
        if (extOf(name) === 'prproj') projectFiles.push(full);
        return shouldSkipFile(name);
    };
    // N15: en una carpeta de Premiere (.../Adobe/Premiere Pro/<versión>/) lo que cuelga del proyecto son
    // preferencias, layouts y perfiles: se queda donde está y no se analiza.
    var premiereFolder = isPremiereFolder(projectFolder);
    if (premiereFolder) plan.warnings.push('El proyecto está en una carpeta de Premiere (Adobe/Premiere Pro): sus preferencias, layouts y perfiles NO se tocan y las subcarpetas no se analizan. Solo se organizan los medios que usa el proyecto y estén sueltos en esta carpeta. Lo mejor es guardar el proyecto en su propia carpeta de trabajo.');
    try {
        await fsu.assertInside(assetsDir, projectFolder, 'La carpeta de assets');
        files = await fsu.walk(projectFolder, shouldSkipDir(assetsDir, premiereFolder), skipFile, options.maxFiles || MAX_FILES, walkErrors);
    } catch (e) {
        if (e.code === 'EOUTSIDE') { plan.blocked = true; plan.blockCode = 'outside'; plan.blockReason = e.message; return plan; }
        if (e.code !== 'ETOOMANY') throw e;
        plan.blocked = true;
        plan.blockCode = 'too-many-files';
        plan.blockReason = 'La carpeta del proyecto tiene más de ' + (options.maxFiles || MAX_FILES) + ' archivos. Comprueba que el proyecto está en su propia carpeta.';
        return plan;
    }
    if (walkErrors.length) {
        plan.unreadable = walkErrors.map(function (e) { return e.path; });
        plan.blocked = true;
        plan.blockCode = 'unreadable';
        plan.blockReason = 'No se pueden leer ' + walkErrors.length + ' carpetas o archivos (permisos). Revisa los permisos y vuelve a analizar para no dejar nada fuera.';
        return plan;
    }

    // --- Otros proyectos de Premiere dentro de la carpeta
    var currentKey = fsu.key(snapshot.projectPath || '');
    var currentDir = snapshot.projectPath ? path.dirname(path.resolve(snapshot.projectPath)) : projectFolder;
    var excludedRoots = [];
    var siblingRefs = {};
    var unreadableProjects = [];
    projectFiles.forEach(function (file) {
        if (fsu.key(file) === currentKey) return;
        var dir = path.dirname(file);
        var sameFolder = fsu.key(dir) === fsu.key(currentDir);
        var info = { path: file, kind: sameFolder ? 'version' : 'subproyecto' };
        if (!sameFolder) {
            // Se excluye el trabajo completo: si el .prproj está en «Premiere/», «Proyecto/»…, también su carpeta padre (Spot30/Media…).
            var workRoot = dir;
            if (WORK_SUBFOLDER.test(path.basename(dir)) && fsu.isWithin(path.dirname(dir), projectFolder) && fsu.key(path.dirname(dir)) !== fsu.key(projectFolder) && !fsu.isWithin(currentDir, path.dirname(dir))) workRoot = path.dirname(dir);
            if (!fsu.isWithin(currentDir, workRoot)) { excludedRoots.push(workRoot); info.excluded = workRoot; }
        }
        try {
            readProjectMediaPaths(file).forEach(function (p) { siblingRefs[fsu.key(p)] = path.basename(file); });
        } catch (e) {
            info.error = e.message;
            unreadableProjects.push(info);
        }
        plan.otherProjects.push(info);
    });
    if (unreadableProjects.length) {
        plan.blocked = true;
        plan.blockCode = 'unreadable-project';
        plan.blockReason = 'No se puede leer ' + unreadableProjects.map(function (p) { return path.basename(p.path) + ' (' + p.error + ')'; }).join(', ') +
            '. Sin saber qué medios usa, organizar podría dejarlo offline. Muévelo fuera de esta carpeta o repáralo y vuelve a analizar.';
        return plan;
    }
    if (excludedRoots.length) {
        files = files.filter(function (f) { return !excludedRoots.some(function (d) { return fsu.isWithin(f.path, d); }); });
        plan.confirmations.push('Estas carpetas son de otros proyectos de Premiere y NO se tocarán: ' + excludedRoots.map(function (d) { return path.relative(projectFolder, d) || '.'; }).join(', ') + '.');
    }

    // N16: lo que el .prproj guardado referencia (proxies y rutas de medios) cuenta como usado: no se mueve.
    var ownRefs = {};
    if (snapshot.projectPath && fs.existsSync(snapshot.projectPath)) {
        try { readProjectMediaPaths(snapshot.projectPath).forEach(function (p) { ownRefs[fsu.key(p)] = true; }); }
        catch (e) { plan.warnings.push('No se pudo leer el proyecto guardado (' + e.message + '): no se puede comprobar qué más usa, además de los medios del panel.'); }
    }
    (snapshot.proxyPaths || []).forEach(function (p) { if (p) ownRefs[fsu.key(p)] = true; });

    var byKey = {}, byName = {};
    files.forEach(function (f) {
        byKey[fsu.key(f.path)] = f;
        var n = fsu.nameKey(f.name);
        (byName[n] = byName[n] || []).push(f);
    });

    // --- Medios referenciados (uno por ruta)
    var refs = {}, refOrder = [];
    items.forEach(function (item) {
        if (item.kind !== 'media' || !item.mediaPath) return;
        var k = fsu.key(item.mediaPath);
        if (!refs[k]) { refs[k] = { requested: path.resolve(item.mediaPath), items: [] }; refOrder.push(k); }
        refs[k].items.push(item);
    });

    var referencedKeys = {};
    var recovered = [];
    var sizeLog = null;
    // Tamaño que tenía un archivo según los journals de sesiones anteriores (null si no consta).
    function knownSize(p) {
        if (!sizeLog) {
            sizeLog = {};
            try {
                require('./execute').sessionJournalEntries(logDir).forEach(function (e) {
                    if (typeof e.size !== 'number') return;
                    sizeLog[fsu.key(e.source)] = e.size;
                    sizeLog[fsu.key(e.dest)] = e.size;
                });
            } catch (ignore) { /* sin registro: no se puede comprobar */ }
        }
        var v = sizeLog[fsu.key(p)];
        return typeof v === 'number' ? v : null;
    }
    var plannedByKey = {};     // clave de origen → destino previsto
    var groupDirMap = {};      // carpeta origen → carpeta destino (solo grupos)
    var groupDirConflict = {};
    var stemIndex = {};        // stem → [{source, plannedDir}]

    for (var r = 0; r < refOrder.length; r++) {
        var ref = refs[refOrder[r]];
        var first = ref.items[0];
        var nodeIds = ref.items.map(function (it) { return it.nodeId; });
        var source = ref.requested, state;
        var info = byKey[fsu.key(source)];
        if (info) {
            state = 'internal';
        } else if (await fsu.exists(source)) {
            state = fsu.isWithin(source, projectFolder) ? 'internal-skipped' : 'external';
        } else {
            var candidates = byName[fsu.nameKey(path.basename(source))] || [];
            // Solo se recupera por nombre si el original estaba dentro del proyecto (archivo movido a mano).
            // Si vivía en otro disco (¿desconectado?) se trata como ausente: mismo nombre no es mismo plano.
            if (!fsu.isWithin(source, projectFolder)) candidates = [];
            var known = candidates.length === 1 ? knownSize(ref.requested) : null;
            if (candidates.length === 1 && known !== null && known !== candidates[0].size) {
                // N11: el registro de BinFlow sabe qué tamaño tenía el original y este no coincide: otro plano con el mismo nombre.
                state = 'missing';
                plan.missing.push({ name: first.name, path: ref.requested, nodeIds: nodeIds, note: 'Hay un archivo con el mismo nombre («' + candidates[0].path + '») pero su tamaño no coincide con el del original; no se da por bueno.' });
            } else if (candidates.length === 1) { state = 'recovered'; source = candidates[0].path; info = candidates[0]; recovered.push({ name: first.name, from: ref.requested, to: source, verified: known !== null }); }
            else if (candidates.length > 1) {
                state = 'ambiguous';
                plan.ambiguous.push({ name: first.name, path: ref.requested, candidates: candidates.map(function (c) { return c.path; }), nodeIds: nodeIds });
            } else {
                state = 'missing';
                plan.missing.push({ name: first.name, path: ref.requested, nodeIds: nodeIds });
            }
        }
        if (state === 'ambiguous' || state === 'missing') continue;
        referencedKeys[fsu.key(source)] = true;
        if (state === 'internal-skipped') continue; // dentro de _Final, LOG, cachés…: no se toca

        var target = bins.targets[first.nodeId] || [OTHERS];
        if (target[0] === SEQUENCES || target[0] === EMPTY_BIN) target = [categoryFor(path.basename(source), cats)];
        var destDir = path.join.apply(path, [assetsDir].concat(diskSegments(target)));
        var dest = path.join(destDir, path.basename(source));
        var isGroup = target.length > 1;
        var ext = extOf(source);
        var manual = MANUAL_EXTENSIONS.indexOf(ext) !== -1;
        var keepManual = manual && !moveManual; // moveManual:false = comportamiento antiguo (se dejan donde están)
        var size = info ? info.size : (await fsu.stat(source)).size;
        var op = { type: null, reason: 'referenciado', source: source, dest: dest, category: target[0], nodeIds: nodeIds, size: size, state: state, manual: manual };

        op.relinkFrom = state === 'recovered' ? null : source;
        if (state === 'external') {
            op.reason = 'externo';
            var reuse = await findInternalCopy(source, size, byName);
            if (reuse) {
                // Ya hay una copia idéntica dentro del proyecto: se usa esa y se coloca en su sitio.
                referencedKeys[fsu.key(reuse)] = true;
                op.state = 'reused';
                op.source = reuse;
                op.type = fsu.key(reuse) === fsu.key(dest) ? 'relink' : (keepManual ? 'relink' : 'move');
                if (op.type === 'relink') op.dest = reuse;
                source = reuse;
            } else op.type = 'copy';
        } else if (keepManual) {
            op.type = 'keep';
            op.dest = source;
        } else if (fsu.key(source) === fsu.key(dest)) {
            op.type = state === 'recovered' ? 'relink' : 'none';
        } else {
            op.type = 'move';
        }
        // Con moveManual Premiere no puede re-enlazarlos (changeMediaPath): no se envían re-enlaces para ellos.
        if (manual && moveManual) op.noRelink = true;
        if (keepManual) plan.manual.push({ name: path.basename(source), path: source, dest: op.dest, type: op.type, offline: false, moved: false });
        else if (manual && (op.type === 'move' || op.type === 'copy')) {
            // move: el original deja de estar donde Premiere lo busca (sin conexión). copy: el proyecto sigue apuntando al original.
            plan.manual.push({ name: path.basename(source), path: source, dest: op.dest, type: op.type, offline: op.type === 'move', moved: true });
        }
        if (op.type !== 'none') plan.ops.push(op);

        var plannedDest = op.type === 'none' || op.type === 'keep' ? source : op.dest;
        plannedByKey[fsu.key(source)] = plannedDest;
        if (isGroup && (op.type === 'move' || op.type === 'none' || op.type === 'relink') && fsu.isWithin(source, projectFolder)) {
            var srcDirKey = fsu.key(path.dirname(source));
            var mapped = path.dirname(plannedDest);
            if (groupDirMap[srcDirKey] && fsu.key(groupDirMap[srcDirKey].dest) !== fsu.key(mapped)) groupDirConflict[srcDirKey] = true;
            else groupDirMap[srcDirKey] = { source: path.dirname(source), dest: mapped };
        }
        var stem = stemOf(source);
        (stemIndex[stem] = stemIndex[stem] || []).push({ source: source, ext: extOf(source), plannedDir: path.dirname(plannedDest) });
    }

    // --- N14: secuencias de imágenes y clips de varios archivos.
    // Premiere solo guarda el primer fotograma; el resto no son «sin uso»: viajan con él y no se re-enlazan.
    plan.sequences = [];
    var seqCandidates = plan.ops.filter(function (op) {
        return (op.type === 'move' || op.type === 'copy') && op.nodeIds && op.nodeIds.length && !op.manual &&
            SEQUENCE_EXTENSIONS.indexOf(extOf(op.source)) !== -1 && seqParts(path.basename(op.source));
    });
    for (var q = 0; q < seqCandidates.length; q++) {
        var main = seqCandidates[q];
        var mainParts = seqParts(path.basename(main.source));
        var srcDir = path.dirname(main.source);
        var frames = [];
        if (main.state === 'external') {
            try {
                fs.readdirSync(srcDir).forEach(function (n) {
                    var full = path.join(srcDir, n);
                    var st = fs.lstatSync(full);
                    if (st.isFile() && !shouldSkipFile(n)) frames.push({ path: full, name: n, size: st.size });
                });
            } catch (ignore) { /* sin lectura de la carpeta: se trata como un archivo suelto */ }
        } else {
            frames = files.filter(function (f) { return fsu.key(path.dirname(f.path)) === fsu.key(srcDir); });
        }
        // N24: lo que usa otro ítem, otra versión del proyecto o el propio .prproj no es de esta secuencia.
        frames = frames.filter(function (f) {
            var fk = fsu.key(f.path);
            return fk !== fsu.key(main.source) && !referencedKeys[fk] && !siblingRefs[fk] && !ownRefs[fk] && sameSequence(mainParts, seqParts(f.name));
        });
        if (!frames.length) continue;
        var seqName = path.basename(main.source).replace(/\d+(\.[^.]+)$/, '#$1');
        // N25: solo es secuencia si hay una tanda de ≥3 fotogramas consecutivos que EMPIEZA en el archivo usado
        // (Premiere guarda el primer fotograma) y, para fotos sueltas (png/jpg), con números rellenos.
        // Ante la duda se mueve solo el usado y se avisa.
        var byNumber = {};
        frames.forEach(function (f) { byNumber[Number(seqParts(f.name).digits)] = f; });
        var firstNo = Number(mainParts.digits), lastNo = firstNo;
        while (byNumber[lastNo + 1]) lastNo++;
        var hasLower = !!byNumber[firstNo - 1];
        var padded = mainParts.digits.length >= 4 || mainParts.digits.charAt(0) === '0';
        var stillOk = STILL_EXTENSIONS.indexOf(mainParts.ext) === -1 || padded;
        // N30: con relleno de ≥4 dígitos en formatos de fotogramas (no fotos sueltas) se admiten huecos
        // (un fotograma perdido en un render es habitual): vale con que haya más fotogramas del mismo patrón con número mayor.
        var allowGaps = STILL_EXTENSIONS.indexOf(mainParts.ext) === -1 && mainParts.digits.length >= 4;
        var above = frames.filter(function (f) { return Number(seqParts(f.name).digits) > firstNo; });
        var looksLikeSequence = allowGaps ? above.length >= MIN_SEQUENCE - 1 : lastNo - firstNo + 1 >= MIN_SEQUENCE;
        if (hasLower || !looksLikeSequence || !stillOk) {
            if (frames.length + 1 >= BIG_PATTERN) plan.confirmations.push('Hay ' + (frames.length + 1) + ' archivos con el patrón «' + seqName + '» y NO se agrupan como secuencia: solo se mueve «' + path.basename(main.source) + '» y los otros ' + frames.length + ' se tratan como archivos sin uso (normalmente irán a «' + UNUSED_DIR + '»). Si en Premiere es una secuencia, no sigas: quedaría incompleta.');
            plan.warnings.push('«' + path.basename(main.source) + '» tiene ' + frames.length + ' archivos con nombre numerado parecido en su carpeta, pero no parece una secuencia (' +
                (hasLower ? 'hay números anteriores al usado' : (!stillOk ? 'son imágenes sueltas' : 'faltan fotogramas consecutivos')) + '). Solo se mueve el archivo usado; los demás siguen su regla normal.');
            continue;
        }
        var picked = frames.filter(function (f) { var no = Number(seqParts(f.name).digits); return no > firstNo && (allowGaps || no <= lastNo); });
        var maxNo = picked.reduce(function (m, f) { return Math.max(m, Number(seqParts(f.name).digits)); }, firstNo);
        var hasGaps = picked.length + 1 !== maxNo - firstNo + 1;
        if (frames.length - picked.length >= BIG_PATTERN) plan.confirmations.push('Hay ' + (frames.length - picked.length) + ' archivos más con el patrón «' + seqName + '» que no se agrupan con la secuencia y se tratan como archivos sin uso (normalmente irán a «' + UNUSED_DIR + '»). Compruébalo antes de continuar.');
        frames = picked;
        var destDirSeq = path.dirname(main.dest);
        // Si en destino ya hay algo con el nombre de algún fotograma, la secuencia quedaría partida: no se mueve.
        // N26: también contra lo que otras operaciones del plan (otras secuencias incluidas) ya van a dejar ahí.
        var planned = {};
        plan.ops.forEach(function (o) { if (o !== main && (o.type === 'move' || o.type === 'copy') && o.sequenceOf !== main.source) planned[fsu.key(o.dest)] = true; });
        var clash = [main].concat(frames.map(function (f) { return { source: f.path, dest: path.join(destDirSeq, f.name) }; })).filter(function (x) {
            return fsu.key(x.dest) !== fsu.key(x.source) && (fs.existsSync(x.dest) || planned[fsu.key(x.dest)]);
        });
        frames.forEach(function (f) { referencedKeys[fsu.key(f.path)] = true; });
        if (clash.length) {
            plan.ops.splice(plan.ops.indexOf(main), 1);
            plan.warnings.push('Secuencia «' + seqName + '» (' + (frames.length + 1) + ' archivos): ya hay archivos (o otra secuencia del plan) con esos nombres en el destino. No se mueve y se deja donde está para no partirla.');
            plan.sequences.push({ name: seqName, count: frames.length + 1, moved: false, dir: srcDir });
            continue;
        }
        var at = plan.ops.indexOf(main) + 1;
        frames.forEach(function (f, n) {
            plan.ops.splice(at + n, 0, { type: main.type, reason: 'secuencia', source: f.path, dest: path.join(destDirSeq, f.name), category: main.category, nodeIds: [], size: f.size, state: main.state, manual: false, sequenceOf: main.source });
        });
        plan.sequences.push({ name: seqName, count: frames.length + 1, moved: true, gaps: hasGaps, dir: srcDir, dest: destDirSeq });
    }
    if (plan.sequences.some(function (x) { return x.moved; })) {
        plan.warnings.push('Secuencias detectadas, se mueven juntas: ' + plan.sequences.filter(function (x) { return x.moved; }).map(function (x) { return x.name + ' (' + x.count + ' archivos' + (x.gaps ? ', con huecos' : '') + ')'; }).join(', ') + '.');
    }

    // Propaga el grupo hacia arriba cuando los nombres coinciden (Brutos/Dia1 → …/Brutos/Dia1 implica Brutos → …/Brutos),
    // para que una subcarpeta hermana no importada (Brutos/Dia2) también se quede en su grupo.
    Object.keys(groupDirMap).forEach(function (k) {
        var src = groupDirMap[k].source, dst = groupDirMap[k].dest;
        while (path.basename(src) && fsu.nameKey(path.basename(src)) === fsu.nameKey(path.basename(dst))) {
            src = path.dirname(src); dst = path.dirname(dst);
            if (!fsu.isWithin(src, projectFolder) || fsu.key(src) === fsu.key(projectFolder)) break;
            if (!fsu.isWithin(dst, assetsDir) || path.relative(assetsDir, dst).split(path.sep).length < 2) break;
            var pk = fsu.key(src);
            if (groupDirMap[pk]) { if (fsu.key(groupDirMap[pk].dest) !== fsu.key(dst)) groupDirConflict[pk] = true; break; }
            groupDirMap[pk] = { source: src, dest: dst };
        }
    });

    // --- Archivos sin uso (R1 + R2)
    plan.unused = [];
    files.forEach(function (f) {
        var k = fsu.key(f.path);
        if (referencedKeys[k]) return;
        if (ownRefs[k]) {
            // Lo usa este mismo proyecto (proxy u otra ruta del .prproj) aunque no sea un ítem del panel.
            plan.unused.push({ name: f.name, source: f.path, dest: f.path, size: f.size, mtime: f.mtime, reason: 'usado por el proyecto', category: categoryFor(f.name, cats) });
            return;
        }
        if (premiereFolder) {
            plan.unused.push({ name: f.name, source: f.path, dest: f.path, size: f.size, mtime: f.mtime, reason: 'carpeta de Premiere', category: categoryFor(f.name, cats) });
            return;
        }
        if (siblingRefs[k]) {
            // Lo usa otra versión del proyecto: se deja donde está para no dejarla offline.
            plan.unused.push({ name: f.name, source: f.path, dest: f.path, size: f.size, mtime: f.mtime, reason: 'otra versión', category: categoryFor(f.name, cats), usedBy: siblingRefs[k] });
            return;
        }
        if (fsu.isWithin(f.path, assetsDir)) {
            // Ya está en assets: se deja donde está, pero se informa.
            plan.unused.push({ name: f.name, source: f.path, dest: f.path, size: f.size, mtime: f.mtime, reason: 'ya en assets', category: categoryFor(f.name, cats) });
            return;
        }
        var dest = null, reason = null;
        // 1) Se queda con su grupo (carpeta que corresponde a un BIN conservado)
        var dir = path.dirname(f.path);
        while (fsu.isWithin(dir, projectFolder) && fsu.key(dir) !== fsu.key(projectFolder)) {
            var g = groupDirMap[fsu.key(dir)];
            if (g && !groupDirConflict[fsu.key(dir)]) {
                dest = path.join(g.dest, path.relative(g.source, f.path));
                reason = 'grupo';
                break;
            }
            dir = path.dirname(dir);
        }
        // 2) Fuente de un archivo usado: mismo nombre, OTRA extensión y tipo de archivo de trabajo (psd, ai, aep…)
        if (!dest && SOURCE_EXTENSIONS.indexOf(extOf(f.name)) !== -1) {
            var siblings = (stemIndex[stemOf(f.name)] || []).filter(function (s) { return s.ext !== extOf(f.name); });
            if (siblings && siblings.length) {
                var sameDir = siblings.filter(function (s) { return fsu.key(path.dirname(s.source)) === fsu.key(path.dirname(f.path)); })[0];
                dest = path.join((sameDir || siblings[0]).plannedDir, f.name);
                reason = 'fuente';
            }
        }
        // 3) No usado
        var category = categoryFor(f.name, cats);
        if (!dest) {
            dest = path.join(assetsDir, UNUSED_DIR, safeCategory(category), f.name);
            reason = 'no usado';
        }
        var entry = { name: f.name, source: f.path, dest: dest, size: f.size, mtime: f.mtime, reason: reason, category: category };
        plan.unused.push(entry);
        if (fsu.key(dest) !== k) plan.ops.push({ type: 'move', reason: reason, source: f.path, dest: dest, category: category, nodeIds: [], size: f.size });
    });

    // Dos orígenes distintos con el mismo destino previsto: se avisa (se resolverá con sufijo __hash).
    var destSeen = {};
    plan.ops.forEach(function (op) {
        if (op.type !== 'move' && op.type !== 'copy') return;
        var dk = fsu.key(op.dest);
        if (destSeen[dk]) plan.warnings.push('Mismo nombre en destino: ' + path.basename(op.dest) + ' (se añadirá un sufijo para no sobrescribir).');
        destSeen[dk] = true;
    });

    // Medios de ESTE proyecto que también usan otros proyectos: se moverán y allí quedarán offline.
    var versions = plan.otherProjects.filter(function (p) { return p.kind === 'version'; });
    var sharedOps = plan.ops.filter(function (op) { return op.type === 'move' && siblingRefs[fsu.key(op.source)]; });
    if (versions.length) {
        plan.confirmations.push('En la carpeta hay ' + versions.length + ' versión(es) más del proyecto (' + versions.map(function (v) { return path.basename(v.path); }).slice(0, 3).join(', ') + '). Los archivos que solo usan ellas se dejan donde están.');
    }
    if (sharedOps.length) {
        var byProject = {};
        sharedOps.forEach(function (op) { var n = siblingRefs[fsu.key(op.source)]; byProject[n] = (byProject[n] || 0) + 1; });
        plan.confirmations.push(sharedOps.length + ' medios que usa este proyecto también los usan otros (' + Object.keys(byProject).map(function (n) { return n + ': ' + byProject[n]; }).join(', ') + '). Se moverán y en esos proyectos aparecerán offline.');
    }

    // Proyecto en subcarpeta (Proyecto/Premiere/x.prproj con la media en Proyecto/Media): se propone la carpeta superior.
    var parent = path.dirname(projectFolder);
    var copies = plan.ops.filter(function (op) { return op.type === 'copy'; });
    var externalInParent = copies.filter(function (op) { return fsu.isWithin(op.source, parent); });
    var bytesAll = copies.reduce(function (a, op) { return a + (op.size || 0); }, 0);
    var bytesParent = externalInParent.reduce(function (a, op) { return a + (op.size || 0); }, 0);
    // Solo se propone si la mayoría de lo externo está al lado y la carpeta superior no contiene otros trabajos.
    if (externalInParent.length && bytesParent >= bytesAll * 0.5 && !isUnsafeRoot(parent) && WORK_SUBFOLDER.test(path.basename(projectFolder))) {
        var foreign = await findOtherProjects(parent, snapshot.projectPath);
        if (foreign === 0) {
            plan.suggestedRoot = parent;
            plan.warnings.push(externalInParent.length + ' medios están en carpetas hermanas de «' + path.basename(projectFolder) + '». Si todo «' + path.basename(parent) + '» es este trabajo, organiza desde ahí para moverlos en vez de copiarlos.');
        }
    }

    if (recovered.length) {
        plan.recovered = recovered;
        plan.confirmations.push(recovered.length + ' medios no estaban en su ruta y se han encontrado por nombre dentro del proyecto (' + recovered.slice(0, 3).map(function (r) { return r.name; }).join(', ') + (recovered.length > 3 ? '…' : '') + '). ' +
            (recovered.some(function (r) { return !r.verified; }) ? 'No hay forma de comprobar que sean el mismo plano (solo coincide el nombre). ' : '') + 'Comprueba en el informe que son los correctos.');
    }

    if (plan.missing.length || plan.ambiguous.length) {
        plan.blocked = true;
        plan.blockCode = 'unresolved';
        plan.blockReason = 'Hay medios que no se encuentran o están duplicados. Resuélvelos y vuelve a analizar.';
    }
    plan.summary = summarize(plan);
    // N10: se cuenta también lo que se mueve a otro disco (se copia y se borra el origen) y el margen es
    // proporcional (10 %), no 200 MB fijos.
    var crossBytes = 0;
    var assetsDev = nearestDev(assetsDir);
    plan.ops.forEach(function (op) {
        if (op.type !== 'move' || !assetsDev) return;
        try { if (fs.statSync(op.source).dev !== assetsDev) crossBytes += op.size || 0; } catch (ignore) {}
    });
    plan.summary.bytesCrossDevice = crossBytes;
    var needed = plan.summary.bytesToCopy + crossBytes;
    if (!plan.blocked && needed > 0) {
        var free = (options.freeSpace || freeSpace)(fs.existsSync(assetsDir) ? assetsDir : projectFolder);
        if (free !== null && needed * 1.1 > free) {
            plan.blocked = true;
            plan.blockCode = 'no-space';
            plan.blockReason = 'No hay espacio suficiente para copiar los medios (' + Math.round(needed / 1048576) + ' MB necesarios entre copias externas y movimientos a otro disco, ' + Math.round(free / 1048576) + ' MB libres).';
        }
    }
    return plan;
}

/** Número de .prproj ajenos bajo root (o -1 si no se puede saber). */
async function findOtherProjects(root, currentProject) {
    var found = 0;
    try {
        await fsu.walk(root, shouldSkipDir(null), function (name, full) {
            if (extOf(name) === 'prproj' && fsu.key(full) !== fsu.key(currentProject || '')) found++;
            return true;
        }, MAX_FILES, []);
    } catch (e) { return -1; }
    return found;
}

async function findInternalCopy(source, size, byName) {
    var candidates = byName[fsu.nameKey(path.basename(source))] || [];
    for (var i = 0; i < candidates.length; i++) {
        if (candidates[i].size !== size) continue;
        try {
            if ((await fsu.fingerprint(candidates[i].path)).sha256 === (await fsu.fingerprint(source)).sha256) return candidates[i].path;
        } catch (ignore) { /* candidato ilegible: se ignora */ }
    }
    return null;
}

function summarize(plan) {
    var s = { moves: 0, copies: 0, relinks: 0, kept: 0, unusedToFolder: 0, sequenceFiles: 0, sources: 0, groupFiles: 0, bytesToCopy: 0, binMoves: 0, items: plan.items.length };
    plan.ops.forEach(function (op) {
        if (op.type === 'move') s.moves++;
        if (op.type === 'copy') { s.copies++; s.bytesToCopy += op.size || 0; }
        if (op.type === 'relink') s.relinks++;
        if (op.type === 'keep') s.kept++;
        if (op.reason === 'no usado') s.unusedToFolder++;
        if (op.reason === 'fuente') s.sources++;
        if (op.reason === 'grupo') s.groupFiles++;
        if (op.reason === 'secuencia') s.sequenceFiles++;
    });
    plan.items.forEach(function (it) { if (it.targetBin.join('/') !== it.currentBin.join('/')) s.binMoves++; });
    s.unusedTotal = (plan.unused || []).length;
    return s;
}

module.exports = {
    buildPlan: buildPlan,
    assignBins: assignBins,
    safeSegment: safeSegment,
    safeCategory: safeCategory,
    readProjectMediaPaths: readProjectMediaPaths,
    categoryFor: categoryFor,
    fileCategories: fileCategories,
    isUnsafeRoot: isUnsafeRoot,
    isPremiereFolder: isPremiereFolder,
    UNUSED_DIR: UNUSED_DIR,
    SEQUENCES: SEQUENCES
};
