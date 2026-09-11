import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import planCore from '../shared/plan-service-core.cjs';
import { BoardTransactionError } from '../src/board-transaction.js';
import { getPorts, portsCompatible } from '../src/graph-model.js';
import { getGeneratorResultEntries } from '../src/generator-result-stack.js';

const { PlanService } = planCore;
const clone = value => structuredClone(value);
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, details) => { throw new BoardTransactionError(code, message, details); };
const requireText = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) fail('INVALID_ARGUMENTS', `${label} must be a nonempty string`);
    return value.trim();
};
const optionalText = value => {
    if (value === undefined) return '';
    if (typeof value !== 'string') fail('INVALID_ARGUMENTS', 'instruction must be a string');
    return value.trim();
};
const columnsFor = entries => entries.map(([key, label, width = 180]) => ({ key, label, width }));
const TEMPLATES = {
    table: planCore.DEFAULT_PLAN_COLUMNS,
    script: columnsFor([['scene', '场次', 100], ['setting', '场景设定'], ['action', '动作与情节', 300],
        ['dialogue', '对白', 300], ['assets', '参考素材', 220], ['notes', '导演备注']]),
    characters: columnsFor([['name', '角色'], ['role', '叙事职责'], ['appearance', '外观', 260],
        ['personality', '性格'], ['motivation', '动机'], ['assets', '参考素材', 220]]),
    shots: columnsFor([['shot', '镜号', 90], ['scene', '场景'], ['framing', '景别与构图'], ['movement', '镜头运动'],
        ['action', '画面动作', 260], ['duration', '时长', 100], ['assets', '参考素材', 220]])
};
const TOOLS = ['flow_canvas.model.list', 'flow_canvas.board.transaction.apply', 'flow_canvas.graph.run'];
const ACCEPTANCE = ['Preserve ordered reference bindings and step dependencies.',
    'Keep source nodes unchanged.', 'Confirm the complete graph once before any paid generation.'];
const STRING_CONFIG = ['ratio', 'resolution', 'resolutionTier', 'size', 'quality', 'negativePrompt', 'style', 'cameraControl'];
const NUMBER_CONFIG = ['duration', 'width', 'height', 'seed'];
const BOOLEAN_CONFIG = ['generateAudio', 'cameraFixed', 'watermark', 'webSearch'];

function requireNode(project, id) {
    requireText(id, 'node ID');
    const node = project.items.find(item => item.id === id);
    if (!node) fail('NODE_NOT_FOUND', `Project node not found: ${id}`);
    return node;
}

function requirePlan(project, id) {
    requireText(id, 'documentId');
    const plan = project.plans.find(entry => entry.id === id);
    if (!plan) fail('DOCUMENT_NOT_FOUND', `Document not found: ${id}`);
    return plan;
}

function validateColumns(columns) {
    if (!Array.isArray(columns) || !columns.length) fail('INVALID_ARGUMENTS', 'columns must be a nonempty array');
    const keys = new Set();
    return columns.map(column => {
        if (!object(column)) fail('INVALID_ARGUMENTS', 'Invalid column');
        const key = requireText(column.key, 'column key');
        if (keys.has(key)) fail('INVALID_ARGUMENTS', 'Duplicate column key');
        keys.add(key);
        const label = requireText(column.label, 'column label');
        if (column.width !== undefined && (!Number.isFinite(column.width) || column.width <= 0)) {
            fail('INVALID_ARGUMENTS', 'Column width must be positive');
        }
        return { key, label, ...(column.width === undefined ? {} : { width: column.width }) };
    });
}

function cells(value) {
    if (!object(value)) fail('INVALID_ARGUMENTS', 'cells must be an object');
    return Object.fromEntries(Object.entries(value).map(([key, cell]) => {
        if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) {
            fail('INVALID_ARGUMENTS', 'Cells must contain scalar values');
        }
        return [key, String(cell ?? '')];
    }));
}

function references(project, values) {
    if (!Array.isArray(values)) fail('INVALID_ARGUMENTS', 'references must be an array');
    return values.map(reference => {
        if (!object(reference)) fail('INVALID_ARGUMENTS', 'Invalid reference');
        const node = requireNode(project, reference.itemId);
        const filePath = getGeneratorResultEntries(node)[0]?.filePath || node.filePath;
        // PlanService discards pathless references; reject instead of silently losing the link.
        if (!filePath) fail('REFERENCE_UNAVAILABLE', 'Document references require a project node with a file');
        return { itemId: node.id, filePath,
            name: node.title || node.name || filePath.split(/[/\\]/).pop(),
            kind: node.kind === 'op' || node.generation ? 'output' : 'source' };
    });
}

function validateRows(rows, creating) {
    if (!Array.isArray(rows)) fail('INVALID_ARGUMENTS', 'rows must be an array');
    const ids = new Set();
    for (const row of rows) {
        if (!object(row)) fail('INVALID_ARGUMENTS', 'Invalid row');
        if (!creating || row.id !== undefined) {
            requireText(row.id, 'row ID');
            if (ids.has(row.id)) fail('INVALID_ARGUMENTS', 'Duplicate row ID');
            ids.add(row.id);
        }
        if (row.delete !== undefined && (creating || typeof row.delete !== 'boolean')) {
            fail('INVALID_ARGUMENTS', 'Invalid row deletion');
        }
        if (row.delete && (row.cells !== undefined || row.references !== undefined)) {
            fail('INVALID_ARGUMENTS', 'A deleted row cannot also be edited');
        }
        if (creating || row.cells !== undefined) cells(row.cells);
    }
}

// Only scalar generation settings are portable. Also scrub free text, including
// known secret/provider values that could have been interpolated into a prompt.
function textScrubber(source) {
    const hidden = new Set();
    const visit = (value, sensitive = false) => {
        if (typeof value === 'string' && sensitive && value) hidden.add(value);
        else if (Array.isArray(value)) value.forEach(entry => visit(entry, sensitive));
        else if (object(value)) for (const [key, entry] of Object.entries(value)) {
            visit(entry, sensitive || /api.?key|token|secret|password|authorization|credential|provider.*id|sourceProviderId|filePath|endpoint|url|directory|saveFolder/i.test(key));
            if (/provider/i.test(key) && object(entry) && typeof entry.id === 'string') hidden.add(entry.id);
        }
    };
    visit(source);
    const values = [...hidden].sort((a, b) => b.length - a.length);
    return text => {
        let result = String(text ?? '');
        for (const value of values) result = result.split(value).join('[removed]');
        return result
            .replace(/\b(?:https?|file|local-res):\/\/[^\s<>"']+/gi, '[removed]')
            .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/gi, '[removed]')
            .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[removed]')
            .replace(/"(?:[a-z]:[/\\]|\\\\|\/)[^"]*"|'(?:[a-z]:[/\\]|\\\\|\/)[^']*'/gi, '[removed]')
            .replace(/\b[a-z]:[/\\][^\s<>"']+|\\\\[^\s<>"']+/gi, '[removed]')
            .replace(/(^|[\s(=])(?:~?\/|\.{1,2}[/\\])[^\s<>"']+/g, '$1[removed]');
    };
}

function portableConfig(config, prompt, scrub) {
    const result = {};
    for (const key of STRING_CONFIG) if (typeof config[key] === 'string') result[key] = scrub(config[key]);
    for (const key of NUMBER_CONFIG) if (Number.isFinite(config[key])) result[key] = config[key];
    for (const key of BOOLEAN_CONFIG) if (typeof config[key] === 'boolean') result[key] = config[key];
    // Each runtime step is already one expanded generation, not the original batch count.
    return { ...result, prompt: scrub(requireText(prompt, 'step prompt')), count: 1 };
}

function recipeFor(project, run, name, instruction) {
    if (String(run.status).toLowerCase() !== 'completed') fail('RUN_NOT_COMPLETED', 'Only completed runs can be saved');
    if (!Array.isArray(run.steps) || !run.steps.length || run.steps.length > 20) {
        fail('INVALID_WORKFLOW', 'A workflow requires 1 to 20 completed generation steps');
    }
    const scrub = textScrubber({ run, name, instruction });
    const inputSlots = [], steps = [], slots = new Map(), priorNodes = new Map(), priorResults = new Map();
    const allNodes = new Set(run.steps.map(step => step?.nodeId));
    const stepIds = new Set();
    for (const source of run.steps) {
        if (!object(source) || !['image', 'video'].includes(source.kind) || !object(source.config)
            || !Array.isArray(source.references) || String(source.status).toLowerCase() !== 'completed'
            || typeof source.id !== 'string' || !source.id || stepIds.has(source.id)
            || typeof source.nodeId !== 'string' || !source.nodeId) {
            fail('INVALID_WORKFLOW', 'Invalid completed generation step');
        }
        if (source.tool !== undefined && source.tool !== 'flow_canvas.graph.run') {
            fail('TOOL_NOT_ALLOWED', 'Only graph.run generation steps can be saved');
        }
        stepIds.add(source.id);
        const recordedResult = Array.isArray(run.results) ? run.results.find(entry => entry.stepId === source.id) : undefined;
        const result = { ...recordedResult, ...source.result };
        if (!Array.isArray(result?.nodeIds) || !result.nodeIds.length || result.nodeIds.some(id => typeof id !== 'string' || !id)) {
            fail('INVALID_WORKFLOW', 'Every saved step requires result node IDs');
        }
        const id = `step-${steps.length + 1}`;
        const refs = source.references.map(ref => {
            if (!object(ref)) fail('INVALID_WORKFLOW', 'Invalid step reference');
            const nodeId = requireText(ref.nodeId, 'reference node ID');
            const candidates = priorNodes.get(nodeId) || [];
            // Expanded steps can share a source node. Resolved reference paths select
            // the actual consumed result; an unresolved reference uses runtime's first.
            const matched = candidates.find(candidate => ref.filePath && candidate.filePaths.includes(ref.filePath));
            const dependency = priorResults.get(nodeId) || matched?.stepId || candidates[0]?.stepId;
            if (dependency) return { stepId: dependency };
            if (allNodes.has(nodeId)) fail('INVALID_WORKFLOW', 'Dependencies must point to prior steps');
            const node = requireNode(project, nodeId);
            if (!slots.has(nodeId)) {
                const slotId = `input-${inputSlots.length + 1}`;
                slots.set(nodeId, slotId);
                inputSlots.push({ id: slotId, label: scrub(node.title || node.name || `Reference ${inputSlots.length + 1}`),
                    kind: getPorts(node).outputs[0]?.dataType || 'any' });
            }
            return { inputSlotId: slots.get(nodeId) };
        });
        if (new Set(refs.map(ref => JSON.stringify(ref))).size !== refs.length) {
            fail('INVALID_WORKFLOW', 'Duplicate step references cannot be represented as distinct graph edges');
        }
        steps.push({ id, title: scrub(source.title || `${source.kind} ${steps.length + 1}`),
            kind: source.kind, tool: 'flow_canvas.graph.run', modelPreference: { kind: source.kind },
            config: portableConfig(source.config, source.prompt ?? source.config.prompt, scrub), references: refs });
        const candidates = priorNodes.get(source.nodeId) || [];
        candidates.push({ stepId: id, filePaths: Array.isArray(result.filePaths) ? result.filePaths : [] });
        priorNodes.set(source.nodeId, candidates);
        for (const nodeId of result.nodeIds) {
            if (priorResults.has(nodeId)) fail('INVALID_WORKFLOW', 'Ambiguous result node ID');
            priorResults.set(nodeId, id);
        }
    }
    return { schemaVersion: 1, name: scrub(name), instruction: scrub(instruction),
        inputSlots, steps, tools: [...TOOLS], acceptance: [...ACCEPTANCE] };
}

function documentType(project, id) {
    return own(project.agentDocumentTypes || {}, id) ? project.agentDocumentTypes[id] : 'table';
}

function documentResult(project, id) {
    return { projectId: project.projectId, revision: project.revision,
        document: { ...clone(requirePlan(project, id)), templateId: documentType(project, id) } };
}

/** Reads are synchronous; writes return Promises. getRun(runId) may be sync or
 * async and must return the runtime run (including projectId, steps and results).
 * This service never executes graph.run or resolves a provider.
 */
export class AgentCreativeService {
    constructor({ board, getRun } = {}) {
        if (!['readProject', 'updateProject', 'apply'].every(key => typeof board?.[key] === 'function')) {
            throw new TypeError('A board service is required');
        }
        if (typeof getRun !== 'function') throw new TypeError('getRun(runId) is required');
        Object.assign(this, { board, getRun });
    }

    documentList(projectId) {
        const project = this.board.readProject(projectId);
        return { projectId, revision: project.revision, documents: project.plans.map(plan => ({
            id: plan.id, title: plan.title, templateId: documentType(project, plan.id),
            rowCount: plan.rows?.length || 0
        })) };
    }

    documentGet(projectId, { documentId } = {}) {
        return documentResult(this.board.readProject(projectId), documentId);
    }

    async documentCreate(projectId, input = {}) {
        const { title, templateId = 'table', columns, rows } = clone(input);
        requireText(title, 'title');
        if (typeof templateId !== 'string' || !own(TEMPLATES, templateId)) fail('INVALID_ARGUMENTS', 'Unknown document template');
        if (columns !== undefined) validateColumns(columns);
        if (rows !== undefined) validateRows(rows, true);
        const result = await this.board.updateProject(projectId, project => {
            const group = { id: projectId, plans: [] };
            const plans = new PlanService({ activeGroupId: projectId, folderGroups: [group] });
            // The shared creation helper is createPlan, not newPlan in this version.
            const plan = plans.createPlan({ title: title.trim() });
            plan.id = `plan-${randomUUID()}`;
            plan.columns = plans.normalizeColumns(columns === undefined ? TEMPLATES[templateId] : validateColumns(columns));
            if (rows !== undefined) plan.rows = rows.map((row, index) => plans.createRow(index, {
                id: row.id || `row-${randomUUID()}`, cells: cells(row.cells),
                references: references(project, row.references ?? [])
            }));
            const normalized = plans.normalizePlan(plan);
            project.plans.push(normalized);
            project.agentDocumentTypes = { ...project.agentDocumentTypes, [plan.id]: templateId };
            return plan.id;
        });
        return { ...documentResult(result, result.value), changed: result.changed };
    }

    async documentUpdate(projectId, input = {}) {
        const { documentId, baseRevision, rows, title, columns } = clone(input);
        if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) fail('INVALID_ARGUMENTS', 'baseRevision is required');
        if (rows !== undefined) validateRows(rows, false);
        if (title !== undefined) requireText(title, 'title');
        if (columns !== undefined) validateColumns(columns);
        const result = await this.board.updateProject(projectId, project => {
            if (project.revision !== baseRevision) fail('REVISION_CONFLICT', 'Project revision changed', {
                expectedRevision: baseRevision, actualRevision: project.revision
            });
            const plan = requirePlan(project, documentId);
            const before = clone(plan);
            const helper = new PlanService({ folderGroups: [] });
            if (title !== undefined) plan.title = title.trim();
            if (columns !== undefined) plan.columns = helper.normalizeColumns(validateColumns(columns));
            for (const patch of rows || []) {
                const index = plan.rows.findIndex(row => row.id === patch.id);
                if (patch.delete) {
                    if (index >= 0) plan.rows.splice(index, 1);
                    continue;
                }
                const row = index >= 0 ? plan.rows[index] : helper.createRow(plan.rows.length, { id: patch.id });
                if (patch.cells !== undefined) row.cells = { ...row.cells, ...cells(patch.cells) };
                if (patch.references !== undefined) row.references = references(project, patch.references);
                if (index < 0) plan.rows.push(row);
            }
            if (!isDeepStrictEqual(before, plan)) plan.updatedAt = Date.now();
        });
        return { ...documentResult(result, documentId), changed: result.changed };
    }

    workflowList(projectId) {
        const project = this.board.readProject(projectId);
        return { projectId, revision: project.revision, workflows: clone(project.agentWorkflows || []) };
    }

    async workflowSave(projectId, input = {}) {
        const { runId, name, instruction } = clone(input);
        requireText(runId, 'runId');
        requireText(name, 'name');
        const text = optionalText(instruction);
        this.board.readProject(projectId);
        const run = clone(await this.getRun(runId));
        if (!run) fail('RUN_NOT_FOUND', 'Run not found');
        if (run.id !== runId || run.projectId !== projectId) fail('PROJECT_MISMATCH', 'Run does not belong to this project');
        const result = await this.board.updateProject(projectId, project => {
            const recipe = recipeFor(project, run, name.trim(), text);
            const workflows = project.agentWorkflows ??= [];
            const versions = workflows.filter(entry => entry.name === recipe.name);
            const existing = versions.find(entry => {
                const { id, version, createdAt, ...definition } = entry;
                return isDeepStrictEqual(definition, recipe);
            });
            if (existing) return existing.id;
            const workflow = { ...recipe, id: `workflow-${randomUUID()}`,
                version: Math.max(0, ...versions.map(entry => entry.version)) + 1, createdAt: Date.now() };
            workflows.push(workflow);
            return workflow.id;
        });
        return { projectId, revision: result.revision, changed: result.changed,
            workflow: clone(result.agentWorkflows.find(entry => entry.id === result.value)) };
    }

    async workflowInstantiate(projectId, input = {}) {
        const { skillId, referenceNodeIds, instruction } = clone(input);
        const text = optionalText(instruction);
        const project = this.board.readProject(projectId);
        const workflow = project.agentWorkflows?.find(entry => entry.id === skillId);
        if (!workflow) fail('WORKFLOW_NOT_FOUND', 'Workflow not found');
        if (workflow.schemaVersion !== 1 || !Array.isArray(workflow.steps) || !workflow.steps.length
            || workflow.steps.length > 20 || !Array.isArray(workflow.inputSlots)
            || !Array.isArray(workflow.tools) || workflow.tools.some(tool => !TOOLS.includes(tool))) {
            fail('INVALID_WORKFLOW', 'Unsupported workflow definition');
        }
        if (!Array.isArray(referenceNodeIds) || referenceNodeIds.length !== workflow.inputSlots.length
            || new Set(referenceNodeIds).size !== referenceNodeIds.length) {
            fail('INVALID_ARGUMENTS', 'Provide one distinct project node per ordered input slot');
        }
        const bindings = new Map();
        for (const [index, slot] of workflow.inputSlots.entries()) {
            if (!object(slot) || typeof slot.id !== 'string' || !slot.id || bindings.has(slot.id)
                || !['image', 'video', 'file', 'string', 'any'].includes(slot.kind)) {
                fail('INVALID_WORKFLOW', 'Input slots require unique IDs and supported kinds');
            }
            const node = requireNode(project, referenceNodeIds[index]);
            if (!getPorts(node).outputs.some(port => port.dataType === slot.kind || slot.kind === 'any')) {
                fail('REFERENCE_TYPE_MISMATCH', 'Input node does not match the saved slot kind');
            }
            bindings.set(slot.id, node);
        }
        const transactionId = `workflow-instance-${randomUUID()}`;
        const operations = [], created = new Map();
        const scrub = textScrubber(workflow);
        const right = Math.max(0, ...project.items.map(node => (Number(node.x) || 0) + (Number(node.width) || 320)));
        for (const [index, step] of workflow.steps.entries()) {
            if (!object(step) || typeof step.id !== 'string' || !step.id || created.has(step.id) || !['image', 'video'].includes(step.kind)
                || step.tool !== 'flow_canvas.graph.run' || !workflow.tools.includes(step.tool)
                || !object(step.config) || !Array.isArray(step.references)) {
                fail('INVALID_WORKFLOW', 'Invalid generation step or tool');
            }
            const config = portableConfig(step.config, step.config.prompt, scrub);
            // Save-time instruction is reusable context. The invocation's User change
            // comes last, so it can explicitly amend the base without replacing it.
            config.prompt = [config.prompt, workflow.instruction ? `Workflow instruction:\n${scrub(workflow.instruction)}` : '',
                text ? `User change:\n${text}` : ''].filter(Boolean).join('\n\n');
            const node = { id: `temp-${transactionId}-${index}`, kind: 'op', nodeType: step.kind,
                title: scrub(step.title), config, x: right + 64 + index * 584, y: 0,
                metadata: { agentWorkflowId: workflow.id, agentWorkflowVersion: workflow.version, agentWorkflowStepId: step.id } };
            operations.push({ op: 'node.create', tempId: node.id, nodeType: step.kind,
                item: Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'id')) });
            const sources = new Set();
            for (const reference of step.references) {
                if (!object(reference) || own(reference, 'stepId') === own(reference, 'inputSlotId')) {
                    fail('INVALID_WORKFLOW', 'A reference must select exactly one dependency or input slot');
                }
                const source = reference.stepId ? created.get(reference.stepId) : bindings.get(reference.inputSlotId);
                if (!source || sources.has(source.id)) fail('INVALID_WORKFLOW', 'Missing, forward or duplicate dependency');
                sources.add(source.id);
                const output = getPorts(source).outputs[0];
                const port = getPorts(node).inputs.find(inputPort => portsCompatible(output, inputPort));
                if (!port) fail('REFERENCE_TYPE_MISMATCH', 'No compatible graph ports');
                operations.push({ op: 'connection.create', from: { nodeId: source.id, port: output.name },
                    to: { nodeId: node.id, port: port.name } });
            }
            created.set(step.id, node);
        }
        const result = await this.board.apply(projectId, { id: transactionId, idempotencyKey: transactionId,
            projectId, baseRevision: project.revision, reason: `Instantiate ${workflow.name}`, operations });
        const nodeIds = [...created.values()].map(node => result.tempIds[node.id]);
        return { projectId, revision: result.nextRevision, skillId, nodeIds, undoToken: result.undoToken,
            nextAction: { tool: 'flow_canvas.graph.run', arguments: { projectId, nodeIds, summary: `执行流程 ${workflow.name}` }, requiresConfirmation: true } };
    }
}
