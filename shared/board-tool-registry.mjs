const BOARD_TOOL_DEFINITIONS = Object.freeze([
    {
        name: 'flow_canvas.board.get_snapshot',
        description: 'Read a scoped Flow Canvas board snapshot before planning any board changes.',
        risk: 'read',
        inputSchema: {
            type: 'object',
            properties: {
                scope: {
                    type: 'string',
                    enum: ['selection', 'neighborhood', 'viewport', 'project'],
                    default: 'selection'
                },
                selectedItemIds: { type: 'array', items: { type: 'string' } },
                depth: { type: 'integer', minimum: 1, maximum: 10, default: 1 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'flow_canvas.board.transaction.preview',
        description: 'Validate a complete board transaction without changing the board.',
        risk: 'read',
        inputSchema: transactionInputSchema()
    },
    {
        name: 'flow_canvas.board.transaction.apply',
        description: 'Atomically apply a planned board transaction and return one undo token.',
        risk: 'write',
        inputSchema: transactionInputSchema()
    },
    {
        name: 'flow_canvas.board.transaction.undo',
        description: 'Undo one complete Agent board transaction using its undo token.',
        risk: 'write',
        inputSchema: {
            type: 'object',
            required: ['undoToken'],
            properties: {
                undoToken: { type: 'string', minLength: 1 }
            },
            additionalProperties: false
        }
    }
]);

function createBoardToolRegistry(handlers = {}) {
    const handlerMap = new Map([
        ['flow_canvas.board.get_snapshot', handlers.getSnapshot],
        ['flow_canvas.board.transaction.preview', handlers.previewTransaction],
        ['flow_canvas.board.transaction.apply', handlers.applyTransaction],
        ['flow_canvas.board.transaction.undo', handlers.undoTransaction]
    ]);

    return {
        definitions() {
            return clone(BOARD_TOOL_DEFINITIONS);
        },
        openAiTools() {
            return BOARD_TOOL_DEFINITIONS.map(definition => ({
                type: 'function',
                function: {
                    name: definition.name,
                    description: definition.description,
                    parameters: clone(definition.inputSchema)
                }
            }));
        },
        has(name) {
            return handlerMap.has(String(name || ''));
        },
        risk(name) {
            return BOARD_TOOL_DEFINITIONS.find(definition => definition.name === name)?.risk || null;
        },
        async execute(name, input = {}) {
            const normalizedName = String(name || '').trim();
            const definition = BOARD_TOOL_DEFINITIONS.find(entry => entry.name === normalizedName);
            if (!definition) throw toolError('TOOL_NOT_FOUND', `Unknown board tool: ${normalizedName || '(empty)'}`);
            const args = input && typeof input === 'object' && !Array.isArray(input) ? clone(input) : {};
            if (normalizedName === 'flow_canvas.board.transaction.undo') {
                if (!String(args.undoToken || '').trim()) throw toolError('INVALID_ARGUMENTS', 'undoToken is required');
            }
            const handler = handlerMap.get(normalizedName);
            if (typeof handler !== 'function') {
                throw toolError('TOOL_UNAVAILABLE', `Board tool is not available: ${normalizedName}`);
            }
            if (normalizedName === 'flow_canvas.board.transaction.undo') return handler(String(args.undoToken));
            if (normalizedName === 'flow_canvas.board.get_snapshot') return handler(args);
            const transaction = args.transaction && typeof args.transaction === 'object'
                ? args.transaction
                : args;
            return handler(transaction);
        }
    };
}

function transactionInputSchema() {
    return {
        type: 'object',
        required: ['id', 'baseRevision', 'operations'],
        properties: {
            schema: { type: 'string', const: 'flow-canvas.board-transaction.v1' },
            id: { type: 'string', minLength: 1 },
            projectId: { type: ['string', 'null'] },
            baseRevision: { type: 'integer', minimum: 0 },
            idempotencyKey: { type: 'string', minLength: 1 },
            reason: { type: 'string' },
            operations: {
                type: 'array',
                minItems: 1,
                maxItems: 500,
                items: operationInputSchema()
            }
        },
        additionalProperties: false
    };
}

function operationInputSchema() {
    const point = {
        type: 'object',
        properties: {
            x: { type: 'number' },
            y: { type: 'number' }
        },
        additionalProperties: false
    };
    const endpoint = {
        type: 'object',
        required: ['nodeId'],
        properties: {
            nodeId: { type: 'string', minLength: 1, description: 'A stable node id or tempId created earlier in this transaction.' },
            port: { type: 'string', description: 'Port name. May be omitted only when Flow Canvas can infer it unambiguously.' }
        },
        additionalProperties: false
    };
    return {
        type: 'object',
        required: ['op'],
        properties: {
            op: {
                type: 'string',
                enum: [
                    'node.create',
                    'node.update',
                    'node.delete',
                    'node.duplicate',
                    'connection.create',
                    'connection.delete',
                    'layout.arrange'
                ]
            },
            id: { type: 'string', minLength: 1, description: 'Optional stable id for a created node or connection.' },
            tempId: { type: 'string', minLength: 1, description: 'Temporary node id that later operations in this transaction may reference.' },
            nodeId: { type: 'string', minLength: 1, description: 'Required by node.update, node.delete, and node.duplicate.' },
            sourceId: { type: 'string', minLength: 1, description: 'Legacy alias for nodeId in node.duplicate.' },
            connectionId: { type: 'string', minLength: 1, description: 'Connection id required by connection.delete unless from and to are supplied.' },
            nodeType: { type: 'string', enum: ['text', 'image', 'video', 'batch'], description: 'Operation node type for node.create.' },
            item: { type: 'object', description: 'Complete media or operation-node data for node.create.', additionalProperties: true },
            data: { type: 'object', description: 'Node data for node.create when item is not supplied.', additionalProperties: true },
            position: point,
            patch: {
                type: 'object',
                description: 'Mutable fields for node.update.',
                properties: {
                    title: {},
                    x: { type: 'number' },
                    y: { type: 'number' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    config: { type: 'object', additionalProperties: true },
                    model: {},
                    tags: {},
                    metadata: {}
                },
                additionalProperties: false
            },
            offset: point,
            from: endpoint,
            to: endpoint,
            kind: { type: 'string', enum: ['flow', 'history'], default: 'flow' },
            nodeIds: {
                type: 'array',
                minItems: 1,
                uniqueItems: true,
                items: { type: 'string', minLength: 1 },
                description: 'Required by layout.arrange; may include tempIds from earlier operations.'
            },
            mode: { type: 'string', enum: ['horizontal', 'vertical', 'grid'], default: 'horizontal' },
            gap: { type: 'number', minimum: 0, maximum: 1000, default: 48 },
            columns: { type: 'integer', minimum: 1, maximum: 50, description: 'Grid column count.' },
            origin: point
        },
        additionalProperties: false
    };
}

function toolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

export {
    BOARD_TOOL_DEFINITIONS,
    createBoardToolRegistry
};
