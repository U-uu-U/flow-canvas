// ============================================================
// Flow Canvas — Thumbnailer Service (fs + nativeImage + LRU Cache)
// ============================================================

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'
]);

class Thumbnailer {
    constructor() {
        this._cache = new Map();   // filePath → { mtime, dataUrl }
        this._maxCache = 200;
    }

    isImageFile(filePath) {
        return IMAGE_EXT.has(path.extname(filePath).toLowerCase());
    }

    /**
     * 获取缩略图 data URL（带 LRU 缓存）
     */
    async getThumbnail(filePath) {
        try {
            if (!this.isImageFile(filePath)) {
                return null;
            }

            if (!fs.existsSync(filePath)) {
                console.log('[Thumbnailer] 文件不存在:', filePath);
                return null;
            }

            // 缓存命中检查（基于文件修改时间）
            const stat = fs.statSync(filePath);
            const cached = this._cache.get(filePath);
            if (cached && cached.mtime === stat.mtimeMs) {
                return cached.dataUrl;
            }

            // 直接读取文件 buffer → nativeImage
            const buf = fs.readFileSync(filePath);
            const img = nativeImage.createFromBuffer(buf);

            if (img.isEmpty()) {
                console.log('[Thumbnailer] nativeImage 为空:', filePath);
                return null;
            }

            // 缩小到合理大小
            const size = img.getSize();
            const maxDim = 300;
            let dataUrl;
            if (size.width > maxDim || size.height > maxDim) {
                const resized = img.resize({ width: maxDim });
                dataUrl = resized.toDataURL();
            } else {
                dataUrl = img.toDataURL();
            }

            // 写入缓存（简易 LRU：超限删最早的）
            if (this._cache.size >= this._maxCache) {
                const oldestKey = this._cache.keys().next().value;
                this._cache.delete(oldestKey);
            }
            this._cache.set(filePath, { mtime: stat.mtimeMs, dataUrl });

            return dataUrl;
        } catch (err) {
            console.error('[Thumbnailer] 失败:', filePath, err.message);
            return null;
        }
    }
}

module.exports = Thumbnailer;
