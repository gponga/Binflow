/**
 * BinFlow - textos y estado de la interfaz (funciones puras, sin DOM ni disco).
 * Se carga en el panel (window.BinFlowUI) y en las pruebas de Node (require).
 * NO decide nada de negocio: solo traduce lo que devuelve el motor a pantallas.
 * Estilo ES5: el Chromium de CEP es antiguo.
 */
(function (factory) {
    var api = factory();
    // En el panel de Premiere (CEP con --mixed-context) la página TAMBIÉN tiene `module`:
    // por eso el global se registra siempre que haya `window`, sin mirar `module`.
    if (typeof window !== 'undefined' && window) window.BinFlowUI = api;
    // Node de las pruebas: no hay `document`.
    if (typeof module === 'object' && module && module.exports && typeof document === 'undefined') module.exports = api;
}(function () {
    'use strict';

    function plural(n, one, many) { return n === 1 ? one : many; }

    function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }

    function sizeText(bytes) {
        var units = ['B', 'KB', 'MB', 'GB', 'TB'], n = Number(bytes) || 0, i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (i ? n.toFixed(1).replace('.', ',').replace(/,0$/, '') : String(n)) + ' ' + units[i];
    }

    /** Traduce errores de sistema a algo que entienda un editor. */
    function humanError(e) {
        var msg = (e && e.message) || String(e);
        var code = e && e.code;
        if (code === 'EACCES' || code === 'EPERM' || /EACCES|EPERM/.test(msg)) return 'Sin permiso para escribir en esa carpeta. Revisa los permisos del disco o de la carpeta.';
        if (code === 'ENOSPC' || /ENOSPC/.test(msg)) return 'El disco está lleno. Libera espacio y vuelve a intentarlo (lo hecho hasta ahora se puede deshacer).';
        if (code === 'EROFS' || /EROFS/.test(msg)) return 'El disco es de solo lectura.';
        if (code === 'ENOENT' || /ENOENT/.test(msg)) return 'Un archivo ya no está donde estaba. Vuelve a analizar.';
        return msg;
    }

    /** Modos que mueven archivos del disco. */
    function touchesDisk(mode) { return mode === 'both' || mode === 'finder'; }
    function touchesBins(mode) { return mode === 'both' || mode === 'bin'; }

    var MODES = [
        { id: 'both', label: 'Bins y archivos (recomendado)', help: 'Premiere y el disco con la misma estructura.' },
        { id: 'bin', label: 'Solo bins en Premiere', help: 'No se mueve ningún archivo del disco.' },
        { id: 'finder', label: 'Solo archivos del disco', help: 'Se re-enlazan en Premiere; los bins no cambian.' }
    ];

    // ------------------------------------------------------------ Qué pantalla toca tras analizar

    /**
     * 'recover'  : hay una organización interrumpida (siempre antes de nada, en cualquier modo).
     * 'problem'  : el motor se detiene (en «solo bins» solo importa lo que afecta a los bins).
     * 'notice'   : hay avisos que se confirman con «Entendido».
     * 'result'   : vista previa.
     */
    function classifyPlan(plan, mode, state) {
        state = state || {};
        if (plan && plan.blockCode === 'interrupted') return 'recover';
        if (plan && plan.blocked && mode !== 'bin') return 'problem';
        var notices = noticeItems(plan, mode);
        if (notices.length && !state.confirmed) return 'notice';
        return 'result';
    }

    function noticeItems(plan, mode) {
        if (!plan || !touchesDisk(mode)) return [];
        return (plan.confirmations || []).slice();
    }

    // ------------------------------------------------------------ Problemas (bloqueos del motor)

    function copyOps(plan) { return (plan.ops || []).filter(function (op) { return op.type === 'copy'; }); }

    function externalList(plan) {
        return copyOps(plan).map(function (op) { return { name: baseName(op.source), path: op.source, size: sizeText(op.size || 0) }; });
    }

    /** Gráficos de Adobe que se mueven y Premiere no podrá re-enlazar: quedan sin conexión (hay que re-enlazarlos a mano). */
    function graphicsList(plan) {
        return (plan.manual || []).filter(function (m) { return m.moved && m.offline; }).map(function (m) {
            return { name: m.name, path: m.path, note: 'Pasará a: ' + m.dest };
        });
    }

    // ------------------------------------------------------------ Actualizaciones (v2.5.0)

    /** Textos de la pantalla «Novedades» a partir de checkForUpdate(): versiones intermedias, qué hace cada cosa y mejoras. */
    function updateInfo(check, current) {
        var latest = check && check.latest ? check.latest.version : '';
        var versions = ((check && check.changelog) || []).map(function (c) {
            return { version: c.version, date: c.date || '', features: c.features || [], improvements: c.improvements || [] };
        });
        return {
            title: 'Hay una versión nueva',
            sub: 'BinFlow ' + latest + ' (tú tienes la ' + current + ').',
            versions: versions,
            empty: !versions.length,
            note: 'Se guarda una copia de la versión actual y tus proyectos no se tocan. Al terminar tendrás que cerrar Premiere del todo y abrirlo otra vez.',
            pill: 'Hay una versión nueva: ' + latest
        };
    }

    // Solo hay mensaje cuando falla una instalación que el usuario ha pedido: al día / sin red / error al comprobar no dicen nada.
    function updateMessage(kind, extra) {
        if (kind === 'failed') return 'No se ha podido actualizar. Tu versión sigue igual.' + (extra ? ' (' + humanError({ message: extra }) + ')' : '');
        return '';
    }

    var A_RECHECK = { id: 'analyze', label: 'Volver a comprobar', kind: 'ghost' };
    var A_FOLDER = { id: 'choose-folder', label: 'Elegir otra carpeta', kind: 'sec' };

    /**
     * Descriptor de la pantalla de problema para un plan bloqueado.
     * Las acciones con soon:true necesitan el motor (Fase 2): se muestran inactivas, «Próximamente».
     * safety = true cuando el bloqueo protege archivos de verdad (no es solo un aviso).
     */
    function problemInfo(plan) {
        var code = plan.blockCode || 'other';
        var reason = plan.blockReason || '';
        var info = { code: code, title: 'Hay un problema', body: reason, why: '', list: [], listTitle: '', details: [], safety: true, actions: [] };
        var s = plan.summary || {};
        var n;

        if (code === 'unreadable') {
            n = (plan.unreadable || []).length;
            info.title = n === 1 ? 'No puedo leer 1 archivo' : 'No puedo leer ' + n + ' archivos';
            info.body = 'Están en tu carpeta, pero el sistema no me deja abrirlos.';
            info.why = 'Si no los leo, no sé si el proyecto los usa. Por eso me paro: así no se deja nada fuera sin mirar.';
            info.list = (plan.unreadable || []).slice(0, 10).map(function (p) { return { name: baseName(p), path: p }; });
            info.details = ['Causa probable: permisos del disco o archivos de otro usuario.', 'Si arreglas los permisos, pulsa «Volver a comprobar».'];
            info.safety = false;
            info.actions = [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' }, A_FOLDER,
                { id: 'soon-unreadable', label: 'Apartar en «Ilegibles» y seguir', kind: 'sec', soon: true }];
        } else if (code === 'unreadable-project') {
            var bad = (plan.otherProjects || []).filter(function (p) { return p.error; });
            info.title = 'Hay un proyecto que no puedo abrir';
            info.body = bad.length ? 'En tu carpeta hay un proyecto que no se deja leer: «' + baseName(bad[0].path) + '».' : reason;
            info.why = 'Sin saber qué archivos usa, al moverlos podrías dejarlo con medios offline. Aquí no hay atajo seguro con archivos.';
            info.list = bad.map(function (p) { return { name: baseName(p.path), path: p.path, note: p.error }; });
            info.details = ['Si lo reparas o lo sacas de esta carpeta, pulsa «Volver a comprobar».'];
            info.actions = [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' }, A_FOLDER,
                { id: 'soon-bins-only', label: 'Organizar solo los bins (sin mover archivos)', kind: 'sec', soon: true }];
        } else if (code === 'unresolved') {
            var miss = plan.missing || [], amb = plan.ambiguous || [];
            if (miss.length && !amb.length) {
                info.title = miss.length === 1 ? 'Falta 1 medio en el disco' : 'Faltan ' + miss.length + ' medios en el disco';
                info.body = 'Premiere los muestra offline y no están donde dice:';
            } else if (amb.length && !miss.length) {
                info.title = amb.length === 1 ? '1 archivo con el mismo nombre' : amb.length + ' archivos con el mismo nombre';
                info.body = 'Hay varios archivos con ese nombre y no sé cuál es el bueno:';
            } else {
                info.title = 'Hay medios sin resolver';
                info.body = 'Unos no están en el disco y otros están repetidos:';
            }
            info.why = 'No puedo ordenar lo que no encuentro. Deja cada medio en su sitio, o reconéctalo en Premiere.';
            info.list = miss.map(function (m) { return { name: m.name, path: m.path, note: m.note }; })
                .concat(amb.map(function (m) { return { name: m.name, path: (m.candidates || []).join('\n'), note: 'Varios candidatos' }; }));
            info.details = ['La ruta que se ve es la última que guardó Premiere para cada clip.', 'Si los reconectas en Premiere, pulsa «Volver a comprobar».'];
            info.safety = false;
            info.actions = [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' },
                { id: 'soon-ignore-missing', label: 'Dejarlos fuera y seguir', kind: 'sec', soon: true }];
        } else if (code === 'no-space') {
            var m = /\((\d+) MB necesarios, (\d+) MB libres\)/.exec(reason);
            info.title = 'No hay espacio para las copias';
            info.body = m ? 'Necesito ' + sizeText(Number(m[1]) * 1048576) + ' y solo hay ' + sizeText(Number(m[2]) * 1048576) + ' libres.' : reason;
            info.why = 'Una copia a medias dejaría archivos rotos. Libera espacio y vuelve a comprobar.';
            info.list = externalList(plan);
            info.listTitle = info.list.length ? 'Se copiarían estos archivos:' : '';
            info.details = [reason];
            info.safety = false;
            info.actions = [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' }, A_FOLDER,
                { id: 'soon-no-copy', label: 'Seguir sin copiar los externos', kind: 'sec', soon: true }];
        } else if (code === 'unsafe-root') {
            info.title = 'Guarda el proyecto en su propia carpeta';
            info.body = reason;
            info.why = 'Si organizo desde aquí, movería todo lo que hay en esa carpeta, y no es solo de este proyecto.';
            info.details = [];
            info.actions = [A_FOLDER, { id: 'analyze', label: 'Volver a comprobar', kind: 'ghost' }];
            info.actions[0] = { id: 'choose-folder', label: 'Elegir otra carpeta', kind: 'primary' };
        } else if (code === 'outside') {
            info.title = 'Una carpeta sale del proyecto';
            info.body = reason;
            info.why = 'Hay un enlace que apunta fuera de la carpeta del proyecto. No sigo enlaces para no tocar archivos ajenos.';
            info.actions = [{ id: 'choose-folder', label: 'Elegir otra carpeta', kind: 'primary' }, A_RECHECK];
        } else if (code === 'too-many-files') {
            info.title = 'Hay demasiados archivos';
            info.body = reason;
            info.why = 'Lo normal es que el proyecto esté en su propia carpeta. Si no, podría estar mirando medio disco.';
            info.actions = [{ id: 'choose-folder', label: 'Elegir otra carpeta', kind: 'primary' }, A_RECHECK];
        } else {
            info.actions = [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' }, A_FOLDER];
        }
        info.n = s.items;
        return info;
    }

    function changedProjectInfo(analyzedName, openName) {
        return {
            code: 'changed', safety: true,
            title: 'Has cambiado de proyecto',
            body: 'Ahora está abierto «' + openName + '», pero la vista previa era de «' + analyzedName + '».',
            why: 'Organizar con el plan de otro proyecto movería archivos equivocados.',
            list: [], listTitle: '',
            details: ['Proyecto analizado: ' + analyzedName, 'Proyecto abierto ahora: ' + openName],
            actions: [{ id: 'analyze', label: 'Analizar de nuevo', kind: 'primary' }, { id: 'home', label: 'Volver al inicio', kind: 'sec' }]
        };
    }

    function errorInfo(e) {
        return {
            code: 'error', safety: false,
            title: 'No he podido analizar', body: humanError(e), why: '', list: [], listTitle: '', details: [],
            actions: [{ id: 'analyze', label: 'Volver a comprobar', kind: 'primary' }, { id: 'home', label: 'Volver al inicio', kind: 'sec' }]
        };
    }

    // ------------------------------------------------------------ Vista previa

    function relTo(p, folder) {
        var a = String(p).replace(/\\/g, '/'), b = String(folder || '').replace(/\\/g, '/').replace(/\/+$/, '');
        if (b && a.toLowerCase().indexOf(b.toLowerCase() + '/') === 0) return a.slice(b.length + 1);
        return a;
    }

    /** Antes/Después a partir de las operaciones del plan (sin tocar disco). */
    function treeData(plan) {
        var ops = (plan.ops || []).filter(function (op) { return op.type === 'move' || op.type === 'copy'; });
        var folderName = baseName(plan.projectFolder) || 'Proyecto';
        var before = [], seen = {}, i;
        for (i = 0; i < ops.length; i++) {
            var rel = relTo(ops[i].source, plan.projectFolder);
            if (ops[i].type === 'copy') rel = baseName(ops[i].source) + '  (externo)';
            if (seen[rel]) continue;
            seen[rel] = true;
            before.push(rel);
        }
        var beforeShown = before.slice(0, 7);
        var counts = {}, order = [], assetsName = baseName(plan.assetsDir) || '01 Assets';
        ops.forEach(function (op) {
            var rel2 = relTo(op.dest, plan.assetsDir);
            var seg = rel2.indexOf('/') === -1 ? '.' : rel2.split('/')[0];
            if (!counts.hasOwnProperty(seg)) { counts[seg] = 0; order.push(seg); }
            counts[seg]++;
        });
        order.sort(function (a, b) {
            var ua = a.charAt(0) === '_' ? 1 : 0, ub = b.charAt(0) === '_' ? 1 : 0;
            return ua - ub || (a < b ? -1 : a > b ? 1 : 0);
        });
        return {
            folderName: folderName, assetsName: assetsName,
            before: beforeShown, beforeMore: Math.max(0, before.length - beforeShown.length),
            after: order.map(function (k) { return { name: k === '.' ? '(raíz de ' + assetsName + ')' : k, count: counts[k], unused: k.charAt(0) === '_' }; })
        };
    }

    function resultInfo(plan, mode, opts) {
        opts = opts || {};
        var s = plan.summary || {};
        var disk = touchesDisk(mode) || mode === 'analysis';
        var bins = touchesBins(mode) || mode === 'analysis';
        var numbers = [], chips = [], cards = [], details = [];
        var moves = s.moves || 0;

        if (mode === 'analysis') {
            numbers.push({ value: s.unusedTotal || 0, label: plural(s.unusedTotal || 0, 'archivo que el proyecto no usa', 'archivos que el proyecto no usa') });
            numbers.push({ value: s.items || 0, label: plural(s.items || 0, 'elemento en el proyecto', 'elementos en el proyecto') });
        } else {
            if (disk) numbers.push({ value: moves, label: plural(moves, 'archivo se ordena', 'archivos se ordenan') });
            if (bins) numbers.push({ value: s.binMoves || 0, label: plural(s.binMoves || 0, 'elemento cambia de bin', 'elementos cambian de bin') });
            if (disk) numbers.push({ value: s.unusedTotal || 0, label: 'sin usar: se apartan, no se borran', hidden: !(s.unusedTotal) });
        }
        numbers = numbers.filter(function (x) { return !x.hidden; });
        if (disk && s.copies) numbers.push({ value: s.copies, label: plural(s.copies, 'externo se copia', 'externos se copian') + ' (' + sizeText(s.bytesToCopy) + ')', wide: true });

        if (opts.rootOverride) chips.push('Desde «' + baseName(opts.rootOverride) + '»');
        var excluded = (plan.otherProjects || []).filter(function (p) { return p.excluded; });
        if (excluded.length) chips.push(excluded.length === 1 ? 'Otro proyecto: no se toca' : excluded.length + ' proyectos más: no se tocan');
        if (mode === 'bin' && plan.blocked && plan.blockCode !== 'interrupted') chips.push('Solo bins: no se mueven archivos');
        if (mode === 'bin' && ((plan.missing || []).length || (plan.ambiguous || []).length)) chips.push((plan.missing || []).length + (plan.ambiguous || []).length + ' medios sin resolver');
        var gfx = disk ? graphicsList(plan) : [];
        var gfxKept = disk ? (plan.manual || []).filter(function (m) { return !m.moved; }) : [];
        var gfxCopied = disk ? (plan.manual || []).filter(function (m) { return m.moved && !m.offline; }) : [];
        if (gfxKept.length) chips.push(gfxKept.length + ' se quedan donde están');
        if (gfx.length) chips.push(gfx.length + ' ' + plural(gfx.length, 'gráfico de Adobe sin conexión', 'gráficos de Adobe sin conexión'));

        var ext = disk && mode !== 'analysis' ? externalList(plan) : [];
        if (ext.length) cards.push({ kind: 'plain', title: ext.length + ' ' + plural(ext.length, 'archivo externo se copiará', 'archivos externos se copiarán') + ' dentro del proyecto', text: 'Están fuera de la carpeta; los originales no se tocan.', list: ext });

        if (gfx.length) {
            cards.push({ kind: 'warn', title: gfx.length === 1 ? 'Este gráfico de Adobe quedará sin conexión en Premiere' : 'Estos ' + gfx.length + ' gráficos de Adobe quedarán sin conexión en Premiere',
                text: 'Premiere no deja re-enlazarlos sola: tendrás que relinkarlos a mano (clic derecho > Vincular medio). En el informe verás de dónde a dónde se mueven.', list: gfx });
        }

        if (plan.suggestedRoot && !opts.rootOverride && disk) {
            cards.push({ kind: 'info', title: '¿Organizar desde la carpeta superior?', text: baseName(plan.suggestedRoot) + ': así se mueven en vez de copiarse.', action: { id: 'use-root', label: 'Organizar desde ahí', kind: 'sec' } });
        }

        (plan.warnings || []).slice(0, 8).forEach(function (w) { details.push(w); });
        gfxKept.forEach(function (m) { details.push('Se deja donde está: ' + m.name + ' (Premiere no permite cambiar la ruta de este tipo de archivo).'); });
        gfxCopied.forEach(function (m) { details.push('Se copia dentro del proyecto: ' + m.name + ' (el proyecto sigue enlazado al original; Premiere no permite cambiar la ruta de este tipo de archivo).'); });
        (plan.groups || []).forEach(function (g) { details.push('Se conserva «' + g.bin + '»: más del 80 % es ' + g.category + ', se guarda entero.'); });
        if (s.unusedTotal) {
            var parts = [];
            if (s.sources) parts.push(s.sources + ' junto a su versión usada');
            if (s.groupFiles) parts.push(s.groupFiles + ' se quedan en su carpeta');
            if (s.unusedToFolder) parts.push(s.unusedToFolder + ' van a «_No usados»');
            details.push(s.unusedTotal + ' archivos que el proyecto no usa' + (parts.length ? ': ' + parts.join(', ') : '') + '. No se borra nada; tendrás un PDF con la lista.');
        }
        details.push('Se guarda un informe de lo que se hace y se puede deshacer.');

        return {
            title: mode === 'analysis' ? 'Esto he encontrado' : 'Así quedará tu proyecto',
            sub: mode === 'analysis' ? 'No se cambia nada.' : 'Todavía no he cambiado nada.',
            numbers: numbers, chips: chips, cards: cards, details: details,
            tree: disk && mode !== 'analysis' && moves + (s.copies || 0) > 0 ? treeData(plan) : null,
            empty: (moves + (s.copies || 0) + (s.binMoves || 0)) === 0 && mode !== 'analysis',
            primary: mode === 'analysis' ? 'Generar informe' : (mode === 'bin' ? 'Organizar bins' : 'Organizar')
        };
    }

    // ------------------------------------------------------------ Resultado de organizar / deshacer

    function doneInfo(result, jsx, error, premiereError, mode) {
        var stats = (jsx && jsx.stats) || {};
        var errors = (result && result.errors) || [];
        var lines = [];
        var problems = errors.filter(function (e) { return !e.skipped && !e.journal; }).length +
            (stats.relinkFailed || []).length + (stats.binFailed || []).length + (error ? 1 : 0) + (premiereError ? 1 : 0) +
            (result && result.aborted ? 1 : 0);
        if (error) lines.push({ title: 'Error', text: humanError(error) });
        if (premiereError) lines.push({ title: 'Premiere', text: premiereError });
        var moved = 0, copied = 0;
        if (result) {
            moved = result.done.filter(function (d) { return d.type === 'move'; }).length;
            copied = result.done.filter(function (d) { return d.type === 'copy'; }).length;
            if (result.aborted) lines.push({ title: 'Detenido', text: result.aborted + ' Lo hecho hasta ese momento se puede deshacer.' });
            var skipped = errors.filter(function (e) { return e.skipped; }).length;
            if (skipped) lines.push({ title: 'Sin hacer', text: skipped + ' operaciones no se llegaron a hacer (los archivos siguen en su sitio).' });
            errors.filter(function (e) { return !e.skipped && !e.journal; }).forEach(function (e) {
                lines.push({ title: 'No se pudo: ' + baseName(e.source), text: humanError({ message: e.message }) });
            });
        }
        (stats.relinkFailed || []).forEach(function (f) { lines.push({ title: 'No se re-enlazó: ' + f.name, text: f.message }); });
        (stats.binFailed || []).forEach(function (f) { lines.push({ title: 'No se movió el bin: ' + f.name, text: f.message }); });
        if (stats.saveError) lines.push({ title: 'Guarda el proyecto a mano', text: stats.saveError });
        var cancelled = !!(result && result.cancelled);
        var undoFirst = !!(premiereError && result && result.done && result.done.length);
        var analysis = mode === 'analysis';
        return {
            cancelled: cancelled, problems: problems, lines: lines, undoFirst: undoFirst,
            moved: moved, copied: copied, copiedBytes: result ? result.copiedBytes : 0,
            binMoved: stats.binMoved || 0, relinked: stats.relinked || 0,
            title: analysis ? 'Informe generado' : (problems ? 'Terminó con algunos avisos' : 'Proyecto organizado'),
            text: analysis ? 'No se ha modificado nada.' : (undoFirst
                ? 'Los archivos se ordenaron, pero Premiere no se actualizó del todo. Lo más seguro es deshacerlo.'
                : (problems ? 'Casi todo está hecho. Lo que falló está en «Ver detalles» y se puede deshacer.' : 'Todo ha ido bien. Premiere ya apunta a los nuevos sitios.')),
            showSave: !analysis
        };
    }

    function stoppedInfo(result, total) {
        var done = result && result.done ? result.done.length : 0;
        return { done: done, total: total, text: 'Se hicieron ' + done + ' de ' + total + ' operaciones. Todo lo hecho está en su sitio y Premiere lo encuentra.' };
    }

    function undoInfo(files, data) {
        var ok = !files.failed.length && !files.relinksSkipped && data.status === 'SUCCESS';
        var lines = [];
        files.failed.forEach(function (f) { lines.push({ title: 'No se pudo devolver', text: f.message }); });
        if ((files.cleaned || []).length) lines.push({ title: 'Restos limpiados', text: files.cleaned.length + ' archivos vacíos o temporales de la organización interrumpida.' });
        (files.kept || []).forEach(function (k) { lines.push({ title: 'Se conserva la copia: ' + baseName(k.path), text: 'El original externo ya no existe, así que la copia del proyecto es la única y no se borra. Premiere sigue apuntando a ella.' }); });
        (data.failed || []).forEach(function (f) { lines.push({ title: 'Premiere: ' + f.name, text: f.message }); });
        return {
            ok: ok, lines: lines,
            title: ok ? 'Todo ha vuelto a su sitio' : 'Se deshizo en parte',
            text: ok ? files.restored + ' archivos devueltos, ' + (data.relinked || 0) + ' medios re-enlazados, ' + (data.binsRestored || 0) + ' bins restaurados.'
                : 'Parte no se pudo deshacer. No se ha borrado nada. Resuelve lo indicado y pulsa «Reintentar deshacer»: solo repite lo que falta.'
        };
    }

    /** Qué muestra el botón de deshacer/recuperar en el inicio, según las sesiones del proyecto. */
    function undoButton(session, interrupted) {
        if (!session) return null;
        var when = new Date(session.meta.createdAt);
        var stamp = when.toLocaleDateString() + ' ' + when.toLocaleTimeString().slice(0, 5);
        if (interrupted) return { kind: 'recover', label: 'Recuperar', stamp: stamp };
        if (session.meta.status === 'partial-undo') return { kind: 'retry', label: 'Reintentar deshacer', stamp: stamp };
        return { kind: 'undo', label: 'Deshacer la última organización', stamp: stamp };
    }

    return {
        plural: plural, baseName: baseName, sizeText: sizeText, humanError: humanError,
        touchesDisk: touchesDisk, touchesBins: touchesBins, MODES: MODES,
        classifyPlan: classifyPlan, noticeItems: noticeItems, problemInfo: problemInfo,
        changedProjectInfo: changedProjectInfo, errorInfo: errorInfo,
        treeData: treeData, resultInfo: resultInfo, externalList: externalList, graphicsList: graphicsList, updateInfo: updateInfo, updateMessage: updateMessage,
        doneInfo: doneInfo, stoppedInfo: stoppedInfo, undoInfo: undoInfo, undoButton: undoButton
    };
}));
