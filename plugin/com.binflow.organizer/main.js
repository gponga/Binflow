/**
 * BinFlow - v2.5.0 (interfaz nueva, Fase 1)
 * Panel: Inicio → Analizando → Así quedará → Organizando → Hecho (+ Deshacer / Recuperar).
 * El disco lo gestiona ./engine (Node); Premiere, host/ext.jsx; los textos y el estado de
 * cada pantalla salen de ./ui/ui-logic.js (funciones puras con pruebas). Aquí NO hay lógica de negocio.
 * Estilo ES5: el Chromium y el Node de CEP son antiguos.
 */
(function() {
    'use strict';

    var UI = window.BinFlowUI;
    var csInterface = new CSInterface();
    var nodeRequire = (window.cep_node && window.cep_node.require) || (typeof window.require === 'function' ? window.require : null);
    var engine = null;
    var APP_VERSION = '2.5.0';
    var updater = null;

    function getEngine() {
        if (engine) return engine;
        if (!nodeRequire) throw new Error('Node.js no está activo en el panel. Reinstala BinFlow con el instalador.');
        var nodePath = nodeRequire('path');
        // CSInterface oficial ya devuelve la ruta decodificada y sin file://
        var extensionPath = csInterface.getSystemPath(SystemPath.EXTENSION);
        engine = nodeRequire(nodePath.join(extensionPath, 'engine', 'index.js'));
        return engine;
    }

    function extensionDir() { return csInterface.getSystemPath(SystemPath.EXTENSION); }
    function getUpdater() {
        if (updater) return updater;
        if (!nodeRequire) throw new Error('Node.js no está activo en el panel.');
        updater = nodeRequire(nodeRequire('path').join(extensionDir(), 'engine', 'updater.js'));
        return updater;
    }
    function currentVersion() { try { return getEngine().version; } catch (e) { return APP_VERSION; } }

    /**
     * Argumento seguro para evalScript: JSON en ASCII puro (todo lo no ASCII como \\uXXXX),
     * así ni U+2028/2029 ni ningún carácter raro llega crudo al eval de ExtendScript (ES3).
     */
    function jsxArg(value) {
        var text = typeof value === 'string' ? value : JSON.stringify(value);
        var ascii = function(str) { return str.replace(/[\u007f-￿]/g, function(c) { return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4); }); };
        return ascii(JSON.stringify(ascii(text)));
    }

    function evalJSX(script) {
        return new Promise(function(resolve, reject) {
            csInterface.evalScript(script, function(result) {
                var data;
                try { data = JSON.parse(result); } catch (e) { reject(new Error(result === 'EvalScript error.' ? 'Error interno de Premiere (ExtendScript).' : String(result))); return; }
                if (data && data.status === 'ERROR') reject(new Error(data.message || 'Error en Premiere.'));
                else resolve(data);
            });
        });
    }

    var isMac = navigator.platform.indexOf('Mac') === 0;

    /** Acciones de Finder/Explorador con execFile (sin shell: ninguna ruta se interpreta como comando). */
    function openPath(filePath) {
        var cp = nodeRequire && nodeRequire('child_process');
        if (cp && isMac) { cp.execFile('/usr/bin/open', [filePath]); return; }
        if (cp) { cp.execFile('explorer.exe', [filePath]); return; }
        csInterface.openURLInDefaultBrowser('file:///' + encodeURI(filePath.replace(/\\/g, '/')).replace(/^\/+/, ''));
    }

    function revealPath(filePath) {
        var cp = nodeRequire && nodeRequire('child_process');
        if (!cp) throw new Error('Node.js no está activo en el panel.');
        if (isMac) cp.execFile('/usr/bin/open', ['-R', filePath]);
        else cp.execFile('explorer.exe', ['/select,', filePath]);
    }

    function copyText(text) {
        var cp = nodeRequire && nodeRequire('child_process');
        if (!cp) throw new Error('Node.js no está activo en el panel.');
        var child = cp.spawn(isMac ? '/usr/bin/pbcopy' : 'clip.exe', [], { stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end(text, 'utf8');
    }

    /** Selector de carpetas del sistema (CEP). Devuelve la ruta o null si se cancela. */
    function pickFolder(title) {
        var fs = window.cep && window.cep.fs;
        if (!fs || !fs.showOpenDialogEx) throw new Error('El selector de carpetas no está disponible en este panel.');
        var r = fs.showOpenDialogEx(false, true, title, '', []);
        if (r && r.err === 0 && r.data && r.data.length) return r.data[0];
        return null;
    }

    function esc(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    // ================================================================ Estado
    var settingsKey = 'binflow.settings.v1';
    var modeKey = 'binflow.mode.v2';
    var saved = {};
    function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
    function lsSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* sin almacenamiento: no pasa nada */ } }
    try { saved = JSON.parse(lsGet(settingsKey) || '{}') || {}; } catch (e) { saved = {}; }

    var st = {
        screen: 'home',
        mode: lsGet(modeKey) || 'both',          // por defecto: analizar y organizar
        runMode: 'both',                         // modo de la ejecución en curso (puede ser «analysis»)
        profile: saved.profile || 'Estándar',
        assetsFolderName: saved.assetsFolderName || '01 Assets',
        moveManual: saved.moveManual !== false,   // mover también gráficos de Adobe (.aegraphic, .mogrt…): activado por defecto
        categories: saved.categories ? toCatList(saved.categories) : null,
        plan: null, snapshotCategories: [], rootOverride: null, confirmed: false,
        info: null, infoError: null, undoBtn: null,
        busy: false, pct: 0, step: 0, msg: '', compare: 'after',
        update: null, updateBusy: false, updated: null,
        problem: null, done: null, undone: null, undoKind: 'undo', stopped: null,
        lastReports: null, paths: [], toast: '', signal: null, workTitle: '', healthLines: null, debugText: ''
    };
    if (['both', 'bin', 'finder'].indexOf(st.mode) === -1) st.mode = 'both';

    function toCatList(obj) { return Object.keys(obj || {}).map(function(k) { return { folder: k, exts: (obj[k] || []).join(', ') }; }); }
    function catsToObject(list) {
        var out = {};
        list.forEach(function(c) {
            var folder = String(c.folder || '').trim();
            var exts = String(c.exts || '').split(',').map(function(v) { return v.trim().replace(/^\./, '').toLowerCase(); }).filter(Boolean);
            if (folder) out[folder] = exts;
        });
        return out;
    }
    function getConfig() { return { assetsFolderName: String(st.assetsFolderName || '').trim() || '01 Assets', categories: catsToObject(st.categories || []) }; }
    function saveSettings() {
        lsSet(settingsKey, JSON.stringify({ profile: st.profile, assetsFolderName: getConfig().assetsFolderName, categories: getConfig().categories, moveManual: !!st.moveManual }));
        lsSet(modeKey, st.mode);
    }
    function ensureCategories() {
        if (st.categories && st.categories.length) return Promise.resolve();
        return loadProfileCategories();
    }
    function loadProfileCategories() {
        return evalJSX('gpOrganizer.getProfilesJSON()').then(function(profiles) {
            st.categories = toCatList(profiles[st.profile] || profiles['Estándar'] || {});
        });
    }

    // ================================================================ Tema (claro/oscuro según Premiere)
    function applyTheme() {
        var theme = 'dark';
        try {
            var c = csInterface.getHostEnvironment().appSkinInfo.panelBackgroundColor.color;
            if ((c.red + c.green + c.blue) / 3 > 140) theme = 'light';
        } catch (e) {
            try { var q = /[?&]theme=(light|dark)/.exec(location.search); if (q) theme = q[1]; } catch (e2) { /* dark */ }
        }
        document.documentElement.setAttribute('data-theme', theme);
    }
    try { csInterface.addEventListener(CSInterface.THEME_COLOR_CHANGED_EVENT, applyTheme); } catch (e) { /* sin host */ }
    applyTheme();

    // ================================================================ Piezas de pantalla
    var screenEl = document.getElementById('screen');
    function go(screen) { st.screen = screen; render(); try { window.scrollTo(0, 0); } catch (e) { /* ok */ } }

    function top() {
        return '<div class="top"><span class="brand">BinFlow<i>' + APP_VERSION + '</i></span><a class="link" href="como_funciono.html">Ayuda</a></div>';
    }
    function btn(label, act, cls, extra) { return '<button class="btn ' + (cls || '') + '" data-act="' + act + '"' + (extra || '') + '>' + label + '</button>'; }
    function actionBtn(a) {
        if (a.soon) return '<button class="btn ' + (a.kind === 'primary' ? '' : a.kind) + ' soon" disabled title="Próximamente">' + esc(a.label) + '<small>Próximamente</small></button>';
        return btn(esc(a.label), a.id, a.kind === 'primary' ? '' : a.kind);
    }
    function pathList(list) {
        var shown = list.slice(0, 8);
        var html = '<ul class="plist">' + shown.map(function(x) {
            var i = st.paths.push(x.path || '') - 1;
            return '<li><b>' + esc(x.name) + '</b>' + (x.size ? ' <span class="sz">' + esc(x.size) + '</span>' : '') +
                '<code style="white-space:pre-wrap">' + esc(x.path || '') + '</code>' + (x.note ? '<span class="note">' + esc(x.note) + '</span>' : '') +
                '<span class="row-actions"><button data-act="copy-path" data-i="' + i + '">Copiar ruta</button><button data-act="reveal" data-i="' + i + '">Mostrar en ' + (isMac ? 'Finder' : 'el Explorador') + '</button></span></li>';
        }).join('') + '</ul>';
        if (list.length > shown.length) html += '<p class="sub" style="margin-top:6px">…y ' + (list.length - shown.length) + ' más (están en el informe).</p>';
        return html;
    }
    function detailsBlock(lines) {
        if (!lines || !lines.length) return '';
        return '<details><summary>Ver detalles</summary><ul>' + lines.map(function(l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul></details>';
    }
    function linesBlock(lines) {
        if (!lines || !lines.length) return '';
        return '<details><summary>Ver detalles</summary><ul>' + lines.map(function(l) { return '<li><b>' + esc(l.title) + ':</b> ' + esc(l.text) + '</li>'; }).join('') + '</ul></details>';
    }
    function toastLine() { return '<div class="toast" id="toast" aria-live="polite">' + esc(st.toast || '') + '</div>'; }
    function setToast(msg) { st.toast = msg; var t = document.getElementById('toast'); if (t) t.textContent = msg; }

    // ================================================================ Pantallas
    var V = {};

    V.home = function() {
        var b = st.undoBtn;
        if (b && b.kind === 'recover') {
            return '<div class="screen">' + top() + '<h3>Quedó una organización a medias</h3>' +
                '<div class="card warn"><h4>Se cortó el ' + esc(b.stamp) + '</h4><p>Algunos archivos pueden estar a medio mover.</p>' +
                '<p class="why"><b>Por qué no sigo sin más:</b> si organizo encima, podría perder la pista de esos archivos.</p></div>' +
                '<div class="spacer"></div><div class="btns">' + btn('Recuperar', 'undo-ask') +
                detailsBlock(['Recuperar devuelve los archivos movidos a su sitio y limpia los restos temporales.', 'No se borra nada tuyo.']) + '</div></div>';
        }
        var name = st.info ? st.info.projectName : null;
        var mode = null;
        UI.MODES.forEach(function(m) { if (m.id === st.mode) mode = m; });
        var undoLink = b ? '<button class="link" data-act="undo-ask">' + esc(b.label) + ' (' + esc(b.stamp) + ')</button>' : '';
        var pill = st.update ? '<button class="pill" data-act="update-view">' + esc(UI.updateInfo(st.update, currentVersion()).pill) + ' <span>Ver novedades</span></button>' : '';
        return '<div class="screen">' + top() + pill +
            '<div><h3>' + esc(name || 'Sin proyecto') + '</h3><p class="sub">' + (name ? 'Proyecto abierto en Premiere' : 'Abre y guarda un proyecto en Premiere para empezar') + '</p></div>' +
            (st.infoError ? '<div class="card warn"><h4>Todavía no puedo ver el proyecto</h4><p>' + esc(UI.humanError(st.infoError)) + '</p></div>' :
                '<div class="card info"><h4>Ordena tu proyecto en un clic</h4><p>Colocará bins y archivos con la misma estructura. Antes de tocar nada te enseño qué va a pasar.</p></div>') +
            '<div class="mode"><span>' + esc(mode ? mode.label.replace(' (recomendado)', '') : '') + ' · <b>' + esc(st.profile) + '</b></span><button class="link" data-act="settings">Cambiar</button></div>' +
            '<div class="spacer"></div><div class="btns">' + btn('Analizar y organizar', 'start') +
            btn('Solo ver qué hay (no cambia nada)', 'start-analysis', 'ghost') + undoLink + '</div>' +
            '</div>';
    };

    V.settings = function() {
        var modes = UI.MODES.map(function(m) {
            return '<button class="' + (m.id === st.mode ? 'on' : '') + '" data-act="set-mode" data-mode="' + m.id + '">' + esc(m.label) + '<small>' + esc(m.help) + '</small></button>';
        }).join('');
        var profiles = ['Estándar', 'Documental', 'YouTube/Reel', 'Publicidad', 'Ficción', 'Personalizado'].map(function(p) {
            return '<option' + (p === st.profile ? ' selected' : '') + '>' + esc(p) + '</option>';
        }).join('');
        var cats = (st.categories || []).map(function(c, i) {
            return '<div class="cat" data-i="' + i + '"><label>Carpeta de destino<input class="cat-folder" type="text" value="' + esc(c.folder) + '"></label>' +
                '<label>Extensiones<input class="cat-exts" type="text" value="' + esc(c.exts) + '"></label><button class="mini" data-act="cat-remove" data-i="' + i + '">Eliminar</button></div>';
        }).join('');
        var last = lsGet('binflow.lastProfile'), warn = '';
        if (last && last !== st.profile && Number(lsGet('binflow.organized.count') || 0) > 0) {
            warn = '<div class="card warn"><p style="color:var(--ink)">Este proyecto ya se organizó con la plantilla «' + esc(last) + '». Cambiarla puede crear una estructura distinta.</p></div>';
        }
        return '<div class="screen">' + top() + '<h3>Ajustes</h3>' +
            '<p class="sub">Qué quieres ordenar</p><div class="seg col">' + modes + '</div>' +
            '<label class="field">Plantilla<select id="profile" data-change="profile">' + profiles + '</select></label>' + warn +
            '<label class="toggle"><input id="move-manual" type="checkbox"' + (st.moveManual ? ' checked' : '') + '><span>Mover también gráficos de Adobe (.aegraphic, .mogrt…)<small>Premiere no los re-enlaza: quedarán sin conexión y tendrás que relinkarlos a mano. Apagado, se dejan donde están.</small></span></label>' +
            '<details><summary>Ajustes avanzados</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">' +
            '<label class="field">Nombre de la carpeta de assets<input id="assets" type="text" value="' + esc(st.assetsFolderName) + '"></label>' +
            '<p class="sub">Estas categorías deciden dónde se guardan los archivos. Se conservan las carpetas internas que ya existan.</p>' +
            cats + '<div class="minis"><button class="mini" data-act="cat-add">+ Añadir categoría</button><button class="mini" data-act="profile-export">Exportar plantilla</button>' +
            '<button class="mini" data-act="profile-import">Importar plantilla</button><button class="mini" data-act="profile-delete">Borrar plantilla</button></div></div></details>' +
            '<details><summary>Diagnóstico</summary><div style="display:flex;flex-direction:column;gap:8px;margin-top:10px"><div class="minis"><button class="mini" data-act="health">Salud del proyecto</button><button class="mini" data-act="debug-run">Ejecutar diagnóstico</button></div>' +
            (st.debugText ? '<div class="debug">' + esc(st.debugText) + '</div>' : '') + '</div></details>' +
            toastLine() + '<div class="spacer"></div><div class="btns">' + btn('Guardar', 'settings-save') + '</div></div>';
    };

    V.analyzing = function() {
        var steps = ['Leyendo el proyecto', 'Buscando tus archivos', 'Preparando la vista previa'];
        var li = steps.map(function(s, i) { return '<li class="' + (i < st.step ? 'done' : (i === st.step ? 'on' : '')) + '">' + s + '</li>'; }).join('');
        return '<div class="screen">' + top() + '<h3>Mirando tu proyecto…</h3><p class="sub">Solo leo. No se cambia nada.</p>' +
            '<div class="bar"><i id="bar" style="width:' + st.pct + '%"></i></div><ul class="steps">' + li + '</ul></div>';
    };

    V.problem = function() {
        var p = st.problem;
        var badge = p.safety ? '<span class="badge bad">Por seguridad me paro</span>' : '<span class="badge warn">Hay un problema</span>';
        var body = '<p style="color:var(--ink)">' + esc(p.body) + '</p>' + (p.listTitle ? '<p style="margin-top:8px">' + esc(p.listTitle) + '</p>' : '') + (p.list.length ? pathList(p.list) : '') +
            (p.why ? '<p class="why"><b>Por qué:</b> ' + esc(p.why) + '</p>' : '');
        return '<div class="screen">' + top() + badge + '<h3>' + esc(p.title) + '</h3><div class="card bad">' + body + '</div>' + toastLine() +
            '<div class="spacer"></div><div class="btns">' + p.actions.map(actionBtn).join('') + detailsBlock(p.details) + '</div></div>';
    };

    V.notice = function() {
        var items = UI.noticeItems(st.plan, st.runMode);
        var lis = items.map(function(t) { return '<p style="color:var(--ink);margin-bottom:6px">' + esc(t) + '</p>'; }).join('');
        return '<div class="screen">' + top() + '<span class="badge warn">Un aviso</span><h3>Antes de seguir</h3>' +
            '<div class="card warn">' + lis + '</div>' +
            '<div class="spacer"></div><div class="btns">' + btn('Entendido, ver qué va a pasar', 'notice-ok') + btn('Cancelar', 'home', 'sec') + '</div></div>';
    };

    V.result = function() {
        var info = UI.resultInfo(st.plan, st.runMode, { rootOverride: st.rootOverride });
        var nums = info.numbers.map(function(n) { return '<div class="num' + (n.wide ? ' wide' : '') + '"><strong>' + esc(n.value) + '</strong><span>' + esc(n.label) + '</span></div>'; }).join('');
        var chips = info.chips.length ? '<div class="chips">' + info.chips.map(function(c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('') + '</div>' : '';
        var cards = info.cards.map(function(c) {
            return '<div class="card ' + (c.kind === 'info' ? 'info' : (c.kind === 'warn' ? 'warn' : '')) + '"><h4>' + esc(c.title) + '</h4><p>' + esc(c.text) + '</p>' + (c.list ? pathList(c.list) : '') + (c.action ? btn(esc(c.action.label), c.action.id, c.action.kind) : '') + '</div>';
        }).join('');
        var tree = '';
        if (info.tree) {
            var t = info.tree, before = '<span class="d">' + esc(t.folderName) + '/</span>\n ' + t.before.map(esc).join('\n ') + (t.beforeMore ? '\n <span class="d">… y ' + t.beforeMore + ' más, mezclados</span>' : '');
            var after = '<span class="d">' + esc(t.folderName) + '/</span>\n <span class="n">' + esc(t.assetsName) + '/</span>' + t.after.map(function(a) {
                return '\n   ' + (a.unused ? '<span class="u">' + esc(a.name) + '/ ' + a.count + '</span>' : esc(a.name) + '/ <span class="d">' + a.count + '</span>');
            }).join('');
            tree = '<div class="seg"><button data-act="cmp-before" class="' + (st.compare === 'before' ? 'on' : '') + '">Antes</button><button data-act="cmp-after" class="' + (st.compare === 'after' ? 'on' : '') + '">Después</button></div>' +
                '<div class="tree">' + (st.compare === 'before' ? before : after) + '</div>';
        }
        var empty = info.empty ? '<div class="card ok"><h4>Todo está ya organizado</h4><p>No hay nada que mover.</p></div>' : '';
        return '<div class="screen">' + top() + '<div><h3>' + esc(info.title) + '</h3><p class="sub">' + esc(info.sub) + '</p></div>' +
            (nums ? '<div class="nums">' + nums + '</div>' : '') + chips + empty + cards + tree +
            '<p class="sub">Nada se borra ni se sobrescribe. Podrás deshacerlo.</p>' +
            '<div class="spacer"></div><div class="btns">' + btn(esc(info.primary), 'organize', '', info.empty && st.runMode !== 'analysis' ? ' disabled' : '') +
            btn('Cancelar', 'home', 'sec') + btn('Analizar de nuevo', 'analyze', 'ghost') + detailsBlock(info.details) + '</div></div>';
    };

    V.organizing = function() {
        return '<div class="screen">' + top() + '<h3>' + (st.runMode === 'analysis' ? 'Generando informe…' : 'Organizando…') + '</h3>' +
            '<p class="sub">No cierres Premiere. Se guarda cada paso para poder deshacerlo.</p>' +
            '<div class="big" id="pct">' + st.pct + '%</div><div class="bar"><i id="bar" style="width:' + st.pct + '%"></i></div><p class="sub" id="msg">' + esc(st.msg) + '</p>' +
            '<div class="spacer"></div>' + (st.runMode === 'analysis' ? '' : btn('Cancelar', 'cancel-run', 'sec', ' id="cancel"') +
            '<p class="sub" style="text-align:center">Si cancelas, termino el archivo en curso y lo hecho queda en orden.</p>') + '</div>';
    };

    V.stopped = function() {
        return '<div class="screen">' + top() + '<span class="badge warn">Parado</span><h3>Lo he parado a tiempo</h3>' +
            '<div class="card warn"><p style="color:var(--ink)">' + esc(st.stopped.text) + '</p></div>' +
            '<div class="spacer"></div><div class="btns">' + btn('Dejarlo así', 'finish') + btn('Deshacer lo hecho', 'undo-ask', 'sec') + '</div></div>';
    };

    V.done = function() {
        var d = st.done;
        var analysis = st.runMode === 'analysis';
        var nums = analysis ? '' : '<div class="nums"><div class="num"><strong>' + d.moved + '</strong><span>' + UI.plural(d.moved, 'archivo ordenado', 'archivos ordenados') + '</span></div>' +
            '<div class="num"><strong>' + d.binMoved + '</strong><span>' + UI.plural(d.binMoved, 'cambio de bin', 'cambios de bin') + '</span></div>' +
            (d.copied ? '<div class="num wide"><strong>' + d.copied + '</strong><span>' + UI.plural(d.copied, 'externo copiado y verificado', 'externos copiados y verificados') + ' (' + UI.sizeText(d.copiedBytes) + ')</span></div>' : '') + '</div>';
        var save = d.showSave ? '<div class="card save"><h4>No olvides guardar tu proyecto</h4><p>Guárdalo antes de salir (<kbd>' + (isMac ? '⌘ S' : 'Ctrl S') + '</kbd>) para que los cambios surtan efecto.</p></div>' : '';
        var status = d.problems ? '<span class="badge warn">Revisar</span>' : '<div class="check">✓</div>';
        var primary = d.undoFirst ? btn('Deshacer todo', 'undo-ask') + btn('Dejarlo así', 'finish', 'sec') : btn('Listo', 'finish');
        var extra = (st.lastReports ? btn('Abrir informe', 'open-report', 'sec') + btn('Abrir PDF de archivos sin uso', 'open-pdf', 'ghost') : '') +
            (!analysis && !d.undoFirst ? btn('Deshacer', 'undo-ask', 'ghost') : '');
        return '<div class="screen">' + top() + status + '<div><h3>' + esc(d.title) + '</h3><p class="sub">' + esc(d.text) + '</p></div>' + nums + save + toastLine() +
            '<div class="spacer"></div><div class="btns">' + primary + extra + linesBlock(d.lines) + '</div></div>';
    };

    V.update = function() {
        var u = UI.updateInfo(st.update, currentVersion());
        var vs = u.versions.map(function(v) {
            var f = v.features.length ? '<p class="sub" style="margin-top:6px">Qué hace de nuevo</p><ul>' + v.features.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '';
            var i = v.improvements.length ? '<p class="sub" style="margin-top:6px">Mejoras</p><ul>' + v.improvements.map(function(x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '';
            return '<div class="card"><h4>Versión ' + esc(v.version) + (v.date ? ' <span class="sz">' + esc(v.date) + '</span>' : '') + '</h4>' + f + i + '</div>';
        }).join('');
        return '<div class="screen">' + top() + '<h3>' + esc(u.title) + '</h3><p class="sub">' + esc(u.sub) + '</p>' +
            (vs || '') + '<p class="why">' + esc(u.note) + '</p>' + toastLine() +
            '<div class="spacer"></div><div class="btns">' + (st.updateBusy ? btn('Actualizando…', 'noop', '', ' disabled') : btn('Actualizar', 'update-install') + btn('Ahora no', 'home', 'sec')) + '</div></div>';
    };

    V.updated = function() {
        return '<div class="screen">' + top() + '<div class="check">✓</div><div><h3>BinFlow ' + esc(st.updated.version) + ' instalado</h3>' +
            '<p class="sub">Cierra Premiere del todo (⌘ Q) y ábrelo otra vez para usar la versión nueva.</p></div>' +
            '<div class="card info"><p>Tu versión anterior queda guardada por si hiciera falta volver atrás.</p></div>' +
            '<div class="spacer"></div><div class="btns">' + btn('Entendido', 'home') + '</div></div>';
    };

    V.undoask = function() {
        var recover = st.undoKind === 'recover';
        return '<div class="screen">' + top() + '<h3>' + (recover ? '¿Recuperar la organización interrumpida?' : (st.undoKind === 'retry' ? '¿Reintentar deshacer?' : '¿Deshacer la última organización?')) + '</h3>' +
            '<p class="sub">' + (recover ? 'Los archivos que se llegaron a mover vuelven a su sitio y se borran los restos vacíos o temporales que dejó.' : 'Los archivos vuelven a su sitio y los elementos a sus bins.') + ' No se borra nada tuyo.</p>' +
            '<div class="spacer"></div><div class="btns">' + btn(recover ? 'Sí, recuperar' : 'Sí, deshacer', 'undo') + btn('No, volver', 'undo-cancel', 'sec') + '</div></div>';
    };

    V.working = function() {
        return '<div class="screen">' + top() + '<h3>' + esc(st.workTitle) + '</h3><div class="bar"><i id="bar" style="width:' + st.pct + '%"></i></div><p class="sub">Un momento…</p><div class="spacer"></div></div>';
    };

    V.undone = function() {
        var u = st.undone;
        var recover = st.undoKind === 'recover';
        return '<div class="screen">' + top() + (u.ok ? '<div class="check">↺</div>' : '<span class="badge warn">Revisar</span>') +
            '<div><h3>' + esc(recover && u.ok ? 'Organización recuperada' : u.title) + '</h3><p class="sub">' + esc(u.text) + '</p></div>' +
            '<div class="spacer"></div><div class="btns">' + (u.ok ? btn('Listo', 'finish') : btn('Reintentar deshacer', 'undo')) + (u.ok ? '' : btn('Volver al inicio', 'finish', 'sec')) + linesBlock(u.lines) + '</div></div>';
    };

    V.health = function() {
        return '<div class="screen">' + top() + '<h3>Salud del proyecto</h3><p class="sub">Comprobación de solo lectura.</p>' +
            (st.healthLines.length ? '<div class="card">' + pathList(st.healthLines) + '</div>' : '<div class="card ok"><h4>Sin incidencias</h4></div>') +
            '<div class="spacer"></div><div class="btns">' + btn('Volver', 'settings', 'sec') + '</div></div>';
    };

    function render() {
        st.paths = [];
        var fn = V[st.screen];
        screenEl.innerHTML = fn ? fn() : '';
    }

    function setProgress(pct, msg) {
        st.pct = Math.max(0, Math.min(100, Math.round(pct)));
        if (msg !== undefined) st.msg = msg;
        var bar = document.getElementById('bar'), p = document.getElementById('pct'), m = document.getElementById('msg');
        if (bar) bar.style.width = st.pct + '%';
        if (p) p.textContent = st.pct + '%';
        if (m && msg !== undefined) m.textContent = msg;
    }

    // ================================================================ Inicio: proyecto y deshacer
    function refreshHome() {
        var eng;
        return evalJSX('gpOrganizer.getProjectInfo()').then(function(info) {
            st.info = info; st.infoError = null;
            try {
                eng = getEngine();
                var dir = eng.logDirFor(info.projectPath);
                var session = eng.latestSession(dir, info.projectPath);
                var interrupted = session ? eng.findInterrupted(dir, info.projectPath).length > 0 : false;
                st.undoBtn = UI.undoButton(session, interrupted);
            } catch (e) { st.undoBtn = null; }
        }, function(e) { st.info = null; st.infoError = e; st.undoBtn = null; }).then(function() { if (st.screen === 'home' && !st.busy) render(); });
    }

    // ================================================================ Analizar
    function startFresh(mode) {
        if (st.busy) return;
        st.rootOverride = null;
        analyze(mode);
    }

    function analyze(mode) {
        if (st.busy) return;
        st.busy = true;
        st.runMode = mode || st.runMode || st.mode;
        st.confirmed = false; st.compare = 'after'; st.step = 0; st.pct = 5;
        go('analyzing');
        var config;
        ensureCategories().then(function() {
            config = getConfig();
            setProgress(12);
            return evalJSX('gpOrganizer.getProjectSnapshot(' + jsxArg(st.profile) + ',' + jsxArg(config) + ')');
        }).then(function(snapshot) {
            st.step = 1; st.pct = 45; if (st.screen === 'analyzing') render();
            st.snapshotCategories = Object.keys(snapshot.categories || {});
            if (st.rootOverride) snapshot.projectFolder = st.rootOverride;
            return getEngine().buildPlan(snapshot, { moveManual: !!st.moveManual });
        }).then(function(plan) {
            st.plan = plan; st.step = 2; st.pct = 100;
            var next = UI.classifyPlan(plan, st.runMode, { confirmed: st.confirmed });
            if (next === 'recover') {
                return refreshHome().then(function() {
                    if (st.undoBtn && st.undoBtn.kind === 'recover') { st.undoKind = 'recover'; go('home'); }
                    else { st.problem = UI.problemInfo(plan); go('problem'); }
                });
            }
            if (next === 'problem') { st.problem = UI.problemInfo(plan); go('problem'); }
            else go(next);
        }).catch(function(e) {
            st.problem = UI.errorInfo(e); go('problem');
        }).then(function() { st.busy = false; });
    }

    // ================================================================ Organizar
    function organize() {
        if (!st.plan || st.busy) return;
        var plan = st.plan, mode = st.runMode;
        var disk = UI.touchesDisk(mode), bins = UI.touchesBins(mode);
        if (disk && plan.blocked) return;
        var eng;
        try { eng = getEngine(); } catch (e) { st.problem = UI.errorInfo(e); go('problem'); return; }
        st.busy = true;
        st.pct = 2; st.msg = 'Preparando…';
        go('organizing');

        var result = null, jsx = null, session = null, premiereError = null;
        var signal = { cancelled: false };
        st.signal = signal;

        // N9: el proyecto abierto tiene que ser el que se analizó.
        var chain = evalJSX('gpOrganizer.getProjectInfo()').then(function(info) {
            if (String(info.projectPath).normalize('NFC').toLowerCase() !== String(plan.projectPath).normalize('NFC').toLowerCase()) {
                var err = new Error('changed');
                err.changed = { analyzed: String(plan.projectPath).split(/[\\/]/).pop().replace(/\.prproj$/i, ''), open: String(info.projectName || info.projectPath).split(/[\\/]/).pop().replace(/\.prproj$/i, '') };
                throw err;
            }
        });
        if (mode !== 'analysis') {
            chain = chain.then(function() { return eng.createSession(plan); }).then(function(s) { session = s; });
        }
        if (disk) {
            chain = chain.then(function() {
                return eng.execute(plan, function(current, total, message) { if (!signal.cancelled) setProgress(5 + 80 * current / Math.max(total, 1), message); }, session, signal);
            }).then(function(r) { result = r; });
        }
        if (mode !== 'analysis') {
            chain = chain.then(function() {
                setProgress(88, 'Actualizando Premiere…');
                var relinks = result ? result.relinks.map(function(r) { return { nodeId: r.nodeId, to: r.to }; }) : [];
                return evalJSX('gpOrganizer.applyOrganization(' + jsxArg({
                    projectPath: plan.projectPath,
                    relinks: relinks,
                    binMoves: bins ? plan.binMoves : [],
                    items: bins ? plan.items.map(function(i) { return { nodeId: i.nodeId, targetBin: i.targetBin }; }) : [],
                    organizeBins: bins,
                    categories: st.snapshotCategories,
                    binsDir: session.dir
                }) + ')').then(function(data) {
                    jsx = data;
                    var stt = data.stats || {};
                    if (stt.requested !== relinks.length) premiereError = 'Premiere no recibió todos los cambios (' + stt.requested + ' de ' + relinks.length + ').';
                    else if ((stt.relinkFailed || []).length) premiereError = stt.relinkFailed.length + ' medios no se pudieron re-enlazar.';
                    else if (stt.undoSaved === false) premiereError = 'No se pudo guardar el registro de BINs para deshacer.';
                }, function(e) { premiereError = 'Premiere no aplicó los cambios: ' + e.message; });
            });
        }
        chain.then(function() {
            if (session) eng.finalizeSession(session.dir, { premiereError: premiereError });
            setProgress(95, 'Escribiendo informe…');
            return eng.writeReports(plan, result);
        }).then(function(reports) {
            st.lastReports = reports;
            finishRun(result, jsx, null, premiereError);
        }, function(e) {
            if (e && e.changed) {
                st.problem = UI.changedProjectInfo(e.changed.analyzed, e.changed.open);
                go('problem');
                return;
            }
            try { if (session) eng.finalizeSession(session.dir, { premiereError: UI.humanError(e) }); } catch (ignore) { /* ya se informa abajo */ }
            finishRun(result, jsx, e, premiereError);
        }).then(function() { st.busy = false; st.signal = null; refreshHome(); });
    }

    function finishRun(result, jsx, error, premiereError) {
        var d = UI.doneInfo(result, jsx, error, premiereError, st.runMode);
        st.done = d;
        if (d.cancelled) {
            st.stopped = UI.stoppedInfo(result, (st.plan.ops || []).length);
            go('stopped');
            return;
        }
        if (!d.problems && st.runMode !== 'analysis') {
            lsSet('binflow.organized.count', String(Number(lsGet('binflow.organized.count') || 0) + 1));
            lsSet('binflow.lastProfile', st.profile);
        }
        go('done');
    }

    // ================================================================ Deshacer / recuperar
    function undoAsk() {
        if (st.busy) return;
        st.undoKind = st.undoBtn ? st.undoBtn.kind : (st.undoKind === 'recover' ? 'recover' : 'undo');
        go('undoask');
    }

    function runUndo() {
        if (st.busy) return;
        st.busy = true;
        var eng;
        try { eng = getEngine(); } catch (e) { st.busy = false; st.problem = UI.errorInfo(e); go('problem'); return; }
        st.workTitle = st.undoKind === 'recover' ? 'Recuperando…' : 'Deshaciendo…';
        st.pct = 15; go('working');
        var files = null, undoProject = null;
        evalJSX('gpOrganizer.getProjectInfo()').then(function(info) {
            undoProject = info.projectPath;
            return eng.undo(eng.logDirFor(info.projectPath), info.projectPath);
        }).then(function(r) {
            files = r; setProgress(60);
            return evalJSX('gpOrganizer.applyUndo(' + jsxArg({ projectPath: undoProject, relinks: r.relinks, binsDir: r.sessionDir }) + ')');
        }).then(function(data) {
            var info = UI.undoInfo(files, data);
            eng.completeUndo(files.sessionDir, { ok: info.ok });
            st.undone = info; go('undone');
        }).catch(function(e) {
            st.problem = { code: 'error', safety: false, title: 'No se pudo deshacer', body: UI.humanError(e), why: 'No se ha borrado nada.', list: [], listTitle: '', details: [],
                actions: [{ id: 'undo', label: 'Reintentar', kind: 'primary' }, { id: 'home', label: 'Volver al inicio', kind: 'sec' }] };
            go('problem');
        }).then(function() { st.busy = false; refreshHome(); });
    }

    // ================================================================ Ajustes
    function syncSettingsFromDom() {
        if (st.screen !== 'settings') return;
        var assets = document.getElementById('assets');
        if (assets) st.assetsFolderName = assets.value;
        var mm = document.getElementById('move-manual');
        if (mm) st.moveManual = !!mm.checked;
        var cards = screenEl.querySelectorAll('.cat');
        if (cards.length || assets) {
            st.categories = [].slice.call(cards).map(function(c) { return { folder: c.querySelector('.cat-folder').value, exts: c.querySelector('.cat-exts').value }; });
        }
    }

    // ================================================================ Acciones
    var ACTIONS = {
        'start': function() { startFresh(st.mode); },
        'start-analysis': function() { startFresh('analysis'); },
        'analyze': function() { analyze(st.runMode); },
        'home': function() { st.rootOverride = null; go('home'); refreshHome(); },
        'finish': function() { st.rootOverride = null; go('home'); refreshHome(); },
        'settings': function() { setToast(''); go('settings'); },
        'update-view': function() { if (st.update) { setToast(''); go('update'); } },
        'update-install': function() { installUpdate(); },
        'noop': function() {},
        'set-mode': function(el) { syncSettingsFromDom(); st.mode = el.getAttribute('data-mode'); saveSettings(); render(); },
        'settings-save': function() { syncSettingsFromDom(); saveSettings(); go('home'); refreshHome(); },
        'cat-add': function() { syncSettingsFromDom(); st.categories.push({ folder: 'Nueva carpeta', exts: '' }); render(); },
        'cat-remove': function(el) { syncSettingsFromDom(); st.categories.splice(Number(el.getAttribute('data-i')), 1); render(); },
        'profile-export': function() {
            syncSettingsFromDom();
            var cfg = getConfig();
            evalJSX('gpOrganizer.exportProfile(' + jsxArg({ name: st.profile, assetsFolderName: cfg.assetsFolderName, categories: cfg.categories }) + ')').then(function() { setToast('Plantilla exportada en Profiles.'); }, function(e) { setToast(e.message); });
        },
        'profile-import': function() {
            evalJSX('gpOrganizer.importProfile()').then(function(data) {
                if (data.status !== 'SUCCESS') return;
                var profile = data.profile || {};
                st.profile = 'Personalizado'; st.assetsFolderName = profile.assetsFolderName || '01 Assets'; st.categories = toCatList(profile.categories || {});
                saveSettings(); render(); setToast('Plantilla importada.');
            }, function(e) { setToast('No se pudo importar la plantilla: ' + e.message); });
        },
        'profile-delete': function() {
            if (st.profile !== 'Personalizado') { setToast('Las plantillas predefinidas no se pueden borrar.'); return; }
            evalJSX('gpOrganizer.deleteProfile(' + jsxArg(st.profile) + ')').then(function() {
                st.profile = 'Estándar'; return loadProfileCategories();
            }).then(function() { saveSettings(); render(); setToast('Plantilla personalizada eliminada.'); }, function(e) { setToast(e.message); });
        },
        'health': function() {
            evalJSX('gpOrganizer.healthCheck()').then(function(data) {
                var lines = [];
                (data.offline || []).forEach(function(item) { lines.push({ name: 'Offline: ' + item.name, path: item.path }); });
                (data.noBin || []).forEach(function(name) { lines.push({ name: 'Sin bin: ' + name, path: 'Está en la raíz del proyecto.' }); });
                (data.duplicates || []).forEach(function(item) { lines.push({ name: 'Mismo nombre: ' + item.name, path: item.first + '\n' + item.second }); });
                (data.emptyBins || []).forEach(function(p) { lines.push({ name: 'Bin vacío', path: p }); });
                st.healthLines = lines; go('health');
            }, function(e) { setToast('Error de comprobación: ' + e.message); });
        },
        'debug-run': function() { runDebug(); },
        'notice-ok': function() { st.confirmed = true; go('result'); },
        'cmp-before': function() { st.compare = 'before'; render(); },
        'cmp-after': function() { st.compare = 'after'; render(); },
        'use-root': function() { if (st.plan && st.plan.suggestedRoot) { st.rootOverride = st.plan.suggestedRoot; analyze(st.runMode); } },
        'choose-folder': function() {
            var folder = null;
            try { folder = pickFolder('Elige la carpeta del trabajo'); } catch (e) { setToast(e.message); return; }
            if (folder) { st.rootOverride = folder; analyze(st.runMode); }
        },
        'organize': organize,
        'cancel-run': function() {
            if (!st.signal) return;
            st.signal.cancelled = true;
            var b = document.getElementById('cancel'); if (b) b.disabled = true;
            setProgress(st.pct, 'Cancelando: se termina de forma segura el archivo en curso…');
        },
        'undo-ask': undoAsk,
        'undo-cancel': function() { go('home'); refreshHome(); },
        'undo': runUndo,
        'open-report': function() { if (st.lastReports) try { openPath(st.lastReports.htmlPath); } catch (e) { setToast(e.message); } },
        'open-pdf': function() { if (st.lastReports) try { openPath(st.lastReports.pdfPath); } catch (e) { setToast(e.message); } },
        'copy-path': function(el) {
            var p = (st.paths[Number(el.getAttribute('data-i'))] || '').split('\n')[0];
            try { copyText(p); setToast('Ruta copiada.'); } catch (e) { setToast(e.message); }
        },
        'reveal': function(el) {
            var p = (st.paths[Number(el.getAttribute('data-i'))] || '').split('\n')[0];
            try { revealPath(p); } catch (e) { setToast(e.message); }
        }
    };

    screenEl.addEventListener('click', function(event) {
        var el = event.target.closest ? event.target.closest('[data-act]') : null;
        if (!el || el.disabled) return;
        var fn = ACTIONS[el.getAttribute('data-act')];
        if (fn) fn(el);
    });
    screenEl.addEventListener('change', function(event) {
        var el = event.target;
        if (el && el.id === 'profile') {
            syncSettingsFromDom();
            st.profile = el.value;
            loadProfileCategories().then(function() { saveSettings(); render(); });
        }
    });
    window.addEventListener('focus', function() { if (st.screen === 'home' && !st.busy) refreshHome(); });

    // ================================================================ Actualizaciones
    // Al abrir el panel se comprueba en silencio: solo si hay versión nueva en gponga/Binflow aparece la franja. Instalar solo con clic.
    function checkUpdate() {
        // Silencio total salvo que haya una versión nueva: al día, sin red o con error no se muestra nada.
        try {
            getUpdater().checkForUpdate(currentVersion()).then(function(r) {
                if (r && r.status === 'available') { st.update = r; if (st.screen === 'home') render(); }
            }, function() { /* silencio */ });
        } catch (e) { /* silencio */ }
    }

    function installUpdate() {
        if (!st.update || st.updateBusy || st.busy) return;
        var up;
        try { up = getUpdater(); } catch (e) { setToast(UI.updateMessage('failed', e.message)); return; }
        st.updateBusy = true; setToast(''); render();
        up.installUpdate(st.update.latest, { installDir: extensionDir(), currentVersion: currentVersion(), onProgress: function(msg) { setToast(msg); } }).then(function(r) {
            st.updateBusy = false; st.updated = { version: r.version }; st.update = null; go('updated');
        }, function(e) {
            st.updateBusy = false; render(); setToast(UI.updateMessage('failed', e && e.message));
        });
    }

    // ================================================================ Diagnóstico (en Ajustes)
    function runDebug() {
        st.debugText = 'Ejecutando diagnóstico…'; render();
        csInterface.evalScript('gpOrganizer.getDebugLog()', function(result) {
            var text = '';
            try {
                var data = JSON.parse(result);
                text += 'Premiere: ' + data.premiereVersion + '\nSistema: ' + data.os + '\nNode en el panel: ' + (nodeRequire ? 'sí' : 'no') + '\n';
                text += 'Proyecto abierto: ' + (data.projectOpen ? 'sí' : 'no') + '\n';
                if (data.projectOpen) {
                    text += 'Nombre: ' + data.projectName + '\nGuardado: ' + (data.projectSaved ? 'sí, ' + data.projectPath : 'no') + '\nMedios: ' + data.totalItems + ' · Offline: ' + data.offlineItems + '\n';
                }
                if (data.lastError) text += 'Último error: ' + data.lastError + '\n';
                try { text += 'Motor: v' + getEngine().version; } catch (e) { text += 'Motor: ' + e.message; }
            } catch (e) { text = 'Resultado no válido: ' + result; }
            st.debugText = text;
            if (st.screen === 'settings') render();
        });
    }

    // ================================================================ Arranque
    // Hook para pruebas en navegador (no se usa en Premiere).
    window.__binflow = { state: st, go: go, refreshHome: refreshHome };
    render();
    refreshHome();
    checkUpdate();
    ensureCategories().catch(function() { /* sin Premiere: se pedirá al analizar */ });
}());
