const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REFERENCE_CACHE_VERSION = 1;

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function extensionForMimeType(mimeType) {
    return mimeType === 'image/webp' ? 'webp' : 'jpg';
}

class ReferenceCache {
    constructor(rootDir, options = {}) {
        this.rootDir = rootDir;
        this.manifestPath = path.join(rootDir, 'index.json');
        this.now = options.now || (() => Date.now());
        this.manifest = null;
        this.loadTask = null;
        this.writeTask = Promise.resolve();
        this.compressionTasks = new Map();
    }

    async _load() {
        if (this.manifest) return this.manifest;
        if (this.loadTask) return this.loadTask;
        this.loadTask = (async () => {
            await fs.promises.mkdir(this.rootDir, { recursive: true });
            let saved = {};
            try {
                saved = JSON.parse(await fs.promises.readFile(this.manifestPath, 'utf8'));
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    console.warn('[ReferenceCache] Failed to read cache index:', error.message);
                }
            }
            this.manifest = {
                version: REFERENCE_CACHE_VERSION,
                compressions: saved?.version === REFERENCE_CACHE_VERSION && saved.compressions
                    ? saved.compressions
                    : {},
                uploads: saved?.version === REFERENCE_CACHE_VERSION && saved.uploads
                    ? saved.uploads
                    : {}
            };
            return this.manifest;
        })();
        return this.loadTask;
    }

    async _persist() {
        const snapshot = JSON.stringify(this.manifest, null, 2);
        this.writeTask = this.writeTask
            .catch(() => {})
            .then(() => fs.promises.writeFile(this.manifestPath, snapshot, 'utf8'));
        return this.writeTask;
    }

    async getOrCreateCompressed({ sourcePath, targetBytes, compress }) {
        const sourceHash = await sha256File(sourcePath);
        const cacheKey = sha256(`${REFERENCE_CACHE_VERSION}:${sourceHash}:${targetBytes}`);
        const pending = this.compressionTasks.get(cacheKey);
        if (pending) return pending;

        const task = this._getOrCreateCompressed({
            cacheKey,
            sourceHash,
            sourcePath,
            targetBytes,
            compress
        });
        this.compressionTasks.set(cacheKey, task);
        try {
            return await task;
        } finally {
            this.compressionTasks.delete(cacheKey);
        }
    }

    async _getOrCreateCompressed({ cacheKey, sourceHash, sourcePath, targetBytes, compress }) {
        const manifest = await this._load();
        const existing = manifest.compressions[cacheKey];
        if (existing?.fileName) {
            const filePath = path.join(this.rootDir, path.basename(existing.fileName));
            const stat = await fs.promises.stat(filePath).catch(() => null);
            if (stat?.isFile()) {
                return {
                    ...existing,
                    sourceHash,
                    filePath,
                    compressedBytes: stat.size,
                    cacheReused: true
                };
            }
            delete manifest.compressions[cacheKey];
        }

        const result = await compress(sourcePath, targetBytes);
        const contentHash = sha256(result.buffer);
        const referenceId = `ref_${contentHash.slice(0, 24)}`;
        const fileName = `${referenceId}.${extensionForMimeType(result.mimeType)}`;
        const filePath = path.join(this.rootDir, fileName);
        await fs.promises.writeFile(filePath, result.buffer, { flag: 'wx' }).catch(error => {
            if (error.code !== 'EEXIST') throw error;
        });
        const record = {
            referenceId,
            sourceHash,
            contentHash,
            fileName,
            mimeType: result.mimeType,
            targetBytes,
            compressedBytes: result.buffer.length,
            width: result.width || null,
            height: result.height || null,
            createdAt: new Date(this.now()).toISOString()
        };
        manifest.compressions[cacheKey] = record;
        await this._persist();
        return { ...record, filePath, cacheReused: false };
    }

    async getUpload(cacheKey) {
        const manifest = await this._load();
        const cached = manifest.uploads[cacheKey];
        if (!cached) return null;
        if (!cached.url || Number(cached.expiresAt) <= this.now()) {
            delete manifest.uploads[cacheKey];
            await this._persist();
            return null;
        }
        return { ...cached };
    }

    async setUpload(cacheKey, value) {
        const manifest = await this._load();
        manifest.uploads[cacheKey] = {
            url: String(value.url || ''),
            expiresAt: Number(value.expiresAt) || this.now(),
            referenceId: value.referenceId || null,
            providerId: value.providerId || null,
            savedAt: new Date(this.now()).toISOString()
        };
        await this._persist();
        return { ...manifest.uploads[cacheKey] };
    }
}

module.exports = {
    REFERENCE_CACHE_VERSION,
    ReferenceCache,
    sha256,
    sha256File
};
