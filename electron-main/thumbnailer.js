const fs = require('node:fs');
const sharp = require('sharp');

const ERRORS = {
    missing: { code: 'FILE_MISSING', message: '文件失联' },
    unreadable: { code: 'FILE_UNREADABLE', message: '文件读取失败' },
    empty: { code: 'FILE_EMPTY', message: '文件为空' },
    html: { code: 'NOT_IMAGE_HTML', message: '文件是网页' },
    unsupported: { code: 'IMAGE_DECODE_FAILED', message: '图片损坏或不支持' },
    large: { code: 'IMAGE_TOO_LARGE', message: '图片尺寸过大' }
};
const failure = kind => ({ success: false, error: ERRORS[kind] });
const browserFormats = new Set(['jpeg', 'png', 'webp', 'gif', 'svg']);

class Thumbnailer {
    constructor() {
        this._cache = new Map();
        this._pending = new Map();
        this._cacheBytes = 0;
        this._maxCacheBytes = 64 * 1024 * 1024;
        this._queue = [];
        this._active = 0;
    }

    async getThumbnail(filePath, maxDim = 200) {
        const preview = await this.getPreview(filePath, maxDim);
        return preview.success ? preview.dataUrl : null;
    }

    async getPreview(filePath, maxDim = 200, preferOriginal = false) {
        if (typeof filePath !== 'string' || !filePath) return failure('missing');
        const dimension = Math.round(Math.min(4096, Math.max(32, Number(maxDim) || 200)));
        let stat;
        try {
            stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) return failure('missing');
        } catch (error) { return failure(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing' : 'unreadable'); }
        if (!stat.size) return failure('empty');
        const key = JSON.stringify([filePath, stat.mtimeMs, stat.ctimeMs, stat.size, dimension, !!preferOriginal]);
        if (this._cache.has(key)) {
            const entry = this._cache.get(key);
            this._cache.delete(key);
            this._cache.set(key, entry);
            return entry;
        }
        if (this._pending.has(key)) return this._pending.get(key);
        const work = this._schedule(() => this._decode(filePath, dimension, preferOriginal)).then(result => {
            if (result.success || ['NOT_IMAGE_HTML', 'IMAGE_DECODE_FAILED', 'IMAGE_TOO_LARGE'].includes(result.error?.code)) {
                const bytes = result.dataUrl?.length || 0;
                while (this._cache.size && (this._cacheBytes + bytes > this._maxCacheBytes || this._cache.size >= 200)) {
                    const oldest = this._cache.keys().next().value;
                    this._cacheBytes -= this._cache.get(oldest).dataUrl?.length || 0;
                    this._cache.delete(oldest);
                }
                if (bytes <= this._maxCacheBytes) {
                    this._cache.set(key, result);
                    this._cacheBytes += bytes;
                }
            }
            return result;
        }).finally(() => this._pending.delete(key));
        this._pending.set(key, work);
        return work;
    }

    _schedule(work) {
        return new Promise((resolve, reject) => {
            this._queue.push({ work, resolve, reject });
            this._drain();
        });
    }

    _drain() {
        while (this._active < 2 && this._queue.length) {
            const { work, resolve, reject } = this._queue.shift();
            this._active++;
            Promise.resolve().then(work).then(resolve, reject).finally(() => { this._active--; this._drain(); });
        }
    }

    async _decode(filePath, dimension, preferOriginal) {
        let input;
        try {
            // Buffer input prevents libvips' operation cache from keeping Windows source files locked.
            input = await fs.promises.readFile(filePath);
            const header = input.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
            if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:!doctype\s+html|html|head|body)(?:\s|>)/i.test(header)) return failure('html');
        } catch (error) { return failure(error.code === 'ENOENT' ? 'missing' : 'unreadable'); }
        try {
            const metadata = await sharp(input).metadata();
            const height = metadata.pageHeight || metadata.height;
            const rotated = [5, 6, 7, 8].includes(metadata.orientation);
            const size = { width: rotated ? height : metadata.width, height: rotated ? metadata.width : height };
            if (!size.width || !size.height) return failure('unsupported');
            // Avoid allocating a full 100+ MP bitmap in Chromium just to draw a canvas tile.
            if (preferOriginal && browserFormats.has(metadata.format) && size.width * size.height <= 16 * 1024 * 1024
                && Math.max(size.width, size.height) <= 8192) {
                return { success: true, useOriginal: true, ...size };
            }
            const { data, info } = await sharp(input).rotate().resize({ width: dimension, height: dimension,
                fit: 'inside', withoutEnlargement: true }).png({ compressionLevel: 3 }).toBuffer({ resolveWithObject: true });
            return { success: true, useOriginal: false, ...size, previewWidth: info.width, previewHeight: info.height,
                dataUrl: `data:image/png;base64,${data.toString('base64')}` };
        } catch (error) {
            if (error.code === 'ENOENT') return failure('missing');
            if (['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) return failure('unreadable');
            return failure(/pixel limit/i.test(error.message) ? 'large' : 'unsupported');
        }
    }
}

module.exports = Thumbnailer;
