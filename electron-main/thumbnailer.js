// ============================================================
// Flow Canvas — Thumbnailer Service (fs + nativeImage)
// ============================================================

const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'
]);

class Thumbnailer {
    constructor() { }

    isImageFile(filePath) {
        return IMAGE_EXT.has(path.extname(filePath).toLowerCase());
    }

    /**
     * 获取缩略图 data URL
     * 最可靠的方式：直接读取文件 → nativeImage → resize → toDataURL
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
            if (size.width > maxDim || size.height > maxDim) {
                const resized = img.resize({ width: maxDim });
                const dataUrl = resized.toDataURL();
                console.log('[Thumbnailer] 成功 (resized):', filePath);
                return dataUrl;
            }

            const dataUrl = img.toDataURL();
            console.log('[Thumbnailer] 成功:', filePath);
            return dataUrl;
        } catch (err) {
            console.error('[Thumbnailer] 失败:', filePath, err.message);
            return null;
        }
    }
}

module.exports = Thumbnailer;
