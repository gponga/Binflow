/**
 * BinFlow engine — informes: HTML legible + PDF de archivos sin uso.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var pdf = require('./pdf');
var fsu = require('./fsutil');

var REASONS = {
    'no usado': 'Sin uso: guardados en _No usados',
    'fuente': 'Fuente de un archivo usado (se queda a su lado)',
    'grupo': 'Se queda en su carpeta (BIN conservado)',
    'ya en assets': 'Ya estaba en assets (no se mueve)',
    'otra versión': 'Lo usa otra versión del proyecto (no se mueve)',
    'usado por el proyecto': 'Lo usa este proyecto aunque no sea un ítem del panel: proxies enlazados o archivos que el proyecto guardado referencia (no se mueve)',
    'carpeta de Premiere': 'Carpeta de Premiere (preferencias, layouts…): se queda donde está'
};

function esc(v) {
    return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function size(bytes) {
    var units = ['B', 'KB', 'MB', 'GB', 'TB'], n = Number(bytes) || 0, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : String(n)) + ' ' + units[i];
}

function date(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function rel(p, base) {
    if (!p) return '';
    return fsu.isWithin(p, base) ? path.relative(base, p) || '.' : p;
}

/** Destino real de cada origen tras ejecutar (si se ejecutó). */
function finalDestinations(result) {
    var map = {};
    ((result && result.done) || []).forEach(function (d) { map[fsu.key(d.source)] = d.dest; });
    return map;
}

function unusedRows(plan, result) {
    var finals = finalDestinations(result);
    var failed = {};
    ((result && result.errors) || []).forEach(function (e) { failed[fsu.key(e.source)] = e.message; });
    return (plan.unused || []).map(function (u) {
        var k = fsu.key(u.source);
        return {
            name: u.name, category: u.category, size: u.size, mtime: u.mtime, reason: u.reason,
            source: u.source,
            dest: failed[k] ? null : (finals[k] || u.dest),
            error: failed[k] || null
        };
    });
}

function writeUnusedPDF(plan, result, file) {
    var executed = !!result;
    var rows = unusedRows(plan, result);
    var base = path.dirname(plan.projectFolder);
    var total = rows.reduce(function (a, r) { return a + (r.size || 0); }, 0);
    var blocks = [
        { text: 'BinFlow — Archivos sin uso en el proyecto', size: 16, bold: true },
        { text: 'Proyecto: ' + path.basename(plan.projectPath || plan.projectFolder), size: 10, gap: 4 },
        { text: 'Fecha: ' + date(Date.now()) + (executed ? '' : '   ·   SOLO ANÁLISIS: todavía no se ha movido nada'), size: 10 },
        { text: rows.length + ' archivos · ' + size(total), size: 10, bold: true, gap: 4 },
        { text: 'Estos archivos estaban en la carpeta del proyecto, pero el proyecto de Premiere no los usa. BinFlow no borra nada: ' +
            'los que tienen una versión usada (por ejemplo logo.psd junto a logo.png) se quedan a su lado; los que pertenecen a una carpeta conservada se quedan en ella; ' +
            'el resto se guarda en «' + path.basename(plan.assetsDir) + '/_No usados» para que decidas si los conservas.', size: 9, gap: 6, color: [0.3, 0.3, 0.3] }
    ];
    var order = ['no usado', 'fuente', 'grupo', 'otra versión', 'usado por el proyecto', 'carpeta de Premiere', 'ya en assets'];
    order.forEach(function (reason) {
        var group = rows.filter(function (r) { return r.reason === reason; });
        if (!group.length) return;
        blocks.push({ text: REASONS[reason] + ' (' + group.length + ')', size: 12, bold: true, gap: 12 });
        group.forEach(function (r) {
            blocks.push({ text: '[  ]  ' + r.name, size: 10, bold: true, gap: 5 });
            blocks.push({ text: r.category + ' · ' + size(r.size) + ' · modificado ' + date(r.mtime), size: 8, indent: 14, color: [0.35, 0.35, 0.35] });
            blocks.push({ text: 'Antes: ' + rel(r.source, base), size: 8, indent: 14 });
            if (r.error) blocks.push({ text: 'NO SE MOVIÓ: ' + r.error, size: 8, indent: 14, color: [0.75, 0.1, 0.1] });
            else if (['ya en assets', 'otra versión', 'usado por el proyecto', 'carpeta de Premiere'].indexOf(r.reason) === -1) blocks.push({ text: (executed ? 'Ahora: ' : 'Destino previsto: ') + rel(r.dest, base), size: 8, indent: 14 });
        });
    });
    if (!rows.length) blocks.push({ text: 'No hay archivos sin uso. Todo lo que hay en la carpeta lo usa el proyecto.', size: 10, gap: 10 });
    fs.writeFileSync(file, pdf.render(blocks, 'BinFlow - Archivos sin uso'), { flag: 'wx' }); // nunca se sobrescribe un informe
    return file;
}

function writeHTML(plan, result, file, pdfName) {
    var executed = !!result;
    var base = path.dirname(plan.projectFolder);
    var s = plan.summary || {};
    var errors = (result && result.errors) || [];
    var done = (result && result.done) || [];
    var h = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>BinFlow — Informe</title><style>' +
        'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:#111;color:#eee;margin:0;padding:32px;line-height:1.45}main{max-width:1000px;margin:auto}' +
        'h1{color:#ffd700;margin-bottom:4px}h2{border-bottom:1px solid #333;padding-bottom:6px;margin-top:32px}.muted{color:#999}' +
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}.card{background:#1b1b1b;border:1px solid #333;padding:12px;border-radius:8px}' +
        '.v{font-size:1.6em;color:#ffd700}table{width:100%;border-collapse:collapse;font-size:.92em}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #2a2a2a;vertical-align:top}' +
        'th{color:#ffd700}code{color:#bbb;word-break:break-all}.ok{color:#43e07b}.warn{color:#ffcc66}.err{color:#ff6b6b}details summary{cursor:pointer;color:#ffd700}</style></head><body><main>';
    h += '<h1>BinFlow — ' + (executed ? 'Organización realizada' : 'Análisis (no se ha cambiado nada)') + '</h1>';
    h += '<p class="muted">' + esc(path.basename(plan.projectPath || '')) + ' · ' + esc(date(Date.now())) + '</p>';
    if (plan.blocked) h += '<p class="err"><strong>Bloqueado:</strong> ' + esc(plan.blockReason) + '</p>';
    (plan.confirmations || []).forEach(function (c) { h += '<p class="warn">' + esc(c) + '</p>'; });
    (plan.warnings || []).forEach(function (w) { h += '<p class="warn">' + esc(w) + '</p>'; });
    if ((plan.unreadable || []).length) h += '<p class="err">Sin permiso de lectura:<br>' + plan.unreadable.slice(0, 50).map(function (u) { return '<code>' + esc(u) + '</code>'; }).join('<br>') + '</p>';
    if (executed) h += '<p class="' + (errors.length ? 'warn' : 'ok') + '"><strong>' + (errors.length ? errors.length + ' operaciones no se pudieron completar.' : 'Todo completado sin errores.') + '</strong></p>';
    h += '<div class="grid">' +
        card(s.moves, 'archivos ' + (executed ? 'movidos' : 'a mover')) +
        card(s.copies, 'externos ' + (executed ? 'copiados' : 'a copiar') + ' (' + size(s.bytesToCopy) + ')') +
        card((plan.groups || []).length, 'carpetas conservadas (80 %)') +
        card(s.unusedTotal, 'archivos sin uso') +
        card(s.binMoves, 'ítems que cambian de BIN') +
        card((plan.missing || []).length + (plan.ambiguous || []).length, 'medios sin resolver') + '</div>';

    if (errors.length) {
        h += '<h2 class="err">Errores</h2><table><tr><th>Archivo</th><th>Motivo</th></tr>';
        errors.forEach(function (e) { h += '<tr><td><code>' + esc(rel(e.source, base)) + '</code></td><td>' + esc(e.message) + '</td></tr>'; });
        h += '</table>';
    }
    if ((plan.missing || []).length || (plan.ambiguous || []).length) {
        h += '<h2 class="err">Medios sin resolver</h2><table><tr><th>Medio</th><th>Problema</th></tr>';
        plan.missing.forEach(function (m) { h += '<tr><td>' + esc(m.name) + '<br><code>' + esc(m.path) + '</code></td><td>No se encuentra en disco. Localízalo en Premiere y vuelve a analizar.</td></tr>'; });
        plan.ambiguous.forEach(function (m) { h += '<tr><td>' + esc(m.name) + '<br><code>' + esc(m.path) + '</code></td><td>Hay ' + m.candidates.length + ' archivos con ese nombre:<br>' + m.candidates.map(function (c) { return '<code>' + esc(rel(c, base)) + '</code>'; }).join('<br>') + '</td></tr>'; });
        h += '</table>';
    }
    if ((plan.manual || []).length) {
        var man = plan.manual;
        var movedMan = man.filter(function (m) { return m.moved; });
        var keptMan = man.filter(function (m) { return !m.moved; });
        if (movedMan.length) {
            var offl = movedMan.filter(function (m) { return m.offline; }).length;
            h += '<h2 class="warn">Gráficos de Adobe: re-enlazar a mano</h2><p class="muted">Premiere no permite cambiar la ruta de estos gráficos (.aegraphic, .mogrt…). ' +
                (offl ? offl + ' quedan sin conexión en Premiere: en el panel Proyecto, clic derecho &gt; «Vincular medio» y elige la ruta nueva. ' : '') +
                'Origen y destino de cada uno:</p><table><tr><th>Archivo</th><th>Estaba en</th><th>Ahora está en</th><th>En Premiere</th></tr>';
            movedMan.forEach(function (m) {
                h += '<tr><td>' + esc(m.name) + '</td><td><code>' + esc(rel(m.path, base)) + '</code></td><td><code>' + esc(rel(m.dest, base)) + '</code></td><td>' +
                    (m.offline ? 'Sin conexión: re-enlazar' : 'Sigue enlazado al original (se copió)') + '</td></tr>';
            });
            h += '</table>';
        }
        if (keptMan.length) {
            h += '<h2 class="warn">Revisar a mano</h2><p class="muted">Premiere no permite cambiar la ruta de estos tipos (gráficos de After Effects / Motion). Se dejan donde están.</p><ul>';
            keptMan.forEach(function (m) { h += '<li><code>' + esc(rel(m.path, base)) + '</code></li>'; });
            h += '</ul>';
        }
    }
    if ((plan.groups || []).length) {
        h += '<h2>Carpetas conservadas</h2><p class="muted">BINs con al menos un 80 % de un tipo: se guardan enteros, igual en Premiere que en disco.</p><table><tr><th>BIN</th><th>Destino</th><th>Ítems</th></tr>';
        plan.groups.forEach(function (g) { h += '<tr><td>' + esc(g.bin) + '</td><td>' + esc(g.category + '/' + g.bin.split('/').pop()) + '</td><td>' + g.items + '</td></tr>'; });
        h += '</table>';
    }
    h += '<h2>Archivos sin uso</h2><p class="muted">Detalle completo en el PDF «' + esc(path.basename(pdfName || 'BinFlow_No usados.pdf')) + '» de esta misma carpeta.</p>';
    var unused = unusedRows(plan, result);
    h += '<details><summary>' + unused.length + ' archivos</summary><table><tr><th>Archivo</th><th>Qué se hace</th><th>Destino</th></tr>';
    unused.forEach(function (u) { h += '<tr><td>' + esc(u.name) + '<br><span class="muted">' + esc(size(u.size)) + '</span></td><td>' + esc(REASONS[u.reason] || u.reason) + '</td><td><code>' + esc(u.error ? 'ERROR: ' + u.error : rel(u.dest, base)) + '</code></td></tr>'; });
    h += '</table></details>';
    var list = executed ? done : plan.ops;
    h += '<h2>Todas las operaciones</h2><details><summary>' + list.length + ' operaciones</summary><table><tr><th>Tipo</th><th>Origen</th><th>Destino</th></tr>';
    list.forEach(function (o) { h += '<tr><td>' + esc(o.type) + (o.reason ? '<br><span class="muted">' + esc(o.reason) + '</span>' : '') + '</td><td><code>' + esc(rel(o.source, base)) + '</code></td><td><code>' + esc(rel(o.dest, base)) + '</code></td></tr>'; });
    h += '</table></details>';
    h += '<p class="muted" style="margin-top:32px">Para deshacer: botón «Deshacer última organización» en BinFlow (registro en la carpeta LOG del proyecto, sessions/).</p></main></body></html>';
    fs.writeFileSync(file, h, { encoding: 'utf8', flag: 'wx' }); // nunca se sobrescribe un informe
    return file;

    function card(value, label) { return '<div class="card"><div class="v">' + esc(value || 0) + '</div>' + esc(label) + '</div>'; }
}

function stamp(d) {
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '_' + p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
}

/**
 * N17: un juego de informes por sesión, nunca sobrescribe el anterior:
 *   LOG/<proyecto>/BinFlow_LOG_<fecha>.html, BinFlow_LOG_<fecha>.json y BinFlow_No usados_<fecha>.pdf
 * Si ya existe uno con el mismo segundo se añade «_2», «_3»… Así la ruta original de cada archivo
 * queda en el informe de la sesión en que se movió, aunque se organice otra vez después.
 */
async function writeReports(plan, result) {
    await fsu.mkdirp(plan.logDir);
    var base = stamp(new Date()), n = 1, suffix;
    for (;;) {
        suffix = base + (n > 1 ? '_' + n : '');
        if (!['BinFlow_LOG_' + suffix + '.html', 'BinFlow_LOG_' + suffix + '.json', 'BinFlow_No usados_' + suffix + '.pdf'].some(function (f) { return fs.existsSync(path.join(plan.logDir, f)); })) break;
        n++;
    }
    var htmlPath = path.join(plan.logDir, 'BinFlow_LOG_' + suffix + '.html');
    var jsonPath = path.join(plan.logDir, 'BinFlow_LOG_' + suffix + '.json');
    var pdfPath = path.join(plan.logDir, 'BinFlow_No usados_' + suffix + '.pdf');
    writeHTML(plan, result, htmlPath, pdfPath);
    writeUnusedPDF(plan, result, pdfPath);
    // Sin sangría: el plan completo duplica el tamaño con 30 000 archivos.
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), plan: plan, result: result || null }), { encoding: 'utf8', flag: 'wx' });
    return { htmlPath: htmlPath, jsonPath: jsonPath, pdfPath: pdfPath };
}

module.exports = { writeReports: writeReports, writeUnusedPDF: writeUnusedPDF, writeHTML: writeHTML };
