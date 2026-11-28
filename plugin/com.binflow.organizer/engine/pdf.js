/**
 * Generador PDF mínimo (A4, Helvetica, WinAnsi) sin dependencias.
 * Suficiente para informes de texto con títulos, párrafos y líneas largas que se parten.
 */
'use strict';

var PAGE_W = 595, PAGE_H = 842, MARGIN = 40;
var SPECIAL = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

function toWinAnsi(text) {
    var s = String(text === undefined || text === null ? '' : text).normalize('NFC');
    var out = '';
    for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i), code = s.charCodeAt(i);
        if (code === 9) out += ' ';
        else if (code >= 32 && code < 127) out += ch;
        else if (code >= 160 && code <= 255) out += ch;
        else if (SPECIAL[ch]) out += String.fromCharCode(SPECIAL[ch]);
        else out += '?';
    }
    return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrap(text, size, indent) {
    var maxChars = Math.max(20, Math.floor((PAGE_W - 2 * MARGIN - (indent || 0)) / (size * 0.52)));
    var lines = [];
    String(text).split('\n').forEach(function (paragraph) {
        var rest = paragraph;
        if (!rest.length) { lines.push(''); return; }
        while (rest.length > maxChars) {
            var cut = rest.lastIndexOf(' ', maxChars);
            if (cut < maxChars * 0.5) {
                var slash = rest.lastIndexOf('/', maxChars);
                cut = slash > maxChars * 0.5 ? slash + 1 : maxChars;
            }
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut).replace(/^ /, '');
        }
        lines.push(rest);
    });
    return lines;
}

/**
 * blocks: [{text, size?, bold?, indent?, gap?, color?: [r,g,b]}]
 * Devuelve un Buffer con el PDF.
 */
function render(blocks, title) {
    var pages = [[]];
    var y = PAGE_H - MARGIN;
    blocks.forEach(function (block) {
        var size = block.size || 9;
        var lead = size * 1.35;
        if (block.gap) y -= block.gap;
        wrap(block.text, size, block.indent).forEach(function (line) {
            if (y - lead < MARGIN) { pages.push([]); y = PAGE_H - MARGIN; }
            y -= lead;
            pages[pages.length - 1].push({ x: MARGIN + (block.indent || 0), y: y, size: size, bold: !!block.bold, text: line, color: block.color });
        });
    });

    var objects = [];
    function add(body) { objects.push(body); return objects.length; }
    var catalogId = add(null), pagesId = add(null);
    var fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    var boldId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    var pageIds = [];
    pages.forEach(function (lines, index) {
        var stream = lines.map(function (l) {
            var c = l.color || [0.1, 0.1, 0.1];
            return c.join(' ') + ' rg BT /' + (l.bold ? 'F2' : 'F1') + ' ' + l.size + ' Tf ' + l.x.toFixed(1) + ' ' + l.y.toFixed(1) + ' Td (' + toWinAnsi(l.text) + ') Tj ET';
        }).join('\n');
        stream += '\n0.5 0.5 0.5 rg BT /F1 7 Tf ' + MARGIN + ' 20 Td (' + toWinAnsi((title || 'BinFlow') + ' - página ' + (index + 1) + ' de ' + pages.length) + ') Tj ET';
        var contentId = add('<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream');
        pageIds.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] /Resources << /Font << /F1 ' + fontId + ' 0 R /F2 ' + boldId + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>'));
    });
    objects[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
    objects[pagesId - 1] = '<< /Type /Pages /Kids [' + pageIds.map(function (id) { return id + ' 0 R'; }).join(' ') + '] /Count ' + pageIds.length + ' >>';

    var out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    var offsets = [];
    objects.forEach(function (body, i) {
        offsets.push(Buffer.byteLength(out, 'latin1'));
        out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
    });
    var xref = Buffer.byteLength(out, 'latin1');
    out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    offsets.forEach(function (o) { out += ('0000000000' + o).slice(-10) + ' 00000 n \n'; });
    out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R /Info << /Title (' + toWinAnsi(title || 'BinFlow') + ') /Producer (BinFlow) >> >>\nstartxref\n' + xref + '\n%%EOF\n';
    return Buffer.from(out, 'latin1');
}

module.exports = { render: render };
