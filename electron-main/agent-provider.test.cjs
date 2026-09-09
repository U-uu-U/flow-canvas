'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { callAgentProvider } = require('./agent-provider.cjs');

const provider = { type: 'openai', endpoint: 'https://relay.example/proxy/v1/images/generations?key=discard#fragment',
    apiKey: 'test-secret-do-not-log', model: 'test-model' };
const messages = [{ role: 'user', content: 'Hello' }];
const tools = [
    { type: 'function', function: { name: 'board.add_node', description: 'Add a node',
        parameters: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] } } },
    { type: 'function', function: { name: 'board_add_node', parameters: { type: 'object', properties: {} } } }
];

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function openaiJson(content = 'Answer', calls = [], usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) {
    return { choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls } }], usage };
}

function functionCall(id, name, args = '{}') {
    return { id, type: 'function', function: { name, arguments: args } };
}

function recordFetch(responder) {
    const requests = [];
    const fetchImpl = async (url, init) => {
        const request = { url, ...init, body: JSON.parse(init.body) };
        requests.push(request);
        return responder(request, requests.length);
    };
    return { requests, fetchImpl };
}

function sse(payload, event, newline = '\r\n') {
    return `${event ? `event: ${event}${newline}` : ''}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}${newline}${newline}`;
}

function streamResponse(text, { width = 1, status = 200, contentType = 'text/event-stream', hold = false, onCancel = () => {} } = {}) {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (offset < bytes.length) {
                controller.enqueue(bytes.slice(offset, offset + width));
                offset += width;
            } else if (!hold) controller.close();
        },
        cancel: onCancel
    }), { status, headers: { 'content-type': contentType } });
}

async function call(overrides = {}) {
    return callAgentProvider({ provider, messages, ...overrides });
}

test('OpenAI JSON preserves multimodal history, pairing, schemas, usage, and reversible names', async () => {
    const history = [
        { role: 'system', content: 'System instructions' },
        { role: 'user', content: [{ type: 'text', text: 'Inspect' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj', detail: 'high' } }] },
        { role: 'assistant', content: '', tool_calls: [functionCall('old-1', tools[0].function.name), functionCall('old-2', tools[1].function.name)] },
        { role: 'tool', tool_call_id: 'old-2', content: '{"ok":true}' },
        { role: 'tool', tool_call_id: 'old-1', content: [{ type: 'text', text: 'Created' },
            { type: 'image_url', image_url: { url: 'https://images.example/result.png' } }] }
    ];
    const original = structuredClone({ history, tools, provider });
    const deltas = [];
    const mock = recordFetch(request => jsonResponse(openaiJson('Ready', [
        functionCall('new-1', request.body.tools[0].function.name, '{"label":"A"}')
    ])));
    const result = await call({ messages: history, tools, onDelta: delta => deltas.push(delta), fetchImpl: mock.fetchImpl });
    const request = mock.requests[0];
    assert.equal(request.url, 'https://relay.example/proxy/v1/chat/completions');
    assert.equal(request.headers.Authorization, `Bearer ${provider.apiKey}`);
    assert.equal(request.body.model, provider.model);
    assert.equal(request.body.max_tokens, 4096);
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
    const names = request.body.tools.map(tool => tool.function.name);
    assert.notEqual(names[0], names[1]);
    names.forEach(name => assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/));
    assert.equal(request.body.messages[2].tool_calls[0].function.name, names[0]);
    assert.equal(request.body.messages[2].tool_calls[1].function.name, names[1]);
    assert.deepEqual(request.body.messages[1], history[1]);
    assert.deepEqual(request.body.messages.slice(3), history.slice(3));
    assert.deepEqual(request.body.tools[0].function.parameters, tools[0].function.parameters);
    assert.deepEqual(result, { text: 'Ready', toolCalls: [{ id: 'new-1', name: 'board.add_node', arguments: { label: 'A' } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }, toolSupport: 'supported' });
    assert.deepEqual(deltas, ['Ready']);
    assert.deepEqual({ history, tools, provider }, original);
});

test('endpoint normalization matches the existing generation path for both protocols', async t => {
    const cases = [
        ['openai', '', 'https://api.openai.com/v1/chat/completions'],
        ['anthropic', '', 'https://api.anthropic.com/v1/messages'],
        ['custom', 'https://relay.example', 'https://relay.example/v1/chat/completions'],
        ['openai', 'https://relay.example/custom/', 'https://relay.example/custom/v1/chat/completions'],
        ['anthropic', 'https://relay.example/proxy/v2beta/models?x=1#x', 'https://relay.example/proxy/v2beta/messages'],
        ['openai', 'https://relay.example/custom/chat/completions/?x=1', 'https://relay.example/custom/chat/completions/'],
        ['anthropic', 'https://relay.example/custom/messages/#x', 'https://relay.example/custom/messages/']
    ];
    for (const [type, endpoint, expected] of cases) await t.test(`${type}: ${endpoint}`, async () => {
        const mock = recordFetch(() => jsonResponse(type === 'anthropic' ? { content: [], usage: {} } : openaiJson()));
        await call({ provider: { ...provider, type, endpoint }, fetchImpl: mock.fetchImpl });
        assert.equal(mock.requests[0].url, expected);
    });
});

test('Anthropic JSON maps system, images, tool uses and grouped parallel results without losing IDs', async () => {
    const history = [
        { role: 'system', content: 'First' },
        { role: 'system', content: [{ type: 'text', text: 'Second' }] },
        { role: 'user', content: [{ type: 'text', text: 'Inspect' },
            { type: 'image_url', image_url: { url: 'data:image/webp;base64,YWJj' } },
            { type: 'image_url', image_url: { url: 'https://images.example/input.png' } }] },
        { role: 'assistant', content: 'Working', tool_calls: [
            functionCall('one', 'board.add_node', '{"label":"first"}'), functionCall('two', 'board_add_node')
        ] },
        { role: 'tool', tool_call_id: 'two', content: 'Second result' },
        { role: 'tool', tool_call_id: 'one', content: [{ type: 'text', text: 'First result' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YWJj' } }] },
        { role: 'user', content: 'Continue' }
    ];
    const mock = recordFetch(request => jsonResponse({ content: [
        { type: 'text', text: 'Next' },
        { type: 'tool_use', id: 'next', name: request.body.tools[0].name, input: { label: 'next' } }
    ], usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 5 } }));
    const result = await call({ provider: { ...provider, type: 'anthropic', stream: false }, messages: history, tools,
        maxTokens: 512, fetchImpl: mock.fetchImpl });
    const { body, headers } = mock.requests[0];
    assert.equal(headers['x-api-key'], provider.apiKey);
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers.Authorization, undefined);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.stream_options, undefined);
    assert.deepEqual(body.system, [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }]);
    assert.equal(body.messages.length, 3);
    assert.deepEqual(body.messages[0].content.slice(1), [
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'YWJj' } },
        { type: 'image', source: { type: 'url', url: 'https://images.example/input.png' } }
    ]);
    assert.deepEqual(body.messages[1].content[1], { type: 'tool_use', id: 'one', name: body.tools[0].name, input: { label: 'first' } });
    assert.deepEqual(body.messages[2].content, [
        { type: 'tool_result', tool_use_id: 'two', content: 'Second result' },
        { type: 'tool_result', tool_use_id: 'one', content: [{ type: 'text', text: 'First result' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } }] },
        { type: 'text', text: 'Continue' }
    ]);
    assert.deepEqual(body.tools[0].input_schema, tools[0].function.parameters);
    assert.deepEqual(result.toolCalls, [{ id: 'next', name: 'board.add_node', arguments: { label: 'next' } }]);
    assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 5 });
});

test('OpenAI SSE handles fragmented UTF-8, CRLF, interleaved calls, name/ID/argument deltas and final usage', async () => {
    const deltas = [];
    const mock = recordFetch(request => {
        const [first, second] = request.body.tools.map(tool => tool.function.name);
        const chunk = delta => sse({ choices: [{ index: 0, delta }] });
        return streamResponse(': keepalive\r\n\r\n' + chunk({ content: '\u4f60' })
            + chunk({ tool_calls: [{ index: 1, id: 'call-', type: 'function', function: { name: second, arguments: '{' } },
                { index: 0, id: 'first', type: 'function', function: { name: first.slice(0, 15), arguments: '{"label":' } }] })
            + chunk({ content: '\u597d' })
            + chunk({ tool_calls: [{ index: 0, function: { name: first.slice(15), arguments: '"\\u4f60\\u597d"}' } },
                { index: 1, id: 'second', function: { arguments: '}' } }] })
            + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            + sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 } })
            + sse('[DONE]'));
    });
    const result = await call({ tools, onDelta: delta => deltas.push(delta), fetchImpl: mock.fetchImpl });
    assert.equal(result.text, '\u4f60\u597d');
    assert.deepEqual(deltas, ['\u4f60', '\u597d']);
    assert.deepEqual(result.toolCalls, [
        { id: 'first', name: 'board.add_node', arguments: { label: '\u4f60\u597d' } },
        { id: 'call-second', name: 'board_add_node', arguments: {} }
    ]);
    assert.deepEqual(result.usage, { prompt_tokens: 8, completion_tokens: 7, total_tokens: 15 });
});

test('Anthropic SSE accumulates partial tool JSON and merges start/delta cache usage', async () => {
    const deltas = [];
    const mock = recordFetch(request => streamResponse([
        { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 2 } } },
        { type: 'ping' },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Start ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\u597d' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'use-1', name: request.body.tools[0].name, input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"label":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"value"}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'use-2', name: request.body.tools[1].name, input: {} } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 11 } },
        { type: 'message_stop' }
    ].map(event => sse(event, event.type)).join('')));
    const result = await call({ provider: { ...provider, type: 'anthropic' }, tools,
        onDelta: delta => deltas.push(delta), fetchImpl: mock.fetchImpl });
    assert.equal(result.text, 'Start \u597d');
    assert.deepEqual(deltas, ['Start ', '\u597d']);
    assert.deepEqual(result.toolCalls, [
        { id: 'use-1', name: 'board.add_node', arguments: { label: 'value' } },
        { id: 'use-2', name: 'board_add_node', arguments: {} }
    ]);
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 11, cache_creation_input_tokens: 2 });
});

test('SSE supports multiline data, lone CR, ignored comments and EOF after finish_reason', async () => {
    const stream = ': comment\r\revent: message\rdata: {"choices":\rdata: [{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}';
    const result = await call({ fetchImpl: async () => streamResponse(stream) });
    assert.equal(result.text, 'ok');
    assert.equal(result.toolSupport, 'unknown');
});

test('a terminal SSE marker releases a body which does not close', async () => {
    let cancelled = false;
    const result = await call({ fetchImpl: async () => streamResponse(sse({ choices: [{ delta: { content: 'ok' } }] }) + sse('[DONE]'),
        { hold: true, onCancel: () => { cancelled = true; } }) });
    assert.equal(result.text, 'ok');
    assert.equal(cancelled, true);
});

test('fragmented non-stream JSON body is decoded and emits one text delta', async () => {
    const deltas = [];
    const result = await call({ provider: { ...provider, stream: false }, onDelta: text => deltas.push(text),
        fetchImpl: async () => streamResponse(JSON.stringify(openaiJson('\u4f60\u597d')), { contentType: 'application/json' }) });
    assert.equal(result.text, '\u4f60\u597d');
    assert.deepEqual(deltas, ['\u4f60\u597d']);
});

test('explicit unsupported-tool HTTP errors retry exactly once without tools for both vendors', async t => {
    const errors = [
        { message: 'This model does not support tools' },
        { message: 'Function calling is not supported by this model' },
        { message: 'Unrecognized request argument supplied: tools' },
        { message: "Unknown parameter: 'tools'" },
        { message: 'Unsupported parameter: tools' },
        { message: 'Not implemented', code: 'unsupported_parameter', param: 'tools' },
        { message: 'Not implemented', code: 'tools_not_supported' }
    ];
    for (const type of ['openai', 'anthropic']) {
        for (const error of errors) await t.test(`${type}: ${error.message} ${error.code || ''}`, async () => {
            const mock = recordFetch((request, attempt) => attempt === 1 ? jsonResponse({ error }, 400)
                : jsonResponse(type === 'anthropic' ? { content: [{ type: 'text', text: 'Use board.add_node({})' }] }
                    : openaiJson('Use board.add_node({})')));
            const result = await call({ provider: { ...provider, type }, tools, fetchImpl: mock.fetchImpl });
            assert.equal(mock.requests.length, 2);
            assert.equal(mock.requests[0].body.tools.length, 2);
            assert.equal(mock.requests[1].body.tools, undefined);
            assert.equal(mock.requests[0].signal, mock.requests[1].signal);
            assert.deepEqual(mock.requests[0].body.messages, mock.requests[1].body.messages);
            assert.equal(result.toolSupport, 'unavailable');
            assert.equal(result.text, 'Use board.add_node({})');
            assert.deepEqual(result.toolCalls, []);
        });
    }
});

test('unsupported fallback preserves existing tool call/result history', async () => {
    const history = [...messages, { role: 'assistant', content: '', tool_calls: [functionCall('prior', 'board.add_node')] },
        { role: 'tool', tool_call_id: 'prior', content: 'Result' }];
    const mock = recordFetch((request, attempt) => attempt === 1
        ? jsonResponse({ error: { message: 'tools are not supported' } }, 422) : jsonResponse(openaiJson('Finished')));
    assert.equal((await call({ tools, messages: history, fetchImpl: mock.fetchImpl })).toolSupport, 'unavailable');
    assert.deepEqual(mock.requests[1].body.messages, mock.requests[0].body.messages);
});

test('ordinary HTTP failures including tool schema errors do not fall back and redact keys', async t => {
    const cases = [
        [401, `Invalid API key ${provider.apiKey}`],
        [403, 'Tools are not allowed'],
        [429, 'Rate limit'],
        [500, 'Tools are not supported'],
        [400, 'tools[0].function.parameters contains an unsupported type'],
        [400, 'Invalid tools schema'],
        [404, 'Model not found'],
        [400, 'tools are valid but this model is unsupported']
    ];
    for (const [status, message] of cases) await t.test(message, async () => {
        const mock = recordFetch(() => jsonResponse({ error: { message } }, status));
        await assert.rejects(call({ tools, fetchImpl: mock.fetchImpl }), error => {
            assert.equal(error.status, status);
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.equal(error.message.includes(provider.apiKey), false);
            return true;
        });
        assert.equal(mock.requests.length, 1);
    });
});

test('unsupported response without offered tools does not retry', async () => {
    const mock = recordFetch(() => jsonResponse({ error: { message: 'tools not supported' } }, 400));
    await assert.rejects(call({ fetchImpl: mock.fetchImpl }), /HTTP 400/);
    assert.equal(mock.requests.length, 1);
});

test('the fallback failure is reported with no third request', async () => {
    const mock = recordFetch(() => jsonResponse({ error: { message: 'tools not supported' } }, 400));
    await assert.rejects(call({ tools, fetchImpl: mock.fetchImpl }), /HTTP 400/);
    assert.equal(mock.requests.length, 2);
});

test('unexpected tool calls on the fallback are never executable results', async () => {
    let name;
    const mock = recordFetch((request, attempt) => {
        if (attempt === 1) {
            name = request.body.tools[0].function.name;
            return jsonResponse({ error: { message: 'tools not supported' } }, 400);
        }
        return jsonResponse(openaiJson('', [functionCall('bad', name)]));
    });
    await assert.rejects(call({ tools, fetchImpl: mock.fetchImpl }), /after tools were disabled/);
});

test('malformed and non-object tool arguments fail for JSON and SSE in both protocols', async t => {
    for (const type of ['openai', 'anthropic']) {
        for (const streaming of [false, true]) {
            for (const args of ['{', '[]', 'null', '42', '"text"', '']) {
                await t.test(`${type} stream=${streaming} args=${args}`, async () => {
                    const mock = recordFetch(request => {
                        const name = type === 'anthropic' ? request.body.tools[0].name : request.body.tools[0].function.name;
                        if (type === 'openai') {
                            if (!streaming) return jsonResponse(openaiJson('', [functionCall('bad', name, args)]));
                            return streamResponse(sse({ choices: [{ delta: { tool_calls: [{ index: 0, ...functionCall('bad', name, args) }] } }] }) + sse('[DONE]'));
                        }
                        if (!streaming) {
                            let input;
                            try { input = JSON.parse(args); } catch { input = args; }
                            return jsonResponse({ content: [{ type: 'tool_use', id: 'bad', name, input }] });
                        }
                        return streamResponse(sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bad', name, input: {} } })
                            + sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args } })
                            + sse({ type: 'message_stop' }));
                    });
                    await assert.rejects(call({ provider: { ...provider, type }, tools, fetchImpl: mock.fetchImpl }), /Malformed tool arguments/);
                    assert.equal(mock.requests.length, 1);
                });
            }
        }
    }
});

test('malformed response JSON, incomplete SSE and stream error events reject instead of returning partial success', async t => {
    const cases = [
        ['openai', 'application/json', 'plain text', /Malformed provider JSON/],
        ['openai', 'application/json', '{}', /Missing OpenAI/],
        ['anthropic', 'application/json', '{}', /Missing Anthropic/],
        ['openai', 'text/event-stream', sse('broken'), /Malformed provider JSON/],
        ['openai', 'text/event-stream', sse({ choices: [{ delta: { content: 'partial' } }] }), /Incomplete provider stream/],
        ['anthropic', 'text/event-stream', sse({ type: 'message_start', message: { usage: {} } }), /Incomplete provider stream/],
        ['openai', 'text/event-stream', sse({ error: { message: 'stream failed' } }), /stream failed/],
        ['anthropic', 'text/event-stream', sse({ type: 'error', error: { message: 'overloaded' } }, 'error'), /overloaded/]
    ];
    for (const [type, contentType, text, expected] of cases) await t.test(`${type} ${text.slice(0, 30)}`, async () => {
        await assert.rejects(call({ provider: { ...provider, type }, fetchImpl: async () => streamResponse(text, { contentType }) }), expected);
    });
});

test('unknown tool names and duplicate IDs are rejected', async t => {
    for (const unknown of [true, false]) await t.test(unknown ? 'name' : 'duplicate ID', async () => {
        const mock = recordFetch(request => jsonResponse(openaiJson('', unknown
            ? [functionCall('id', 'unadvertised_tool')]
            : [functionCall('id', request.body.tools[0].function.name), functionCall('id', request.body.tools[1].function.name)])));
        await assert.rejects(call({ tools, fetchImpl: mock.fetchImpl }), unknown ? /unknown tool name/ : /duplicate response tool call ID/);
    });
});

test('invalid historical tool pairing and arguments fail before fetching', async t => {
    const assistant = { role: 'assistant', content: '', tool_calls: [functionCall('id', 'board.add_node')] };
    const result = { role: 'tool', tool_call_id: 'id', content: 'result' };
    const cases = [
        [[result], /Unpaired tool result/],
        [[assistant], /Missing tool results/],
        [[assistant, messages[0], result], /must be followed/],
        [[assistant, result, result], /Unpaired tool result/],
        [[{ ...assistant, tool_calls: [functionCall('id', 'board.add_node', 'oops')] }, result], /Malformed tool arguments/]
    ];
    for (const [history, expected] of cases) await t.test(expected.source, async () => {
        let fetched = false;
        await assert.rejects(call({ messages: history, fetchImpl: async () => { fetched = true; } }), expected);
        assert.equal(fetched, false);
    });
});

test('already-aborted calls never invoke fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetched = false;
    await assert.rejects(call({ signal: controller.signal, fetchImpl: async () => { fetched = true; } }), { name: 'AbortError' });
    assert.equal(fetched, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation interrupts a stalled fetch even when the transport ignores its signal', { timeout: 2000 }, async () => {
    const controller = new AbortController();
    const promise = call({ signal: controller.signal, fetchImpl: async () => {
        queueMicrotask(() => controller.abort());
        return new Promise(() => {});
    } });
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation from a streamed delta stops further callbacks and cancels the reader', async () => {
    const controller = new AbortController();
    const deltas = [];
    let cancelled = false;
    const body = sse({ choices: [{ delta: { content: 'first' } }] })
        + sse({ choices: [{ delta: { content: 'second' } }] }) + sse('[DONE]');
    await assert.rejects(call({ signal: controller.signal,
        onDelta: delta => { deltas.push(delta); controller.abort(); },
        fetchImpl: async () => streamResponse(body, { width: 65536, hold: true, onCancel: () => { cancelled = true; } }) }), { name: 'AbortError' });
    assert.deepEqual(deltas, ['first']);
    assert.equal(cancelled, true);
});

test('timeout spans stalled headers, SSE, JSON and HTTP error bodies', { timeout: 3000 }, async t => {
    for (const mode of ['headers', 'sse', 'json', 'http', 'text-fallback']) await t.test(mode, async () => {
        let requestSignal;
        let cancelled = false;
        const fetchImpl = async (url, init) => {
            requestSignal = init.signal;
            if (mode === 'headers') return new Promise(() => {});
            if (mode === 'text-fallback') return { ok: true, headers: new Headers(), text: () => new Promise(() => {}) };
            return streamResponse(mode === 'sse' ? sse({ choices: [{ delta: { content: 'partial' } }] }) : '{', {
                hold: true, status: mode === 'http' ? 400 : 200,
                contentType: mode === 'sse' ? 'text/event-stream' : 'application/json',
                onCancel: () => { cancelled = true; }
            });
        };
        await assert.rejects(call({ provider: { ...provider, timeoutMs: 30 }, fetchImpl }), { name: 'TimeoutError' });
        assert.equal(requestSignal.aborted, true);
        if (!['headers', 'text-fallback'].includes(mode)) assert.equal(cancelled, true);
    });
});

test('caller abort interrupts a pending JSON body read', { timeout: 2000 }, async () => {
    const controller = new AbortController();
    let cancelled = false;
    let trigger;
    const reading = new Promise(resolve => { trigger = resolve; });
    const promise = call({ signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({
        pull() { trigger(); }, cancel() { cancelled = true; }
    }), { headers: { 'content-type': 'application/json' } }) });
    await reading;
    controller.abort();
    await assert.rejects(promise, { name: 'AbortError' });
    assert.equal(cancelled, true);
});

test('abort listeners are removed after successful completion', async () => {
    const controller = new AbortController();
    await call({ signal: controller.signal, fetchImpl: async () => jsonResponse(openaiJson()) });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('transport failures redact credentials without attaching the unsafe cause', async () => {
    await assert.rejects(call({ fetchImpl: async () => { throw new Error(`Transport leaked ${provider.apiKey}`); } }), error => {
        assert.equal(error.message, 'Transport leaked [REDACTED]');
        assert.equal(error.cause, undefined);
        assert.equal(error.stack.includes(provider.apiKey), false);
        return true;
    });
});

test('tool-free prose remains text, with unknown capability and no inferred calls', async () => {
    const text = '{"tool":"board.add_node","arguments":{}}';
    const result = await call({ fetchImpl: async () => jsonResponse(openaiJson(text, [], undefined)) });
    assert.equal(result.text, text);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.toolSupport, 'unknown');
});

test('Google native requests and unsupported Anthropic content fail before network access', async t => {
    await t.test('Google', async () => {
        await assert.rejects(call({ provider: { ...provider, type: 'google' }, fetchImpl: () => assert.fail('must not fetch') }), /Google native/);
    });
    await t.test('content', async () => {
        await assert.rejects(call({ provider: { ...provider, type: 'anthropic' },
            messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'YWJj', format: 'wav' } }] }],
            fetchImpl: () => assert.fail('must not fetch') }), /Unsupported Anthropic content part/);
    });
});
