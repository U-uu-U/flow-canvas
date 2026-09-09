const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const ids = { type: 'array', items: string, minItems: 1, maxItems: 20, uniqueItems: true };
const AGENT_TOOL_DEFINITIONS = [
    { name: 'flow_canvas.asset.search', description: 'Search project nodes by title, filename or media type. Paginated metadata index; use asset.read for actual visual content.', inputSchema: object({ query: { type: 'string' }, kind: { enum: ['image', 'video', 'audio', 'text'] }, offset: { type: 'integer', minimum: 0 } }) },
    { name: 'flow_canvas.asset.read', description: 'Inspect a project node image, a crop, or video frames. Returns actual visual inputs and timestamped evidence; audio is metadata only.', inputSchema: object({ nodeId: string, detail: { enum: ['preview', 'high'] }, time: { type: 'number', minimum: 0 }, crop: object({ x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, width: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, height: { type: 'number', exclusiveMinimum: 0, maximum: 1 } }, ['x', 'y', 'width', 'height']) }, ['nodeId']) },
    { name: 'flow_canvas.model.list', description: 'Read configured generation models, supported parameters, and sourced sale prices. Unknown cost must never be presented as zero.', inputSchema: object() },
    { name: 'flow_canvas.graph.run', description: 'Propose a batch running target image/video nodes and their needed dependencies. This pauses for one user confirmation before paid calls. Existing completed upstream results are reused. Node prompts must already contain the intended instruction.', inputSchema: object({ nodeIds: ids, summary: string }, ['nodeIds', 'summary']) },
    { name: 'flow_canvas.task.list', description: 'List Agent runs in this project.', inputSchema: object() },
    { name: 'flow_canvas.task.get', description: 'Read an Agent run and its results in this project.', inputSchema: object({ runId: string }, ['runId']) },
    { name: 'flow_canvas.task.cancel', description: 'Stop an Agent run in this project. This does not promise provider cancellation or refunds.', inputSchema: object({ runId: string }, ['runId']) },
    { name: 'flow_canvas.memory.read', description: 'Read the project brief and confirmed constraints, separate from model observations.', inputSchema: object() },
    { name: 'flow_canvas.memory.propose', description: 'Propose project brief/constraint changes for explicit user confirmation. Never save inferred facts as confirmed requirements.', inputSchema: object({ brief: { type: 'string', maxLength: 6000 }, constraints: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 1000 } } }, ['brief', 'constraints']) }
];
const AGENT_RUN_TOOLS = ['start', 'get', 'list', 'confirm', 'revise', 'cancel', 'resume', 'retry'].map(action => ({
    name: `flow_canvas.agent.${action}`,
    description: `Agent runtime ${action}. Runs remain bound to their original project. Paid plans require explicit confirmation in the desktop UI.`,
    inputSchema: { type: 'object', properties: {
        projectId: { type: ['string', 'null'] }, conversationId: string, runId: string,
        afterSeq: { type: 'integer', minimum: 0 }, instruction: string,
        messages: { type: 'array', items: object({ role: { enum: ['user', 'assistant'] }, content: string }, ['role', 'content']) },
        providerId: string, model: string
    }, additionalProperties: false }
}));
module.exports = { AGENT_TOOL_DEFINITIONS, AGENT_RUN_TOOLS };
