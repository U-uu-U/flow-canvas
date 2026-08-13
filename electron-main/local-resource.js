const fs = require('fs');
const path = require('path');
const { ReadableStream } = require('stream/web');

const MIME_TYPES = {
    '.aac': 'audio/aac',
    '.avi': 'video/x-msvideo',
    '.bmp': 'image/bmp',
    '.flac': 'audio/flac',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.m4a': 'audio/mp4',
    '.m4v': 'video/x-m4v',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
    '.wmv': 'video/x-ms-wmv'
};

function decodeLocalResourcePath(url) {
    const encodedPath = String(url || '').slice('local-res://'.length).split(/[?#]/, 1)[0];
    return decodeURIComponent(encodedPath).replace(/\0/g, '');
}

function parseByteRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value || '').trim());
    if (!match || size <= 0 || (!match[1] && !match[2])) return null;

    let start;
    let end;
    if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
        start = Math.max(0, size - suffixLength);
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] ? Number(match[2]) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
        if (start < 0 || start >= size || end < start) return null;
        end = Math.min(end, size - 1);
    }

    return { start, end };
}

function baseHeaders(filePath, size) {
    return {
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
        'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Content-Length': String(size)
    };
}

function createFileWebStream(filePath, options = {}) {
    const fileStream = fs.createReadStream(filePath, options);
    const iterator = fileStream[Symbol.asyncIterator]();
    let closed = false;

    return new ReadableStream({
        async pull(controller) {
            if (closed) return;
            try {
                const { value, done } = await iterator.next();
                if (closed) return;
                if (done) {
                    closed = true;
                    controller.close();
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                if (closed || error?.code === 'ERR_INVALID_STATE') return;
                closed = true;
                controller.error(error);
            }
        },
        async cancel() {
            if (closed) return;
            closed = true;
            fileStream.destroy();
            try { await iterator.return?.(); } catch (_) { }
        }
    });
}

async function handleLocalResourceRequest(request) {
    let filePath;
    try {
        filePath = decodeLocalResourcePath(request?.url);
    } catch (_) {
        return new Response('Invalid local resource path', { status: 400 });
    }

    let stat;
    try {
        stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) throw new Error('Not a file');
    } catch (_) {
        return new Response('Local resource not found', { status: 404 });
    }

    const rangeValue = request?.headers?.get?.('range');
    const range = rangeValue ? parseByteRange(rangeValue, stat.size) : null;
    if (rangeValue && !range) {
        return new Response(null, {
            status: 416,
            headers: {
                ...baseHeaders(filePath, 0),
                'Content-Range': `bytes */${stat.size}`
            }
        });
    }

    if (range) {
        const contentLength = range.end - range.start + 1;
        const headers = {
            ...baseHeaders(filePath, contentLength),
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`
        };
        if (request?.method === 'HEAD') return new Response(null, { status: 206, headers });
        return new Response(createFileWebStream(filePath, { start: range.start, end: range.end }), { status: 206, headers });
    }

    const headers = baseHeaders(filePath, stat.size);
    if (request?.method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(createFileWebStream(filePath), { status: 200, headers });
}

module.exports = {
    decodeLocalResourcePath,
    handleLocalResourceRequest,
    parseByteRange
};
