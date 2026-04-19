// ============================================================
// Flow Canvas — JSON Store (Zero-Copy Index)
// ============================================================
// 只存储文件路径和画布坐标，不移动/复制任何文件
// 数据量始终保持在 KB 级
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_DATA = {
    version: 1,
    watchFolders: [],
    folderGroups: [],       // [{id, name, folders: [...paths], items: [...]}]
    activeGroupId: null,    // 当前激活的文件夹组 ID
    items: [],
    viewport: { x: 0, y: 0, scale: 1 }
};

class Store {
    constructor() {
        this.dataDir = path.join(app.getPath('userData'), 'data');
        this.filePath = path.join(this.dataDir, 'board.json');
        this._ensureDir();
    }

    _ensureDir() {
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf-8');
                return { ...DEFAULT_DATA, ...JSON.parse(raw) };
            }
        } catch (err) {
            console.error('[Store] 加载失败:', err.message);
        }
        return { ...DEFAULT_DATA };
    }

    save(data) {
        try {
            const merged = { ...DEFAULT_DATA, ...data };
            fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
            return true;
        } catch (err) {
            console.error('[Store] 保存失败:', err.message);
            return false;
        }
    }
}

module.exports = Store;
