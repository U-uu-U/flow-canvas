'use strict';

const { createHash } = require('node:crypto');

function endpointFor(provider, anthropic) {
    const fallback = anthropic
        ? 'https://api.anthropic.com/v1/messages'
        : 'https://api.openai.com/v1/chat/completions';
    const url = new URL(String(provider.endpoint || '').trim() || fallback);
    const versionedPrefix = url.pathname.match(/^(.*?\/v\d+(?:beta|alpha)?)(?:\/.*)?$/i)?.[1] || '';
    const suffix = anthropic ? '/messages' : '/chat/completions';
    const complete = anthropic ? /\/messages\/?$/i : /\/chat\/completions\/?$/i;
    if (!complete.test(url.pathname)) {
        url.pathname = `${versionedPrefix || `${url.pathname.replace(/\/+$/, '')}/v1`}${suffix}`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
}

function objectArguments(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch {
            throw new Error('Malformed tool arguments: expected a JSON object');
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Malformed tool arguments: expected a JSON object');
    }
    return parsed;
}

function toolNames(tools, messages) {
    const forward = new Map();
    const reverse = new Map();
    const register = name => {
        if (typeof name !== 'string' || !name) throw new Error('Tool name is required');
        if (forward.has(name)) return;
        // Map every name, including already-valid names, to avoid escape-prefix collisions.
        const vendor = `t_${createHash('sha256').update(name).digest('hex').slice(0, 60)}`;
        if (reverse.has(vendor)) throw new Error('Tool name mapping collision');
        forward.set(name, vendor);
        reverse.set(vendor, name);
    };
    for (const tool of tools) {
        if (tool?.type !== 'function' || !tool.function) throw new Error('Expected OpenAI function tools');
        register(tool.function.name);
    }
    for (const message of messages) {
        for (const call of message.tool_calls || []) register(call.function?.name);
    }
    return { forward, reverse };
}

function validateHistory(messages) {
    const pending = new Set();
    const seen = new Set();
    for (const message of messages) {
        if (!['system', 'user', 'assistant', 'tool'].includes(message?.role)) {
            throw new Error('Invalid message role');
        }
        if (message.role === 'tool') {
            if (!pending.delete(message.tool_call_id)) throw new Error('Unpaired tool result');
        } else if (pending.size) {
            throw new Error('Tool calls must be followed by their results');
        }
        if (message.tool_calls?.length) {
            if (message.role !== 'assistant') throw new Error('Only assistant messages may call tools');
            for (const call of message.tool_calls) {
                if (!call.id || seen.has(call.id) || call.type !== 'function') {
                    throw new Error('Invalid or duplicate tool call ID/type');
                }
                objectArguments(call.function?.arguments);
                seen.add(call.id);
                pending.add(call.id);
            }
        }
    }
    if (pending.size) throw new Error('Missing tool results');
}

function anthropicContent(content) {
    if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
    if (content == null) return [];
    if (!Array.isArray(content)) throw new Error('Invalid message content');
    return content.map(part => {
        if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
        if (part.type === 'image_url') {
            const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (typeof url !== 'string' || !url) throw new Error('Invalid image URL');
            const data = url.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
            if (url.startsWith('data:') && !data) throw new Error('Invalid base64 image URL');
            return {
                type: 'image',
                source: data
                    ? { type: 'base64', media_type: data[1], data: data[2] }
                    : { type: 'url', url }
            };
        }
        throw new Error('Unsupported Anthropic content part');
    });
}

function requestBody(provider, messages, tools, names, anthropic, maxTokens) {
    const body = { model: provider.model, max_tokens: maxTokens, stream: provider.stream !== false };
    if (!anthropic) {
        if (body.stream) body.stream_options = { include_usage: true };
        body.messages = messages.map(message => ({
            ...message,
            ...(message.tool_calls ? {
                tool_calls: message.tool_calls.map(call => ({
                    ...call,
                    function: { ...call.function, name: names.forward.get(call.function.name) }
                }))
            } : {})
        }));
        if (tools.length) body.tools = tools.map(tool => ({
            ...tool, function: { ...tool.function, name: names.forward.get(tool.function.name) }
        }));
        return body;
    }
    const system = messages.filter(message => message.role === 'system')
        .flatMap(message => anthropicContent(message.content));
    if (system.some(part => part.type !== 'text')) throw new Error('Anthropic system messages must contain only text');
    if (system.length) body.system = system;
    body.messages = [];
    for (const message of messages) {
        if (message.role === 'system') continue;
        const role = message.role === 'assistant' ? 'assistant' : 'user';
        const content = message.role === 'tool'
            ? [{ type: 'tool_result', tool_use_id: message.tool_call_id,
                content: typeof message.content === 'string' ? message.content : anthropicContent(message.content) }]
            : anthropicContent(message.content);
        for (const call of message.tool_calls || []) {
            content.push({ type: 'tool_use', id: call.id, name: names.forward.get(call.function.name),
                input: objectArguments(call.function.arguments) });
        }
        // Parallel tool results must share the user turn immediately after tool_use.
        const previous = body.messages[body.messages.length - 1];
        if (previous?.role === role) previous.content.push(...content);
        else body.messages.push({ role, content });
    }
    if (tools.length) body.tools = tools.map(tool => ({
        name: names.forward.get(tool.function.name),
        ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
    }));
    return body;
}

function abortError(signal) {
    if (signal.reason instanceof Error) return signal.reason;
    const error = new Error('Agent provider request aborted');
    error.name = 'AbortError';
    return error;
}

function interruptible(operation, signal) {
    if (signal.aborted) return Promise.reject(abortError(signal));
    return new Promise((resolve, reject) => {
        const onAbort = () => { cleanup(); reject(abortError(signal)); };
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve().then(() => {
            if (signal.aborted) throw abortError(signal);
            return operation();
        }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
}

async function readBody(response, signal, onChunk) {
    if (!response.body?.getReader) {
        onChunk(await interruptible(() => response.text(), signal));
        return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let ended = false;
    try {
        while (true) {
            const { value, done } = await interruptible(() => reader.read(), signal);
            if (done) {
                ended = true;
                onChunk(decoder.decode());
                break;
            }
            if (onChunk(decoder.decode(value, { stream: true })) === false) break;
        }
    } finally {
        if (!ended) {
            try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Already closed. */ }
        }
        try { reader.releaseLock(); } catch { /* A cancelled read may still be settling. */ }
    }
}

function sseParser(onEvent) {
    let buffer = '';
    let event = '';
    let data = [];
    let stopped = false;
    const dispatch = () => {
        if (data.length) stopped = onEvent(event, data.join('\n')) === false;
        event = '';
        data = [];
    };
    const line = value => {
        if (!value) return dispatch();
        if (value.startsWith(':')) return;
        const colon = value.indexOf(':');
        const field = colon < 0 ? value : value.slice(0, colon);
        const raw = colon < 0 ? '' : value.slice(colon + 1);
        const text = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') event = text;
        if (field === 'data') data.push(text);
    };
    return (chunk, final = false) => {
        buffer += chunk;
        while (!stopped) {
            const index = buffer.search(/[\r\n]/);
            if (index < 0 || (!final && buffer[index] === '\r' && index === buffer.length - 1)) break;
            const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
            const value = buffer.slice(0, index);
            buffer = buffer.slice(index + width);
            line(value);
        }
        if (final && !stopped) {
            if (buffer) line(buffer);
            buffer = '';
            dispatch();
        }
        return !stopped;
    };
}

function textContent(content) {
    if (typeof content === 'string') return content;
    if (content == null) return '';
    if (Array.isArray(content)) return content.filter(part => part.type === 'text').map(part => part.text || '').join('');
    throw new Error('Invalid provider text content');
}

function parseJson(text) {
    try { return JSON.parse(text); } catch { throw new Error('Malformed provider JSON response'); }
}

function providerError(payload) {
    const detail = typeof payload?.error === 'string' ? payload.error : payload?.error?.message;
    return new Error(`Provider error: ${typeof detail === 'string' ? detail : 'request failed'}`);
}

function accumulator(anthropic, names, onDelta, signal) {
    let text = '';
    let usage = {};
    let complete = false;
    const calls = new Map();
    const addText = delta => {
        if (signal.aborted) throw abortError(signal);
        if (!delta) return;
        text += delta;
        if (onDelta) onDelta(delta);
    };
    const addUsage = value => {
        if (value && typeof value === 'object') usage = { ...usage, ...value };
    };
    const json = payload => {
        if (payload?.error) throw providerError(payload);
        if (anthropic) {
            if (!Array.isArray(payload?.content)) throw new Error('Missing Anthropic response content');
            for (const [index, block] of payload.content.entries()) {
                if (block.type === 'text') addText(block.text);
                if (block.type === 'tool_use') calls.set(index, {
                    id: block.id, name: block.name, input: block.input
                });
            }
        } else {
            const message = payload?.choices?.find(choice => choice.index === 0 || choice.index == null)?.message;
            if (!message) throw new Error('Missing OpenAI response message');
            addText(textContent(message.content));
            for (const [index, call] of (message.tool_calls || []).entries()) {
                if (call.type !== 'function') throw new Error('Unsupported tool call type');
                calls.set(index, { id: call.id, name: call.function?.name, input: call.function?.arguments });
            }
        }
        addUsage(payload.usage);
        complete = true;
    };
    const event = (eventName, data) => {
        if (data.trim() === '[DONE]') {
            if (anthropic) throw new Error('Unexpected Anthropic stream terminator');
            complete = true;
            return false;
        }
        const payload = parseJson(data);
        if (eventName === 'error' || payload?.error || payload?.type === 'error') throw providerError(payload);
        if (!anthropic) {
            addUsage(payload.usage);
            const choice = payload.choices?.find(item => item.index === 0 || item.index == null);
            if (!choice) return;
            if (choice.finish_reason != null) complete = true;
            const delta = choice.delta || {};
            addText(textContent(delta.content));
            for (const part of delta.tool_calls || []) {
                if (!Number.isInteger(part.index) || part.index < 0) throw new Error('Missing tool call index');
                if (part.type && part.type !== 'function') throw new Error('Unsupported tool call type');
                const call = calls.get(part.index) || { id: '', name: '', input: '' };
                if (part.id != null) call.id += part.id;
                if (part.function?.name != null) call.name += part.function.name;
                if (part.function?.arguments != null) {
                    if (typeof part.function.arguments !== 'string') throw new Error('Malformed tool argument delta');
                    call.input += part.function.arguments;
                }
                calls.set(part.index, call);
            }
            return;
        }
        const type = payload.type || eventName;
        if (type === 'message_start') addUsage(payload.message?.usage);
        if (type === 'message_delta') addUsage(payload.usage);
        if (type === 'content_block_start') {
            const block = payload.content_block;
            if (block?.type === 'text') addText(block.text);
            if (block?.type === 'tool_use') {
                if (!Number.isInteger(payload.index) || payload.index < 0 || calls.has(payload.index)) {
                    throw new Error('Invalid tool block index');
                }
                calls.set(payload.index, { id: block.id, name: block.name, input: block.input, partial: null });
            }
        }
        if (type === 'content_block_delta') {
            if (payload.delta?.type === 'text_delta') addText(payload.delta.text);
            if (payload.delta?.type === 'input_json_delta') {
                const call = calls.get(payload.index);
                if (!call || typeof payload.delta.partial_json !== 'string') throw new Error('Invalid tool argument delta');
                call.partial = (call.partial ?? '') + payload.delta.partial_json;
            }
        }
        if (type === 'message_stop') {
            complete = true;
            return false;
        }
    };
    const result = () => {
        if (!complete) throw new Error('Incomplete provider stream');
        const ids = new Set();
        const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
            if (typeof call.id !== 'string' || !call.id || ids.has(call.id)) throw new Error('Invalid or duplicate response tool call ID');
            const name = names.reverse.get(call.name);
            if (!name) throw new Error('Provider returned an unknown tool name');
            ids.add(call.id);
            return { id: call.id, name, arguments: objectArguments(call.partial ?? call.input) };
        });
        return { text, toolCalls, usage };
    };
    return { json, event, result };
}

function unsupportedTools(status, text) {
    if (![400, 404, 405, 422, 501].includes(status)) return false;
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    const error = payload?.error || payload;
    const message = typeof error === 'string' ? error : error?.message || text;
    const tool = '(?:tools?|tool[_ -]?(?:choice|use|calls?|calling)|function[_ -]?(?:calls?|calling))';
    const explicit = new RegExp([
        `\\b${tool}\\b["']?(?:\\s+(?:is|are))?\\s+(?:not supported|unsupported|not available|unavailable|not allowed)\\b`,
        `\\b(?:does not support|do not support|doesn't support)\\s+(?:the\\s+)?["']?${tool}\\b`,
        `\\bunsupported\\s+(?:(?:request\\s+)?(?:parameter|argument|feature)\\s*[:=]?\\s*)?["']?${tool}\\b`,
        `\\b(?:unknown|unrecognized)\\s+(?:request\\s+)?(?:parameter|argument)(?:\\s+supplied)?\\s*[:=]?\\s*["']?${tool}\\b`
    ].join('|'), 'i');
    return explicit.test(message)
        || (/^(?:tools|tool_choice|functions|function_call)$/.test(String(error?.param || '')) && /^(?:unsupported_parameter|unknown_parameter)$/.test(error?.code || ''))
        || /^(?:tools_not_supported|unsupported_tools|tool_use_not_supported|function_calling_not_supported)$/.test(error?.code || '');
}

/**
 * onDelta receives text strings (also once for a JSON response). usage retains vendor
 * fields; Anthropic usage events are merged. timeoutMs defaults to 120 seconds and
 * covers both attempts and all body reads. Inject Electron net.fetch via fetchImpl.
 */
async function callAgentProvider({ provider, messages, tools = [], signal, onDelta, maxTokens = 4096, fetchImpl } = {}) {
    const key = String(provider?.apiKey || '').trim();
    const controller = new AbortController();
    let timer;
    let activeResponse;
    const cancel = () => controller.abort(signal.reason);
    try {
        if (!provider?.model || !key) throw new Error('Provider model and API key are required');
        const type = String(provider.type || 'openai').toLowerCase();
        if (type === 'google' || type === 'gemini') throw new Error('Google native protocol is not supported');
        if (!Array.isArray(messages) || !messages.length || !Array.isArray(tools)) throw new Error('Messages and tools must be arrays; messages cannot be empty');
        if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error('maxTokens must be a positive integer');
        const timeoutMs = provider.timeoutMs === undefined ? 120000 : provider.timeoutMs;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error('Invalid provider timeoutMs');
        if (onDelta !== undefined && typeof onDelta !== 'function') throw new Error('onDelta must be a function');
        if (signal?.aborted) controller.abort(signal.reason);
        else signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => {
            const error = new Error('Agent provider request timed out');
            error.name = 'TimeoutError';
            controller.abort(error);
        }, timeoutMs);
        validateHistory(messages);
        const names = toolNames(tools, messages);
        const anthropic = type === 'anthropic';
        const endpoint = endpointFor(provider, anthropic);
        const body = requestBody(provider, messages, tools, names, anthropic, maxTokens);
        const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' };
        if (anthropic) {
            headers['x-api-key'] = key;
            headers['anthropic-version'] = '2023-06-01';
        } else headers.Authorization = `Bearer ${key}`;
        const fetcher = fetchImpl || globalThis.fetch;
        if (typeof fetcher !== 'function') throw new Error('No fetch implementation available');
        let unavailable = false;
        for (let attempt = 0; attempt < 2; attempt++) {
            const response = await interruptible(async () => {
                const received = await fetcher(endpoint, {
                    method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'follow'
                });
                activeResponse = received;
                // A transport that ignores abort can deliver headers after the race has ended.
                if (controller.signal.aborted) {
                    try { Promise.resolve(received.body?.cancel()).catch(() => {}); } catch { /* Already closed. */ }
                    throw abortError(controller.signal);
                }
                return received;
            }, controller.signal);
            if (!response.ok) {
                let errorText = '';
                await readBody(response, controller.signal, chunk => { errorText += chunk; });
                if (attempt === 0 && tools.length && unsupportedTools(response.status, errorText)) {
                    delete body.tools;
                    unavailable = true;
                    continue;
                }
                const error = new Error(`HTTP ${response.status}: ${errorText}`);
                error.status = response.status;
                throw error;
            }
            const state = accumulator(anthropic, names, onDelta, controller.signal);
            if (/text\/event-stream/i.test(response.headers?.get('content-type') || '')) {
                const parse = sseParser(state.event);
                await readBody(response, controller.signal, chunk => parse(chunk));
                parse('', true);
            } else {
                let responseText = '';
                await readBody(response, controller.signal, chunk => { responseText += chunk; });
                state.json(parseJson(responseText));
            }
            if (controller.signal.aborted) throw abortError(controller.signal);
            const result = state.result();
            if (unavailable && result.toolCalls.length) throw new Error('Provider returned tool calls after tools were disabled');
            return { ...result, toolSupport: unavailable ? 'unavailable' : tools.length || result.toolCalls.length ? 'supported' : 'unknown' };
        }
        throw new Error('Provider retry exhausted');
    } catch (error) {
        // Providers and custom transports may echo credentials in error messages.
        let message = String(error?.message || 'Agent provider request failed');
        for (const secret of new Set([key, encodeURIComponent(key)])) {
            if (secret) message = message.split(secret).join('[REDACTED]');
        }
        const safe = new Error(message.slice(0, 1200));
        safe.name = error?.name || 'Error';
        if (typeof error?.status === 'number') safe.status = error.status;
        throw safe;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        if (activeResponse?.body && !activeResponse.body.locked) {
            try { Promise.resolve(activeResponse.body.cancel()).catch(() => {}); } catch { /* Already closed. */ }
        }
    }
}

module.exports = { callAgentProvider };
