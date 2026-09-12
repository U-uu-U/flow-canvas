const fs = require('node:fs');
const path = require('node:path');

function namingPrompt(request = {}, fallback = '') {
    return [request.userPrompt, request.promptDraftConfig?.prompt, request.originalPrompt, request.prompt, fallback]
        .find(value => typeof value === 'string' && value.trim()) || '';
}

function extractGenerationName(prompt) {
    const text = String(prompt || '').slice(0, 12000).normalize('NFKC')
        .replace(/^参考图编号与上传顺序一致[^\n]*(?:\n|$)/, '')
        .replace(/(?:https?:\/\/|data:[^,\s]+,|local-res:\/\/)[^\s<>]+/gi, ' ')
        .replace(/(?:[a-z]:[\\/]|\\\\)[^\s<>]+/gi, ' ')
        .replace(/\[\[(?:image|video|audio|ref)[^\]]*\]\]|@(?:image|video|audio)\d+/gi, '')
        .replace(/(?:参考图|图片|图|视频|音频)[一二三四五六七八九十\d]+/g, '')
        .replace(/(?:^|\s)--[a-z][\s\S]*$/i, '')
        .replace(/[\p{Cc}\p{Cf}]/gu, character => /[\r\n]/.test(character) ? '\n' : ' ');
    const phrases = text.split(/[\n\r.!?;。！？；]/).map(phrase => {
        let clean = phrase.trim().replace(/^[#>*\s]+/, '');
        for (let pass = 0; pass < 6; pass++) {
            const next = clean.replace(/^(?:请(?:帮我|为我)?|帮我|为我|生成|制作|创作|画一张|一张|一段|一个|让|根据|按照|参考图(?:中的|的)?|(?:please\s+)?(?:generate|create|make|draw)\s+(?:(?:an?|the)\s+)?|please\s+)/i, '').trim();
            if (next === clean) break;
            clean = next;
        }
        return clean.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').replace(/[\s_-]+/g, ' ').trim();
    }).filter(phrase => phrase && !/^(?:图片|视频|图像|image|video|picture)$/i.test(phrase));
    const summary = phrases[0] || '未命名';
    const limit = /[\u3400-\u9fff]/.test(summary) ? 24 : 48;
    let shortened = Array.from(summary).slice(0, limit).join('');
    if (summary.length > shortened.length && /^[\x20-\x7e]+$/.test(summary) && shortened.includes(' ')) {
        shortened = shortened.slice(0, shortened.lastIndexOf(' '));
    }
    return shortened.trim().replace(/ /g, '_') || '未命名';
}

// New files only. Exclusive creation also protects against another process using the same folder.
function writeGeneratedMedia(buffer, { targetDir, prompt, mediaType = 'image', extension }) {
    const ext = String(extension || (mediaType === 'video' ? '.mp4' : '.png')).toLowerCase();
    if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw new Error('Invalid generated media extension');
    const summary = extractGenerationName(prompt);
    // These prefixes are reserved for hidden internal placeholders in existing boards.
    const safeSummary = /^flow_(?:source_)?builtin(?:_|$)/i.test(summary) ? `output_${summary}` : summary;
    const stem = `${safeSummary}_${mediaType === 'video' ? '视频' : '图片'}`;
    const prefix = `${stem}_`.normalize('NFC').toLowerCase();
    let sequence = 1;
    for (const name of fs.readdirSync(targetDir)) {
        const normalized = name.normalize('NFC').toLowerCase();
        if (!normalized.startsWith(prefix)) continue;
        const match = normalized.slice(prefix.length).match(/^(\d+)(?:_u\d+)?\.[a-z0-9]+$/i);
        if (match) sequence = Math.max(sequence, Number(match[1]) + 1);
    }
    for (let attempt = 0; attempt < 10000; attempt++, sequence++) {
        if (!Number.isSafeInteger(sequence)) throw new Error('Generated media sequence is out of range');
        const filePath = path.join(targetDir, `${stem}_${String(sequence).padStart(3, '0')}${ext}`);
        let descriptor;
        try {
            descriptor = fs.openSync(filePath, 'wx');
        } catch (error) {
            if (error.code === 'EEXIST') continue;
            throw error;
        }
        try {
            fs.writeFileSync(descriptor, buffer);
        } catch (error) {
            fs.closeSync(descriptor);
            fs.unlinkSync(filePath);
            throw error;
        }
        fs.closeSync(descriptor);
        return filePath;
    }
    throw new Error('No available generated media filename');
}

module.exports = { namingPrompt, extractGenerationName, writeGeneratedMedia };
