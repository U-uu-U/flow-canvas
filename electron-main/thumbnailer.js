// ============================================================
// Flow Canvas — Thumbnailer Service (fs + nativeImage + LRU Cache)
// ============================================================

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const createLogger = require('../shared/logger');
const { THUMBNAIL_CACHE_MAX_MB, THUMBNAIL_MAX_DIMENSION } = require('./constants');

const logger = createLogger('Thumbnailer');

const IMAGE_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'
]);

class Thumbnailer {
    constructor(maxMemoryMB = THUMBNAIL_CACHE_MAX_MB, dependencies = {}) {
        if (!Number.isFinite(maxMemoryMB) || maxMemoryMB < 0) {
            throw new TypeError('maxMemoryMB 必须是非负数');
        }
        this._cache = new Map();   // filePath → { mtime, dataUrl, size }
        this._maxMemoryBytes = maxMemoryMB * 1024 * 1024;
        this._currentMemory = 0;
        this._inFlight = new Map();
        this._nativeImage = dependencies.nativeImage || nativeImage;
        this._fs = dependencies.fs || fs;
        this._stats = { hits: 0, misses: 0, coalesced: 0 };
    }

    isImageFile(filePath) {
        return IMAGE_EXT.has(path.extname(filePath).toLowerCase());
    }

    /**
     * 获取缩略图 data URL（带 LRU 缓存）
     */
    async getThumbnail(filePath) {
        if (!this.isImageFile(filePath)) return null;

        const inFlight = this._inFlight.get(filePath);
        if (inFlight) {
            this._stats.coalesced++;
            return inFlight;
        }

        const pending = this._loadThumbnail(filePath);
        this._inFlight.set(filePath, pending);
        try {
            return await pending;
        } finally {
            if (this._inFlight.get(filePath) === pending) this._inFlight.delete(filePath);
        }
    }

    async _loadThumbnail(filePath) {
        try {
            let stat;
            try {
                stat = await this._fs.promises.stat(filePath);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    logger.debug('文件不存在', { fileName: path.basename(filePath) });
                    return null;
                }
                throw error;
            }

            // 缓存命中检查（基于文件修改时间）
            const cached = this._cache.get(filePath);
            if (cached && cached.mtime === stat.mtimeMs) {
                this._stats.hits++;
                // 移到最后（LRU 访问更新）
                this._cache.delete(filePath);
                this._cache.set(filePath, cached);
                return cached.dataUrl;
            }
            if (cached) this._removeCacheEntry(filePath);

            this._stats.misses++;

            // 异步读取文件 buffer → nativeImage
            const buf = await this._fs.promises.readFile(filePath);
            const img = this._nativeImage.createFromBuffer(buf);

            if (img.isEmpty()) {
                logger.warn('nativeImage 解码失败', { fileName: path.basename(filePath) });
                return null;
            }

            // 缩小到合理大小
            const size = img.getSize();
            const maxDim = THUMBNAIL_MAX_DIMENSION;
            let dataUrl;
            if (size.width > maxDim || size.height > maxDim) {
                const resizeOptions = size.width >= size.height
                    ? { width: maxDim }
                    : { height: maxDim };
                const resized = img.resize(resizeOptions);
                dataUrl = resized.toDataURL();
            } else {
                dataUrl = img.toDataURL();
            }

            const dataUrlSize = Buffer.byteLength(dataUrl, 'utf8');

            // 单个条目超过预算时直接返回，不让缓存永久超限。
            if (dataUrlSize > this._maxMemoryBytes) return dataUrl;

            // 基于内存大小的 LRU：驱逐直到内存足够
            while (this._currentMemory + dataUrlSize > this._maxMemoryBytes && this._cache.size > 0) {
                const oldestKey = this._cache.keys().next().value;
                this._removeCacheEntry(oldestKey);
            }

            // 写入缓存
            this._cache.set(filePath, { mtime: stat.mtimeMs, dataUrl, size: dataUrlSize });
            this._currentMemory += dataUrlSize;

            return dataUrl;
        } catch (err) {
            logger.error('缩略图生成失败', {
                fileName: path.basename(filePath),
                error: err.message
            });
            return null;
        }
    }

    _removeCacheEntry(filePath) {
        const entry = this._cache.get(filePath);
        if (!entry) return;
        this._currentMemory = Math.max(0, this._currentMemory - entry.size);
        this._cache.delete(filePath);
    }

    clearCache() {
        this._cache.clear();
        this._currentMemory = 0;
    }

    /**
     * 获取缓存统计信息
     */
    getCacheStats() {
        return {
            hits: this._stats.hits,
            misses: this._stats.misses,
            coalesced: this._stats.coalesced,
            hitRate: this._stats.hits / (this._stats.hits + this._stats.misses) || 0,
            cacheSize: this._cache.size,
            memoryUsedBytes: this._currentMemory,
            memoryUsedMB: Number((this._currentMemory / 1024 / 1024).toFixed(2))
        };
    }
}

module.exports = Thumbnailer;
