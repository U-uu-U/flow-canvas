// ============================================================
// Flow Canvas — File Watcher (Auto-Sync)
// ============================================================
// 基于 chokidar 监听关联文件夹的文件变动
// ============================================================

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

// 支持的文件扩展名
const SUPPORTED_EXT = new Set([
    // 图片
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico', '.tiff', '.tif',
    '.psd', '.ai', '.eps', '.raw', '.cr2', '.nef', '.arw',
    // 视频
    '.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm', '.m4v',
    // 音频
    '.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a',
    // 文档
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // 3D / 设计
    '.obj', '.fbx', '.gltf', '.glb', '.blend', '.sketch', '.fig',
]);

class Watcher {
    constructor(store, onChange) {
        this.store = store;
        this.onChange = onChange;
        this.watchers = new Map(); // folderPath → chokidar.FSWatcher
    }

    isSupportedFile(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return SUPPORTED_EXT.has(ext);
    }

    add(folderPath) {
        if (this.watchers.has(folderPath)) return;

        const watcher = chokidar.watch(folderPath, {
            ignored: /(^|[\/\\])\../, // 忽略隐藏文件
            persistent: true,
            ignoreInitial: true,
            depth: 2,                    // 减少监听深度，降低句柄占用
            awaitWriteFinish: {
                stabilityThreshold: 2000, // 大文件写入等待更久
                pollInterval: 500         // 降低轮询频率
            }
        });

        watcher.on('add', (filePath) => {
            if (this.isSupportedFile(filePath)) {
                this.onChange('add', filePath);
            }
        });

        watcher.on('unlink', (filePath) => {
            if (this.isSupportedFile(filePath)) {
                this.onChange('remove', filePath);
            }
        });

        this.watchers.set(folderPath, watcher);
        console.log('[Watcher] 开始监听:', folderPath);
    }

    remove(folderPath) {
        const watcher = this.watchers.get(folderPath);
        if (watcher) {
            watcher.close();
            this.watchers.delete(folderPath);
            console.log('[Watcher] 停止监听:', folderPath);
        }
    }

    /**
     * 扫描文件夹中已有的文件
     * @returns {string[]} 文件路径列表
     */
    scanFolder(folderPath) {
        const files = [];
        try {
            this._walkDir(folderPath, files, 0, 5);
        } catch (err) {
            console.error('[Watcher] 扫描失败:', err.message);
        }
        return files;
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
