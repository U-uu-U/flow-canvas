// ============================================================
// Flow Canvas — JSON Store (Zero-Copy Index)
// ============================================================
// 只存储文件路径和画布坐标，不移动/复制任何文件
// 数据量始终保持在 KB 级
// ============================================================

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
    DEFAULT_MCP_CONFIG,
    MCP_BOARD_TOOLS_VERSION,
    normalizeMcpConfig
} = require('../shared/plan-service-core.cjs');

const DEFAULT_DATA = {
    version: 1,
    watchFolders: [],
    folderGroups: [],       // [{id, name, folders: [...paths], items: [...]}]
    assetLibrary: { folders: [], defaultFolder: null },
    activeGroupId: null,    // 当前激活的文件夹组 ID
    items: [],
    connections: [],        // [{id, from: {nodeId, port}, to: {nodeId, port}}]
    boardRevision: 0,
    appliedTransactionKeys: [],
    mcp: { ...DEFAULT_MCP_CONFIG },
    viewport: { x: 0, y: 0, scale: 1 },
    defaultSaveFolder: null,
    activeGroupDefaultSaveFolder: null,
    removedFromBoardPaths: [],
    removedFromBoardPathsInitialized: false,
    sidebarClosed: false
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
                const parsed = JSON.parse(raw);
                const normalized = this._normalizeData(parsed);
                const currentBoardToolsVersion = Number(parsed.mcp?.boardToolsVersion);
                if (!Number.isInteger(currentBoardToolsVersion)
                    || currentBoardToolsVersion < MCP_BOARD_TOOLS_VERSION) {
                    this.save(normalized);
                }
                return normalized;
            }
        } catch (err) {
            console.error('[Store] 加载失败:', err.message);
        }
        return this._normalizeData({});
    }

    save(data) {
        try {
            const merged = this._normalizeData(data);
            const existing = this._readExistingData();
            if (this._looksLikeAccidentalEmptyOverwrite(existing, merged)) {
                console.warn('[Store] 拒绝可疑的空数据覆盖，已保留现有 board.json');
                return false;
            }
            this._backupExistingFile(existing);
            fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
            return true;
        } catch (err) {
            console.error('[Store] 保存失败:', err.message);
            return false;
        }
    }

    _normalizeData(data) {
        const source = data && typeof data === 'object' ? data : {};
        const folderGroups = Array.isArray(source.folderGroups)
            ? source.folderGroups.map(group => this._normalizeGroup(group))
            : [];
        const activeGroup = folderGroups.find(group => group.id === source.activeGroupId) || null;
        const boardRevision = normalizeRevision(activeGroup?.boardRevision ?? source.boardRevision);
        const appliedTransactionKeys = normalizeTransactionKeys(
            activeGroup?.appliedTransactionKeys ?? source.appliedTransactionKeys
        );
        const assetLibrarySource = source.assetLibrary && typeof source.assetLibrary === 'object'
            ? source.assetLibrary
            : {};
        const assetLibraryFolders = Array.isArray(assetLibrarySource.folders)
            ? [...new Set(assetLibrarySource.folders.filter(folder => typeof folder === 'string' && folder.trim()))]
            : [];

        return {
            ...DEFAULT_DATA,
            ...source,
            watchFolders: Array.isArray(source.watchFolders) ? [...source.watchFolders] : [],
            folderGroups,
            assetLibrary: {
                folders: assetLibraryFolders,
                defaultFolder: typeof assetLibrarySource.defaultFolder === 'string'
                    ? assetLibrarySource.defaultFolder
                    : null
            },
            activeGroupId: activeGroup ? activeGroup.id : (source.activeGroupId || null),
            items: Array.isArray(source.items) ? [...source.items] : [],
            connections: Array.isArray(source.connections) ? [...source.connections] : [],
            boardRevision,
            appliedTransactionKeys,
            removedFromBoardPaths: Array.isArray(source.removedFromBoardPaths)
                ? [...source.removedFromBoardPaths]
                : [],
            removedFromBoardPathsInitialized: source.removedFromBoardPathsInitialized === true,
            mcp: normalizeMcpConfig(source.mcp),
            viewport: { ...DEFAULT_DATA.viewport, ...(source.viewport || {}) },
            defaultSaveFolder: typeof source.defaultSaveFolder === 'string' ? source.defaultSaveFolder : null,
            activeGroupDefaultSaveFolder: activeGroup?.defaultSaveFolder || null,
            sidebarClosed: Boolean(source.sidebarClosed)
        };
    }

    _normalizeGroup(group) {
        const source = group && typeof group === 'object' ? group : {};
        const folders = Array.isArray(source.folders) ? [...source.folders] : [];
        const savedItems = Array.isArray(source.savedItems)
            ? source.savedItems
            : Array.isArray(source.items)
                ? source.items
                : [];
        const savedViewport = source.savedViewport || source.viewport || null;
        const defaultSaveFolder = folders.includes(source.defaultSaveFolder)
            ? source.defaultSaveFolder
            : (folders[0] || null);
        const normalized = {
            ...source,
            folders,
            savedItems: [...savedItems],
            savedViewport: savedViewport ? { ...DEFAULT_DATA.viewport, ...savedViewport } : null,
            defaultSaveFolder,
            removedFromBoardPaths: Array.isArray(source.removedFromBoardPaths)
                ? [...source.removedFromBoardPaths]
                : [],
            removedFromBoardPathsInitialized: source.removedFromBoardPathsInitialized === true,
            plans: Array.isArray(source.plans) ? [...source.plans] : [],
            connections: Array.isArray(source.connections) ? [...source.connections] : [],
            boardRevision: normalizeRevision(source.boardRevision),
            appliedTransactionKeys: normalizeTransactionKeys(source.appliedTransactionKeys)
        };

        delete normalized.items;
        delete normalized.viewport;
        return normalized;
    }

    _readExistingData() {
        try {
            if (!fs.existsSync(this.filePath)) return null;
            const raw = fs.readFileSync(this.filePath, 'utf-8');
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    _looksLikeAccidentalEmptyOverwrite(existing, next) {
        const existingGroups = Array.isArray(existing?.folderGroups) ? existing.folderGroups.length : 0;
        const existingWatchFolders = Array.isArray(existing?.watchFolders) ? existing.watchFolders.length : 0;
        const existingItems = Array.isArray(existing?.items) ? existing.items.length : 0;
        const existingAssetFolders = Array.isArray(existing?.assetLibrary?.folders)
            ? existing.assetLibrary.folders.length
            : 0;
        const nextGroups = Array.isArray(next?.folderGroups) ? next.folderGroups.length : 0;
        const nextWatchFolders = Array.isArray(next?.watchFolders) ? next.watchFolders.length : 0;
        const nextItems = Array.isArray(next?.items) ? next.items.length : 0;
        const nextAssetFolders = Array.isArray(next?.assetLibrary?.folders)
            ? next.assetLibrary.folders.length
            : 0;
        const existingHasBoardData = existingGroups > 0 || existingWatchFolders > 0
            || existingItems > 0 || existingAssetFolders > 0;
        const nextIsEmptyBoard = nextGroups === 0 && nextWatchFolders === 0 && nextItems === 0
            && nextAssetFolders === 0 && !next.activeGroupId;
        return existingHasBoardData && nextIsEmptyBoard;
    }

    _backupExistingFile(existing) {
        if (!existing || !fs.existsSync(this.filePath)) return;
        const backupDir = path.join(this.dataDir, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(backupDir, `board-${stamp}.json`);
        fs.copyFileSync(this.filePath, backupPath);

        const backups = fs.readdirSync(backupDir)
            .filter(name => /^board-.*\.json$/i.test(name))
            .map(name => ({
                name,
                fullPath: path.join(backupDir, name),
                mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs
            }))
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
        backups.slice(30).forEach(entry => {
            try { fs.unlinkSync(entry.fullPath); } catch (_) { }
        });
    }
}

function normalizeRevision(value) {
    const revision = Number(value);
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeTransactionKeys(value) {
    return [...new Set((Array.isArray(value) ? value : [])
        .map(key => String(key || '').trim())
        .filter(Boolean))].slice(-200);
}

module.exports = Store;
