/**
 * BinFlow v2.1.1 — lado Premiere (ExtendScript).
 *
 * Este archivo solo habla con Premiere: lee el proyecto, re-enlaza medios y ordena BINs.
 * Todo lo que toca el disco (planificar, mover, copiar, verificar, deshacer, informes)
 * vive en ../engine/ (Node) y se llama desde main.js.
 */

// JSON seguro para ExtendScript antiguo (escapa cadenas y valida antes de evaluar).
if (typeof JSON !== 'object') { JSON = {}; }
(function () {
    var escapable = /[\\\"\u0000-\u001f\u007f-\u009f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g;
    var meta = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };
    function quote(s) {
        escapable.lastIndex = 0;
        return '"' + s.replace(escapable, function (a) {
            var c = meta[a];
            return typeof c === 'string' ? c : '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
        }) + '"';
    }
    function str(value) {
        var i, parts;
        if (value === null || value === undefined) return 'null';
        switch (typeof value) {
            case 'string': return quote(value);
            case 'number': return isFinite(value) ? String(value) : 'null';
            case 'boolean': return String(value);
            case 'object':
                parts = [];
                if (value instanceof Array) {
                    for (i = 0; i < value.length; i++) parts.push(str(value[i]));
                    return '[' + parts.join(',') + ']';
                }
                for (i in value) {
                    if (Object.prototype.hasOwnProperty.call(value, i) && typeof value[i] !== 'function') parts.push(quote(i) + ':' + str(value[i]));
                }
                return '{' + parts.join(',') + '}';
        }
        return 'null';
    }
    if (typeof JSON.stringify !== 'function') JSON.stringify = function (value) { return str(value); };
    if (typeof JSON.parse !== 'function') {
        JSON.parse = function (text) {
            text = String(text);
            // rx_dangerous de json2: U+2028/2029 y otros invisibles se escapan antes de evaluar (en ES3 rompen el literal).
            text = text.replace(/[\u0000\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g, function (a) {
                return '\\u' + ('0000' + a.charCodeAt(0).toString(16)).slice(-4);
            });
            // Validación json2: solo se evalúa si es JSON puro (sin llamadas ni asignaciones).
            if (/^[\],:{}\s]*$/.test(text.replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, '@')
                    .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, ']')
                    .replace(/(?:^|:|,)(?:\s*\[)+/g, ''))) {
                return eval('(' + text + ')');
            }
            throw new SyntaxError('JSON no válido');
        };
    }
}());

var gpOrganizer = {

    EMPTY_BIN: '(Carpetas Vacias)',

    ok: function (data) { data = data || {}; data.status = data.status || 'SUCCESS'; return JSON.stringify(data); },
    fail: function (message) { return JSON.stringify({ status: 'ERROR', message: String(message) }); },

    /** Premiere a veces entrega %20; se usa la ruta decodificada solo si existe. */
    normalizePath: function (rawPath) {
        if (!rawPath) return '';
        var original = String(rawPath);
        var decoded = File.decode(original);
        if ((new File(decoded)).exists) return (new File(decoded)).fsName;
        if ((new File(original)).exists) return (new File(original)).fsName;
        return decoded;
    },

    sameFile: function (a, b) {
        var x = String(a || ''), y = String(b || '');
        if ($.os.indexOf('Windows') !== -1 || $.os.indexOf('Mac') !== -1) { x = x.toLowerCase(); y = y.toLowerCase(); }
        return x === y;
    },

    /** Devuelve {project, projectPath, projectFolder} o lanza un error legible. */
    /** N9: el proyecto abierto debe ser el mismo con el que trabajó el panel. */
    assertSameProject: function (info, payload) {
        // N20: sin ruta de proyecto no se puede comprobar nada: se rechaza en vez de dejar pasar.
        if (payload.projectPath === undefined || payload.projectPath === null || payload.projectPath === '') {
            throw new Error('Faltan datos del proyecto en la orden del panel. Vuelve a analizar.');
        }
        if (String(payload.projectPath).toLowerCase() !== String(info.projectPath).toLowerCase()) {
            throw new Error('El proyecto abierto en Premiere no es el que se analizó. Vuelve a analizar.');
        }
    },

    requireSavedProject: function () {
        var project = app.project;
        if (!project) throw new Error('No hay proyecto activo.');
        var projectPath = this.normalizePath(project.path);
        if (!projectPath || !(new File(projectPath)).exists) throw new Error('Guarda el proyecto antes de organizarlo.');
        return { project: project, projectPath: projectPath, projectFolder: (new File(projectPath)).parent.fsName };
    },

    // ------------------------------------------------------------ Plantillas

    getProfiles: function () {
        return {
            'Estándar': {
                '_Secuencias': [],
                'Videos': ['mp4', 'mov', 'mxf', 'avi', 'mkv', 'r3d', 'braw', 'mts', 'm2ts', 'flv', 'webm', 'dv', 'vob', 'mpg', 'mpeg'],
                'Music & SFX': ['wav', 'mp3', 'aac', 'aiff', 'aif', 'm4a', 'flac', 'ogg', 'wma'],
                'Images': ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'psd', 'ai', 'gif', 'tga', 'exr', 'dpx', 'bmp', 'svg', 'eps', 'heic', 'webp'],
                'VFX & Motion': ['mogrt', 'aegraphic', 'aep', 'aet', 'prgraphic', 'c4d'],
                'Mascaras': ['prm', 'prmf', 'mask'],
                'Docs': ['pdf'],
                'Z_Others': ['doc', 'docx', 'txt', 'rtf', 'pages', 'xls', 'xlsx', 'csv', 'pptx', 'zip', 'rar', '7z', 'srt', 'xml']
            },
            'Documental': {
                '_Secuencias': [], 'Entrevistas': ['mp4', 'mov', 'mxf'], 'Audio': ['wav', 'mp3', 'aac', 'aiff', 'm4a', 'flac'],
                'Images': ['jpg', 'jpeg', 'png', 'tiff', 'psd'], 'Docs': ['pdf', 'doc', 'docx', 'txt'], 'Z_Others': []
            },
            'YouTube/Reel': {
                '_Secuencias': [], 'Footage': ['mp4', 'mov', 'mxf', 'mkv', 'avi'], 'Music & SFX': ['wav', 'mp3', 'aac', 'aiff', 'm4a'],
                'Graphics': ['mogrt', 'aegraphic', 'png', 'jpg', 'psd', 'svg'], 'Docs': ['pdf', 'txt'], 'Z_Others': []
            },
            'Publicidad': {
                '_Secuencias': [], 'Footage': ['mp4', 'mov', 'mxf', 'avi', 'mkv', 'r3d', 'braw'], 'Audio': ['wav', 'mp3', 'aac', 'aiff', 'm4a'],
                'Graphics': ['mogrt', 'aegraphic', 'png', 'jpg', 'psd', 'ai', 'svg'], 'VFX': ['aep', 'aet', 'c4d', 'prgraphic'],
                'Docs': ['pdf', 'doc', 'docx'], 'Z_Others': []
            },
            'Ficción': {
                '_Secuencias': [], 'Camera': ['mp4', 'mov', 'mxf', 'mkv', 'avi', 'r3d', 'braw'], 'Audio': ['wav', 'mp3', 'aac', 'aiff'],
                'VFX': ['aep', 'aet', 'c4d', 'mogrt', 'aegraphic'], 'Images': ['jpg', 'jpeg', 'png', 'tiff', 'psd'],
                'Docs': ['pdf', 'doc', 'docx'], 'Z_Others': []
            },
            'Personalizado': {
                '_Secuencias': [], 'Videos': ['mp4', 'mov'], 'Audio': ['wav', 'mp3'], 'Images': ['jpg', 'jpeg', 'png'], 'Docs': ['pdf'], 'Z_Others': []
            }
        };
    },

    getProfilesJSON: function () { return JSON.stringify(this.getProfiles()); },

    /** Para órdenes que cambian el proyecto: un JSON ilegible es un error, nunca un «no hacer nada» silencioso. */
    parseStrict: function (json) {
        if (!json) throw new Error('Datos vacíos recibidos del panel.');
        return typeof json === 'string' ? JSON.parse(json) : json;
    },

    parseConfig: function (configJSON) {
        if (!configJSON) return {};
        try { return typeof configJSON === 'string' ? JSON.parse(configJSON) : configJSON; } catch (e) { return {}; }
    },

    getProfileCategories: function (profileName, configJSON) {
        var profiles = this.getProfiles();
        var selected = profiles[profileName] || profiles['Estándar'];
        var categories = {}, name;
        for (name in selected) if (selected.hasOwnProperty(name)) categories[name] = selected[name].slice(0);
        var config = this.parseConfig(configJSON);
        if (config.categories) {
            for (name in config.categories) {
                if (config.categories.hasOwnProperty(name) && config.categories[name] instanceof Array) categories[name] = config.categories[name];
            }
        }
        return categories;
    },

    exportProfile: function (profileJSON) {
        try {
            var profile = this.parseConfig(profileJSON);
            var name = String(profile.name || 'BinFlow_Custom').replace(/[^a-zA-Z0-9_-]/g, '_');
            var folder = new Folder(Folder.userData.fsName + '/BinFlow/Profiles');
            if (!folder.exists) folder.create();
            var path = folder.fsName + '/' + name + '.json';
            if (!this.writeTextFile(path, JSON.stringify(profile))) return this.fail('No se pudo guardar la plantilla.');
            return this.ok({ path: path });
        } catch (e) { return this.fail(e); }
    },

    deleteProfile: function (profileName) {
        try {
            var name = String(profileName || '');
            if (name !== 'Personalizado') return this.fail('Las plantillas predefinidas no se pueden borrar.');
            var file = new File(Folder.userData.fsName + '/BinFlow/Profiles/' + name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
            if (file.exists && !file.remove()) return this.fail('No se pudo borrar la plantilla.');
            return this.ok();
        } catch (e) { return this.fail(e); }
    },

    importProfile: function () {
        try {
            var file = File.openDialog('Selecciona una plantilla BinFlow', 'JSON:*.json');
            if (!file) return JSON.stringify({ status: 'CANCELLED' });
            if (file.length > 256 * 1024) return this.fail('La plantilla es demasiado grande.');
            var content = this.readTextFile(file.fsName);
            if (content === null) return this.fail('No se pudo leer la plantilla.');
            var profile = JSON.parse(content);
            var clean = { name: String(profile.name || 'Importada').slice(0, 80), assetsFolderName: String(profile.assetsFolderName || '01 Assets').slice(0, 120), categories: {} };
            for (var category in (profile.categories || {})) {
                if (!profile.categories.hasOwnProperty(category) || !(profile.categories[category] instanceof Array)) continue;
                var exts = [];
                for (var i = 0; i < profile.categories[category].length && i < 200; i++) {
                    var ext = String(profile.categories[category][i]).toLowerCase().replace(/[^a-z0-9]/g, '');
                    if (ext) exts.push(ext);
                }
                clean.categories[String(category).slice(0, 80)] = exts;
            }
            return this.ok({ profile: clean, path: file.fsName });
        } catch (e) { return this.fail(e); }
    },

    // ------------------------------------------------------------ Archivos

    writeTextFile: function (path, content) {
        var file = new File(path);
        file.encoding = 'UTF-8';
        if (!file.open('w')) return false;
        file.write(content);
        file.close();
        return true;
    },

    readTextFile: function (path) {
        var file = new File(path);
        if (!file.exists) return null;
        file.encoding = 'UTF-8';
        if (!file.open('r')) return null;
        var content = file.read();
        file.close();
        return content;
    },

    /** Ruta del proyecto activo (las acciones de Finder las hace el panel con Node, sin shell). */
    getProjectInfo: function () {
        try {
            var info = this.requireSavedProject();
            return this.ok({ projectPath: info.projectPath, projectFolder: info.projectFolder, projectName: info.project.name });
        } catch (e) { return this.fail(e.message || e); }
    },

    // ------------------------------------------------------------ Árbol del proyecto

    binPathArray: function (bin) {
        var parts = [], current = bin;
        while (current && current.parent) { parts.unshift(current.name); current = current.parent; }
        return parts;
    },

    getBinPath: function (bin) { return this.binPathArray(bin).join('/'); },

    isSequenceItem: function (item) {
        try { if (item.isSequence && item.isSequence()) return true; } catch (e) {}
        return false;
    },

    indexByNodeId: function (bin, index) {
        index = index || {};
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];
            if (!item) continue;
            index[item.nodeId] = item;
            if (item.type === 2) this.indexByNodeId(item, index);
        }
        return index;
    },

    findBin: function (root, parts) {
        var current = root;
        for (var i = 0; i < parts.length; i++) {
            var found = null;
            for (var j = 0; j < current.children.numItems; j++) {
                var child = current.children[j];
                if (child && child.type === 2 && child.name === parts[i]) { found = child; break; }
            }
            if (!found) return null;
            current = found;
        }
        return current;
    },

    getOrCreateBin: function (root, parts) {
        var current = root;
        for (var i = 0; i < parts.length; i++) {
            var found = this.findBin(current, [parts[i]]);
            if (!found) {
                found = current.createBin(parts[i]);
                if (!found) found = this.findBin(current, [parts[i]]);
            }
            if (!found) throw new Error('No se pudo crear el BIN ' + parts.slice(0, i + 1).join('/'));
            current = found;
        }
        return current;
    },

    getAllMediaItems: function (bin, list) {
        for (var i = 0; i < bin.children.numItems; i++) {
            var item = bin.children[i];
            if (!item) continue;
            if (item.type === 2) this.getAllMediaItems(item, list);
            else if ((item.type === 1 || item.type === 4) && item.getMediaPath && item.getMediaPath() !== '') list.push(item);
        }
    },

    isBinEffectivelyEmpty: function (bin) {
        if (!bin || bin.type !== 2) return false;
        for (var i = 0; i < bin.children.numItems; i++) {
            var child = bin.children[i];
            if (child.type !== 2) return false;
            if (!this.isBinEffectivelyEmpty(child)) return false;
        }
        return true;
    },

    /**
     * Foto del proyecto para el motor: cada ítem con su BIN y su ruta de medio.
     * No modifica nada.
     */
    getProjectSnapshot: function (profileName, configJSON) {
        try {
            var info = this.requireSavedProject();
            var config = this.parseConfig(configJSON);
            var items = [], proxyPaths = [], self = this;
            (function walk(bin, path) {
                for (var i = 0; i < bin.children.numItems; i++) {
                    var item = bin.children[i];
                    if (!item) continue;
                    if (item.type === 2) { walk(item, path.concat([item.name])); continue; }
                    var mediaPath = '';
                    try { mediaPath = item.getMediaPath ? self.normalizePath(item.getMediaPath()) : ''; } catch (e) {}
                    var kind = self.isSequenceItem(item) ? 'sequence' : (mediaPath ? 'media' : 'synthetic');
                    items.push({ nodeId: item.nodeId, name: item.name, kind: kind, mediaPath: kind === 'media' ? mediaPath : '', binPath: path });
                    // N16: los proxies enlazados también son archivos que el proyecto usa.
                    try {
                        if (item.hasProxy && item.hasProxy() && item.getProxyPath) {
                            var proxyPath = self.normalizePath(item.getProxyPath());
                            if (proxyPath) proxyPaths.push(proxyPath);
                        }
                    } catch (proxyError) {}
                }
            }(info.project.rootItem, []));
            return this.ok({
                projectPath: info.projectPath,
                projectFolder: info.projectFolder,
                projectName: info.project.name,
                profile: profileName || 'Estándar',
                assetsFolderName: config.assetsFolderName || '01 Assets',
                categories: this.getProfileCategories(profileName, configJSON),
                items: items,
                proxyPaths: proxyPaths
            });
        } catch (e) { return this.fail(e.message || e); }
    },

    /**
     * Aplica en Premiere el resultado del motor.
     * payload = { relinks: [{nodeId, to}], binMoves: [{binPath, targetParent}], items: [{nodeId, targetBin}],
     *             organizeBins: bool, categories: [nombres], binsDir }
     */
    applyOrganization: function (payloadJSON) {
        try {
            var info = this.requireSavedProject();
            var payload = this.parseStrict(payloadJSON);
            this.assertSameProject(info, payload);
            if (!(payload.relinks instanceof Array)) throw new Error('Datos del panel incompletos (relinks).');
            var root = info.project.rootItem;
            var index = this.indexByNodeId(root);
            var stats = { relinked: 0, relinkFailed: [], binMoved: 0, binFailed: [], emptied: 0 };
            var undo = [];
            var i;

            // 1) Re-enlazar medios movidos o copiados.
            var relinks = payload.relinks || [];
            for (i = 0; i < relinks.length; i++) {
                var r = relinks[i], item = index[r.nodeId];
                if (!item) { stats.relinkFailed.push({ name: r.nodeId, message: 'El ítem ya no existe en el proyecto.' }); continue; }
                try {
                    var current = this.normalizePath(item.getMediaPath());
                    if (this.sameFile(current, r.to)) { stats.relinked++; continue; }
                    if (item.canChangeMediaPath && !item.canChangeMediaPath()) throw new Error('Premiere no permite cambiar la ruta de este ítem.');
                    item.changeMediaPath(r.to, true);
                    if (this.sameFile(this.normalizePath(item.getMediaPath()), r.to)) stats.relinked++;
                    else throw new Error('La ruta no se actualizó.');
                } catch (relinkError) {
                    stats.relinkFailed.push({ name: item.name, path: r.to, message: relinkError.message || String(relinkError) });
                }
            }

            // 2) BINs.
            if (payload.organizeBins) {
                var touched = [];
                var moves = payload.binMoves || [];
                for (i = 0; i < moves.length; i++) {
                    var bin = this.findBin(root, moves[i].binPath);
                    if (!bin) continue;
                    try {
                        var parent = this.getOrCreateBin(root, moves[i].targetParent);
                        if (bin.parent && bin.parent.nodeId === parent.nodeId) continue;
                        undo.push({ nodeId: bin.nodeId, name: bin.name, fromBin: this.binPathArray(bin.parent), toBin: this.binPathArray(parent) });
                        touched.push(bin.parent);
                        bin.moveBin(parent);
                        stats.binMoved++;
                    } catch (binError) { stats.binFailed.push({ name: moves[i].binPath.join('/'), message: binError.message || String(binError) }); }
                }
                var targets = payload.items || [];
                for (i = 0; i < targets.length; i++) {
                    var target = targets[i], projectItem = index[target.nodeId];
                    if (!projectItem || !target.targetBin) continue;
                    var from = this.binPathArray(projectItem.parent);
                    if (from.join('\u0001') === target.targetBin.join('\u0001')) continue;
                    try {
                        var destination = target.targetBin.length ? this.getOrCreateBin(root, target.targetBin) : root;
                        undo.push({ nodeId: projectItem.nodeId, name: projectItem.name, fromBin: from, toBin: this.binPathArray(destination) });
                        touched.push(projectItem.parent);
                        projectItem.moveBin(destination);
                        stats.binMoved++;
                    } catch (itemError) { stats.binFailed.push({ name: projectItem.name, message: itemError.message || String(itemError) }); }
                }
                // BINs que se han quedado vacíos por la organización → (Carpetas Vacias)
                var categories = payload.categories || [];
                var seen = {};
                for (i = 0; i < touched.length; i++) {
                    var b = touched[i];
                    while (b && b.parent && b.type === 2) {
                        var up = b.parent;
                        if (!seen[b.nodeId] && b.name !== this.EMPTY_BIN && !(up === root && this.inArray(categories, b.name)) && this.isBinEffectivelyEmpty(b)) {
                            seen[b.nodeId] = true;
                            undo.push({ nodeId: b.nodeId, name: b.name, fromBin: this.binPathArray(up), toBin: [this.EMPTY_BIN] });
                            b.moveBin(this.getOrCreateBin(root, [this.EMPTY_BIN]));
                            stats.emptied++;
                        }
                        b = up;
                    }
                }
            }

            stats.undoSaved = true;
            if (undo.length) {
                var binsFolder = payload.binsDir ? new Folder(payload.binsDir) : null;
                if (!binsFolder || (!binsFolder.exists && !binsFolder.create()) || !this.writeTextFile(binsFolder.fsName + '/bins.json', JSON.stringify({ createdAt: new Date().toString(), entries: undo }))) {
                    stats.undoSaved = false;
                }
            }
            try { info.project.save(); } catch (saveError) { stats.saveError = saveError.message || String(saveError); }
            stats.requested = relinks.length;
            var problems = stats.relinkFailed.length || stats.binFailed.length || !stats.undoSaved || stats.saveError;
            return this.ok({ status: problems ? 'WARNING' : 'SUCCESS', stats: stats });
        } catch (e) { return this.fail(e.message || e); }
    },

    /** Busca un ítem por nodeId; si no existe (proyecto reabierto), por ruta de medio. */
    findItemForRelink: function (index, root, entry, used) {
        used = used || {};
        if (index[entry.nodeId] && !used[entry.nodeId]) { used[entry.nodeId] = true; return index[entry.nodeId]; }
        if (!entry.current) return null;
        for (var id in index) {
            if (!index.hasOwnProperty(id) || used[id]) continue; // N23: un ítem ya devuelto no se vuelve a coger
            var item = index[id];
            try {
                if (item.type !== 2 && item.getMediaPath && this.sameFile(this.normalizePath(item.getMediaPath()), entry.current)) { used[id] = true; return item; }
            } catch (e) {}
        }
        return null;
    },

    /** Busca un ítem o BIN por nodeId; si no existe, por nombre dentro del BIN donde quedó. */
    findItemForBin: function (index, root, entry) {
        if (index[entry.nodeId]) return index[entry.nodeId];
        if (!entry.toBin || !entry.name) return null;
        var bin = entry.toBin.length ? this.findBin(root, entry.toBin) : root;
        if (!bin) return null;
        for (var i = 0; i < bin.children.numItems; i++) if (bin.children[i] && bin.children[i].name === entry.name) return bin.children[i];
        return null;
    },

    /**
     * Deshace en Premiere: vuelve a enlazar las rutas originales y devuelve cada ítem a su BIN.
     * payload = { relinks: [{nodeId, path, current}], binsDir }
     */
    applyUndo: function (payloadJSON) {
        try {
            var info = this.requireSavedProject();
            var payload = this.parseStrict(payloadJSON);
            this.assertSameProject(info, payload);
            var root = info.project.rootItem;
            var index = this.indexByNodeId(root);
            var relinked = 0, binsRestored = 0, failed = [], i;
            var relinks = payload.relinks || [];
            var usedItems = {};
            for (i = 0; i < relinks.length; i++) {
                var item = this.findItemForRelink(index, root, relinks[i], usedItems);
                if (!item) { failed.push({ name: relinks[i].current || relinks[i].nodeId, message: 'No se encontró el ítem en el proyecto.' }); continue; }
                try {
                    if (!this.sameFile(this.normalizePath(item.getMediaPath()), relinks[i].path)) item.changeMediaPath(relinks[i].path, true);
                    if (this.sameFile(this.normalizePath(item.getMediaPath()), relinks[i].path)) relinked++;
                    else throw new Error('La ruta no se actualizó.');
                } catch (e1) { failed.push({ name: item.name, message: e1.message || String(e1) }); }
            }
            var binsFile = payload.binsDir ? payload.binsDir + '/bins.json' : null;
            var content = binsFile ? this.readTextFile(binsFile) : null;
            var entries = [];
            if (content) {
                try { entries = JSON.parse(content).entries || []; }
                catch (parseError) { failed.push({ name: 'bins.json', message: 'Registro de BINs ilegible.' }); }
            }
            for (i = entries.length - 1; i >= 0; i--) {
                var projectItem = this.findItemForBin(index, root, entries[i]);
                if (!projectItem) { failed.push({ name: entries[i].name || entries[i].nodeId, message: 'No se encontró el ítem.' }); continue; }
                try {
                    var target = entries[i].fromBin.length ? this.getOrCreateBin(root, entries[i].fromBin) : root;
                    if (!projectItem.parent || projectItem.parent.nodeId !== target.nodeId) projectItem.moveBin(target);
                    binsRestored++;
                } catch (e2) { failed.push({ name: projectItem.name, message: e2.message || String(e2) }); }
            }
            if (content && !failed.length) (new File(binsFile)).rename('bins.deshecho.json');
            try { info.project.save(); } catch (saveError) { failed.push({ name: 'Proyecto', message: 'No se pudo guardar: ' + saveError }); }
            var nothing = (relinks.length || entries.length) && !relinked && !binsRestored;
            return this.ok({ status: failed.length || nothing ? 'WARNING' : 'SUCCESS', relinked: relinked, binsRestored: binsRestored, requested: relinks.length + entries.length, failed: failed });
        } catch (e) { return this.fail(e.message || e); }
    },

    inArray: function (arr, value) {
        for (var i = 0; i < arr.length; i++) if (arr[i] === value) return true;
        return false;
    },

    // ------------------------------------------------------------ Diagnóstico

    healthCheck: function () {
        try {
            var info = this.requireSavedProject();
            var items = [];
            this.getAllMediaItems(info.project.rootItem, items);
            var noBin = [], offline = [], names = {}, duplicates = [], emptyBins = [], self = this;
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.parent === info.project.rootItem) noBin.push(item.name);
                var mediaPath = this.normalizePath(item.getMediaPath());
                if (mediaPath && !(new File(mediaPath)).exists) offline.push({ name: item.name, path: mediaPath });
                var key = String(item.name || '').toLowerCase();
                if (names[key]) duplicates.push({ name: item.name, first: names[key], second: this.getBinPath(item.parent) });
                else names[key] = this.getBinPath(item.parent);
            }
            (function scan(bin) {
                for (var j = 0; j < bin.children.numItems; j++) {
                    var child = bin.children[j];
                    if (child && child.type === 2) {
                        if (self.isBinEffectivelyEmpty(child)) emptyBins.push(self.getBinPath(child));
                        else scan(child);
                    }
                }
            }(info.project.rootItem));
            return this.ok({ noBin: noBin, offline: offline, duplicates: duplicates, emptyBins: emptyBins });
        } catch (e) { return this.fail(e.message || e); }
    },

    getDebugLog: function () {
        var result = { premiereVersion: 'N/A', os: 'N/A', projectOpen: false, projectName: '', projectPath: '', projectSaved: false, totalItems: 0, offlineItems: 0, lastError: '' };
        try {
            result.premiereVersion = app.version || 'Unknown';
            result.os = $.os || 'Unknown';
            if (app.project) {
                result.projectOpen = true;
                result.projectName = app.project.name || 'Sin nombre';
                var path = this.normalizePath(app.project.path);
                result.projectSaved = !!path && (new File(path)).exists;
                result.projectPath = path || '(no guardado)';
                var items = [];
                this.getAllMediaItems(app.project.rootItem, items);
                result.totalItems = items.length;
                for (var i = 0; i < items.length; i++) if (!(new File(this.normalizePath(items[i].getMediaPath()))).exists) result.offlineItems++;
            }
        } catch (e) { result.lastError = e.toString(); }
        return JSON.stringify(result);
    }
};
