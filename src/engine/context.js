// Process-wide configuration shared by engine modules (set once in main.js).
let cfg = null;

export function setEngineConfig(c) {
    cfg = c;
}

export function engineConfig() {
    if (!cfg) throw new Error('Engine configuration not set');
    return cfg;
}

/** Path translation options for the controller namespace. */
export function pathOpts(from, to) {
    return { from, to, controllerRoot: engineConfig().backupRoot };
}
