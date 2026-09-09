const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'flow-test-external', version: '1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'scene.inspect', description: 'Read test scene',
    inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
    annotations: { readOnlyHint: true } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: JSON.stringify({
    label: request.params.arguments.label, objectCount: 3, cwd: process.cwd(), marker: process.env.FLOW_MCP_TEST_MARKER
}) }] }));
server.connect(new StdioServerTransport()).catch(error => { console.error(error); process.exitCode = 1; });
