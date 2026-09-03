// ============================================================
// Flow Canvas — JSON Store (Zero-Copy Index)
// ============================================================
// 只存储文件路径和画布坐标，不移动/复制任何文件
// 数据量始终保持在 KB 级
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const createLogger = require('../shared/logger');

const logger = createLogger('Store');

const SCHEMA_VERSION = 2;

const DEFAULT_DATA = {
    version: SCHEMA_VERSION,
    watchFolders: [],
    folderGroups: [],       // [{id, name, folders: [...paths], items: [...]}]
    activeGroupId: null,    // 当前激活的文件夹组 ID
    items: [],
    connections: [],        // [{id, from:{nodeId,port}, to:{nodeId,port}}]
    viewport: { x: 0, y: 0, scale: 1 }
};

// 运行态字段只存在于内存，不落盘
const RUNTIME_FIELDS = ['runStatus', 'runError', 'runResult'];

function stripRuntime(item) {
    const clean = { ...item };
    RUNTIME_FIELDS.forEach(key => delete clean[key]);
    return clean;
}

/**
 * v1 → v2：items 引入 kind 字段区分素材卡片与功能节点，
 * 并新增 connections 数组。旧数据全部是素材卡片。
 */
function migrate(data) {
    if ((data.version || 1) >= SCHEMA_VERSION) return data;

    const addKind = item => (item.kind ? item : { ...item, kind: 'media' });

    return {
        ...data,
        version: SCHEMA_VERSION,
        items: (data.items || []).map(addKind),
        connections: data.connections || [],
        folderGroups: (data.folderGroups || []).map(group => ({
            ...group,
            savedItems: (group.savedItems || []).map(addKind),
            savedConnections: group.savedConnections || []
        }))
    };
}

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
                const parsed = { ...DEFAULT_DATA, ...JSON.parse(raw) };
                const migrated = migrate(parsed);
                if (migrated.version !== (parsed.version || 1)) {
                    logger.info('画布数据已迁移', { to: migrated.version });
                }
                return migrated;
            }
        } catch (err) {
            logger.error('画布数据加载失败', { error: err.message });
        }
        return { ...DEFAULT_DATA };
    }

    save(data) {
        try {
            const merged = {
                ...DEFAULT_DATA,
                ...data,
                version: SCHEMA_VERSION,
                items: (data.items || []).map(stripRuntime),
                folderGroups: (data.folderGroups || []).map(group => ({
                    ...group,
                    savedItems: (group.savedItems || []).map(stripRuntime)
                }))
            };
            fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
            return true;
        } catch (err) {
            logger.error('画布数据保存失败', { error: err.message });
            return false;
        }
    }
}

module.exports = Store;
module.exports.migrate = migrate;
module.exports.stripRuntime = stripRuntime;
module.exports.SCHEMA_VERSION = SCHEMA_VERSION;
