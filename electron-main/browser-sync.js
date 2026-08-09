const fs = require('fs');
const path = require('path');

const ROUTE_LIMIT = 500;
const EVENT_LIMIT = 1000;

class BrowserSyncService {
    constructor(store) {
        this.dataDir = store.dataDir;
        this.routesPath = path.join(this.dataDir, 'browser-task-routes.json');
        this.eventsPath = path.join(this.dataDir, 'browser-task-events.jsonl');
    }

    registerTaskRoute(event = {}) {
        const remoteTaskId = String(event.remoteTaskId || event.taskId || '').trim();
        if (!remoteTaskId) return null;
        const routes = this._readJson(this.routesPath, {});
        routes[remoteTaskId] = {
            clientTaskId: String(event.clientTaskId || '').trim() || null,
            remoteTaskId,
            targetDir: String(event.targetDir || '').trim() || null,
            model: String(event.model || '').trim(),
            prompt: String(event.prompt || ''),
            createdAt: event.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        const entries = Object.entries(routes)
            .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
            .slice(0, ROUTE_LIMIT);
        this._writeJson(this.routesPath, Object.fromEntries(entries));
        return routes[remoteTaskId];
    }

    markTaskCompleted(remoteTaskId, filePath) {
        const taskId = String(remoteTaskId || '').trim();
        if (!taskId) return null;
        const routes = this._readJson(this.routesPath, {});
        const route = routes[taskId];
        if (!route) return null;
        routes[taskId] = {
            ...route,
            status: 'completed',
            filePath: String(filePath || '').trim() || null,
            completedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        this._writeJson(this.routesPath, routes);
        return routes[taskId];
    }

    getEvents() {
        try {
            if (!fs.existsSync(this.eventsPath)) return [];
            return fs.readFileSync(this.eventsPath, 'utf8')
                .split(/\r?\n/)
                .filter(Boolean)
                .slice(-EVENT_LIMIT)
                .map(line => {
                    try { return JSON.parse(line); } catch (_) { return null; }
                })
                .filter(Boolean);
        } catch (error) {
            console.warn('[BrowserSync] Failed to read events:', error.message);
            return [];
        }
    }

    _readJson(filePath, fallback) {
        try {
            if (!fs.existsSync(filePath)) return fallback;
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (_) {
            return fallback;
        }
    }

    _writeJson(filePath, value) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const temporaryPath = `${filePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
        try { fs.rmSync(filePath, { force: true }); } catch (_) { }
        fs.renameSync(temporaryPath, filePath);
    }
}

module.exports = BrowserSyncService;
