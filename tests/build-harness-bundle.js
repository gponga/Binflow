/**
 * Genera un único HTML autocontenido a partir de tests/ui-harness.html
 * (CSS + scripts incrustados) para abrirlo en navegadores que no cargan archivos relativos.
 * Uso: node tests/build-harness-bundle.js <salida.html> [--fonts]
 */
'use strict';
var fs = require('fs');
var path = require('path');
var out = process.argv[2];
var withFonts = process.argv.indexOf('--fonts') !== -1;
if (!out) { console.error('Falta la ruta de salida.'); process.exit(1); }
var root = path.join(__dirname, '..', 'plugin', 'com.binflow.organizer');
var html = fs.readFileSync(path.join(__dirname, 'ui-harness.html'), 'utf8');
var css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
css = css.replace(/url\('fonts\/([^']+)'\)/g, function (m, f) {
    if (!withFonts || /Medium/.test(f)) return "url('')";
    return "url(data:font/ttf;base64," + fs.readFileSync(path.join(root, 'fonts', f)).toString('base64') + ")";
});
html = html.replace('<link rel="stylesheet" href="../plugin/com.binflow.organizer/style.css">', function () { return '<style>' + css + '</style>'; });
['ui/ui-logic.js', 'main.js'].forEach(function (f) {
    var code = fs.readFileSync(path.join(root, f), 'utf8');
    html = html.replace('<script src="../plugin/com.binflow.organizer/' + f + '"></script>', function () { return '<script>' + code + '</script>'; });
});
fs.writeFileSync(out, html);
console.log('Escrito ' + out + ' (' + html.length + ' bytes)');
