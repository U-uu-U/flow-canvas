const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');

const mediaKind = file => /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(file) ? 'video'
    : /\.(mp3|wav|ogg|flac|aac|m4a)$/i.test(file) ? 'audio' : 'image';
const imagePart = url => ({ type: 'image_url', image_url: { url, detail: 'high' } });

class AgentMedia {
    constructor({ board, directory, readFrames, extraRoots = () => [] }) {
        Object.assign(this, { board, directory, readFrames, extraRoots });
        fs.mkdirSync(directory, { recursive: true });
    }
    async read(projectId, { nodeId, detail = 'preview', time, crop } = {}, signal) {
        const project = this.board.readProject(projectId);
        const node = project.items.find(item => item.id === nodeId);
        if (!node) throw new Error('素材节点不存在');
        const filePath = node.filePath || node.runResult?.filePaths?.[0] || node.runResult?.items?.[0]?.filePath;
        if (!filePath || !fs.existsSync(filePath)) throw new Error('素材文件已断联，请先重接');
        const realPath = fs.realpathSync(filePath);
        const roots = [...(project.folders || []), project.defaultSaveFolder, ...this.extraRoots()].filter(Boolean);
        if (!roots.some(root => {
            try { const relative = path.relative(fs.realpathSync(root), realPath); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
            catch { return false; }
        })) throw new Error('素材不在项目或素材库目录中');
        const stat = fs.statSync(realPath);
        const kind = mediaKind(realPath);
        const key = crypto.createHash('sha256').update(JSON.stringify({ realPath, size: stat.size, mtime: stat.mtimeMs, detail, time, crop, version: 1 })).digest('hex');
        const cachePath = path.join(this.directory, `${key}.json`);
        let cached;
        try { cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf8')); } catch { /* Cache miss. */ }
        if (signal?.aborted) throw new Error('素材读取已取消');
        if (!cached) {
            if (kind === 'audio') cached = { evidence: '仅提供音频文件信息，未收听或转录', images: [] };
            else if (kind === 'video') {
                const result = await this.readFrames(realPath, time, signal);
                cached = { duration: result.duration, evidence: '视频抽样帧；不代表完整动作或音频分析',
                    frames: result.frames.map(frame => ({ time: frame.time })), images: result.frames.map(frame => imagePart(frame.dataUrl)) };
            } else {
                let pipeline = sharp(realPath).rotate();
                if (crop) {
                    const oriented = await pipeline.toBuffer({ resolveWithObject: true });
                    const { width, height } = oriented.info;
                    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
                        || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
                        || crop.x + crop.width > 1 || crop.y + crop.height > 1) throw new Error('裁切区域必须在素材内');
                    const left = Math.floor(crop.x * width), top = Math.floor(crop.y * height);
                    pipeline = sharp(oriented.data).extract({ left, top,
                        width: Math.max(1, Math.min(width - left, Math.round(crop.width * width))),
                        height: Math.max(1, Math.min(height - top, Math.round(crop.height * height))) });
                }
                const max = detail === 'high' ? 2048 : 1024;
                const preview = await pipeline.resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
                cached = { evidence: crop ? '用户素材的指定区域' : '用户素材的实际预览', images: [imagePart(`data:image/jpeg;base64,${preview.toString('base64')}`)] };
            }
            if (signal?.aborted) throw new Error('素材读取已取消');
            const temporary = `${cachePath}.tmp`;
            await fs.promises.writeFile(temporary, JSON.stringify(cached));
            await fs.promises.rename(temporary, cachePath);
            const entries = await fs.promises.readdir(this.directory);
            if (entries.length > 160) {
                const files = entries.filter(name => /^[a-f0-9]{64}\.json$/.test(name))
                    .map(name => ({ name, mtime: fs.statSync(path.join(this.directory, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
                await Promise.all(files.slice(128).map(file => fs.promises.unlink(path.join(this.directory, file.name)).catch(() => {})));
            }
        }
        return { nodeId, kind, fileName: path.basename(filePath), fingerprint: key, bytes: stat.size, ...cached,
            images: cached.images.flatMap((image, index) => [
                { type: 'text', text: `节点 ${nodeId}，文件 ${path.basename(filePath)}${cached.frames ? `，视频时间 ${cached.frames[index].time.toFixed(2)} 秒` : crop ? `，区域 ${JSON.stringify(crop)}` : ''}` }, image
            ]) };
    }
}
module.exports = { AgentMedia, mediaKind };
