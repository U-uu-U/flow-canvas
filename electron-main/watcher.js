// ============================================================
// Flow Canvas - File Watcher (Auto-Sync)
// ============================================================

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

const WATCH_DEPTH = 5;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a']);
const DOCUMENT_EXT = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
const DESIGN_EXT = new Set([
    '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef', '.arw',
    '.obj', '.fbx', '.gltf', '.glb', '.blend', '.sketch', '.fig'
]);

const SUPPORTED_EXT = new Set([
    ...IMAGE_EXT,
    ...VIDEO_EXT,
    ...AUDIO_EXT,
    ...DOCUMENT_EXT,
    ...DESIGN_EXT,
]);

class Watcher {
    constructor(store, onChange) {
        this.store = store;
        this.onChange = onChange;
        this.watchers = new Map();
    }

    isSupportedFile(filePath) {
        if (this.isTemporaryFile(filePath)) return false;
        const ext = path.extname(filePath).toLowerCase();
        return SUPPORTED_EXT.has(ext);
    }

    isReadyFile(filePath) {
        if (!this.isSupportedFile(filePath)) return false;

        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() && stat.size > 0;
        } catch (_) {
            return false;
        }
    }

    isTemporaryFile(filePath) {
        const base = path.basename(String(filePath || ''));
        if (!base) return true;

        const lower = base.toLowerCase();
        if (base.startsWith('.') || base.startsWith('~') || base.endsWith('~')) return true;
        if (lower === 'thumbs.db' || lower === 'desktop.ini') return true;
        if (/\.(tmp|temp|part|partial|crdownload|download|swp|swo)$/i.test(lower)) return true;
        if (/\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff)\.(tmp|temp|part|partial|download)$/i.test(lower)) return true;
        return false;
    }

    add(folderPath) {
        if (!folderPath) return false;
        if (this.watchers.has(folderPath)) return true;

        try {
            const stats = fs.statSync(folderPath);
            if (!stats.isDirectory()) {
                console.warn('[Watcher] Not a directory, skipped:', folderPath);
                return false;
            }
        } catch (err) {
            console.warn('[Watcher] Folder is not accessible, skipped:', folderPath, err.message);
            return false;
        }

        const watcher = chokidar.watch(folderPath, {
            ignored: /(^|[\/\\])\../,
            persistent: true,
            ignoreInitial: true,
            depth: WATCH_DEPTH,
            awaitWriteFinish: {
                stabilityThreshold: 2000,
                pollInterval: 500
            }
        });

        watcher.on('add', (filePath) => {
            if (this.isReadyFile(filePath)) {
                this.onChange('add', filePath);
            }
        });

        watcher.on('unlink', (filePath) => {
            if (this.isSupportedFile(filePath)) {
                this.onChange('remove', filePath);
            }
        });

        watcher.on('error', (err) => {
            console.error('[Watcher] Watch error:', folderPath, err.message);
        });

        this.watchers.set(folderPath, watcher);
        console.log('[Watcher] Started:', folderPath);
        return true;
    }

    remove(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (!watcher) return false;

        watcher.close();
        this.watchers.delete(folderPath);
        console.log('[Watcher] Stopped:', folderPath);
        return true;
    }

    sync(activeFolders = [], knownFolders = []) {
        const activeSet = new Set(activeFolders.filter(Boolean));
        const managedFolders = new Set([
            ...this.watchers.keys(),
            ...knownFolders.filter(Boolean)
        ]);

        managedFolders.forEach((folderPath) => {
            if (!activeSet.has(folderPath)) {
                this.remove(folderPath);
            }
        });

        let allActiveWatched = true;
        activeSet.forEach((folderPath) => {
            allActiveWatched = this.add(folderPath) && allActiveWatched;
        });

        return allActiveWatched;
    }

    scanFolder(folderPath) {
        const files = [];
        try {
            this._walkDir(folderPath, files, 0, WATCH_DEPTH);
            return { success: true, files };
        } catch (err) {
            console.error('[Watcher] Scan failed:', err.message);
            return { success: false, files: [], error: err.message };
        }
    }

    _walkDir(dir, result, depth, maxDepth) {
        if (depth > maxDepth) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._walkDir(fullPath, result, depth + 1, maxDepth);
            } else if (this.isSupportedFile(fullPath)) {
                result.push(fullPath);
            }
        }
    }

    closeAll() {
        for (const [, watcher] of this.watchers) {
            watcher.close();
        }
        this.watchers.clear();
    }
}

module.exports = Watcher;
