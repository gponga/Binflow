/**
 * BinFlow engine — punto de entrada.
 * Separado de CEP: solo usa Node, para poder reutilizarlo desde un panel UXP o un CLI.
 */
'use strict';

var path = require('path');
var plan = require('./plan');
var execute = require('./execute');
var report = require('./report');

/** Carpeta de LOG de un .prproj (misma regla que buildPlan). */
function logDirFor(projectPath) {
    var stem = path.basename(String(projectPath)).replace(/\.prproj$/i, '');
    return path.join(path.dirname(path.resolve(projectPath)), 'LOG', plan.safeSegment(stem));
}

module.exports = {
    version: require('./version'),
    buildPlan: plan.buildPlan,
    createSession: execute.createSession,
    execute: execute.execute,
    finalizeSession: execute.finalizeSession,
    latestSession: execute.latestSession,
    findInterrupted: execute.findInterrupted,
    undo: execute.undo,
    completeUndo: execute.completeUndo,
    writeReports: report.writeReports,
    logDirFor: logDirFor
};
