#!/usr/bin/env node

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const DEFAULT_BASE_URL = `http://127.0.0.1:${process.env.FLOW_CANVAS_MCP_PORT || '18765'}`;
const BASE_URL = (process.env.FLOW_CANVAS_BRIDGE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

const tools = [
    {
        name: 'flow_canvas.health',
        description: 'Check whether the Flow Canvas local bridge is running and reachable.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flow_canvas.config.get',
        description: 'Read the Flow Canvas MCP configuration and runtime status.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flow_canvas.config.update',
        description: 'Update Flow Canvas MCP settings such as enabled state, port, and allowed tools.',
        inputSchema: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean' },
                port: { type: 'integer' },
                allowedTools: {
                    type: 'array',
                    items: { type: 'string' }
                }
            }
        }
    },
    {
        name: 'flow_canvas.context.get_active_group',
        description: 'Get the active Flow Canvas folder group, planning context, viewport, and item count.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flow_canvas.plan.list',
        description: 'List planning matrix tables in the active folder group.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flow_canvas.plan.get',
        description: 'Get a planning matrix table by id.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' }
            },
            required: ['planId']
        }
    },
    {
        name: 'flow_canvas.plan.create',
        description: 'Create a planning matrix table in the active folder group.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                node: {
                    type: 'object',
                    properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        width: { type: 'number' },
                        height: { type: 'number' }
                    }
                }
            }
        }
    },
    {
        name: 'flow_canvas.plan.update',
        description: 'Update a planning matrix title, rows, columns, or node position.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                title: { type: 'string' },
                rows: { type: 'array', items: { type: 'object' } },
                node: { type: 'object' }
            },
            required: ['planId']
        }
    },
    {
        name: 'flow_canvas.plan.row.add',
        description: 'Add a row to a planning matrix table.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                index: { type: 'integer' },
                cells: { type: 'object' },
                references: { type: 'array', items: { type: 'object' } }
            },
            required: ['planId']
        }
    },
    {
        name: 'flow_canvas.plan.row.update',
        description: 'Update a planning matrix row. Use cells for multiple cells, or cellKey/value for one cell.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                rowId: { type: 'string' },
                cells: { type: 'object' },
                cellKey: { type: 'string' },
                value: { type: 'string' },
                references: { type: 'array', items: { type: 'object' } }
            },
            required: ['planId', 'rowId']
        }
    },
    {
        name: 'flow_canvas.plan.row.delete',
        description: 'Delete a row from a planning matrix table.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' },
                rowId: { type: 'string' }
            },
            required: ['planId', 'rowId']
        }
    },
    {
        name: 'flow_canvas.plan.delete',
        description: 'Delete a planning matrix table.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' }
            },
            required: ['planId']
        }
    },
    {
        name: 'flow_canvas.plan.export',
        description: 'Export a planning matrix table as Markdown.',
        inputSchema: {
            type: 'object',
            properties: {
                planId: { type: 'string' }
            },
            required: ['planId']
        }
    },
    {
        name: 'flow_canvas.image.generate',
        description: 'Generate an image and add it to the Flow Canvas board. Uses OpenAI if OPENAI_API_KEY is set, otherwise local built-in generation.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                provider: { type: 'string', enum: ['auto', 'builtin'] },
                title: { type: 'string' },
                planId: { type: 'string' },
                rowId: { type: 'string' },
                sourceReferences: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            itemId: { type: 'string' },
                            filePath: { type: 'string' },
                            name: { type: 'string' }
                        }
                    }
                },
                includePlanAssets: { type: 'boolean' },
                replaceReferences: { type: 'boolean' },
                addToCanvas: {
                    type: 'boolean',
                    description: 'Defaults to true. Set false to only write the generated image file.'
                },
                targetDir: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' },
                model: { type: 'string' },
                size: {
                    type: 'string',
                    description: 'OpenAI-compatible size string, for example 1024x1024, 2880x2880, 3840x2160, or 2160x3840.'
                },
                quality: { type: 'string', default: 'high' },
                responseFormat: { type: 'string', enum: ['url', 'b64_json'], default: 'url' },
                historyDisabled: { type: 'boolean', default: true }
            },
            required: ['prompt']
        }
    },
    {
        name: 'flow_canvas.video.generate',
        description: 'Generate a Seedance-compatible video, save the local file, and add it to the Flow Canvas board. The configured provider must support POST /v1/video/generations and task polling.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: { type: 'string' },
                title: { type: 'string' },
                planId: { type: 'string' },
                rowId: { type: 'string' },
                sourceReferences: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            itemId: { type: 'string' },
                            filePath: { type: 'string' },
                            name: { type: 'string' }
                        }
                    }
                },
                includePlanAssets: { type: 'boolean' },
                replaceReferences: { type: 'boolean' },
                addToCanvas: { type: 'boolean' },
                targetDir: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                model: { type: 'string', description: 'Defaults to doubao-seedance-2-0 when no provider model is configured.' },
                endpoint: { type: 'string' },
                apiKey: { type: 'string' },
                resolution: { type: 'string', enum: ['480p', '720p', '1080p', '720P', '1080P', '4K', '4k'] },
                ratio: { type: 'string', enum: ['21:9', '16:9', '9:16', '4:3', '3:4', '1:1', 'adaptive'] },
                duration: { type: 'integer', minimum: -1, maximum: 60 },
                cameraFixed: { type: 'boolean' },
                generateAudio: { type: 'boolean' },
                webSearch: { type: 'boolean' },
                watermark: { type: 'boolean' }
            },
            required: ['prompt']
        }
    },
    {
        name: 'flow_canvas.item.list',
        description: 'List local files currently placed on the active Flow Canvas board.',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'flow_canvas.item.get',
        description: 'Get one Flow Canvas board item by id.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'string' }
            },
            required: ['itemId']
        }
    },
    {
        name: 'flow_canvas.item.add',
        description: 'Add an existing local file path to the active Flow Canvas board.',
        inputSchema: {
            type: 'object',
            properties: {
                filePath: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' }
            },
            required: ['filePath']
        }
    },
    {
        name: 'flow_canvas.item.update',
        description: 'Update a Flow Canvas board item file path, position, or size.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'string' },
                filePath: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                width: { type: 'number' },
                height: { type: 'number' }
            },
            required: ['itemId']
        }
    },
    {
        name: 'flow_canvas.item.delete',
        description: 'Delete a Flow Canvas board item and remove matching planning-row references.',
        inputSchema: {
            type: 'object',
            properties: {
                itemId: { type: 'string' }
            },
            required: ['itemId']
        }
    }
];

const toolHandlers = {
    'flow_canvas.health': () => api('GET', '/health'),
    'flow_canvas.config.get': () => api('GET', '/config'),
    'flow_canvas.config.update': (body = {}) => api('PATCH', '/config', body),
    'flow_canvas.context.get_active_group': () => api('GET', '/context'),
    'flow_canvas.plan.list': () => api('GET', '/plans'),
    'flow_canvas.plan.get': ({ planId }) => api('GET', `/plans/${encodeURIComponent(required(planId, 'planId'))}`),
    'flow_canvas.plan.create': ({ title, node } = {}) => api('POST', '/plans', { title, node }),
    'flow_canvas.plan.update': ({ planId, ...patch }) => api('PATCH', `/plans/${encodeURIComponent(required(planId, 'planId'))}`, patch),
    'flow_canvas.plan.row.add': ({ planId, ...body }) => api('POST', `/plans/${encodeURIComponent(required(planId, 'planId'))}/rows`, body),
    'flow_canvas.plan.row.update': ({ planId, rowId, ...body }) => api('PATCH', `/plans/${encodeURIComponent(required(planId, 'planId'))}/rows/${encodeURIComponent(required(rowId, 'rowId'))}`, body),
    'flow_canvas.plan.row.delete': ({ planId, rowId }) => api('DELETE', `/plans/${encodeURIComponent(required(planId, 'planId'))}/rows/${encodeURIComponent(required(rowId, 'rowId'))}`),
    'flow_canvas.plan.delete': ({ planId }) => api('DELETE', `/plans/${encodeURIComponent(required(planId, 'planId'))}`),
    'flow_canvas.plan.export': ({ planId }) => api('POST', `/plans/${encodeURIComponent(required(planId, 'planId'))}/export`, {}),
    'flow_canvas.image.generate': (body = {}) => generateImageWithSources(body),
    'flow_canvas.video.generate': (body = {}) => api('POST', '/videos/generate', {
        ...body,
        providerConfig: body.endpoint || body.apiKey || body.model
            ? { endpoint: body.endpoint, apiKey: body.apiKey, model: body.model }
            : undefined
    }),
    'flow_canvas.item.list': () => api('GET', '/items'),
    'flow_canvas.item.get': ({ itemId }) => api('GET', `/items/${encodeURIComponent(required(itemId, 'itemId'))}`),
    'flow_canvas.item.add': (body = {}) => api('POST', '/items/add', body),
    'flow_canvas.item.update': ({ itemId, ...patch }) => api('PATCH', `/items/${encodeURIComponent(required(itemId, 'itemId'))}`, patch),
    'flow_canvas.item.delete': ({ itemId }) => api('DELETE', `/items/${encodeURIComponent(required(itemId, 'itemId'))}`)
};

let inputBuffer = Buffer.alloc(0);
let stdinEnded = false;
const pendingMessages = new Set();

process.stdin.on('data', chunk => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    for (const message of readMessages()) {
        const pending = handleMessage(message).catch(error => {
            if (message?.id !== undefined) {
                send({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: {
                        code: -32603,
                        message: error.message
                    }
                });
            }
        }).finally(() => {
            pendingMessages.delete(pending);
            maybeExitAfterStdinEnd();
        });
        pendingMessages.add(pending);
    }
});

process.stdin.on('end', () => {
    stdinEnded = true;
    maybeExitAfterStdinEnd();
});

function readMessages() {
    const messages = [];
    while (inputBuffer.length > 0) {
        const headerEnd = inputBuffer.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
            const header = inputBuffer.slice(0, headerEnd).toString('utf8');
            const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
            if (!lengthMatch) {
                inputBuffer = Buffer.alloc(0);
                return messages;
            }
            const length = Number(lengthMatch[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (inputBuffer.length < bodyEnd) return messages;
            const raw = inputBuffer.slice(bodyStart, bodyEnd).toString('utf8');
            inputBuffer = inputBuffer.slice(bodyEnd);
            messages.push(JSON.parse(raw));
            continue;
        }

        const newline = inputBuffer.indexOf('\n');
        if (newline < 0) return messages;
        const line = inputBuffer.slice(0, newline).toString('utf8').trim();
        inputBuffer = inputBuffer.slice(newline + 1);
        if (line) messages.push(JSON.parse(line));
    }
    return messages;
}

async function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    const { id, method, params = {} } = message;

    if (id === undefined) return;

    try {
        if (method === 'initialize') {
            sendResult(id, {
                protocolVersion: params.protocolVersion || '2024-11-05',
                capabilities: {
                    tools: {}
                },
                serverInfo: {
                    name: 'flow-canvas-mcp',
                    version: '0.1.0'
                }
            });
            return;
        }

        if (method === 'ping') {
            sendResult(id, {});
            return;
        }

        if (method === 'tools/list') {
            sendResult(id, { tools });
            return;
        }

        if (method === 'tools/call') {
            const name = params.name;
            const handler = toolHandlers[name];
            if (!handler) {
                throw new McpError(-32602, `Unknown tool: ${name}`);
            }
            const result = await handler(params.arguments || {});
            sendResult(id, {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            });
            return;
        }

        throw new McpError(-32601, `Method not found: ${method}`);
    } catch (error) {
        send({
            jsonrpc: '2.0',
            id,
            error: {
                code: error.code || -32603,
                message: error.message
            }
        });
    }
}

async function api(method, pathname, body) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method,
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { raw: text };
    }
    if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `Flow Canvas API failed: ${res.status}`);
    }
    return data;
}

async function generateImageWithSources(body = {}) {
    const prompt = String(body.prompt || '').trim();
    if (!prompt) throw new McpError(-32602, 'Missing required argument: prompt');

    if (body.provider !== 'builtin') {
        try {
            return await api('POST', '/images/generate', body);
        } catch (error) {
            if (process.env.OPENAI_API_KEY) throw error;
        }
    }

    const context = await api('GET', '/context');
    const plansResult = await api('GET', '/plans');
    const plan = body.planId
        ? (plansResult.plans || []).find(entry => entry.id === body.planId)
        : (plansResult.plans || [])[0];
    const row = plan && body.rowId
        ? (plan.rows || []).find(entry => entry.id === body.rowId)
        : null;
    const sourceReferences = collectSourceReferences({ body, plan, row });
    const requestedTargetDir = body.targetDir
        || context.activeGroup?.defaultSaveFolder
        || context.activeGroup?.folders?.[0];
    if (!requestedTargetDir) throw new Error('No save directory available for generated image');
    const targetInfo = await resolveWritableTargetDir(requestedTargetDir);
    const targetDir = targetInfo.targetDir;

    const width = sanitizeImageDimension(body.width, 1024);
    const height = sanitizeImageDimension(body.height, 1024);
    const title = String(body.title || 'Flow Canvas source-aware image').trim();
    const filePath = path.join(targetDir, uniqueImageName('flow_source_builtin', prompt, '.png'));
    const sourceThumbnails = await createSourceThumbnails(sourceReferences);
    const svg = createPromptSvg({ prompt, title, width, height, sourceThumbnails });
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
    await fs.writeFile(filePath, buffer);

    const shouldAddToCanvas = body.addToCanvas !== false;
    const itemResult = shouldAddToCanvas
        ? await api('POST', '/items/add', {
            filePath,
            x: body.x,
            y: body.y,
            width,
            height
        })
        : null;
    const generatedReference = itemResult?.item
        ? {
            itemId: itemResult.item.id,
            filePath: itemResult.item.filePath,
            name: path.basename(itemResult.item.filePath),
            kind: 'output'
        }
        : null;
    let updatedPlan = null;
    if (plan && row && generatedReference) {
        const references = body.replaceReferences === true
            ? [generatedReference]
            : dedupeReferences([
                ...(row.references || []),
                generatedReference
            ]);
        const updated = await api('PATCH', `/plans/${encodeURIComponent(plan.id)}/rows/${encodeURIComponent(row.id)}`, { references });
        updatedPlan = updated.plan;
    }

    return {
        success: true,
        item: itemResult?.item || null,
        filePath,
        provider: 'builtin-source-aware',
        image: { width, height },
        targetDir,
        requestedTargetDir,
        targetDirFallback: targetInfo.fallbackReason || null,
        sourceReferences,
        plan: updatedPlan
    };
}

async function resolveWritableTargetDir(requestedTargetDir) {
    const workspaceOutputDir = path.join(process.cwd(), 'output');
    try {
        await fs.mkdir(requestedTargetDir, { recursive: true });
        await assertWritableDir(requestedTargetDir);
        return { targetDir: requestedTargetDir, fallbackReason: null };
    } catch (error) {
        await fs.mkdir(workspaceOutputDir, { recursive: true });
        await assertWritableDir(workspaceOutputDir);
        return {
            targetDir: workspaceOutputDir,
            fallbackReason: `Requested directory was not writable: ${error.message}`
        };
    }
}

async function assertWritableDir(dirPath) {
    const probePath = path.join(dirPath, `.flow-canvas-write-test-${process.pid}-${Date.now()}.tmp`);
    await fs.writeFile(probePath, '');
    await fs.unlink(probePath).catch(() => {});
}

function collectSourceReferences({ body, plan, row }) {
    const references = [];
    const push = reference => {
        const normalized = normalizeSourceReference(reference);
        if (!normalized) return;
        if (!isSupportedSourceImage(normalized.filePath)) return;
        if (!fsSync.existsSync(normalized.filePath)) return;
        if (references.some(existing => normalizeFsPath(existing.filePath) === normalizeFsPath(normalized.filePath))) return;
        references.push(normalized);
    };

    (Array.isArray(body.sourceReferences) ? body.sourceReferences : []).forEach(push);
    (row?.references || []).forEach(push);

    const shouldIncludePlanAssets = body.includePlanAssets === true || ((row?.references || []).length === 0 && body.includePlanAssets !== false);
    if (plan && shouldIncludePlanAssets) {
        (plan.rows || []).forEach(entry => {
            if (!row || entry.id !== row.id) (entry.references || []).forEach(push);
        });
    }
    return references;
}

function normalizeSourceReference(reference) {
    if (!reference) return null;
    if (typeof reference === 'string') {
        return { itemId: '', filePath: reference, name: path.basename(reference), kind: 'source' };
    }
    const filePath = String(reference.filePath || '').trim();
    if (!filePath) return null;
    return {
        itemId: reference.itemId ? String(reference.itemId) : '',
        filePath,
        name: String(reference.name || path.basename(filePath)).trim(),
        kind: reference.kind ? String(reference.kind) : (reference.role ? String(reference.role) : 'source')
    };
}

function toRowReference(reference) {
    return {
        itemId: reference.itemId || '',
        filePath: reference.filePath,
        name: reference.name || path.basename(reference.filePath),
        kind: reference.kind || 'source'
    };
}

function dedupeReferences(references) {
    const seen = new Set();
    return references.filter(reference => {
        const key = normalizeFsPath(reference.filePath);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function isSupportedSourceImage(filePath) {
    return ['.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(String(filePath || '')).toLowerCase());
}

function normalizeFsPath(filePath) {
    return String(filePath || '').replace(/\//g, '\\').toLowerCase();
}

async function createSourceThumbnails(sourceReferences = []) {
    const thumbnails = [];
    for (const reference of sourceReferences.slice(0, 3)) {
        try {
            const buffer = await sharp(reference.filePath)
                .rotate()
                .resize(180, 150, { fit: 'cover' })
                .png()
                .toBuffer();
            thumbnails.push({
                ...reference,
                dataUri: `data:image/png;base64,${buffer.toString('base64')}`
            });
        } catch (error) {
            thumbnails.push({ ...reference, error: error.message });
        }
    }
    return thumbnails;
}

function createPromptSvg({ prompt, title, width, height, sourceThumbnails = [] }) {
    const hasSources = sourceThumbnails.length > 0;
    const lines = wrapText(prompt, 30).slice(0, hasSources ? 8 : 12);
    const promptText = lines.map((line, index) =>
        `<text x="72" y="${210 + index * 42}" class="prompt">${escapeXml(line)}</text>`
    ).join('');
    const sourceY = Math.max(560, height - 250);
    const sourceCards = sourceThumbnails.map((reference, index) => {
        const x = 72 + index * 230;
        const labelLines = wrapText(reference.name || path.basename(reference.filePath), 18).slice(0, 2);
        const labelText = labelLines.map((line, lineIndex) =>
            `<text x="${x}" y="${sourceY + 178 + lineIndex * 22}" class="sourceName">${escapeXml(line)}</text>`
        ).join('');
        const imageMarkup = reference.dataUri
            ? `<image href="${reference.dataUri}" x="${x}" y="${sourceY}" width="180" height="150" preserveAspectRatio="xMidYMid slice"/>`
            : `<rect x="${x}" y="${sourceY}" width="180" height="150" rx="18" fill="#d8e1e5"/><text x="${x + 18}" y="${sourceY + 78}" class="sourceName">missing</text>`;
        return `
          <g>
            <rect x="${x - 10}" y="${sourceY - 10}" width="200" height="232" rx="22" fill="rgba(255,255,255,0.55)" stroke="rgba(56,80,90,0.18)"/>
            ${imageMarkup}
            ${labelText}
          </g>`;
    }).join('');
    const sourceBlock = hasSources
        ? `<text x="72" y="${sourceY - 28}" class="meta">Source assets read from the connected planning row</text>${sourceCards}`
        : '<text x="72" y="152" class="meta">Generated locally without connected source assets</text>';

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f3ea"/>
      <stop offset="0.48" stop-color="#dbe8f0"/>
      <stop offset="1" stop-color="#d9ede3"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="20" flood-color="#24404d" flood-opacity="0.18"/>
    </filter>
    <style>
      .label { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 28px; fill: #38505a; font-weight: 700; }
      .prompt { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 31px; fill: #10242d; font-weight: 650; }
      .meta { font-family: "Segoe UI", Arial, sans-serif; font-size: 18px; fill: #5d6f77; letter-spacing: 0; }
      .sourceName { font-family: "Microsoft YaHei", "Segoe UI", Arial, sans-serif; font-size: 18px; fill: #314852; font-weight: 600; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="44" y="44" width="${width - 88}" height="${height - 88}" rx="30" fill="rgba(255,255,255,0.62)" filter="url(#shadow)"/>
  <circle cx="${width - 170}" cy="148" r="62" fill="#f5b971" opacity="0.72"/>
  <rect x="${width - 300}" y="${height - 220}" width="210" height="120" rx="26" fill="#6db5a6" opacity="0.52"/>
  <path d="M84 ${height - 170} C 180 ${height - 280}, 320 ${height - 90}, 470 ${height - 190} S 710 ${height - 230}, ${width - 84} ${height - 130}" fill="none" stroke="#507f9a" stroke-width="8" opacity="0.28"/>
  <text x="72" y="110" class="label">${escapeXml(title)}</text>
  ${sourceBlock}
  ${promptText}
</svg>`;
}

function wrapText(text, maxChars) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];
    const tokens = normalized.match(/[\u4e00-\u9fff]|[^\s\u4e00-\u9fff]+/g) || [normalized];
    const lines = [];
    let line = '';
    tokens.forEach(token => {
        const candidate = line ? `${line}${/^[\u4e00-\u9fff]$/.test(token) ? '' : ' '}${token}` : token;
        if (candidate.length > maxChars && line) {
            lines.push(line);
            line = token;
        } else {
            line = candidate;
        }
    });
    if (line) lines.push(line);
    return lines;
}

function uniqueImageName(prefix, prompt, ext) {
    const hash = crypto.createHash('sha1').update(`${Date.now()}:${prompt}:${Math.random()}`).digest('hex').slice(0, 12);
    return `${prefix}_${hash}${ext}`;
}

function sanitizeImageDimension(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(256, Math.min(2048, Math.round(number)));
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function required(value, name) {
    if (value == null || value === '') {
        throw new McpError(-32602, `Missing required argument: ${name}`);
    }
    return String(value);
}

function sendResult(id, result) {
    send({ jsonrpc: '2.0', id, result });
}

function send(payload) {
    const json = JSON.stringify(payload);
    const body = Buffer.from(json, 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
}

function maybeExitAfterStdinEnd() {
    if (!stdinEnded || pendingMessages.size > 0) return;
    process.exitCode = 0;
}

class McpError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
