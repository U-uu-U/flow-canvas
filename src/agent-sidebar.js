// ============================================================
// Flow Canvas — Agent Sidebar (AI 对话右侧边栏)
// ============================================================

import {
    DEFAULT_SHORTCUTS,
    SHORTCUT_DEFINITIONS,
    SHORTCUTS_CHANGED_EVENT,
    formatShortcut,
    loadShortcutBindings,
    normalizeShortcut,
    saveShortcutBindings,
    shortcutFromKeyboardEvent
} from './shortcut-settings.js';
import {
    IMAGE_RESOLUTION_TIERS,
    inferClosestAspectRatio,
    inferImageResolutionTier
} from './image-node-settings.js';
import {
    inferProviderCapability,
    providerHasCapability,
    isGptImage2Model
} from './provider-capabilities.js';
import {
    getImageGenerationPreferences as readImageGenerationPreferences,
    normalizeImageGenerationPreferences,
    saveImageGenerationPreferences as writeImageGenerationPreferences
} from './image-generation-preferences.js';
import {
    buildAgentImageCompilationMessages,
    normalizeAgentGenerationSource,
    parseAgentImageCompilationResponse
} from './agent-image-generation.js';
import { reconcileApiConfig } from './api-config-recovery.js';
import { CANCELED_IMAGE_REFERENCES } from './node-types.js';
import { requestRecoveryTaskId } from './generation-recovery-dialog.js';
import { DEFAULT_VIDEO_MODEL_PROFILE, getVideoModelProfile } from '../shared/video-model-profiles.mjs';
import {
    AgentRuntimeClient, createRuntimeCard, isRuntimeTerminal, runtimeOutputFiles,
    settleRuntimeConversation, formatAgentElapsed
} from './agent-runtime-view.js';
import { createBoardToolRegistry } from './board-tool-registry.js';
import {
    CUSTOM_AGENT_SKILL_LIMIT,
    createCustomAgentSkill,
    normalizeCustomAgentSkills,
    removeCustomAgentSkill
} from './agent-skills.js';
import {
    AGENT_CONVERSATION_LIMIT,
    createAgentConversation,
    deriveAgentConversationTitle,
    mergeAgentConversationFiles,
    normalizeAgentConversationProject,
    normalizeAgentConversationFiles
} from './agent-conversations.js';

const DEFAULT_TEMPLATES = {
    'ravenhash-text': { name: 'RavenHash Text', capability: 'text', type: 'openai', endpoint: 'https://ai.ravenhash.org/v1', model: '' },
    ravenhash: { name: 'RavenHash Image', capability: 'image', type: 'openai', endpoint: 'https://ai.ravenhash.org/v1', model: 'gpt-image-2' },
    'ravenhash-video': { name: 'RavenHash Video', capability: 'video', type: 'openai', endpoint: 'https://art.ravenhash.org/v1', model: 'doubao-seedance-2-0' }
};

function normalizeRavenHashEndpoint(endpoint) {
    const value = String(endpoint || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/(?:ai|art)\.ravenhash\.org$/i.test(value)) {
        return `${value}/v1`;
    }
    return value;
}


function formatVideoModelPrice(price) {
    if (price?.kind !== 'sale' || !price.source || price.currency !== 'CNY' || price.unit !== 'request') return '';
    const amount = Number(price.amount);
    if (!Number.isFinite(amount) || amount < 0) return '';
    return `¥${Number.isInteger(amount) ? amount : amount.toFixed(2)}/次`;
}

function formatVideoModelProfile(profile, includeLabel = true) {
    return [
        includeLabel ? profile?.label : '',
        profile?.routeLabel,
        formatVideoModelPrice(profile?.price)
    ].filter(Boolean).join(' · ');
}


const DEFAULT_IMAGE_SIZES = [
    { value: '', label: '自动（匹配比例，优先最大）' },
    { value: '1024x1024', label: '1024 × 1024（方图）' },
    { value: '1536x1024', label: '1536 × 1024（横图）' },
    { value: '1024x1536', label: '1024 × 1536（竖图）' }
];

const RAVENHASH_IMAGE_SIZES = [
    ...DEFAULT_IMAGE_SIZES,
    { value: '2048x2048', label: '2048 × 2048（2K 方图）' },
    { value: '2880x2880', label: '2880 × 2880（原生方图）' },
    { value: '3840x2160', label: '3840 × 2160（原生 4K 横图）' },
    { value: '2160x3840', label: '2160 × 3840（原生 4K 竖图）' }
];

const VIDEO_REFERENCE_LIMITS = Object.freeze({ image: 9, video: 3, audio: 3 });
const VIDEO_REFERENCE_LARGE_TOTAL_BYTES = 10 * 1024 * 1024;
const IMAGE_REFERENCE_UPLOAD_BUDGET_BYTES = 6 * 1024 * 1024;
const IMAGE_REFERENCE_MANUAL_BUDGET_BYTES = 2 * 1024 * 1024;
const IMAGE_PROMPT_HEIGHT_STORAGE_KEY = 'flow-canvas-image-prompt-height';
const VIDEO_PROMPT_HEIGHT_STORAGE_KEY = 'flow-canvas-video-prompt-height';
const PROJECT_COMPOSER_CACHE_STORAGE_KEY = 'flow-canvas-project-composer-cache-v1';
const PROJECT_COMPOSER_DEFAULT_KEY = '__no_project__';
const AGENT_CONVERSATION_STORAGE_KEY = 'flow-canvas-agent-conversations-v1';
const AGENT_CONVERSATION_MESSAGE_LIMIT = 80;
const AGENT_PENDING_ATTACHMENTS_STORAGE_KEY = 'flow-canvas-agent-pending-attachments-v1';
const AGENT_PENDING_ATTACHMENT_LIMIT = 32;
const AGENT_SKILLS = Object.freeze([
    {
        id: 'board-planning',
        name: '画板规划',
        category: 'planning',
        description: '整理阶段、交付物和执行顺序',
        instruction: '优先把目标拆成可执行阶段，并检查规划表中的依赖、缺项和交付物。'
    },
    {
        id: 'shot-planning',
        name: '镜头规划',
        category: 'planning',
        description: '组织镜头、节奏和画面衔接',
        instruction: '涉及视频时，明确镜头目的、景别、运动、时长和前后镜头的连续关系。'
    },
    {
        id: 'prompt-refine',
        name: '提示词优化',
        category: 'creative',
        description: '强化目标、约束和参考图职责',
        instruction: '优化生成提示词时保留原始意图，明确主体、构图、风格、限制条件和每张参考图的职责。'
    },
    {
        id: 'asset-audit',
        name: '素材检查',
        category: 'review',
        description: '核对素材完整性和引用关系',
        instruction: '先核对选中素材、文件夹组和引用关系，明确指出缺失、断联、重复或不适合当前任务的素材。'
    },
    {
        id: 'node-diagnosis',
        name: '节点排错',
        category: 'review',
        description: '检查节点输入、连线和生成配置',
        instruction: '排查节点问题时按输入、连线、模型配置、请求参数、任务状态和输出落地的顺序定位原因。'
    }
]);
const AGENT_BUILTIN_SKILL_IDS = new Set(AGENT_SKILLS.map(skill => skill.id));
const AGENT_CUSTOM_SKILLS_STORAGE_KEY = 'flow-canvas-agent-custom-skills-v1';
const PROMPT_PRESETS_STORAGE_KEY = 'flow-canvas-prompt-presets-v1';
const PROMPT_PRESET_LIMIT = 100;
const GENERATION_TASKS_STORAGE_KEY = 'flow-canvas-generation-tasks';
const GENERATION_TASK_LIMIT = 100;
const BROWSER_SYNC_EVENT_IDS_KEY = 'flow-canvas-browser-sync-event-ids';
const API_PROVIDERS_STORAGE_KEY = 'flow-canvas-agent-providers';
const API_GLOBAL_STORAGE_KEY = 'flow-canvas-agent-global';
const API_META_STORAGE_KEY = 'flow-canvas-api-config-meta-v1';
const RESERVED_SHORTCUTS = Object.freeze([
    { binding: 'Mod+C', label: '复制到剪贴板' },
    { binding: 'Mod+V', label: '粘贴素材' },
    { binding: 'Mod+A', label: '全选' },
    { binding: 'Mod+Shift+Z', label: '重做兼容键' },
    { binding: 'Backspace', label: '删除兼容键' },
    { binding: 'Escape', label: '取消操作' }
]);

export class AgentSidebar {
    constructor(options = {}) {
        this.options = options;
        this.boardToolRegistry = createBoardToolRegistry({
            getSnapshot: options.getBoardSnapshot,
            previewTransaction: options.previewBoardTransaction,
            applyTransaction: options.applyBoardTransaction,
            undoTransaction: options.undoBoardTransaction
        });
        // 全局配置：文字、图片和视频 provider 选择
        this.globalConfig = {
            textProviderId: null,
            imageProviderId: null,
            videoProviderId: null,
            imageIntentPipelineMode: 'compiled',
            imageIntentPipelineVersion: 2,
            defaultTemporaryImageCompression: false,
            imageGenerationPreferences: normalizeImageGenerationPreferences({}),
            agentExecutionMode: 'auto',
            agentSkillIds: []
        };
        // 存储所有的 provider { id, name, capability, type, endpoint, apiKey, model }
        this.providers = [];
        this.apiConfigRevision = 0;
        this.apiConfigUpdatedAt = '';
        this.apiConfigHydrated = false;
        this.apiConfigSaveTimer = null;
        this.pendingDurableApiConfigSave = false;
        this.localApiConfigPresent = false;

        this.editingProviderId = null;
        this.imageGenerationMode = 'text';
        this.imageReferenceSelections = [];
        this.videoReferenceSelections = { image: [], video: [], audio: [] };
        this.activeReferenceWorkspace = null;
        this.activeVideoReferenceType = null;
        this.activeProjectCacheKey = this._projectCacheKey(this.options.getActiveProjectId?.());
        this.projectComposerSaveTimer = null;
        this.restoringProjectComposer = false;
        this.selectedPromptPresetIds = { image: '', video: '' };
        this.activeConversationId = null;
        this.conversationFiles = [];
        this.messages = [];
        this.pendingAgentAttachments = [];
        this.pendingAgentSource = null;
        this.isAgentSending = false;
        this.runtimeClient = null;
        this.runtimeStarting = new Set();
        this.runtimeCards = new Map();
        this.runtimeStartErrors = new Map();
        this.activeRuntimeProjectId = this.options.getActiveProjectId?.() ?? null;
        this.agentModelKind = 'text';
        this.agentSkillCategory = 'all';
        this.customAgentSkills = this._loadCustomAgentSkills();

        // DOM 引用
        this.settingsPanel = document.getElementById('agentSettings');

        // Settings elements
        this.settingsTabs = document.getElementById('agentSettingsTabs');
        this.shortcutSettingsPane = document.getElementById('agentShortcutSettingsPane');
        this.creationSettingsPane = document.getElementById('agentCreationSettingsPane');
        this.apiSettingsPane = document.getElementById('agentApiSettingsPane');
        this.defaultTemporaryCompressionToggle = document.getElementById('agentDefaultTemporaryCompression');
        this.assetLibraryFolderSelect = document.getElementById('agentAssetLibraryFolderSelect');
        this.assetLibraryFolderChoose = document.getElementById('agentAssetLibraryFolderChoose');
        this.assetLibraryFolderStatus = document.getElementById('agentAssetLibraryFolderStatus');
        this.shortcutList = document.getElementById('agentShortcutList');
        this.shortcutResetBtn = document.getElementById('agentShortcutResetBtn');
        this.shortcutStatus = document.getElementById('agentShortcutStatus');
        this.shortcutBindings = loadShortcutBindings();
        this.activeSettingsTab = 'shortcuts';
        this.recordingShortcutAction = null;
        this.providerListEl = document.getElementById('agentProviderList');
        this.addApiBtn = document.getElementById('agentAddApiBtn');
        this.apiForm = document.getElementById('agentApiForm');
        this.apiFormCloseBtn = document.getElementById('agentApiFormClose');
        this.apiFormTitle = document.getElementById('agentApiFormTitle');
        this.textModelSelectEl = document.getElementById('agentTextModelSelect');
        this.imageModelSelectEl = document.getElementById('agentImageModelSelect');
        this.videoModelSelectEl = document.getElementById('agentVideoModelSelect');
        this.modeTitle = document.getElementById('creationModeTitle');
        this.conversationMenuBtn = document.getElementById('agentConversationMenuBtn');
        this.conversationTitleBtn = document.getElementById('agentConversationTitleBtn');
        this.conversationTitleEl = document.getElementById('agentConversationTitle');
        this.conversationPopover = document.getElementById('agentConversationPopover');
        this.conversationSummary = document.getElementById('agentConversationSummary');
        this.conversationList = document.getElementById('agentConversationList');
        this.newConversationBtn = document.getElementById('agentNewConversationBtn');
        this.filesBtn = document.getElementById('agentFilesBtn');
        this.filesCount = document.getElementById('agentFilesCount');
        this.filesPopover = document.getElementById('agentFilesPopover');
        this.filesSummary = document.getElementById('agentFilesSummary');
        this.filesList = document.getElementById('agentFilesList');
        this.sidebarCloseBtn = document.getElementById('agentSidebarCloseBtn');
        this.agentHeader = document.querySelector('.agent-header');
        this.messagesEl = document.getElementById('agentMessages');
        this.inputEl = document.getElementById('agentInput');
        this.agentAttachmentTray = document.getElementById('agentAttachmentTray');
        this.agentAttachmentList = document.getElementById('agentAttachmentList');
        this.agentContextSummary = document.getElementById('agentContextSummary');
        this.agentAttachmentClear = document.getElementById('agentAttachmentClear');
        this.sendBtn = document.getElementById('agentSendBtn');
        this.planBtn = document.getElementById('agentPlanBtn');
        this.clearBtn = document.getElementById('agentClearBtn');
        this.agentComposerControls = document.getElementById('agentComposerControls');
        this.agentAddMenuBtn = document.getElementById('agentAddMenuBtn');
        this.agentAddPopover = document.getElementById('agentAddPopover');
        this.agentModelMenuBtn = document.getElementById('agentModelMenuBtn');
        this.agentModelPopover = document.getElementById('agentModelPopover');
        this.agentModelTabs = document.getElementById('agentModelTabs');
        this.agentModelSummary = document.getElementById('agentModelSummary');
        this.agentComposerModelList = document.getElementById('agentComposerModelList');
        this.agentModelSettingsBtn = document.getElementById('agentModelSettingsBtn');
        this.agentSkillMenuBtn = document.getElementById('agentSkillMenuBtn');
        this.agentSkillPopover = document.getElementById('agentSkillPopover');
        this.agentSkillSearchInput = document.getElementById('agentSkillSearchInput');
        this.agentSkillAddBtn = document.getElementById('agentSkillAddBtn');
        this.agentSkillTabs = document.getElementById('agentSkillTabs');
        this.agentSkillList = document.getElementById('agentSkillList');
        this.agentSkillCount = document.getElementById('agentSkillCount');
        this.agentSkillClearBtn = document.getElementById('agentSkillClearBtn');
        this.agentSkillDoneBtn = document.getElementById('agentSkillDoneBtn');
        this.agentSkillForm = document.getElementById('agentSkillForm');
        this.agentSkillFormName = document.getElementById('agentSkillFormName');
        this.agentSkillFormCategory = document.getElementById('agentSkillFormCategory');
        this.agentSkillFormDescription = document.getElementById('agentSkillFormDescription');
        this.agentSkillFormInstruction = document.getElementById('agentSkillFormInstruction');
        this.agentSkillFormStatus = document.getElementById('agentSkillFormStatus');
        this.agentSkillFormCancel = document.getElementById('agentSkillFormCancel');
        this.agentExecutionMenuBtn = document.getElementById('agentExecutionMenuBtn');
        this.agentExecutionPopover = document.getElementById('agentExecutionPopover');
        this.agentExecutionModeLabel = document.getElementById('agentExecutionModeLabel');
        this.taskHistoryDock = document.getElementById('taskHistoryDock');
        this.taskHistoryBtn = document.getElementById('agentTaskHistoryBtn');
        this.taskHistoryBadge = document.getElementById('agentTaskHistoryBadge');
        this.taskHistoryPanel = document.getElementById('agentTaskHistory');
        this.taskHistoryCloseBtn = document.getElementById('agentTaskHistoryClose');
        this.taskHistoryFilters = document.getElementById('agentTaskHistoryFilters');
        this.taskHistoryList = document.getElementById('agentTaskHistoryList');
        this.taskHistorySummary = document.getElementById('agentTaskHistorySummary');
        this.agentSidebar = document.getElementById('agentSidebar');
        this.videoModelPicker = document.getElementById('videoModelPicker');
        this.videoModelSearchInput = document.getElementById('videoModelSearchInput');
        this.videoModelList = document.getElementById('videoModelList');
        this.videoModelEmpty = document.getElementById('videoModelEmpty');
        this.videoSelectedModelName = document.getElementById('videoSelectedModelName');
        this.videoSelectedModelId = document.getElementById('videoSelectedModelId');
        this.videoSelectedModelProfile = document.getElementById('videoSelectedModelProfile');
        this.videoSelectedModelRoute = document.getElementById('videoSelectedModelRoute');
        this.videoSelectedModelPrice = document.getElementById('videoSelectedModelPrice');
        this.videoSelectedModelProviderType = document.getElementById('videoSelectedModelProviderType');
        this.videoSelectedModelResolutions = document.getElementById('videoSelectedModelResolutions');
        this.videoSelectedModelDurations = document.getElementById('videoSelectedModelDurations');
        this.videoSelectedModelRatios = document.getElementById('videoSelectedModelRatios');
        this.videoModelFavoriteBtn = document.getElementById('videoModelFavoriteBtn');
        this.videoModelCopyBtn = document.getElementById('videoModelCopyBtn');
        this.videoWorkspace = document.getElementById('videoWorkspace');
        this.videoPromptDock = document.getElementById('videoPromptDock');
        this.videoPromptInput = document.getElementById('videoPromptInput');
        this.videoPromptResizeHandle = document.getElementById('videoPromptResizeHandle');
        this.videoRatioField = document.getElementById('videoRatioField');
        this.videoRatioGrid = document.querySelector('.creation-ratio-grid');
        this.videoResolutionField = document.getElementById('videoResolutionField');
        this.videoResolutionSelect = document.getElementById('videoResolutionSelect');
        this.videoRatioSelect = document.getElementById('videoRatioSelect');
        this.videoDurationField = document.getElementById('videoDurationField');
        this.videoDurationSelect = document.getElementById('videoDurationSelect');
        this.videoDurationControl = document.getElementById('videoDurationControl');
        this.videoCameraFixed = document.getElementById('videoCameraFixed');
        this.videoGenerateAudio = document.getElementById('videoGenerateAudio');
        this.videoWebSearchField = document.getElementById('videoWebSearchField');
        this.videoWebSearch = document.getElementById('videoWebSearch');
        this.videoWatermark = document.getElementById('videoWatermark');
        this.videoAddMediaBtn = document.getElementById('videoAddMediaBtn');
        this.videoClearSourcesBtn = document.getElementById('videoClearSourcesBtn');
        this.videoWorkspaceStatus = document.getElementById('videoWorkspaceStatus');
        this.videoGenerateBtn = document.getElementById('videoGenerateBtn');
        this.videoGenerateMessage = document.getElementById('videoGenerateMessage');
        this.videoPromptPresetSelect = document.getElementById('videoPromptPresetSelect');
        this.videoPromptPresetName = document.getElementById('videoPromptPresetName');
        this.videoPromptPresetSave = document.getElementById('videoPromptPresetSave');
        this.videoPromptPresetDelete = document.getElementById('videoPromptPresetDelete');
        this.videoPromptPresetCount = document.getElementById('videoPromptPresetCount');
        this.videoPromptPresetStatus = document.getElementById('videoPromptPresetStatus');
        this.videoPromptProviderChip = document.getElementById('videoPromptProviderChip');
        this.videoPromptModelChip = document.getElementById('videoPromptModelChip');
        this.imageWorkspace = document.getElementById('imageWorkspace');
        this.imagePromptInput = document.getElementById('imagePromptInput');
        this.imagePromptResizeHandle = document.getElementById('imagePromptResizeHandle');
        this.imageGenerationModeControl = document.getElementById('imageGenerationModeControl');
        this.imageReferencePanel = document.getElementById('imageReferencePanel');
        this.imageReferenceCount = document.getElementById('imageReferenceCount');
        this.imageReferenceList = document.getElementById('imageReferenceList');
        this.imageAddReferenceBtn = document.getElementById('imageAddReferenceBtn');
        this.imageCompressReferencesBtn = document.getElementById('imageCompressReferencesBtn');
        this.imageClearReferencesBtn = document.getElementById('imageClearReferencesBtn');
        this.imageSizeSelect = document.getElementById('imageSizeSelect');
        this.imageQualitySelect = document.getElementById('imageQualitySelect');
        this.imageApiOptions = document.getElementById('imageApiOptions');
        this.imageResponseFormatSelect = document.getElementById('imageResponseFormatSelect');
        this.imageHistoryDisabled = document.getElementById('imageHistoryDisabled');
        this.imageStream = document.getElementById('imageStream');
        this.imageWorkspaceStatus = document.getElementById('imageWorkspaceStatus');
        this.imageGenerateBtn = document.getElementById('imageGenerateBtn');
        this.imageGenerateMessage = document.getElementById('imageGenerateMessage');
        this.imagePromptPresetSelect = document.getElementById('imagePromptPresetSelect');
        this.imagePromptPresetName = document.getElementById('imagePromptPresetName');
        this.imagePromptPresetSave = document.getElementById('imagePromptPresetSave');
        this.imagePromptPresetDelete = document.getElementById('imagePromptPresetDelete');
        this.imagePromptPresetCount = document.getElementById('imagePromptPresetCount');
        this.imagePromptPresetStatus = document.getElementById('imagePromptPresetStatus');
        this.currentMode = 'canvas';
        this.taskHistoryOpen = false;
        this.taskHistoryFilter = 'all';
        this.generationTasks = [];
        this.processedBrowserSyncEventIds = new Set();
        this.browserSyncPolling = false;
        this.activeVideoWorkspaceTaskId = null;
        this.lastCanvasSelection = this.options.getSelectedCanvasEntries?.() || [];

        // Form inputs
        this.formName = document.getElementById('agentFormName');
        this.formCapability = document.getElementById('agentFormCapability');
        this.formType = document.getElementById('agentFormType');
        this.formEndpoint = document.getElementById('agentFormEndpoint');
        this.formKey = document.getElementById('agentFormKey');
        this.getApiBtn = document.getElementById('agentGetApiBtn');
        this.formModel = document.getElementById('agentFormModel');
        this.fetchModelsBtn = document.getElementById('agentFetchModelsBtn');
        this.fetchedModelSelect = document.getElementById('agentFetchedModelSelect');
        this.fetchedModelOptions = document.getElementById('agentFetchedModelOptions');
        this.additionalModelsEl = document.getElementById('agentAdditionalModels');
        this.addModelSlotBtn = document.getElementById('agentAddModelSlotBtn');
        this.modelFetchStatus = document.getElementById('agentModelFetchStatus');
        this.formSaveBtn = document.getElementById('agentFormSaveBtn');
        this.fetchedModels = [];

        // 加载保存的设置
        this._loadConfig();
        this._loadGenerationTasks();
        this._loadBrowserSyncEventIds();

        // 绑定事件
        this._bindEvents();
        this._bindAgentSidebarResize();
        this._syncHudState();

        // 渲染 UI
        this._renderProviderList();
        this._renderModelSelect();
        this._renderShortcutSettings();
        if (this.defaultTemporaryCompressionToggle) {
            this.defaultTemporaryCompressionToggle.checked = this.globalConfig.defaultTemporaryImageCompression === true;
        }
        this._renderAssetLibrarySettings();
        this._setSettingsTab(this.activeSettingsTab);
        this._renderGenerationTasks();
        this._renderPromptPresets('image');
        this._renderPromptPresets('video');
        this.apiConfigReady = this._restoreDurableApiConfig();
        this._restoreAgentConversation(this.activeProjectCacheKey);
        this._restorePendingAgentAttachments();
        this._connectAgentRuntime();
        this.runtimePageHide = () => this.runtimeClient?.dispose();
        this.runtimePageShow = () => this._connectAgentRuntime();
        window.addEventListener('pagehide', this.runtimePageHide);
        window.addEventListener('pageshow', this.runtimePageShow);
        window.flowCanvas?.browserSync?.onTaskSubmitted?.((event) => this._handleTaskSubmitted(event));
        window.flowCanvas?.browserSync?.onTaskCompleted?.((event) => this._handleTaskCompleted(event));
        window.flowCanvas?.mcp?.onVideoProgress?.((event) => this._handleVideoProgress(event));
        this._pollBrowserSyncEvents();
        this.browserSyncTimer = setInterval(() => this._pollBrowserSyncEvents(), 4000);
        this.options.subscribeCanvasSelection?.((entries) => {
            this.lastCanvasSelection = Array.isArray(entries) ? entries : [];
        });
        this.options.subscribeInitialRenderComplete?.(() => {
            this._restoreProjectComposerReferences(this.activeProjectCacheKey);
        });
        this.options.subscribeMediaReferenceSelection?.((payload) => {
            const type = payload?.type;
            if (this.activeReferenceWorkspace === 'image' && type === 'image') {
                this.imageReferenceSelections = Array.isArray(payload.entries) ? payload.entries : [];
                this._renderImageReferences();
                return;
            }
            if (this.activeReferenceWorkspace !== 'video') return;
            const profile = this._getVideoModelProfile(this._getVideoProvider()) || DEFAULT_VIDEO_MODEL_PROFILE;
            const limits = this._getVideoReferenceLimits(profile);
            if (!limits[type]) return;
            this.videoReferenceSelections[type] = (Array.isArray(payload.entries) ? payload.entries : [])
                .slice(0, limits[type]);
            this._renderVideoSourcePreview();
        });
        this.options.subscribeMediaReferencePickState?.((payload) => {
            const workspace = this.activeReferenceWorkspace;
            if (!payload?.active) this.activeReferenceWorkspace = null;
            this.activeVideoReferenceType = payload?.active && workspace === 'video' ? payload.type : null;
            this._renderVideoReferencePickState();
            this._renderImageReferences();
        });
        this.options.subscribeAssetLibrarySettings?.(() => this._renderAssetLibrarySettings());
    }

    getBoardSnapshot(options = {}) {
        return this.boardToolRegistry.execute('flow_canvas.board.get_snapshot', options);
    }

    previewBoardTransaction(transaction) {
        return this.boardToolRegistry.execute('flow_canvas.board.transaction.preview', transaction);
    }

    applyBoardTransaction(transaction) {
        return this.boardToolRegistry.execute('flow_canvas.board.transaction.apply', transaction);
    }

    undoBoardTransaction(undoToken) {
        return this.boardToolRegistry.execute('flow_canvas.board.transaction.undo', { undoToken });
    }

    getBoardToolDefinitions() {
        return this.boardToolRegistry.definitions();
    }

    _projectCacheKey(projectId) {
        const value = String(projectId || '').trim();
        return value || PROJECT_COMPOSER_DEFAULT_KEY;
    }

    _loadAgentConversationStore() {
        try {
            const value = JSON.parse(localStorage.getItem(AGENT_CONVERSATION_STORAGE_KEY) || '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) {
            return {};
        }
    }

    _normalizeAgentMessages(messages = []) {
        return (Array.isArray(messages) ? messages : [])
            .filter(message => ['user', 'assistant'].includes(message?.role)
                && typeof message.content === 'string'
                && message.content.trim())
            .slice(-AGENT_CONVERSATION_MESSAGE_LIMIT)
            .map(message => ({
                ...message,
                role: message.role,
                content: message.content.slice(0, 12000)
            }));
    }

    _createAgentConversationId() {
        return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    }

    _normalizeAgentConversationProject(state) {
        const originals = Array.isArray(state?.conversations) ? state.conversations : [];
        const normalized = normalizeAgentConversationProject(state, {
            createId: () => this._createAgentConversationId(),
            normalizeMessages: messages => this._normalizeAgentMessages(messages)
        });
        return {
            ...state,
            ...normalized,
            conversations: normalized.conversations.map(conversation => ({
                ...originals.find(entry => entry.id === conversation.id),
                ...conversation
            }))
        };
    }

    _saveAgentConversationProject(key, project, store = this._loadAgentConversationStore()) {
        try {
            store[key] = project;
            localStorage.setItem(AGENT_CONVERSATION_STORAGE_KEY, JSON.stringify(store));
            return true;
        } catch (error) {
            console.warn('[AgentSidebar] Failed to save Agent conversation:', error);
            return false;
        }
    }

    _activeConversationCacheKey(
        projectKey = this.activeProjectCacheKey,
        conversationId = this.activeConversationId
    ) {
        return `${projectKey}::${conversationId || '__default_task__'}`;
    }

    _isActiveConversation(projectKey, conversationId) {
        return this.activeProjectCacheKey === projectKey && this.activeConversationId === conversationId;
    }

    _saveAgentConversation(
        key = this.activeProjectCacheKey,
        messages = this.messages,
        { conversationId = this.activeConversationId, files, title, customTitle } = {}
    ) {
        const store = this._loadAgentConversationStore();
        const project = this._normalizeAgentConversationProject(store[key]);
        const targetId = conversationId || project.activeConversationId;
        const conversation = project.conversations.find(entry => entry.id === targetId)
            || project.conversations[0];
        const normalizedMessages = this._normalizeAgentMessages(messages);
        conversation.messages = normalizedMessages;
        if (files !== undefined) conversation.files = normalizeAgentConversationFiles(files);
        if (title !== undefined) {
            conversation.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '新任务';
            conversation.customTitle = customTitle !== false;
        } else if (!conversation.customTitle) {
            conversation.title = deriveAgentConversationTitle(normalizedMessages);
        }
        conversation.updatedAt = Date.now();
        project.conversations = project.conversations.slice(0, AGENT_CONVERSATION_LIMIT);
        const saved = this._saveAgentConversationProject(key, project, store);
        if (saved && this._isActiveConversation(key, conversation.id)) {
            this.messages = normalizedMessages;
            this.conversationFiles = normalizeAgentConversationFiles(conversation.files);
            this._renderAgentConversationHeader(project);
        }
        return conversation;
    }

    _restoreAgentConversation(key = this.activeProjectCacheKey, conversationId = null) {
        const store = this._loadAgentConversationStore();
        const project = this._normalizeAgentConversationProject(store[key]);
        if (conversationId && project.conversations.some(entry => entry.id === conversationId)) {
            project.activeConversationId = conversationId;
        }
        const conversation = project.conversations.find(entry => entry.id === project.activeConversationId)
            || project.conversations[0];
        this.activeConversationId = conversation.id;
        this.messages = this._normalizeAgentMessages(conversation.messages);
        this.conversationFiles = normalizeAgentConversationFiles(conversation.files);
        this._saveAgentConversationProject(key, project, store);
        this._renderAgentMessages();
        this._renderAgentConversationHeader(project);
        this._watchAgentRuntime();
    }

    _renderAgentConversationHeader(projectState = null) {
        const project = projectState || this._normalizeAgentConversationProject(
            this._loadAgentConversationStore()[this.activeProjectCacheKey]
        );
        const active = project.conversations.find(entry => entry.id === this.activeConversationId)
            || project.conversations[0];
        if (this.conversationTitleEl) this.conversationTitleEl.textContent = active?.title || '新任务';
        if (this.conversationTitleBtn) this.conversationTitleBtn.title = active?.title || '新任务';
        if (this.conversationNameInput && document.activeElement !== this.conversationNameInput) {
            this.conversationNameInput.value = active?.title || '新任务';
        }
        if (this.conversationSummary) {
            this.conversationSummary.textContent = `${project.conversations.length} 个任务`;
        }
        if (this.conversationDeleteBtn) this.conversationDeleteBtn.disabled = false;
        this._renderAgentConversationList(project);
        this._renderAgentFiles();
    }

    _renderAgentConversationList(projectState = null) {
        if (!this.conversationList) return;
        const project = projectState || this._normalizeAgentConversationProject(
            this._loadAgentConversationStore()[this.activeProjectCacheKey]
        );
        this.conversationList.replaceChildren();
        [...project.conversations]
            .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
            .forEach(conversation => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'agent-conversation-item';
                button.classList.toggle('active', conversation.id === this.activeConversationId);
                button.dataset.agentConversationId = conversation.id;
                button.setAttribute('aria-pressed', String(conversation.id === this.activeConversationId));
                const icon = document.createElement('svg');
                icon.className = 'flow-icon flow-icon-sm';
                icon.setAttribute('aria-hidden', 'true');
                const use = document.createElement('use');
                use.setAttribute('href', './icons/flow-icons.svg#icon-folder');
                icon.appendChild(use);
                const copy = document.createElement('span');
                const title = document.createElement('strong');
                title.textContent = conversation.title || '新任务';
                const detail = document.createElement('small');
                const count = this._normalizeAgentMessages(conversation.messages).filter(message => message.role === 'user').length;
                detail.textContent = count ? `${count} 条指令` : '尚未开始';
                copy.append(title, detail);
                const check = document.createElement('svg');
                check.className = 'flow-icon flow-icon-sm agent-conversation-check';
                check.setAttribute('aria-hidden', 'true');
                const checkUse = document.createElement('use');
                checkUse.setAttribute('href', './icons/flow-icons.svg#icon-check');
                check.appendChild(checkUse);
                button.append(icon, copy, check);
                this.conversationList.appendChild(button);
            });
    }

    _createAgentConversation() {
        this._saveAgentConversation();
        this._savePendingAgentAttachments();
        const store = this._loadAgentConversationStore();
        const project = this._normalizeAgentConversationProject(store[this.activeProjectCacheKey]);
        const conversation = createAgentConversation({
            createId: () => this._createAgentConversationId(),
            normalizeMessages: messages => this._normalizeAgentMessages(messages)
        });
        project.conversations.unshift(conversation);
        project.conversations = project.conversations.slice(0, AGENT_CONVERSATION_LIMIT);
        project.activeConversationId = conversation.id;
        this._saveAgentConversationProject(this.activeProjectCacheKey, project, store);
        this.activeConversationId = conversation.id;
        this.messages = [];
        this.conversationFiles = [];
        this._restorePendingAgentAttachments();
        this._renderAgentMessages();
        this._renderAgentConversationHeader(project);
        this._closeAgentHeaderPopovers();
        this.inputEl?.focus();
        this._watchAgentRuntime();
    }

    _switchAgentConversation(conversationId) {
        const targetId = String(conversationId || '');
        if (!targetId || targetId === this.activeConversationId) {
            this._closeAgentHeaderPopovers();
            return;
        }
        this._saveAgentConversation();
        this._savePendingAgentAttachments();
        this._restoreAgentConversation(this.activeProjectCacheKey, targetId);
        this._restorePendingAgentAttachments();
        this._closeAgentHeaderPopovers();
        this.inputEl?.focus();
    }

    _renameAgentConversation() {
        const title = String(this.conversationNameInput?.value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!title) {
            this.conversationNameInput?.focus();
            return;
        }
        this._saveAgentConversation(this.activeProjectCacheKey, this.messages, {
            conversationId: this.activeConversationId,
            files: this.conversationFiles,
            title,
            customTitle: true
        });
        this._closeAgentHeaderPopovers();
    }

    _deleteAgentConversation() {
        const store = this._loadAgentConversationStore();
        const project = this._normalizeAgentConversationProject(store[this.activeProjectCacheKey]);
        const active = project.conversations.find(entry => entry.id === this.activeConversationId);
        if (!active || !window.confirm(`删除任务对话“${active.title}”？`)) return;
        this._clearPendingAgentAttachments(this._activeConversationCacheKey());
        project.conversations = project.conversations.filter(entry => entry.id !== active.id);
        if (project.conversations.length === 0) {
            project.conversations.push(createAgentConversation({
                createId: () => this._createAgentConversationId(),
                normalizeMessages: messages => this._normalizeAgentMessages(messages)
            }));
        }
        project.activeConversationId = project.conversations[0].id;
        this._saveAgentConversationProject(this.activeProjectCacheKey, project, store);
        this._restoreAgentConversation(this.activeProjectCacheKey, project.activeConversationId);
        this._restorePendingAgentAttachments();
        this._closeAgentHeaderPopovers();
        this.inputEl?.focus();
    }

    _captureAgentConversationFiles(files = [], direction = 'input') {
        this.conversationFiles = mergeAgentConversationFiles(
            this.conversationFiles,
            files,
            direction
        );
        this._renderAgentFiles();
        return this.conversationFiles;
    }

    _renderAgentFiles() {
        const files = normalizeAgentConversationFiles(this.conversationFiles);
        if (this.filesCount) {
            this.filesCount.textContent = String(files.length);
            this.filesCount.hidden = files.length === 0;
        }
        if (this.filesSummary) {
            const inputCount = files.filter(file => file.direction === 'input').length;
            const outputCount = files.length - inputCount;
            this.filesSummary.textContent = files.length
                ? `输入 ${inputCount} · 产出 ${outputCount}`
                : '当前对话还没有输入或产出文件';
        }
        if (!this.filesList) return;
        this.filesList.replaceChildren();
        if (files.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'agent-files-empty';
            empty.textContent = '当前对话中发送或生成的文件会保留在这里。';
            this.filesList.appendChild(empty);
            return;
        }
        files.forEach(file => {
            const item = document.createElement('div');
            item.className = `agent-file-item ${file.kind} ${file.direction}`;
            item.title = file.filePath || file.url || file.name;
            const icon = document.createElement('span');
            icon.innerHTML = `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${file.kind}"></use></svg>`;
            const copy = document.createElement('span');
            const name = document.createElement('strong');
            name.textContent = file.name;
            const detail = document.createElement('small');
            detail.textContent = file.detail || (file.direction === 'output' ? '产出文件' : '输入文件');
            copy.append(name, detail);
            item.append(icon, copy);
            this.filesList.appendChild(item);
        });
    }

    _agentHeaderPopoverEntries() {
        return [
            { name: 'conversation', buttons: [this.conversationMenuBtn, this.conversationTitleBtn], popover: this.conversationPopover },
            { name: 'files', buttons: [this.filesBtn], popover: this.filesPopover }
        ];
    }

    _closeAgentHeaderPopovers(except = null) {
        this._agentHeaderPopoverEntries().forEach(entry => {
            if (entry.name === except) return;
            if (entry.popover) entry.popover.hidden = true;
            entry.buttons.forEach(button => button?.setAttribute('aria-expanded', 'false'));
        });
    }

    _toggleAgentHeaderPopover(name) {
        const entry = this._agentHeaderPopoverEntries().find(candidate => candidate.name === name);
        if (!entry?.popover) return;
        const opening = entry.popover.hidden;
        this._closeAgentHeaderPopovers();
        if (!opening) return;
        if (name === 'conversation') this._renderAgentConversationHeader();
        if (name === 'files') this._renderAgentFiles();
        entry.popover.hidden = false;
        entry.buttons.forEach(button => button?.setAttribute('aria-expanded', 'true'));
    }

    _loadPendingAgentAttachmentStore() {
        try {
            const value = JSON.parse(localStorage.getItem(AGENT_PENDING_ATTACHMENTS_STORAGE_KEY) || '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) {
            return {};
        }
    }

    _normalizePendingAgentAttachments(attachments = []) {
        const seen = new Set();
        return (Array.isArray(attachments) ? attachments : [])
            .map(attachment => {
                const filePath = String(attachment?.filePath || '').trim();
                const url = String(attachment?.url || '').trim();
                const mediaType = ['image', 'video', 'audio'].includes(attachment?.mediaType)
                    ? attachment.mediaType
                    : null;
                if (!mediaType || (!filePath && !url)) return null;
                const key = `${mediaType}:${(filePath || url).replace(/\\/g, '/').toLowerCase()}`;
                if (seen.has(key)) return null;
                seen.add(key);
                return {
                    itemId: attachment?.itemId || null,
                    sourceNodeId: attachment?.sourceNodeId || null,
                    filePath,
                    url,
                    mediaType,
                    name: String(attachment?.name || '').trim()
                        || (filePath || url).replace(/\\/g, '/').split('/').pop()
                        || `${mediaType}素材`,
                    width: Number(attachment?.width) || null,
                    height: Number(attachment?.height) || null,
                    depth: Math.max(1, Number(attachment?.depth) || 1)
                };
            })
            .filter(Boolean)
            .slice(0, AGENT_PENDING_ATTACHMENT_LIMIT);
    }

    _normalizePendingAgentSource(source = null) {
        return normalizeAgentGenerationSource(source);
    }

    _savePendingAgentAttachments(
        key = this._activeConversationCacheKey(),
        attachments = this.pendingAgentAttachments,
        source = this.pendingAgentSource
    ) {
        try {
            const store = this._loadPendingAgentAttachmentStore();
            const normalized = this._normalizePendingAgentAttachments(attachments);
            const normalizedSource = this._normalizePendingAgentSource(source);
            if (normalized.length === 0 && !normalizedSource) delete store[key];
            else {
                store[key] = {
                    attachments: normalized,
                    source: normalizedSource,
                    updatedAt: new Date().toISOString()
                };
            }
            localStorage.setItem(AGENT_PENDING_ATTACHMENTS_STORAGE_KEY, JSON.stringify(store));
        } catch (error) {
            console.warn('[AgentSidebar] Failed to save pending Agent attachments:', error);
        }
    }

    _restorePendingAgentAttachments(key = this._activeConversationCacheKey()) {
        const store = this._loadPendingAgentAttachmentStore();
        let state = store[key];
        if (!state && key === this._activeConversationCacheKey() && store[this.activeProjectCacheKey]) {
            state = store[this.activeProjectCacheKey];
            store[key] = state;
            delete store[this.activeProjectCacheKey];
            localStorage.setItem(AGENT_PENDING_ATTACHMENTS_STORAGE_KEY, JSON.stringify(store));
        }
        this.pendingAgentAttachments = this._normalizePendingAgentAttachments(state?.attachments);
        this.pendingAgentSource = this._normalizePendingAgentSource(state?.source);
        this._renderPendingAgentAttachments();
    }

    _pendingAgentAttachmentPreview(attachment) {
        const preview = document.createElement('span');
        preview.className = 'agent-attachment-preview';
        if (attachment.mediaType === 'image') {
            const image = document.createElement('img');
            image.alt = '';
            image.draggable = false;
            image.src = attachment.filePath
                ? `local-res://${encodeURIComponent(attachment.filePath)}`
                : attachment.url;
            image.addEventListener('error', () => preview.classList.add('failed'));
            preview.appendChild(image);
        }
        const icon = document.createElement('svg');
        icon.className = 'flow-icon agent-attachment-fallback';
        icon.setAttribute('aria-hidden', 'true');
        const use = document.createElement('use');
        use.setAttribute('href', `./icons/flow-icons.svg#icon-${attachment.mediaType}`);
        icon.appendChild(use);
        preview.appendChild(icon);
        return preview;
    }

    _renderPendingAgentAttachments() {
        if (!this.agentAttachmentTray || !this.agentAttachmentList) return;
        const attachments = this.pendingAgentAttachments;
        const source = this.pendingAgentSource;
        this.agentAttachmentTray.hidden = attachments.length === 0 && !source;
        this.agentAttachmentList.hidden = attachments.length === 0;
        if (this.agentContextSummary) {
            const summary = [];
            if (source?.effectivePrompt) summary.push('提示词');
            const parameterCount = Object.keys(source?.parameters || {}).length;
            if (parameterCount) summary.push(`${parameterCount} 项参数`);
            if (attachments.length) summary.push(`${attachments.length} 个素材`);
            this.agentContextSummary.textContent = summary.join(' · ') || '节点上下文';
        }
        this.agentAttachmentList.replaceChildren();
        attachments.forEach((attachment, index) => {
            const item = document.createElement('div');
            item.className = `agent-attachment-item ${attachment.mediaType}`;
            item.title = attachment.name;
            item.appendChild(this._pendingAgentAttachmentPreview(attachment));

            const type = document.createElement('span');
            type.className = 'agent-attachment-type';
            type.textContent = { image: '图片', video: '视频', audio: '音频' }[attachment.mediaType];
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.removeAgentAttachment = String(index);
            remove.title = `移除 ${attachment.name}`;
            remove.setAttribute('aria-label', `移除 ${attachment.name}`);
            remove.innerHTML = '<svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-close"></use></svg>';
            item.append(type, remove);
            this.agentAttachmentList.appendChild(item);
        });
    }

    _removePendingAgentAttachment(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.pendingAgentAttachments.length) return;
        this.pendingAgentAttachments.splice(index, 1);
        if (this.pendingAgentAttachments.length === 0) this.pendingAgentSource = null;
        this._savePendingAgentAttachments();
        this._renderPendingAgentAttachments();
        this.inputEl?.focus();
    }

    _clearPendingAgentAttachments(key = this._activeConversationCacheKey()) {
        if (key === this._activeConversationCacheKey()) {
            this.pendingAgentAttachments = [];
            this.pendingAgentSource = null;
            this._renderPendingAgentAttachments();
        }
        this._savePendingAgentAttachments(key, [], null);
    }

    _pendingAgentAttachmentSignature(attachments = [], source = null) {
        const normalized = this._normalizePendingAgentAttachments(attachments);
        const sourceId = this._normalizePendingAgentSource(source)?.nodeId || '';
        const keys = normalized.map(attachment =>
            `${attachment.mediaType}:${(attachment.filePath || attachment.url).replace(/\\/g, '/').toLowerCase()}`
        );
        return `${sourceId}|${keys.join('\u0000')}`;
    }

    _consumePendingAgentAttachments(key, attachments, source) {
        const expectedSignature = this._pendingAgentAttachmentSignature(attachments, source);
        if (key === this._activeConversationCacheKey()) {
            const currentSignature = this._pendingAgentAttachmentSignature(
                this.pendingAgentAttachments,
                this.pendingAgentSource
            );
            if (currentSignature === expectedSignature) this._clearPendingAgentAttachments(key);
            return;
        }
        const state = this._loadPendingAgentAttachmentStore()[key];
        const storedSignature = this._pendingAgentAttachmentSignature(state?.attachments, state?.source);
        if (storedSignature === expectedSignature) this._clearPendingAgentAttachments(key);
    }

    prepareAgentFromNode(details = {}) {
        const previousSourceId = this.pendingAgentSource?.nodeId || null;
        this.pendingAgentAttachments = this._normalizePendingAgentAttachments(details.attachments);
        this.pendingAgentSource = this._normalizePendingAgentSource(details);
        this._savePendingAgentAttachments();
        this._renderPendingAgentAttachments();
        this.setMode('agent');
        if (this.inputEl && (!this.inputEl.value.trim() || previousSourceId !== this.pendingAgentSource?.nodeId)) {
            this.inputEl.value = this.pendingAgentSource?.effectivePrompt || '';
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 120)}px`;
        }
        setTimeout(() => this.inputEl?.focus(), 140);
        return {
            count: this.pendingAgentAttachments.length,
            nodeId: this.pendingAgentSource?.nodeId || null
        };
    }

    _renderAgentWelcome() {
        if (!this.messagesEl) return;
        const welcome = document.createElement('div');
        welcome.className = 'agent-welcome';
        welcome.innerHTML = `
            <div class="agent-welcome-icon" aria-hidden="true">
                <svg class="flow-icon"><use href="./icons/flow-icons.svg#icon-sparkles"></use></svg>
            </div>
            <div class="agent-welcome-text">
                <strong>开始一项画板任务</strong>
                <span>AI Agent</span>
            </div>
        `;
        this.messagesEl.appendChild(welcome);
    }

    _renderAgentMessages() {
        if (!this.messagesEl) return;
        this.messagesEl.innerHTML = '';
        this.runtimeCards?.clear();
        if (this.messages.length === 0) {
            this._renderAgentWelcome();
            this._renderAgentRuntimeCards();
            return;
        }
        this.messages.forEach(message => {
            const element = this._appendAgentMessageElement(message.role, message.content, message);
            if (message.runtimeRunId) element.dataset.runtimeMessageId = message.runtimeRunId;
            if (message.role === 'assistant' && !message.runtimeRunId) this._attachAgentPlanAction(element, message.content);
        });
        this._renderAgentRuntimeCards();
        this._scrollAgentMessages();
    }

    _appendAgentMessageElement(role, content, metadata = {}) {
        if (!this.messagesEl) return null;
        this.messagesEl.querySelector('.agent-welcome')?.remove();
        const element = document.createElement('div');
        element.className = `agent-msg ${role}`;

        const body = document.createElement('div');
        body.className = 'agent-msg-body';
        element.setAttribute('aria-label', role === 'assistant' ? '助手回复' : role === 'user' ? '你的消息' : '请求错误');
        if (role === 'error') element.setAttribute('role', 'alert');
        const duration = role === 'assistant' ? formatAgentElapsed(metadata.elapsedMs) : '';
        if (duration) {
            const elapsed = document.createElement('div');
            elapsed.className = 'agent-msg-duration';
            elapsed.textContent = duration;
            elapsed.title = '从发送到完成的总用时';
            body.append(elapsed);
        }
        const contentElement = document.createElement('div');
        contentElement.className = 'agent-msg-content';
        contentElement.textContent = content;
        body.append(contentElement);
        if (Number.isFinite(metadata.createdAt)) {
            const timestamp = new Date(metadata.createdAt);
            if (Number.isFinite(timestamp.getTime())) {
                const time = document.createElement('time');
                time.className = 'agent-msg-time';
                time.dateTime = timestamp.toISOString();
                time.textContent = timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
                time.title = timestamp.toLocaleString('zh-CN');
                body.append(time);
            }
        }
        element.append(body);
        this.messagesEl.appendChild(element);
        this._scrollAgentMessages();
        return element;
    }

    _appendAgentError(message) {
        return this._appendAgentMessageElement('error', message);
    }

    _appendAgentTyping() {
        if (!this.messagesEl) return null;
        const element = this._appendAgentMessageElement('assistant', '');
        if (!element) return null;
        element.classList.add('agent-typing');
        const contentElement = element.querySelector('.agent-msg-content');
        if (contentElement) {
            contentElement.innerHTML = '<span class="agent-loading-ring" aria-hidden="true"></span><span class="agent-typing-line"></span>';
        }
        this._scrollAgentMessages();
        return element;
    }

    _scrollAgentMessages() {
        requestAnimationFrame(() => {
            if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        });
    }

    _clearAgentConversation() {
        const store = this._loadAgentConversationStore();
        const conversation = store[this.activeProjectCacheKey]?.conversations?.find(entry => entry.id === this.activeConversationId);
        if (conversation) {
            conversation.runtimeReceipts ||= {};
            for (const run of this.runtimeClient?.runs.values() || []) {
                if (this._isActiveConversation(this._projectCacheKey(run.projectId), run.conversationId)) {
                    conversation.runtimeReceipts[run.id] = { ignored: true };
                }
            }
            for (const receipt of Object.values(conversation.runtimeReceipts)) receipt.ignored = true;
            this._saveAgentConversationProject(this.activeProjectCacheKey, store[this.activeProjectCacheKey], store);
        }
        this.messages = [];
        this.conversationFiles = [];
        this._saveAgentConversation(this.activeProjectCacheKey, this.messages, {
            conversationId: this.activeConversationId,
            files: this.conversationFiles
        });
        this._renderAgentMessages();
        this.inputEl?.focus();
    }

    _agentComposerPopoverEntries() {
        return [
            { name: 'add', button: this.agentAddMenuBtn, popover: this.agentAddPopover },
            { name: 'model', button: this.agentModelMenuBtn, popover: this.agentModelPopover },
            { name: 'skill', button: this.agentSkillMenuBtn, popover: this.agentSkillPopover },
            { name: 'execution', button: this.agentExecutionMenuBtn, popover: this.agentExecutionPopover }
        ];
    }

    _closeAgentComposerPopovers(except = null) {
        this._agentComposerPopoverEntries().forEach(entry => {
            if (!entry.popover || entry.name === except) return;
            entry.popover.hidden = true;
            entry.button?.setAttribute('aria-expanded', 'false');
            if (entry.name === 'skill') this._setAgentSkillFormOpen(false);
        });
    }

    _toggleAgentComposerPopover(name) {
        const entry = this._agentComposerPopoverEntries().find(candidate => candidate.name === name);
        if (!entry?.popover) return;
        const shouldOpen = entry.popover.hidden;
        this._closeAgentComposerPopovers();
        if (!shouldOpen) return;

        if (name === 'model') this._renderAgentComposerModels();
        if (name === 'skill') this._renderAgentSkillList();
        if (name === 'execution') this._renderAgentExecutionMode();
        entry.popover.hidden = false;
        entry.button?.setAttribute('aria-expanded', 'true');
        if (name === 'skill') requestAnimationFrame(() => this.agentSkillSearchInput?.focus());
    }

    _setAgentModelKind(kind) {
        this.agentModelKind = ['image', 'video'].includes(kind) ? kind : 'text';
        this._renderAgentComposerModels();
    }

    _renderAgentComposerModels() {
        if (!this.agentComposerModelList) return;
        const kind = this.agentModelKind;
        const allProviders = this._providerVariants();
        const providers = allProviders.filter(provider => kind === 'video'
            ? this._isVideoProvider(provider)
            : kind === 'image'
                ? this._isImageProvider(provider)
                : this._isTextProvider(provider));
        const selectedId = kind === 'video'
            ? this.globalConfig.videoProviderId
            : kind === 'image'
                ? this.globalConfig.imageProviderId
                : this.globalConfig.textProviderId;

        this.agentModelTabs?.querySelectorAll('[data-agent-model-kind]').forEach(button => {
            const selected = button.dataset.agentModelKind === kind;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
        if (this.agentModelSummary) {
            const configured = new Set(allProviders.map(provider => provider.id)).size;
            this.agentModelSummary.textContent = configured > 0 ? `已配置 ${configured}` : '尚未配置';
        }

        this.agentComposerModelList.innerHTML = '';
        if (providers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'agent-composer-empty';
            const title = document.createElement('strong');
            title.textContent = `没有可用的${kind === 'text' ? '文字' : kind === 'image' ? '图片' : '视频'}模型`;
            const detail = document.createElement('span');
            detail.textContent = '请先在 API 设置中添加模型。';
            empty.append(title, detail);
            this.agentComposerModelList.appendChild(empty);
            return;
        }

        const iconId = kind === 'video' ? 'icon-video' : kind === 'image' ? 'icon-image' : 'icon-sparkles';
        providers.forEach(provider => {
            const selected = provider.id === selectedId;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'agent-composer-list-item agent-model-list-item';
            button.classList.toggle('selected', selected);
            button.dataset.agentProviderId = provider.id;
            button.dataset.agentModelKind = kind;
            button.setAttribute('aria-pressed', String(selected));

            const icon = document.createElement('span');
            icon.className = 'agent-composer-list-icon';
            icon.innerHTML = `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#${iconId}"></use></svg>`;
            const copy = document.createElement('span');
            copy.className = 'agent-composer-list-copy';
            const name = document.createElement('strong');
            name.textContent = provider.model || provider.name || '未命名模型';
            const meta = document.createElement('small');
            const videoProfile = kind === 'video' ? this._getVideoModelProfile(provider) : null;
            if (videoProfile?.routeLabel) name.textContent = `${videoProfile.routeLabel} · ${provider.model}`;
            meta.textContent = kind === 'video'
                ? [provider.name || '未命名 API', formatVideoModelProfile(videoProfile)].filter(Boolean).join(' · ')
                : (provider.name || '未命名 API');
            copy.append(name, meta);
            const check = document.createElement('span');
            check.className = 'agent-composer-list-check';
            check.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-check"></use></svg>';
            button.append(icon, copy, check);
            this.agentComposerModelList.appendChild(button);
        });
    }

    _selectAgentComposerModel(kind, providerId) {
        if (kind === 'video') this._setVideoProvider(providerId);
        else if (kind === 'image') this._setImageProvider(providerId);
        else this._setTextProvider(providerId);
        this._renderAgentComposerModels();
    }

    _selectedAgentSkillIds() {
        const availableIds = new Set(this._agentSkills().map(skill => skill.id));
        return (Array.isArray(this.globalConfig.agentSkillIds) ? this.globalConfig.agentSkillIds : [])
            .filter(id => availableIds.has(id));
    }

    _activeAgentSkills() {
        const selectedIds = new Set(this._selectedAgentSkillIds());
        return this._agentSkills().filter(skill => selectedIds.has(skill.id));
    }

    _agentSkills() {
        return [...AGENT_SKILLS, ...this.customAgentSkills];
    }

    _loadCustomAgentSkills() {
        try {
            const saved = JSON.parse(localStorage.getItem(AGENT_CUSTOM_SKILLS_STORAGE_KEY) || '[]');
            return normalizeCustomAgentSkills(saved, { reservedIds: AGENT_BUILTIN_SKILL_IDS });
        } catch (error) {
            console.warn('[AgentSidebar] Failed to load custom Skills:', error);
            return [];
        }
    }

    _saveCustomAgentSkills() {
        localStorage.setItem(
            AGENT_CUSTOM_SKILLS_STORAGE_KEY,
            JSON.stringify(this.customAgentSkills.slice(0, CUSTOM_AGENT_SKILL_LIMIT))
        );
    }

    _setAgentSkillFormStatus(message = '', state = '') {
        if (!this.agentSkillFormStatus) return;
        this.agentSkillFormStatus.textContent = message;
        this.agentSkillFormStatus.dataset.state = state;
    }

    _setAgentSkillFormOpen(open) {
        if (!this.agentSkillForm || !this.agentSkillPopover) return;
        this.agentSkillForm.hidden = !open;
        this.agentSkillPopover.classList.toggle('is-creating', open);
        this.agentSkillAddBtn?.setAttribute('aria-expanded', String(open));
        if (!open) return;
        this.agentSkillForm.reset();
        if (this.agentSkillFormCategory) this.agentSkillFormCategory.value = 'creative';
        this._setAgentSkillFormStatus();
        requestAnimationFrame(() => this.agentSkillFormName?.focus());
    }

    _createCustomAgentSkillFromForm() {
        try {
            if (this.customAgentSkills.length >= CUSTOM_AGENT_SKILL_LIMIT) {
                throw new Error(`最多可新增 ${CUSTOM_AGENT_SKILL_LIMIT} 个自定义 Skill`);
            }
            const skill = createCustomAgentSkill({
                name: this.agentSkillFormName?.value,
                category: this.agentSkillFormCategory?.value,
                description: this.agentSkillFormDescription?.value,
                instruction: this.agentSkillFormInstruction?.value
            }, { existingSkills: this._agentSkills() });
            this.customAgentSkills.push(skill);
            this._saveCustomAgentSkills();
            this.globalConfig.agentSkillIds = [...new Set([...this._selectedAgentSkillIds(), skill.id])];
            this._saveConfig();
            this.agentSkillCategory = 'all';
            if (this.agentSkillSearchInput) this.agentSkillSearchInput.value = '';
            this._setAgentSkillFormOpen(false);
            this._renderAgentSkillList();
            return true;
        } catch (error) {
            this._setAgentSkillFormStatus(error?.message || String(error), 'error');
            return false;
        }
    }

    _deleteCustomAgentSkill(skillId) {
        const skill = this.customAgentSkills.find(entry => entry.id === skillId);
        if (!skill) return false;
        if (!window.confirm(`删除自定义 Skill“${skill.name}”？`)) return false;
        this.customAgentSkills = removeCustomAgentSkill(this.customAgentSkills, skillId);
        this._saveCustomAgentSkills();
        this.globalConfig.agentSkillIds = this._selectedAgentSkillIds().filter(id => id !== skillId);
        this._saveConfig();
        this._renderAgentSkillList();
        return true;
    }

    _renderAgentSkillList() {
        if (!this.agentSkillList) return;
        const selectedIds = new Set(this._selectedAgentSkillIds());
        const keyword = String(this.agentSkillSearchInput?.value || '').trim().toLowerCase();
        const category = this.agentSkillCategory;
        const skills = this._agentSkills().filter(skill => {
            const matchesCategory = category === 'all' || skill.category === category;
            const searchable = `${skill.name} ${skill.description}`.toLowerCase();
            return matchesCategory && (!keyword || searchable.includes(keyword));
        });

        this.agentSkillTabs?.querySelectorAll('[data-agent-skill-category]').forEach(button => {
            const selected = button.dataset.agentSkillCategory === category;
            button.classList.toggle('active', selected);
            button.setAttribute('aria-selected', String(selected));
        });
        if (this.agentSkillCount) {
            this.agentSkillCount.textContent = String(selectedIds.size);
            this.agentSkillCount.hidden = selectedIds.size === 0;
        }
        if (this.agentSkillClearBtn) this.agentSkillClearBtn.disabled = selectedIds.size === 0;

        this.agentSkillList.innerHTML = '';
        if (skills.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'agent-composer-empty';
            const title = document.createElement('strong');
            title.textContent = '没有匹配的 Skill';
            const detail = document.createElement('span');
            detail.textContent = '换一个关键词或分类。';
            empty.append(title, detail);
            this.agentSkillList.appendChild(empty);
            return;
        }

        skills.forEach(skill => {
            const selected = selectedIds.has(skill.id);
            const row = document.createElement('div');
            row.className = 'agent-skill-list-row';
            row.classList.toggle('is-custom', skill.custom === true);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'agent-composer-list-item agent-skill-list-item';
            button.classList.toggle('selected', selected);
            button.dataset.agentSkillId = skill.id;
            button.setAttribute('aria-pressed', String(selected));
            const icon = document.createElement('span');
            icon.className = 'agent-composer-list-icon';
            icon.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-skill"></use></svg>';
            const copy = document.createElement('span');
            copy.className = 'agent-composer-list-copy';
            const name = document.createElement('strong');
            name.textContent = skill.name;
            const meta = document.createElement('small');
            meta.textContent = skill.description;
            copy.append(name, meta);
            const check = document.createElement('span');
            check.className = 'agent-composer-list-check';
            check.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-check"></use></svg>';
            button.append(icon, copy, check);
            row.appendChild(button);
            if (skill.custom) {
                const deleteButton = document.createElement('button');
                deleteButton.type = 'button';
                deleteButton.className = 'agent-skill-delete-btn';
                deleteButton.dataset.deleteAgentSkill = skill.id;
                deleteButton.title = `删除 ${skill.name}`;
                deleteButton.setAttribute('aria-label', `删除自定义 Skill ${skill.name}`);
                deleteButton.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-trash"></use></svg>';
                row.appendChild(deleteButton);
            }
            this.agentSkillList.appendChild(row);
        });
    }

    _toggleAgentSkill(skillId) {
        if (!this._agentSkills().some(skill => skill.id === skillId)) return;
        const selectedIds = new Set(this._selectedAgentSkillIds());
        if (selectedIds.has(skillId)) selectedIds.delete(skillId);
        else selectedIds.add(skillId);
        this.globalConfig.agentSkillIds = [...selectedIds];
        this._saveConfig();
        this._renderAgentSkillList();
    }

    _renderAgentExecutionMode() {
        const mode = this.globalConfig.agentExecutionMode === 'ask' ? 'ask' : 'auto';
        if (this.agentExecutionModeLabel) this.agentExecutionModeLabel.textContent = mode === 'ask' ? '询问' : '自动';
        this.agentExecutionPopover?.querySelectorAll('[data-agent-execution-mode]').forEach(button => {
            const selected = button.dataset.agentExecutionMode === mode;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
    }

    _setAgentExecutionMode(mode) {
        this.globalConfig.agentExecutionMode = mode === 'ask' ? 'ask' : 'auto';
        this._saveConfig();
        this._renderAgentExecutionMode();
        this._closeAgentComposerPopovers();
        this.inputEl?.focus();
    }

    _agentBoardContext() {
        try {
            return this.options.getPlanningContext?.() || null;
        } catch (error) {
            console.warn('[AgentSidebar] Failed to read planning context:', error);
            return null;
        }
    }

    _agentSystemPrompt() {
        const context = this._agentBoardContext();
        const serialized = context ? JSON.stringify(context) : '{}';
        const executionInstruction = this.globalConfig.agentExecutionMode === 'ask'
            ? '当前为“询问”模式。涉及应用规划、批量修改或改变画板结构时，先提出一个明确的确认问题；用户确认前不要输出可应用的 JSON 规划。'
            : '当前为“自动”模式。可以直接完成分析并返回可应用的规划结果，但不要声称已经执行用户尚未触发的操作。';
        const skillInstructions = this._activeAgentSkills().map(skill => `${skill.name}：${skill.instruction}`);
        return [
            '你是 Flow Canvas 的 AI Agent。回答要直接、可执行，并以当前画板数据为准。',
            '你可以读取当前项目的规划表、文件夹组和用户选中的素材。不要声称看不到已经出现在上下文中的内容。',
            '当用户要求补全规划表时，最后输出一个 JSON 数组；每项可使用 stage、title、role、content、assets、output、status、notes 字段。',
            executionInstruction,
            ...(skillInstructions.length > 0 ? [`已启用 Skill：\n${skillInstructions.join('\n')}`] : []),
            `当前画板上下文：${serialized.slice(0, 24000)}`
        ].join('\n\n');
    }

    _extractAgentPlanRows(content) {
        const text = String(content || '');
        const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1]);
        candidates.push(text);
        for (const candidate of candidates) {
            const start = candidate.indexOf('[');
            const end = candidate.lastIndexOf(']');
            if (start < 0 || end <= start) continue;
            try {
                const rows = JSON.parse(candidate.slice(start, end + 1));
                if (Array.isArray(rows) && rows.length > 0) return rows;
            } catch (_) { }
        }
        return null;
    }

    _attachAgentPlanAction(messageElement, content) {
        const rows = this._extractAgentPlanRows(content);
        if (!messageElement || !rows || !this.options.applyPlanSuggestion) return;
        const actions = document.createElement('div');
        actions.className = 'agent-msg-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-apply-plan-btn';
        button.textContent = '应用到规划表';
        button.addEventListener('click', () => {
            const applied = this.options.applyPlanSuggestion(rows);
            button.textContent = applied ? '已应用' : '应用失败';
            button.disabled = true;
        });
        actions.appendChild(button);
        (messageElement.querySelector('.agent-msg-body') || messageElement).appendChild(actions);
    }

    _agentImageSkillInstructions() {
        return this._activeAgentSkills().map(skill => `${skill.name}：${skill.instruction}`);
    }

    _connectAgentRuntime() {
        const api = window.flowCanvas?.agent;
        if (!api?.start) return;
        if (!this.runtimeClient || this.runtimeClient.closed) {
            const previousRuns = this.runtimeClient?.runs;
            this.runtimeClient = new AgentRuntimeClient(api, {
                onChange: run => this._onAgentRuntimeChange(run),
                onSync: scope => {
                    if (this.runtimeSyncError && this._isActiveConversation(this._projectCacheKey(scope.projectId), scope.conversationId)) {
                        this.runtimeSyncError = '';
                        this._renderAgentRuntimeCards();
                    }
                },
                onError: (error, scope) => {
                    console.warn('[AgentRuntime] Sync failed:', error);
                    if (!scope || this._isActiveConversation(this._projectCacheKey(scope.projectId), scope.conversationId)) {
                        this.runtimeSyncError = '运行状态同步失败，正在重试';
                        this._renderAgentRuntimeCards();
                    }
                }
            });
            if (previousRuns) this.runtimeClient.runs = previousRuns;
            this.runtimeClient.connect();
        }
        this._watchAgentRuntime();
    }

    _watchAgentRuntime() {
        this.runtimeSyncError = '';
        this._syncAgentRuntimeSendState();
        this._renderAgentRuntimeCards();
        if (this.runtimeClient && !this.runtimeClient.closed) {
            void this.runtimeClient.watch({
                projectId: this.activeRuntimeProjectId
            });
        }
    }

    _syncAgentRuntimeSendState() {
        if (window.flowCanvas?.agent?.start && this.sendBtn) {
            const activeRuns = [...(this.runtimeClient?.runs.values() || [])].some(run =>
                this._isActiveConversation(this._projectCacheKey(run.projectId), run.conversationId)
                && !isRuntimeTerminal(run.status));
            this.sendBtn.disabled = this.runtimeStarting.has(this._activeConversationCacheKey()) || activeRuns;
        }
    }

    _onAgentRuntimeChange(run) {
        if (!run) return;
        const key = this._projectCacheKey(run.projectId);
        const store = this._loadAgentConversationStore();
        let project = store[key];
        if (run.external && !project?.conversations?.some(entry => entry.id === run.conversationId)) {
            project ||= { conversations: [], activeConversationId: run.conversationId };
            project.conversations.push(createAgentConversation({ id: run.conversationId, title: '外部助手任务', customTitle: true }));
            this._saveAgentConversationProject(key, project, store);
            if (key === this.activeProjectCacheKey) this._renderAgentConversationHeader();
        }
        const index = project?.conversations?.findIndex(entry => entry.id === run.conversationId) ?? -1;
        let changed = false;
        if (index >= 0) {
            const previous = project.conversations[index];
            let next = settleRuntimeConversation(previous, run);
            if (isRuntimeTerminal(run.status) && !previous.runtimeReceipts?.[run.id]?.ignored) {
                const files = mergeAgentConversationFiles(previous.files, runtimeOutputFiles(run), 'output');
                if (JSON.stringify(files) !== JSON.stringify(previous.files || [])) next = { ...next, files };
            }
            if (next !== previous) {
                next.messages = this._normalizeAgentMessages(next.messages);
                next.updatedAt = Date.now();
                project.conversations[index] = next;
                changed = this._saveAgentConversationProject(key, project, store);
                if (changed && this._isActiveConversation(key, run.conversationId)) {
                    this.messages = next.messages;
                    this.conversationFiles = next.files;
                    this._renderAgentConversationHeader();
                }
            }
        }
        if (this._isActiveConversation(key, run.conversationId)) {
            this.runtimeSyncError = '';
            if (changed) this._renderAgentMessages();
            else this._renderAgentRuntimeCards();
            this._syncAgentRuntimeSendState();
        } else if (key === this.activeProjectCacheKey) this._renderAgentRuntimeCards();
    }

    _renderAgentRuntimeCards() {
        if (!this.messagesEl || !this.runtimeCards) return;
        this.messagesEl.querySelector('.agent-runtime-external-notice')?.remove();
        const externalPending = [...(this.runtimeClient?.runs.values() || [])].find(run => run.external
            && this._projectCacheKey(run.projectId) === this.activeProjectCacheKey
            && run.conversationId !== this.activeConversationId && run.status === 'awaiting_confirmation');
        if (externalPending) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'agent-runtime-external-notice agent-apply-plan-btn';
            button.textContent = '查看外部助手的待确认任务';
            button.addEventListener('click', () => this._switchAgentConversation(externalPending.conversationId));
            this.messagesEl.prepend(button);
        }
        const conversation = this._loadAgentConversationStore()[this.activeProjectCacheKey]?.conversations
            ?.find(entry => entry.id === this.activeConversationId);
        for (const run of this.runtimeClient?.runs.values() || []) {
            if (!this._isActiveConversation(this._projectCacheKey(run.projectId), run.conversationId)
                || conversation?.runtimeReceipts?.[run.id]?.ignored) continue;
            let card = this.runtimeCards.get(run.id);
            if (!card) {
                card = createRuntimeCard({
                    onAction: (runId, action, instruction) => this.runtimeClient.act(runId, action, instruction),
                    onLocate: window.flowCanvas?.shell?.showInExplorer
                        ? file => window.flowCanvas.shell.showInExplorer(file.filePath)
                        : null
                });
                this.runtimeCards.set(run.id, card);
                this.messagesEl.querySelector('.agent-welcome')?.remove();
                const anchor = [...this.messagesEl.querySelectorAll('[data-runtime-message-id]')]
                    .find(node => node.dataset.runtimeMessageId === run.id);
                if (anchor) anchor.after(card.root);
                else this.messagesEl.append(card.root);
            }
            card.update(run, {
                busy: this.runtimeClient.actions.has(run.id),
                confirmed: this.runtimeClient.confirmedVersions.get(run.id) === run.plan?.version && run.plan?.version != null,
                saved: this.messages.some(message => message.role === 'assistant' && message.runtimeRunId === run.id)
            });
        }
        let notice = this.messagesEl.querySelector('.agent-runtime-notice');
        const noticeText = this.runtimeStartErrors.get(this._activeConversationCacheKey())
            || this.runtimeSyncError
            || (this.runtimeStarting.has(this._activeConversationCacheKey()) ? '正在提交任务' : '');
        if (noticeText) {
            if (!notice) {
                notice = document.createElement('p');
                notice.className = 'agent-runtime-notice';
                notice.setAttribute('role', 'status');
                this.messagesEl.append(notice);
            }
            notice.textContent = noticeText;
        } else notice?.remove();
    }

    async _startAgentRuntime({ text, attachments = [], source = null, clearInput = false }) {
        this._connectAgentRuntime();
        const projectKey = this.activeProjectCacheKey;
        const projectId = this.activeRuntimeProjectId;
        const conversationId = this.activeConversationId;
        const cacheKey = this._activeConversationCacheKey(projectKey, conversationId);
        const running = [...this.runtimeClient.runs.values()].some(run =>
            this._isActiveConversation(this._projectCacheKey(run.projectId), run.conversationId)
            && !isRuntimeTerminal(run.status));
        if (this.runtimeStarting.has(cacheKey) || running) return { ok: false, reason: '当前对话已有运行中的任务' };
        const provider = this._getTextProvider();
        if (!provider?.endpoint || !provider?.apiKey || !provider?.model) {
            const reason = '请先配置并选择文字 API。';
            this._appendAgentError(reason);
            return { ok: false, reason };
        }
        // Capture identity and request synchronously; the parent owns flushing and source binding.
        const requestMessages = this._normalizeAgentMessages([...this.messages, { role: 'user', content: text, createdAt: Date.now() }]);
        const selection = this.options.getSelectedCanvasEntries?.() ?? this.lastCanvasSelection ?? [];
        const request = {
            projectId, conversationId, provider: { ...provider },
            messages: requestMessages.map(({ role, content }) => ({ role, content })),
            selectedItemIds: [...new Set(selection.map(entry => entry?.id).filter(id => typeof id === 'string' && id))],
            attachments: structuredClone(attachments),
            ...(source ? { source: structuredClone(source) } : {}),
            mode: this.globalConfig.agentExecutionMode === 'ask' ? 'ask' : 'auto',
            skillInstructions: this._agentImageSkillInstructions()
        };
        this._saveAgentConversation(projectKey, requestMessages, {
            conversationId, files: this._captureAgentConversationFiles(attachments, 'input')
        });
        this.runtimeStarting.add(cacheKey);
        this.runtimeStartErrors.delete(cacheKey);
        this._renderAgentMessages();
        this._syncAgentRuntimeSendState();
        if (clearInput && this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
        }
        this.setMode('agent');
        try {
            if (await this.options.flushBoard?.() === false) {
                throw new Error('本地画板保存冲突，任务未启动。请先解决保存冲突后重试。');
            }
            const snapshot = await window.flowCanvas.agent.start(request);
            if (!snapshot?.id || snapshot.projectId !== projectId || snapshot.conversationId !== conversationId) {
                throw new Error('Runtime 返回的任务身份无效');
            }
            const store = this._loadAgentConversationStore();
            const project = store[projectKey];
            const conversation = project?.conversations?.find(entry => entry.id === conversationId);
            // Events can arrive before start resolves. Never replace the newer conversation.
            if (conversation) {
                const message = conversation.messages[requestMessages.length - 1];
                if (message?.role === 'user' && message.content === text) message.runtimeRunId = snapshot.id;
                this._saveAgentConversationProject(projectKey, project, store);
                if (this._isActiveConversation(projectKey, conversationId)) {
                    this.messages = this._normalizeAgentMessages(conversation.messages);
                }
            }
            this.runtimeClient.accept(snapshot);
            void this.runtimeClient.refresh(snapshot.id);
            this._consumePendingAgentAttachments(cacheKey, attachments, this._normalizePendingAgentSource(source));
            if (this._isActiveConversation(projectKey, conversationId)) this._renderAgentMessages();
            return { ok: true, runId: snapshot.id, run: snapshot };
        } catch (error) {
            const reason = `任务提交失败：${error?.message || error}`;
            this.runtimeStartErrors.set(cacheKey, reason);
            // No legacy retry: a failed IPC response may still have started a paid run.
            void this.runtimeClient.watch({ projectId, conversationId });
            return { ok: false, reason };
        } finally {
            this.runtimeStarting.delete(cacheKey);
            this._syncAgentRuntimeSendState();
            this._renderAgentRuntimeCards();
        }
    }

    async generateImageFromNode(details = {}, instruction = '', { fromSidebar = false } = {}) {
        const canRefreshContext = details?.nodeId && typeof this.options.getAgentNodeContext === 'function';
        const latest = canRefreshContext ? this.options.getAgentNodeContext(details.nodeId) : null;
        if (canRefreshContext && !latest) {
            const reason = '当前图片生成节点已不存在，请重新选择节点。';
            this._appendAgentError(reason);
            return { ok: false, reason };
        }
        const context = latest || details;
        const attachments = this._normalizePendingAgentAttachments(
            context?.attachments?.length ? context.attachments : this.pendingAgentAttachments
        );
        const source = this._normalizePendingAgentSource(context || this.pendingAgentSource);
        if (!source || source.nodeType !== 'image') {
            const reason = '当前 Agent 上下文没有可执行的图片生成节点。';
            this._appendAgentError(reason);
            return { ok: false, reason };
        }
        if (window.flowCanvas?.agent?.start) {
            this.pendingAgentAttachments = attachments;
            this.pendingAgentSource = source;
            this._savePendingAgentAttachments();
            this._renderPendingAgentAttachments();
            return this._startAgentRuntime({
                text: String(instruction || '').trim() || source.effectivePrompt || source.prompt || '生成图片',
                attachments,
                source: { ...context, ...source, details: context },
                clearInput: fromSidebar
            });
        }
        if (this.isAgentSending) {
            return { ok: false, reason: 'Agent 正在整理上一条请求' };
        }

        this.pendingAgentAttachments = attachments;
        this.pendingAgentSource = source;
        this._savePendingAgentAttachments();
        this._renderPendingAgentAttachments();
        this.setMode('agent');

        const provider = this._getTextProvider();
        if (!provider?.endpoint || !provider?.apiKey || !provider?.model) {
            const reason = '请先通过设置配置并选择文字 API。';
            this._appendAgentError(reason);
            return { ok: false, reason };
        }
        if (!window.flowCanvas?.ai?.generateText) {
            const reason = '本地文字 AI 接口不可用，请完全退出并重新启动 Flow Canvas。';
            this._appendAgentError(reason);
            return { ok: false, reason };
        }

        const userInstruction = String(instruction || '').trim();
        const displayPrompt = userInstruction || source.effectivePrompt || source.prompt;
        const projectKey = this.activeProjectCacheKey;
        const conversationId = this.activeConversationId;
        const attachmentCacheKey = this._activeConversationCacheKey(projectKey, conversationId);
        const conversationFiles = this._captureAgentConversationFiles(attachments, 'input');
        const requestMessages = this._normalizeAgentMessages([
            ...this.messages,
            { role: 'user', content: displayPrompt, createdAt: Date.now() }
        ]);
        this.messages = requestMessages;
        this._appendAgentMessageElement('user', displayPrompt, requestMessages.at(-1));
        this._saveAgentConversation(projectKey, requestMessages, {
            conversationId,
            files: conversationFiles
        });
        if (fromSidebar && this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
        }

        const compilationMessages = buildAgentImageCompilationMessages({
            source,
            instruction: userInstruction,
            skillInstructions: this._agentImageSkillInstructions()
        });
        this.isAgentSending = true;
        if (this.sendBtn) this.sendBtn.disabled = true;
        const typing = this._appendAgentTyping();
        const startedAt = Date.now();
        let compilation;
        try {
            const result = await window.flowCanvas.ai.generateText({
                provider,
                attachments,
                attachmentContext: source,
                messages: compilationMessages,
                maxTokens: 4096,
                temperature: 0.2
            });
            if (!result?.success) throw new Error(result?.error || '文字 API 请求失败');
            compilation = parseAgentImageCompilationResponse(result.text, source.effectivePrompt || source.prompt);
            if (!compilation.prompt) throw new Error('Agent 没有返回可执行的生图提示词');
        } catch (error) {
            typing?.remove();
            const reason = `Agent 整理失败：${error?.message || error}`;
            if (this._isActiveConversation(projectKey, conversationId)) this._appendAgentError(reason);
            return { ok: false, reason };
        } finally {
            this.isAgentSending = false;
            if (this.sendBtn) this.sendBtn.disabled = false;
        }

        typing?.remove();
        const assistantContent = compilation.summary
            ? `已整理并提交生图：${compilation.summary}\n\n${compilation.prompt}`
            : `已整理并提交生图：\n\n${compilation.prompt}`;
        const completedMessages = this._normalizeAgentMessages([
            ...requestMessages,
            { role: 'assistant', content: assistantContent, createdAt: Date.now(), elapsedMs: Date.now() - startedAt }
        ]);
        if (this._isActiveConversation(projectKey, conversationId)) {
            this.messages = completedMessages;
            this._appendAgentMessageElement('assistant', assistantContent, completedMessages.at(-1));
        }
        this._saveAgentConversation(projectKey, completedMessages, {
            conversationId,
            files: conversationFiles
        });
        this._consumePendingAgentAttachments(attachmentCacheKey, attachments, source);

        try {
            const execution = await this.options.executeImageNodeFromAgent?.({
                nodeId: source.nodeId,
                prompt: compilation.prompt,
                summary: compilation.summary,
                source,
                attachments
            });
            if (!execution) throw new Error('画布没有接收 Agent 生图任务');
            if (execution.ok === false) throw new Error(execution.reason || '图片生成失败');
            const outputFiles = (Array.isArray(execution.filePaths) ? execution.filePaths : [])
                .filter(Boolean)
                .map(filePath => ({
                    mediaType: 'image',
                    filePath,
                    name: String(filePath).replace(/\\/g, '/').split('/').pop()
                }));
            if (outputFiles.length) {
                const completedFiles = this._isActiveConversation(projectKey, conversationId)
                    ? this._captureAgentConversationFiles(outputFiles, 'output')
                    : mergeAgentConversationFiles(conversationFiles, outputFiles, 'output');
                this._saveAgentConversation(projectKey, completedMessages, {
                    conversationId,
                    files: completedFiles
                });
            }
            return execution;
        } catch (error) {
            const reason = `图片生成失败：${error?.message || error}`;
            if (this._isActiveConversation(projectKey, conversationId)) this._appendAgentError(reason);
            return { ok: false, reason };
        } finally {
            if (this._isActiveConversation(projectKey, conversationId)) this.inputEl?.focus();
        }
    }

    async _sendAgentMessage(prompt = null) {
        if (prompt == null && this.pendingAgentSource?.nodeType === 'image' && this.getImageIntentPipelineMode() !== 'off') {
            const latest = this.options.getAgentNodeContext?.(this.pendingAgentSource.nodeId) || {
                ...this.pendingAgentSource,
                attachments: this.pendingAgentAttachments
            };
            return this.generateImageFromNode(latest, this.inputEl?.value || '', { fromSidebar: true });
        }
        const text = String(prompt ?? this.inputEl?.value ?? '').trim();
        if (text && window.flowCanvas?.agent?.start) {
            return this._startAgentRuntime({
                text,
                attachments: this._normalizePendingAgentAttachments(this.pendingAgentAttachments),
                source: this.pendingAgentSource,
                clearInput: true
            });
        }
        if (!text || this.isAgentSending) return;
        const projectKey = this.activeProjectCacheKey;
        const conversationId = this.activeConversationId;
        const attachmentCacheKey = this._activeConversationCacheKey(projectKey, conversationId);
        const pendingAttachments = this._normalizePendingAgentAttachments(this.pendingAgentAttachments);
        const pendingSource = this._normalizePendingAgentSource(this.pendingAgentSource);
        const provider = this._getTextProvider();
        if (!provider?.endpoint || !provider?.apiKey || !provider?.model) {
            this._appendAgentError('请先通过右上角设置配置并选择文字 API。');
            return;
        }
        if (!window.flowCanvas?.ai?.generateText) {
            this._appendAgentError('本地文字 AI 接口不可用，请完全退出并重新启动 Flow Canvas。');
            return;
        }
        const conversationFiles = this._captureAgentConversationFiles(pendingAttachments, 'input');

        const requestMessages = this._normalizeAgentMessages([
            ...this.messages,
            { role: 'user', content: text, createdAt: Date.now() }
        ]);
        this.messages = requestMessages;
        this._appendAgentMessageElement('user', text, requestMessages.at(-1));
        this._saveAgentConversation(projectKey, requestMessages, {
            conversationId,
            files: conversationFiles
        });
        if (this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
        }

        this.isAgentSending = true;
        if (this.sendBtn) this.sendBtn.disabled = true;
        const typing = this._appendAgentTyping();
        const startedAt = Date.now();
        try {
            const result = await window.flowCanvas.ai.generateText({
                provider,
                attachments: pendingAttachments,
                attachmentContext: pendingSource,
                messages: [
                    { role: 'system', content: this._agentSystemPrompt() },
                    ...requestMessages.slice(-24)
                ],
                maxTokens: 4096
            });
            if (!result?.success) throw new Error(result?.error || '文字 API 请求失败');
            const content = String(result.text || '').trim() || '模型没有返回可显示的文本。';
            const completedMessages = this._normalizeAgentMessages([
                ...requestMessages,
                { role: 'assistant', content, createdAt: Date.now(), elapsedMs: Date.now() - startedAt }
            ]);
            typing?.remove();
            if (this._isActiveConversation(projectKey, conversationId)) {
                this.messages = completedMessages;
                const messageElement = this._appendAgentMessageElement('assistant', content, completedMessages.at(-1));
                this._attachAgentPlanAction(messageElement, content);
            }
            this._saveAgentConversation(projectKey, completedMessages, {
                conversationId,
                files: conversationFiles
            });
            this._consumePendingAgentAttachments(attachmentCacheKey, pendingAttachments, pendingSource);
        } catch (error) {
            typing?.remove();
            if (this._isActiveConversation(projectKey, conversationId)) {
                this._appendAgentError(`请求失败：${error?.message || error}`);
            }
        } finally {
            this.isAgentSending = false;
            if (this.sendBtn) this.sendBtn.disabled = false;
            if (this._isActiveConversation(projectKey, conversationId)) this.inputEl?.focus();
        }
    }

    _assistAgentPlanning() {
        const context = this._agentBoardContext();
        const hasPlan = Array.isArray(context?.plans) && context.plans.length > 0;
        const prompt = hasPlan
            ? '请检查当前项目的规划表，找出缺项和不合理之处并给出可直接应用的优化版本。'
            : '请结合当前项目和选中素材，建立一份 3 到 6 行的通用创作规划表。';
        void this._sendAgentMessage(prompt);
    }

    _loadProjectComposerCache() {
        try {
            const value = JSON.parse(localStorage.getItem(PROJECT_COMPOSER_CACHE_STORAGE_KEY) || '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) {
            return {};
        }
    }

    _serializeReferenceEntries(entries = []) {
        return (Array.isArray(entries) ? entries : []).map(entry => ({
            id: entry?.id || entry?.itemId || null,
            filePath: entry?.filePath || null,
            width: Number(entry?.width) || null,
            height: Number(entry?.height) || null
        })).filter(entry => entry.id || entry.filePath);
    }

    _saveProjectComposer(key = this.activeProjectCacheKey) {
        if (this.restoringProjectComposer || !key) return;
        const cache = this._loadProjectComposerCache();
        cache[key] = {
            imagePrompt: this.imagePromptInput?.value || '',
            videoPrompt: this.videoPromptInput?.value || '',
            imageGenerationMode: this.imageGenerationMode,
            imageSettings: {
                size: this.imageSizeSelect?.value || '',
                quality: this.imageQualitySelect?.value || '',
                responseFormat: this.imageResponseFormatSelect?.value || 'url',
                historyDisabled: this.imageHistoryDisabled?.checked !== false,
                stream: Boolean(this.imageStream?.checked)
            },
            videoSettings: {
                ratio: this.videoRatioSelect?.value || '',
                ratioMode: this.videoRatioSelect?.value === 'adaptive' ? 'auto' : 'manual',
                resolution: this.videoResolutionSelect?.value || '',
                duration: this.videoDurationSelect?.value || '',
                cameraFixed: Boolean(this.videoCameraFixed?.checked),
                generateAudio: Boolean(this.videoGenerateAudio?.checked),
                webSearch: Boolean(this.videoWebSearch?.checked),
                watermark: Boolean(this.videoWatermark?.checked)
            },
            imageReferences: this._serializeReferenceEntries(this.imageReferenceSelections),
            videoReferences: Object.fromEntries(['image', 'video', 'audio'].map(type => [
                type,
                this._serializeReferenceEntries(this.videoReferenceSelections[type])
            ])),
            updatedAt: new Date().toISOString()
        };
        try {
            localStorage.setItem(PROJECT_COMPOSER_CACHE_STORAGE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.warn('[AgentSidebar] Failed to save project composer cache:', error);
        }
    }

    _scheduleProjectComposerSave() {
        if (this.restoringProjectComposer) return;
        clearTimeout(this.projectComposerSaveTimer);
        this.projectComposerSaveTimer = setTimeout(() => {
            this.projectComposerSaveTimer = null;
            this._saveProjectComposer();
        }, 180);
    }

    _restoreProjectComposerReferences(key = this.activeProjectCacheKey) {
        if (key !== this.activeProjectCacheKey) return;
        const state = this._loadProjectComposerCache()[key];
        if (!state) return;
        this.restoringProjectComposer = true;
        try {
            this.imageReferenceSelections = this.options.resolveMediaReferenceEntries?.(
                state.imageReferences,
                'image'
            ) || [];
            this.videoReferenceSelections = Object.fromEntries(['image', 'video', 'audio'].map(type => [
                type,
                this.options.resolveMediaReferenceEntries?.(state.videoReferences?.[type], type) || []
            ]));
            this.options.clearMediaReferenceSelections?.();
            this._renderImageReferences();
            this._renderVideoSourcePreview();
        } finally {
            this.restoringProjectComposer = false;
        }
    }

    _restoreProjectComposerControls(state) {
        const setSelectValue = (select, value) => {
            if (!select || value == null) return;
            if (Array.from(select.options || []).some(option => option.value === String(value))) {
                select.value = String(value);
            }
        };
        setSelectValue(this.imageSizeSelect, state?.imageSettings?.size);
        setSelectValue(this.imageQualitySelect, state?.imageSettings?.quality);
        setSelectValue(this.imageResponseFormatSelect, state?.imageSettings?.responseFormat);
        if (this.imageHistoryDisabled && state?.imageSettings?.historyDisabled != null) {
            this.imageHistoryDisabled.checked = Boolean(state.imageSettings.historyDisabled);
        }
        if (this.imageStream && state?.imageSettings?.stream != null) {
            this.imageStream.checked = Boolean(state.imageSettings.stream);
        }
        setSelectValue(this.videoResolutionSelect, state?.videoSettings?.resolution);

        const videoProfile = this._getVideoModelProfile(this._getVideoProvider()) || DEFAULT_VIDEO_MODEL_PROFILE;
        const legacyH3Ratio = videoProfile.resolveAdaptiveRatio === true && !state?.videoSettings?.ratioMode;
        const ratio = legacyH3Ratio
            ? 'adaptive'
            : String(state?.videoSettings?.ratio || '');
        if (ratio && this.videoRatioGrid?.querySelector(`[data-ratio="${CSS.escape(ratio)}"]`)) {
            this.videoRatioSelect.value = ratio;
            this.videoRatioGrid.querySelectorAll('[data-ratio]').forEach(button => {
                button.classList.toggle('active', button.dataset.ratio === ratio);
            });
        }

        const duration = String(state?.videoSettings?.duration || '');
        if (duration) {
            this._setVideoDurationValue(duration);
            const durationInput = this.videoDurationControl?.querySelector('input[type="range"], select');
            if (durationInput && Array.from(durationInput.options || []).every(option => option.value !== duration)) {
                if (durationInput.type === 'range') durationInput.value = duration;
            } else if (durationInput) {
                durationInput.value = duration;
            }
            const output = this.videoDurationControl?.querySelector('output');
            if (output) output.textContent = `${duration} 秒`;
        }

        [
            [this.videoCameraFixed, state?.videoSettings?.cameraFixed],
            [this.videoGenerateAudio, state?.videoSettings?.generateAudio],
            [this.videoWebSearch, state?.videoSettings?.webSearch],
            [this.videoWatermark, state?.videoSettings?.watermark]
        ].forEach(([input, checked]) => {
            if (input && checked != null && !input.closest('.creation-switch-control')?.hidden) {
                input.checked = Boolean(checked);
            }
        });
    }

    switchProjectContext(projectId, { saveCurrent = true } = {}) {
        const nextKey = this._projectCacheKey(projectId);
        clearTimeout(this.projectComposerSaveTimer);
        this.projectComposerSaveTimer = null;
        if (saveCurrent) {
            this._saveProjectComposer(this.activeProjectCacheKey);
            this._saveAgentConversation(this.activeProjectCacheKey);
            this._savePendingAgentAttachments();
        }
        this.options.endMediaReferencePick?.({ silent: true, clearHighlights: true });
        this.activeProjectCacheKey = nextKey;
        this.activeRuntimeProjectId = projectId ?? null;
        this._restoreAgentConversation(nextKey);
        this._restorePendingAgentAttachments();

        const state = this._loadProjectComposerCache()[nextKey] || null;
        this.restoringProjectComposer = true;
        try {
            if (this.imagePromptInput) this.imagePromptInput.value = state?.imagePrompt || '';
            if (this.videoPromptInput) this.videoPromptInput.value = state?.videoPrompt || '';
            this.imageGenerationMode = state?.imageGenerationMode === 'reference' ? 'reference' : 'text';
            this.imageReferenceSelections = [];
            this.videoReferenceSelections = { image: [], video: [], audio: [] };
            this.options.clearMediaReferenceSelections?.();
            this._renderImageReferences();
            this._renderVideoSourcePreview();
            this._restoreProjectComposerControls(state);
        } finally {
            this.restoringProjectComposer = false;
        }
        this._restoreProjectComposerReferences(nextKey);
        ['image', 'video'].forEach(kind => {
            this.selectedPromptPresetIds[kind] = '';
            const controls = this._promptPresetControls(kind);
            if (controls.nameInput) controls.nameInput.value = '';
            this._setPromptPresetStatus(kind, '');
            this._renderPromptPresets(kind);
        });
    }

    _promptPresetControls(kind) {
        if (kind === 'video') {
            return {
                promptInput: this.videoPromptInput,
                select: this.videoPromptPresetSelect,
                nameInput: this.videoPromptPresetName,
                saveButton: this.videoPromptPresetSave,
                deleteButton: this.videoPromptPresetDelete,
                count: this.videoPromptPresetCount,
                status: this.videoPromptPresetStatus
            };
        }
        return {
            promptInput: this.imagePromptInput,
            select: this.imagePromptPresetSelect,
            nameInput: this.imagePromptPresetName,
            saveButton: this.imagePromptPresetSave,
            deleteButton: this.imagePromptPresetDelete,
            count: this.imagePromptPresetCount,
            status: this.imagePromptPresetStatus
        };
    }

    _loadPromptPresetStore() {
        try {
            const value = JSON.parse(localStorage.getItem(PROMPT_PRESETS_STORAGE_KEY) || '{}');
            return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        } catch (_) {
            return {};
        }
    }

    _getPromptPresets(kind) {
        const store = this._loadPromptPresetStore();
        const presets = store?.[this.activeProjectCacheKey]?.[kind];
        if (!Array.isArray(presets)) return [];
        return presets
            .filter(preset => preset && preset.id && preset.name && typeof preset.prompt === 'string')
            .slice(0, PROMPT_PRESET_LIMIT);
    }

    _storePromptPresets(kind, presets) {
        const store = this._loadPromptPresetStore();
        const projectStore = store[this.activeProjectCacheKey]
            && typeof store[this.activeProjectCacheKey] === 'object'
            ? store[this.activeProjectCacheKey]
            : {};
        projectStore[kind] = presets.slice(0, PROMPT_PRESET_LIMIT);
        store[this.activeProjectCacheKey] = projectStore;
        localStorage.setItem(PROMPT_PRESETS_STORAGE_KEY, JSON.stringify(store));
    }

    getPromptPresets(kind) {
        const normalizedKind = kind === 'video' ? 'video' : 'image';
        return this._getPromptPresets(normalizedKind)
            .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
            .map(preset => ({ ...preset }));
    }

    savePromptPreset(kind, value = {}) {
        const normalizedKind = kind === 'video' ? 'video' : 'image';
        const name = String(value.name || '').trim();
        const prompt = String(value.prompt || '').trim();
        if (!name) throw new Error('请填写预设名称');
        if (!prompt) throw new Error('当前提示词为空');

        const presets = this._getPromptPresets(normalizedKind);
        const requestedId = String(value.id || '').trim();
        let index = requestedId ? presets.findIndex(preset => preset.id === requestedId) : -1;
        if (index < 0) {
            index = presets.findIndex(preset => preset.name.trim().toLowerCase() === name.toLowerCase());
        }
        const now = new Date().toISOString();
        const previous = index >= 0 ? presets.splice(index, 1)[0] : null;
        const preset = {
            id: previous?.id || globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            prompt,
            createdAt: previous?.createdAt || now,
            updatedAt: now
        };
        presets.unshift(preset);
        this._storePromptPresets(normalizedKind, presets);
        this.selectedPromptPresetIds[normalizedKind] = preset.id;
        this._renderPromptPresets(normalizedKind);
        return { ...preset };
    }

    deletePromptPreset(kind, presetId) {
        const normalizedKind = kind === 'video' ? 'video' : 'image';
        const requestedId = String(presetId || '').trim();
        if (!requestedId) return false;
        const presets = this._getPromptPresets(normalizedKind);
        if (!presets.some(preset => preset.id === requestedId)) return false;
        this._storePromptPresets(
            normalizedKind,
            presets.filter(preset => preset.id !== requestedId)
        );
        if (this.selectedPromptPresetIds[normalizedKind] === requestedId) {
            this.selectedPromptPresetIds[normalizedKind] = '';
        }
        this._renderPromptPresets(normalizedKind);
        return true;
    }

    _setPromptPresetStatus(kind, message, state = '') {
        const status = this._promptPresetControls(kind).status;
        if (!status) return;
        status.textContent = message || '';
        status.dataset.state = state || '';
    }

    _renderPromptPresets(kind) {
        const controls = this._promptPresetControls(kind);
        if (!controls.select) return;
        const presets = this._getPromptPresets(kind)
            .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
        const selectedId = this.selectedPromptPresetIds[kind];
        controls.select.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = presets.length > 0 ? '新建或选择预设提示词' : '暂无预设，填写名称后保存';
        controls.select.appendChild(placeholder);
        presets.forEach(preset => {
            const option = document.createElement('option');
            option.value = preset.id;
            option.textContent = preset.name;
            controls.select.appendChild(option);
        });
        const hasSelectedPreset = presets.some(preset => preset.id === selectedId);
        controls.select.value = hasSelectedPreset ? selectedId : '';
        if (!hasSelectedPreset) this.selectedPromptPresetIds[kind] = '';
        if (controls.count) controls.count.textContent = String(presets.length);
        if (controls.deleteButton) controls.deleteButton.disabled = !hasSelectedPreset;
        const saveLabel = controls.saveButton?.querySelector('span');
        if (saveLabel) saveLabel.textContent = hasSelectedPreset ? '更新预设' : '保存预设';
    }

    _selectPromptPreset(kind, presetId) {
        const controls = this._promptPresetControls(kind);
        const preset = this._getPromptPresets(kind).find(entry => entry.id === presetId);
        this.selectedPromptPresetIds[kind] = preset?.id || '';
        if (!preset) {
            if (controls.nameInput) controls.nameInput.value = '';
            this._setPromptPresetStatus(kind, '填写名称，将当前提示词保存为新预设');
            this._renderPromptPresets(kind);
            return;
        }
        if (controls.promptInput) controls.promptInput.value = preset.prompt;
        if (controls.nameInput) controls.nameInput.value = preset.name;
        this._scheduleProjectComposerSave();
        this._setPromptPresetStatus(kind, `已写入“${preset.name}”`, 'success');
        this._renderPromptPresets(kind);
    }

    _savePromptPreset(kind) {
        const controls = this._promptPresetControls(kind);
        const name = String(controls.nameInput?.value || '').trim();
        const prompt = String(controls.promptInput?.value || '').trim();
        if (!name) {
            this._setPromptPresetStatus(kind, '请先填写预设名称', 'error');
            controls.nameInput?.focus();
            return;
        }
        if (!prompt) {
            this._setPromptPresetStatus(kind, '当前提示词为空，无法保存', 'error');
            controls.promptInput?.focus();
            return;
        }

        const now = new Date().toISOString();
        const presets = this._getPromptPresets(kind);
        const selectedId = this.selectedPromptPresetIds[kind];
        let index = selectedId ? presets.findIndex(preset => preset.id === selectedId) : -1;
        if (index < 0) {
            index = presets.findIndex(preset => preset.name.trim().toLowerCase() === name.toLowerCase());
        }
        let preset;
        let action;
        if (index >= 0) {
            preset = { ...presets[index], name, prompt, updatedAt: now };
            presets.splice(index, 1);
            action = '已更新';
        } else {
            preset = {
                id: globalThis.crypto?.randomUUID?.() || `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name,
                prompt,
                createdAt: now,
                updatedAt: now
            };
            action = '已保存';
        }
        presets.unshift(preset);
        try {
            this._storePromptPresets(kind, presets);
        } catch (error) {
            console.warn('[AgentSidebar] Failed to save prompt preset:', error);
            this._setPromptPresetStatus(kind, '保存失败，本地存储空间可能已满', 'error');
            return;
        }
        this.selectedPromptPresetIds[kind] = preset.id;
        this._renderPromptPresets(kind);
        this._setPromptPresetStatus(kind, `${action}“${preset.name}”`, 'success');
    }

    _deletePromptPreset(kind) {
        const presetId = this.selectedPromptPresetIds[kind];
        if (!presetId) return;
        const presets = this._getPromptPresets(kind);
        const preset = presets.find(entry => entry.id === presetId);
        try {
            this._storePromptPresets(kind, presets.filter(entry => entry.id !== presetId));
        } catch (error) {
            console.warn('[AgentSidebar] Failed to delete prompt preset:', error);
            this._setPromptPresetStatus(kind, '删除失败，请稍后重试', 'error');
            return;
        }
        this.selectedPromptPresetIds[kind] = '';
        const controls = this._promptPresetControls(kind);
        if (controls.nameInput) controls.nameInput.value = '';
        this._renderPromptPresets(kind);
        this._setPromptPresetStatus(kind, preset ? `已删除“${preset.name}”` : '预设已删除', 'success');
    }

    _setSettingsTab(tab = 'shortcuts') {
        const nextTab = ['shortcuts', 'creation', 'api'].includes(tab) ? tab : 'shortcuts';
        if (this.recordingShortcutAction) this._cancelShortcutCapture();
        this.activeSettingsTab = nextTab;
        this.settingsTabs?.querySelectorAll('[data-settings-tab]').forEach(button => {
            const active = button.dataset.settingsTab === nextTab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        });
        if (this.shortcutSettingsPane) this.shortcutSettingsPane.hidden = nextTab !== 'shortcuts';
        if (this.creationSettingsPane) this.creationSettingsPane.hidden = nextTab !== 'creation';
        if (this.apiSettingsPane) this.apiSettingsPane.hidden = nextTab !== 'api';
    }

    _setAssetLibraryFolderStatus(message = '', state = '') {
        if (!this.assetLibraryFolderStatus) return;
        this.assetLibraryFolderStatus.textContent = message;
        this.assetLibraryFolderStatus.dataset.state = state;
    }

    _renderAssetLibrarySettings() {
        const select = this.assetLibraryFolderSelect;
        if (!select) return;
        const settings = this.options.getAssetLibrarySettings?.() || {};
        const folders = Array.isArray(settings.folders) ? settings.folders.filter(Boolean) : [];
        const managedFolder = String(settings.managedFolder || '');
        const defaultFolder = String(settings.defaultFolder || '');

        select.replaceChildren();
        if (folders.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无素材库目录';
            select.appendChild(option);
            select.disabled = true;
            select.title = '';
            return;
        }

        folders.forEach(folder => {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = folder === managedFolder ? `Flow Canvas 管理目录 - ${folder}` : folder;
            select.appendChild(option);
        });
        const selectedFolder = folders.includes(defaultFolder) ? defaultFolder : folders[0];
        select.value = selectedFolder;
        select.disabled = false;
        select.title = selectedFolder;
    }

    async _chooseAssetLibraryFolder() {
        if (!this.options.chooseAssetLibraryFolder || !this.assetLibraryFolderChoose) return;
        this.assetLibraryFolderChoose.disabled = true;
        this.assetLibraryFolderChoose.setAttribute('aria-busy', 'true');
        try {
            const folderPath = await this.options.chooseAssetLibraryFolder();
            this._renderAssetLibrarySettings();
            if (folderPath) this._setAssetLibraryFolderStatus('素材库目录已更新', 'success');
        } catch (error) {
            console.warn('[AgentSidebar] Failed to choose asset library folder:', error);
            this._setAssetLibraryFolderStatus('目录设置失败', 'error');
        } finally {
            this.assetLibraryFolderChoose.disabled = false;
            this.assetLibraryFolderChoose.removeAttribute('aria-busy');
        }
    }

    async _setDefaultAssetLibraryFolder(folderPath) {
        if (!folderPath || !this.options.setDefaultAssetLibraryFolder) return;
        try {
            const updated = await this.options.setDefaultAssetLibraryFolder(folderPath);
            this._renderAssetLibrarySettings();
            this._setAssetLibraryFolderStatus(updated === false ? '目录设置失败' : '默认目录已更新', updated === false ? 'error' : 'success');
        } catch (error) {
            console.warn('[AgentSidebar] Failed to set default asset library folder:', error);
            this._setAssetLibraryFolderStatus('目录设置失败', 'error');
        }
    }

    _setShortcutStatus(message = '', state = '') {
        if (!this.shortcutStatus) return;
        this.shortcutStatus.textContent = message;
        if (state) this.shortcutStatus.dataset.state = state;
        else delete this.shortcutStatus.dataset.state;
    }

    _renderShortcutSettings() {
        if (!this.shortcutList) return;
        const fragment = document.createDocumentFragment();
        SHORTCUT_DEFINITIONS.forEach(definition => {
            const row = document.createElement('div');
            row.className = 'agent-shortcut-row';

            const copy = document.createElement('div');
            copy.className = 'agent-shortcut-copy';
            const label = document.createElement('strong');
            label.textContent = definition.label;
            const description = document.createElement('span');
            description.textContent = definition.description;
            copy.append(label, description);

            const button = document.createElement('button');
            button.className = 'agent-shortcut-binding';
            button.type = 'button';
            button.dataset.shortcutAction = definition.action;
            button.setAttribute('aria-label', `修改${definition.label}快捷键`);
            button.title = '点击后按下新的快捷键';
            const binding = document.createElement('kbd');
            binding.textContent = this.recordingShortcutAction === definition.action
                ? '请按键…'
                : formatShortcut(this.shortcutBindings[definition.action], window.flowCanvas?.platform);
            button.classList.toggle('recording', this.recordingShortcutAction === definition.action);
            button.appendChild(binding);

            row.append(copy, button);
            fragment.appendChild(row);
        });
        this.shortcutList.replaceChildren(fragment);

        document.querySelectorAll('.context-menu-shortcut[data-shortcut-action]').forEach(element => {
            const binding = this.shortcutBindings[element.dataset.shortcutAction];
            if (binding) element.textContent = formatShortcut(binding, window.flowCanvas?.platform);
        });
    }

    _startShortcutCapture(action) {
        if (!SHORTCUT_DEFINITIONS.some(definition => definition.action === action)) return;
        this.recordingShortcutAction = action;
        this._renderShortcutSettings();
        this._setShortcutStatus('请按下新的快捷键，按 Esc 取消', 'recording');
    }

    _cancelShortcutCapture(message = '') {
        if (!this.recordingShortcutAction) return;
        this.recordingShortcutAction = null;
        this._renderShortcutSettings();
        this._setShortcutStatus(message);
    }

    _persistShortcutBindings(message) {
        try {
            this.shortcutBindings = saveShortcutBindings(this.shortcutBindings);
            document.dispatchEvent(new CustomEvent(SHORTCUTS_CHANGED_EVENT, {
                detail: { ...this.shortcutBindings }
            }));
            this._renderShortcutSettings();
            this._setShortcutStatus(message, 'success');
        } catch (error) {
            console.warn('[AgentSidebar] Failed to save shortcuts:', error);
            this._setShortcutStatus('快捷键保存失败，请检查本地存储权限', 'error');
        }
    }

    _captureShortcut(event) {
        const action = this.recordingShortcutAction;
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();

        if (event.key === 'Escape') {
            this._cancelShortcutCapture('已取消修改');
            return;
        }
        const binding = shortcutFromKeyboardEvent(event);
        if (!binding) return;

        const reserved = RESERVED_SHORTCUTS.find(entry => normalizeShortcut(entry.binding) === binding);
        if (reserved) {
            this._setShortcutStatus(`${formatShortcut(binding, window.flowCanvas?.platform)} 已用于${reserved.label}`, 'error');
            return;
        }
        const conflictAction = Object.keys(this.shortcutBindings)
            .find(candidate => candidate !== action && this.shortcutBindings[candidate] === binding);
        if (conflictAction) {
            const conflict = SHORTCUT_DEFINITIONS.find(definition => definition.action === conflictAction);
            this._setShortcutStatus(`${formatShortcut(binding, window.flowCanvas?.platform)} 已用于${conflict?.label || '其他操作'}`, 'error');
            return;
        }

        const definition = SHORTCUT_DEFINITIONS.find(candidate => candidate.action === action);
        this.shortcutBindings[action] = binding;
        this.recordingShortcutAction = null;
        this._persistShortcutBindings(`已更新${definition?.label || '快捷键'}`);
    }

    _resetShortcutBindings() {
        this.recordingShortcutAction = null;
        this.shortcutBindings = { ...DEFAULT_SHORTCUTS };
        this._persistShortcutBindings('已恢复默认快捷键');
    }

    _bindAgentSidebarResize() {
        const handle = document.getElementById('agentSidebarResizeHandle');
        const panel = document.getElementById('agentSidebar');
        if (!handle || !panel) return;
        const storageKey = 'flow-canvas-agent-panel-width';
        let preferredWidth = 420;
        try {
            const saved = Number(localStorage.getItem(storageKey));
            if (Number.isFinite(saved) && saved >= 320) preferredWidth = Math.min(saved, 960);
        } catch (_) { }
        const bounds = () => {
            const viewport = window.innerWidth;
            const leftWidth = document.getElementById('sidebarWrapper')?.getBoundingClientRect().width || 0;
            const min = Math.min(320, viewport);
            const max = viewport <= 520 ? viewport : Math.max(min, Math.min(960, viewport - leftWidth - 240));
            return { min, max };
        };
        const apply = width => {
            const { min, max } = bounds();
            const value = Math.round(Math.max(min, Math.min(max, width)));
            document.body.style.setProperty('--agent-panel-width', `${value}px`);
            handle.setAttribute('aria-valuemin', String(min));
            handle.setAttribute('aria-valuemax', String(max));
            handle.setAttribute('aria-valuenow', String(value));
            return value;
        };
        const save = () => {
            try { localStorage.setItem(storageKey, String(preferredWidth)); } catch (_) { }
        };
        let drag = null;
        let frame = null;
        const renderDrag = () => {
            frame = null;
            if (drag) preferredWidth = apply(drag.width + drag.x - drag.latestX);
        };
        const finish = () => {
            if (!drag) return;
            if (frame !== null) cancelAnimationFrame(frame);
            renderDrag();
            const pointerId = drag.pointerId;
            drag = null;
            document.body.classList.remove('agent-sidebar-resizing');
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
            save();
        };
        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || drag || this.currentMode !== 'agent') return;
            event.preventDefault();
            event.stopPropagation();
            drag = { pointerId: event.pointerId, x: event.clientX, latestX: event.clientX, width: panel.getBoundingClientRect().width };
            handle.setPointerCapture(event.pointerId);
            document.body.classList.add('agent-sidebar-resizing');
        });
        handle.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) return;
            drag.latestX = event.clientX;
            if (frame === null) frame = requestAnimationFrame(renderDrag);
        });
        for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(eventName, finish);
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            preferredWidth = 420;
            apply(preferredWidth);
            save();
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
            event.preventDefault();
            preferredWidth = event.key === 'Home' ? 420
                : Number(handle.getAttribute('aria-valuenow')) + (event.key === 'ArrowLeft' ? 24 : -24);
            preferredWidth = apply(preferredWidth);
            save();
        });
        window.addEventListener('resize', () => apply(preferredWidth));
        window.addEventListener('blur', finish);
        window.addEventListener('pagehide', finish);
        this._finishAgentSidebarResize = finish;
        const leftSidebar = document.getElementById('sidebarWrapper');
        if (leftSidebar) {
            this.agentSidebarWidthObserver = new ResizeObserver(() => apply(preferredWidth));
            this.agentSidebarWidthObserver.observe(leftSidebar);
        }
        apply(preferredWidth);
    }

    _bindEvents() {
        // 主 HUD：左键打开 Agent，右键把主窗口收进置顶浮动按钮。
        const toggleBtn = document.getElementById('agentToggleBtn');
        let collapsingToOrb = false;
        const collapseToOrb = async () => {
            if (collapsingToOrb) return;
            collapsingToOrb = true;
            toggleBtn.classList.add('activating');
            toggleBtn.setAttribute('aria-busy', 'true');

            try {
                await new Promise(resolve => setTimeout(resolve, 140));
                await window.flowCanvas?.win?.collapseToOrb?.();
            } catch (err) {
                console.error('[AgentSidebar] Failed to collapse window:', err);
            } finally {
                toggleBtn.classList.remove('activating');
                toggleBtn.removeAttribute('aria-busy');
                collapsingToOrb = false;
            }
        };
        toggleBtn?.addEventListener('click', event => {
            if (event.button !== 0) return;
            if (document.body.classList.contains('agent-open')) {
                if (this.currentMode === 'settings') {
                    this.setMode('canvas');
                    return;
                }
                this.close();
                return;
            }
            this.setMode('agent');
        });
        toggleBtn?.addEventListener('contextmenu', event => {
            event.preventDefault();
            void collapseToOrb();
        });
        this.settingsTabs?.addEventListener('click', event => {
            const button = event.target.closest('[data-settings-tab]');
            if (button) this._setSettingsTab(button.dataset.settingsTab);
        });
        this.shortcutList?.addEventListener('click', event => {
            const button = event.target.closest('[data-shortcut-action]');
            if (button) this._startShortcutCapture(button.dataset.shortcutAction);
        });
        this.shortcutResetBtn?.addEventListener('click', () => this._resetShortcutBindings());
        this.defaultTemporaryCompressionToggle?.addEventListener('change', () => {
            this.globalConfig.defaultTemporaryImageCompression = this.defaultTemporaryCompressionToggle.checked;
            this._saveConfig();
        });
        this.assetLibraryFolderChoose?.addEventListener('click', () => void this._chooseAssetLibraryFolder());
        this.assetLibraryFolderSelect?.addEventListener('change', () => {
            void this._setDefaultAssetLibraryFolder(this.assetLibraryFolderSelect.value);
        });
        document.addEventListener('keydown', event => this._captureShortcut(event), true);
        this.conversationMenuBtn?.addEventListener('click', () => this._toggleAgentHeaderPopover('conversation'));
        this.conversationTitleBtn?.addEventListener('click', () => this._toggleAgentHeaderPopover('conversation'));
        this.newConversationBtn?.addEventListener('click', () => this._createAgentConversation());
        this.conversationList?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-conversation-id]');
            if (button) this._switchAgentConversation(button.dataset.agentConversationId);
        });
        this.filesBtn?.addEventListener('click', () => this._toggleAgentHeaderPopover('files'));
        this.sidebarCloseBtn?.addEventListener('click', () => {
            this._closeAgentHeaderPopovers();
            this.close();
        });
        this.sendBtn?.addEventListener('click', () => {
            this._closeAgentComposerPopovers();
            void this._sendAgentMessage();
        });
        this.planBtn?.addEventListener('click', () => {
            this._closeAgentComposerPopovers();
            this._assistAgentPlanning();
        });
        this.clearBtn?.addEventListener('click', () => {
            this._closeAgentComposerPopovers();
            this._clearAgentConversation();
        });
        this.agentAddMenuBtn?.addEventListener('click', () => this._toggleAgentComposerPopover('add'));
        this.agentModelMenuBtn?.addEventListener('click', () => this._toggleAgentComposerPopover('model'));
        this.agentSkillMenuBtn?.addEventListener('click', () => this._toggleAgentComposerPopover('skill'));
        this.agentExecutionMenuBtn?.addEventListener('click', () => this._toggleAgentComposerPopover('execution'));
        this.agentModelTabs?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-model-kind]');
            if (button) this._setAgentModelKind(button.dataset.agentModelKind);
        });
        this.agentComposerModelList?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-provider-id]');
            if (button) this._selectAgentComposerModel(button.dataset.agentModelKind, button.dataset.agentProviderId);
        });
        this.agentModelSettingsBtn?.addEventListener('click', () => {
            this._closeAgentComposerPopovers();
            this.setMode('settings', 'api');
        });
        this.agentSkillSearchInput?.addEventListener('input', () => this._renderAgentSkillList());
        this.agentSkillAddBtn?.addEventListener('click', () => this._setAgentSkillFormOpen(true));
        this.agentSkillForm?.addEventListener('submit', event => {
            event.preventDefault();
            this._createCustomAgentSkillFromForm();
        });
        this.agentSkillFormCancel?.addEventListener('click', () => this._setAgentSkillFormOpen(false));
        this.agentSkillTabs?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-skill-category]');
            if (!button) return;
            this.agentSkillCategory = ['planning', 'creative', 'review'].includes(button.dataset.agentSkillCategory)
                ? button.dataset.agentSkillCategory
                : 'all';
            this._renderAgentSkillList();
        });
        this.agentSkillList?.addEventListener('click', event => {
            const deleteButton = event.target.closest('[data-delete-agent-skill]');
            if (deleteButton) {
                event.stopPropagation();
                this._deleteCustomAgentSkill(deleteButton.dataset.deleteAgentSkill);
                return;
            }
            const button = event.target.closest('[data-agent-skill-id]');
            if (button) this._toggleAgentSkill(button.dataset.agentSkillId);
        });
        this.agentSkillClearBtn?.addEventListener('click', () => {
            this.globalConfig.agentSkillIds = [];
            this._saveConfig();
            this._renderAgentSkillList();
        });
        this.agentSkillDoneBtn?.addEventListener('click', () => {
            this._closeAgentComposerPopovers();
            this.inputEl?.focus();
        });
        this.agentExecutionPopover?.addEventListener('click', event => {
            const button = event.target.closest('[data-agent-execution-mode]');
            if (button) this._setAgentExecutionMode(button.dataset.agentExecutionMode);
        });
        this.agentAttachmentList?.addEventListener('click', event => {
            const button = event.target.closest('[data-remove-agent-attachment]');
            if (button) this._removePendingAgentAttachment(Number(button.dataset.removeAgentAttachment));
        });
        this.agentAttachmentClear?.addEventListener('click', () => this._clearPendingAgentAttachments());
        this.inputEl?.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
            event.preventDefault();
            void this._sendAgentMessage();
        });
        this.inputEl?.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 120)}px`;
        });
        this.taskHistoryBtn?.addEventListener('click', event => {
            event.stopPropagation();
            const open = !this.taskHistoryOpen;
            this._setTaskHistoryOpen(open);
        });
        this.taskHistoryCloseBtn?.addEventListener('click', () => this._setTaskHistoryOpen(false));
        this.taskHistoryFilters?.addEventListener('click', event => {
            const button = event.target.closest('[data-task-kind]');
            if (!button) return;
            this.taskHistoryFilter = ['image', 'video'].includes(button.dataset.taskKind)
                ? button.dataset.taskKind
                : 'all';
            this.taskHistoryFilters.querySelectorAll('[data-task-kind]').forEach(candidate => {
                const selected = candidate.dataset.taskKind === this.taskHistoryFilter;
                candidate.classList.toggle('active', selected);
                candidate.setAttribute('aria-selected', String(selected));
            });
            this._renderGenerationTasks();
        });
        this.taskHistoryList?.addEventListener('click', (event) => {
            const stopRecovery = event.target.closest('[data-stop-recovery]');
            if (stopRecovery) {
                void this._cancelGenerationTask(stopRecovery.dataset.stopRecovery);
                return;
            }
            const recoverButton = event.target.closest('[data-recover-task]');
            if (recoverButton) {
                void this._recoverGenerationTask(recoverButton.dataset.recoverTask, recoverButton.dataset.editTaskId === 'true');
                return;
            }
            const copyIdButton = event.target.closest('[data-copy-remote-task]');
            if (copyIdButton) {
                const task = this.generationTasks.find(item => item.id === copyIdButton.dataset.copyRemoteTask);
                void window.flowCanvas?.clipboard?.writeText?.(task?.taskId || '');
                return;
            }
            const copyPromptButton = event.target.closest('[data-copy-task-prompt]');
            if (copyPromptButton) {
                this._copyGenerationTaskPrompt(copyPromptButton.dataset.copyTaskPrompt, copyPromptButton);
                return;
            }
            const retryButton = event.target.closest('[data-retry-task]');
            if (retryButton) this._retryGenerationTask(retryButton.dataset.retryTask);
        });
        document.addEventListener('pointerdown', event => {
            if (!this.taskHistoryOpen
                || event.target.closest?.('.generation-recovery-dialog')
                || this.taskHistoryDock?.contains(event.target)
                || this.taskHistoryBtn?.contains(event.target)) return;
            this._setTaskHistoryOpen(false);
        });
        document.addEventListener('pointerdown', event => {
            if (this.agentComposerControls?.contains(event.target)) return;
            this._closeAgentComposerPopovers();
        });
        document.addEventListener('pointerdown', event => {
            if (this.agentHeader?.contains(event.target)) return;
            this._closeAgentHeaderPopovers();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.taskHistoryOpen) this._setTaskHistoryOpen(false);
            if (event.key === 'Escape') {
                this._closeAgentComposerPopovers();
                this._closeAgentHeaderPopovers();
            }
        });
        this.videoGenerateBtn?.addEventListener('click', () => this._generateVideoFromWorkspace());
        ['image', 'video'].forEach(kind => {
            const controls = this._promptPresetControls(kind);
            controls.select?.addEventListener('change', event => this._selectPromptPreset(kind, event.target.value));
            controls.saveButton?.addEventListener('click', () => this._savePromptPreset(kind));
            controls.deleteButton?.addEventListener('click', () => this._deletePromptPreset(kind));
            controls.nameInput?.addEventListener('keydown', event => {
                if (event.key !== 'Enter' || event.isComposing) return;
                event.preventDefault();
                this._savePromptPreset(kind);
            });
        });
        [this.videoPromptInput, this.imagePromptInput].forEach(input => {
            input?.addEventListener('input', () => this._scheduleProjectComposerSave());
        });
        [
            this.imageSizeSelect,
            this.imageQualitySelect,
            this.imageResponseFormatSelect,
            this.imageHistoryDisabled,
            this.imageStream,
            this.videoResolutionSelect,
            this.videoCameraFixed,
            this.videoGenerateAudio,
            this.videoWebSearch,
            this.videoWatermark
        ].forEach(control => control?.addEventListener('change', () => this._scheduleProjectComposerSave()));
        this.videoRatioGrid?.addEventListener('click', () => this._scheduleProjectComposerSave());
        this.videoDurationControl?.addEventListener('input', () => this._scheduleProjectComposerSave());
        this.videoDurationControl?.addEventListener('change', () => this._scheduleProjectComposerSave());
        this.videoAddMediaBtn?.addEventListener('click', () => this._toggleVideoReferencePick());
        this.videoClearSourcesBtn?.addEventListener('click', () => this._clearVideoReferences());
        document.addEventListener('canvas-add-generation-reference', event => {
            this._addCanvasGenerationReference(event.detail?.entry);
        });
        this.agentSidebar?.addEventListener('pointerdown', (event) => {
            if (!this.activeReferenceWorkspace || event.target.closest('.creation-source-add')) return;
            this.options.endMediaReferencePick?.({ silent: true });
        }, true);
        this.imageGenerationModeControl?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-image-generation-mode]');
            if (button) this._setImageGenerationMode(button.dataset.imageGenerationMode);
        });
        this.imageAddReferenceBtn?.addEventListener('click', () => this._toggleImageReferencePick());
        this.imageCompressReferencesBtn?.addEventListener('click', () => this._compressSelectedImageReferences());
        this.imageClearReferencesBtn?.addEventListener('click', () => this._clearImageReferences());
        this.imageReferenceList?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove-image-reference]');
            if (button) this._removeImageReference(button.dataset.removeImageReference);
        });
        this.imageGenerateBtn?.addEventListener('click', () => this._generateImageFromWorkspace());
        this._bindImagePromptResize();
        this._bindVideoPromptResize();
        document.getElementById('videoChangeModelBtn')?.addEventListener('click', () => this._showVideoModelPicker());
        this.videoModelFavoriteBtn?.addEventListener('click', () => this._toggleSelectedVideoModelFavorite());
        this.videoModelCopyBtn?.addEventListener('click', () => this._copySelectedVideoModelId());
        document.getElementById('videoPromptModelChip')?.addEventListener('click', () => this._showVideoModelPicker());
        document.getElementById('videoModelOpenSettingsBtn')?.addEventListener('click', () => this.setMode('settings', 'api'));
        this.videoModelSearchInput?.addEventListener('input', () => this._renderVideoModelPicker());

        // 左侧工具栏中的齿轮切换设置面板。
        document.getElementById('agentSettingsBtn')?.addEventListener('click', () => {
            this._closeAgentHeaderPopovers();
            this.setMode(this.currentMode === 'settings' && document.body.classList.contains('agent-open')
                ? 'canvas' : 'settings');
        });

        // 模板点击
        document.querySelectorAll('.agent-template-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                const templateId = e.target.getAttribute('data-template');
                this._applyTemplate(templateId);
                // 更新选中状态
                document.querySelectorAll('.agent-template-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
            });
        });

        // 各种表单动作
        this.addApiBtn?.addEventListener('click', () => this._showForm());
        this.getApiBtn?.addEventListener('click', async () => {
            const endpoint = String(this.formEndpoint?.value || '').toLowerCase();
            const site = endpoint.includes('art.ravenhash.org') ? 'art' : 'ai';
            this.getApiBtn.disabled = true;
            try {
                await window.flowCanvas?.shell?.openRavenHash?.(site);
            } catch (err) {
                console.error('[AgentSidebar] Failed to open RavenHash:', err);
            } finally {
                this.getApiBtn.disabled = false;
            }
        });
        this.apiFormCloseBtn?.addEventListener('click', () => this._hideForm());
        this.formSaveBtn?.addEventListener('click', () => this._saveForm());
        this.fetchModelsBtn?.addEventListener('click', () => this._fetchModelsForForm());
        this.addModelSlotBtn?.addEventListener('click', () => this._addModelSlot());
        this.fetchedModelSelect?.addEventListener('change', (e) => {
            if (e.target.value && this.formModel) {
                this.formModel.value = e.target.value;
                this._setModelFetchStatus('success', `已选择模型：${e.target.value}`);
            }
        });
        [this.formType, this.formEndpoint, this.formKey].forEach(el => {
            el?.addEventListener('input', () => this._resetFetchedModels());
            el?.addEventListener('change', () => this._resetFetchedModels());
        });

        // 顶部下拉框切换
        this.textModelSelectEl?.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) {
                this._setTextProvider(id);
            }
        });

        this.imageModelSelectEl?.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) {
                this._setImageProvider(id);
            }
        });

        this.videoModelSelectEl?.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) {
                this._setVideoProvider(id);
            }
        });

    }

    setMode(mode = 'canvas', settingsTab = null) {
        this._finishAgentSidebarResize?.();
        const nextMode = ['agent', 'settings', 'canvas'].includes(mode) ? mode : 'canvas';
        const body = document.body;
        // 离开设置界面时必须解除快捷键录制状态。_captureShortcut 是 document 捕获
        // 阶段的常驻监听器，只要 recordingShortcutAction 有值就会 preventDefault +
        // stopImmediatePropagation —— 面板收起后用户看不见任何提示，但全应用按键都
        // 被吞掉（输入框打不进字），且第一个不冲突的键会被静默写成新绑定。
        // 此前只有 Esc 和切换 tab 会清除它，关闭面板的路径都不会。
        if (nextMode !== 'settings') this._cancelShortcutCapture();
        this._closeAgentComposerPopovers();
        this._closeAgentHeaderPopovers();
        this._setTaskHistoryOpen(false);
        this.options.endMediaReferencePick?.({ clearHighlights: true });
        this.currentMode = nextMode;
        if (this.modeTitle) {
            this.modeTitle.textContent = {
                agent: 'AI Agent',
                settings: '\u8bbe\u7f6e'
            }[nextMode] || '';
        }

        body.classList.remove('agent-mode', 'settings-mode', 'image-mode', 'video-mode');
        if (nextMode === 'canvas') {
            body.classList.remove('creation-mode');
            this.close();
            this.settingsPanel?.classList.remove('show');
            if (this.videoWorkspace) this.videoWorkspace.hidden = true;
            if (this.videoModelPicker) this.videoModelPicker.hidden = true;
            if (this.videoPromptDock) this.videoPromptDock.hidden = true;
            if (this.imageWorkspace) this.imageWorkspace.hidden = true;
            return;
        }

        body.classList.add('creation-mode', nextMode + '-mode');
        body.classList.add('agent-open');
        this.settingsPanel?.classList.toggle('show', nextMode === 'settings');
        if (nextMode === 'settings') this._setSettingsTab(settingsTab || this.activeSettingsTab);
        if (this.videoWorkspace) this.videoWorkspace.hidden = true;
        if (this.videoModelPicker) this.videoModelPicker.hidden = true;
        if (this.videoPromptDock) this.videoPromptDock.hidden = true;
        if (this.imageWorkspace) this.imageWorkspace.hidden = true;
        this.open();
        if (nextMode === 'agent') setTimeout(() => this.inputEl?.focus(), 120);
    }

    _selectedImagePaths() {
        const selectedPaths = this.options.getSelectedFilePaths?.() || [];
        return selectedPaths
            .map(filePath => String(filePath || ''))
            .filter(filePath => /\.(png|jpe?g|webp)$/i.test(filePath))
            .slice(0, 2);
    }

    _hasSelectedVideoProvider() {
        const provider = this._getVideoProvider();
        return Boolean(provider && this._isVideoProvider(provider) && provider.model);
    }

    _renderVideoStage() {
        const hasModel = this._hasSelectedVideoProvider();
        if (this.videoModelPicker) this.videoModelPicker.hidden = hasModel;
        if (this.videoWorkspace) this.videoWorkspace.hidden = !hasModel;
        if (hasModel) {
            this._renderVideoProviderContext();
        } else {
            this._renderVideoModelPicker();
        }
    }

    _showVideoModelPicker() {
        if (this.currentMode !== 'video') return;
        if (this.videoWorkspace) this.videoWorkspace.hidden = true;
        if (this.videoModelPicker) this.videoModelPicker.hidden = false;
        if (this.videoModelSearchInput) this.videoModelSearchInput.value = '';
        this._renderVideoModelPicker();
        this.videoModelSearchInput?.focus();
    }

    _renderVideoModelPicker() {
        if (!this.videoModelList || !this.videoModelEmpty) return;
        const keyword = this.videoModelSearchInput?.value?.trim().toLowerCase() || '';
        const providers = this._providerVariants().filter(provider => {
            if (!this._isVideoProvider(provider)) return false;
            const searchable = `${provider.name || ''} ${provider.model || ''} ${provider.endpoint || ''}`.toLowerCase();
            return !keyword || searchable.includes(keyword);
        });

        this.videoModelList.innerHTML = '';
        this.videoModelEmpty.hidden = providers.length > 0;
        if (providers.length === 0) {
            const title = this.videoModelEmpty.querySelector('strong');
            const detail = this.videoModelEmpty.querySelector('span');
            if (title) title.textContent = keyword ? '没有匹配的视频模型' : '没有可用的视频模型';
            if (detail) {detail.textContent = keyword
                ? '换一个关键词，或到设置中检查模型名称。'
                : '请先在设置中添加 API，并填写视频模型名称。';}
            return;
        }

        const selectedId = this.globalConfig.videoProviderId;
        providers.forEach(provider => {
            const profile = this._getVideoModelProfile(provider);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'video-model-option';
            button.classList.toggle('selected', provider.id === selectedId);

            const icon = document.createElement('span');
            icon.className = 'video-model-option-icon';
            icon.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-video"></use></svg>';

            const copy = document.createElement('span');
            copy.className = 'video-model-option-copy';
            const model = document.createElement('strong');
            model.textContent = provider.model || provider.name || '未命名模型';
            if (profile?.routeLabel) model.textContent = `${profile.routeLabel} · ${provider.model}`;
            const meta = document.createElement('small');
            meta.textContent = [
                provider.name || '未命名 API',
                formatVideoModelProfile(profile)
            ].filter(Boolean).join(' · ');
            copy.append(model, meta);

            const arrow = document.createElement('span');
            arrow.className = 'video-model-option-arrow';
            arrow.textContent = '›';
            button.append(icon, copy, arrow);
            button.addEventListener('click', () => this._setVideoProvider(provider.id));
            this.videoModelList.appendChild(button);
        });
    }

    _renderVideoSourcePreview() {
        this._renderVideoReferencePickState();
        this._scheduleProjectComposerSave();
    }

    _toggleVideoReferencePick() {
        if (this.activeVideoReferenceType === 'mixed') {
            this.options.endMediaReferencePick?.();
            return;
        }
        const profile = this._getVideoModelProfile(this._getVideoProvider()) || DEFAULT_VIDEO_MODEL_PROFILE;
        const limits = this._getVideoReferenceLimits(profile);
        if (!Object.values(limits).some(limit => limit > 0)) return;
        this.options.endMediaReferencePick?.({ silent: true });
        this.activeReferenceWorkspace = 'video';
        this.options.beginMediaReferencePick?.(
            'mixed',
            [],
            limits,
            this.videoReferenceSelections
        );
    }

    _addCanvasGenerationReference(entry) {
        const feedback = message => document.dispatchEvent(new CustomEvent('canvas-reference-feedback', {
            detail: { message }
        }));
        if (!['image', 'video', 'audio'].includes(entry?.mediaType) || !entry?.filePath) {
            feedback('该素材不能作为创作参考');
            return;
        }
        feedback('图片和视频创作已迁移到画布节点，请使用素材上方的“生成”菜单');
    }

    _removeVideoReference(type, id) {
        this.videoReferenceSelections[type] = (this.videoReferenceSelections[type] || [])
            .filter(entry => (entry.id || entry.itemId || entry.filePath) !== id);
        this.options.updateMediaReferencePick?.(type, this.videoReferenceSelections[type]);
        this._renderVideoSourcePreview();
    }

    _clearVideoReferences() {
        this.videoReferenceSelections = { image: [], video: [], audio: [] };
        this.options.clearMediaReferenceSelections?.();
        this._renderVideoSourcePreview();
    }

    _renderVideoReferencePickState() {
        if (!this.videoAddMediaBtn) return;
        const active = this.activeVideoReferenceType === 'mixed';
        const counts = ['image', 'video', 'audio'].map(type => this.videoReferenceSelections[type]?.length || 0);
        const hasSelection = counts.some(Boolean);
        this.videoAddMediaBtn.classList.toggle('active', active);
        this.videoAddMediaBtn.setAttribute('aria-pressed', String(active));
        this.videoAddMediaBtn.querySelector('span').textContent = active || hasSelection
            ? `图片${counts[0]} / 视频${counts[1]} / 音频${counts[2]}`
            : '添加素材';
    }

    _setImageGenerationMode(mode) {
        this.imageGenerationMode = mode === 'reference' ? 'reference' : 'text';
        if (this.imageGenerationMode !== 'reference' && this.activeReferenceWorkspace === 'image') {
            this.options.endMediaReferencePick?.({ silent: true, clearHighlights: true });
        }
        this._renderImageReferences();
    }

    _toggleImageReferencePick() {
        if (this.activeReferenceWorkspace === 'image') {
            this.options.endMediaReferencePick?.({ silent: true });
            return;
        }
        this._setImageGenerationMode('reference');
        this.options.endMediaReferencePick?.({ silent: true });
        this.activeReferenceWorkspace = 'image';
        this.options.beginMediaReferencePick?.(
            'image',
            this.imageReferenceSelections,
            Number.MAX_SAFE_INTEGER,
            { image: this.imageReferenceSelections }
        );
    }

    _removeImageReference(id) {
        this.imageReferenceSelections = this.imageReferenceSelections.filter(entry => (
            String(entry.id || entry.itemId || entry.filePath) !== String(id)
        ));
        this.options.updateMediaReferencePick?.('image', this.imageReferenceSelections);
        this._renderImageReferences();
    }

    _clearImageReferences() {
        this.imageReferenceSelections = [];
        if (this.activeReferenceWorkspace === 'image') {
            this.options.endMediaReferencePick?.({ silent: true });
        }
        this.options.clearMediaReferenceSelections?.();
        this._renderImageReferences();
        this._scheduleProjectComposerSave();
    }

    _bindImagePromptResize() {
        const input = this.imagePromptInput;
        const handle = this.imagePromptResizeHandle;
        if (!input || !handle) return;

        const defaultHeight = 116;
        const minHeight = 116;
        const maxHeight = () => Math.max(240, Math.min(560, window.innerHeight - 260));
        const clampHeight = value => Math.round(Math.max(minHeight, Math.min(maxHeight(), Number(value) || defaultHeight)));
        const applyHeight = (value, persist = false) => {
            const height = clampHeight(value);
            input.style.height = `${height}px`;
            handle.setAttribute('aria-valuemin', String(minHeight));
            handle.setAttribute('aria-valuemax', String(maxHeight()));
            handle.setAttribute('aria-valuenow', String(height));
            if (persist) {
                try {
                    localStorage.setItem(IMAGE_PROMPT_HEIGHT_STORAGE_KEY, String(height));
                } catch (_) {
                    // Local storage may be unavailable in browser-only previews.
                }
            }
            return height;
        };

        try {
            const savedHeight = Number(localStorage.getItem(IMAGE_PROMPT_HEIGHT_STORAGE_KEY));
            if (Number.isFinite(savedHeight)) applyHeight(savedHeight);
            else applyHeight(input.getBoundingClientRect().height || defaultHeight);
        } catch (_) {
            applyHeight(defaultHeight);
        }

        let dragState = null;
        const finishDrag = event => {
            if (!dragState || (event?.pointerId != null && event.pointerId !== dragState.pointerId)) return;
            const pointerId = dragState.pointerId;
            dragState = null;
            document.body.classList.remove('image-prompt-resizing');
            handle.removeAttribute('aria-grabbed');
            applyHeight(input.getBoundingClientRect().height, true);
            if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        };

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            dragState = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startHeight: input.getBoundingClientRect().height
            };
            handle.setPointerCapture?.(event.pointerId);
            handle.setAttribute('aria-grabbed', 'true');
            document.body.classList.add('image-prompt-resizing');
        });
        handle.addEventListener('pointermove', event => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            event.preventDefault();
            applyHeight(dragState.startHeight + event.clientY - dragState.startY);
        });
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('lostpointercapture', finishDrag);
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            applyHeight(defaultHeight, true);
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
            event.preventDefault();
            const currentHeight = input.getBoundingClientRect().height;
            const nextHeight = event.key === 'Home'
                ? defaultHeight
                : currentHeight + (event.key === 'ArrowDown' ? 16 : -16);
            applyHeight(nextHeight, true);
        });
    }

    _bindVideoPromptResize() {
        const input = this.videoPromptInput;
        const handle = this.videoPromptResizeHandle;
        if (!input || !handle) return;

        const defaultHeight = 92;
        const minHeight = 62;
        const maxHeight = () => Math.max(180, Math.min(520, window.innerHeight - 220));
        const clampHeight = value => Math.round(Math.max(minHeight, Math.min(maxHeight(), Number(value) || defaultHeight)));
        const applyHeight = (value, persist = false) => {
            const height = clampHeight(value);
            input.style.height = `${height}px`;
            handle.setAttribute('aria-valuemin', String(minHeight));
            handle.setAttribute('aria-valuemax', String(maxHeight()));
            handle.setAttribute('aria-valuenow', String(height));
            if (persist) {
                try {
                    localStorage.setItem(VIDEO_PROMPT_HEIGHT_STORAGE_KEY, String(height));
                } catch (_) {
                    // Local storage may be unavailable in browser-only previews.
                }
            }
            return height;
        };

        try {
            const savedHeight = Number(localStorage.getItem(VIDEO_PROMPT_HEIGHT_STORAGE_KEY));
            if (Number.isFinite(savedHeight) && savedHeight > 0) applyHeight(savedHeight);
            else applyHeight(input.getBoundingClientRect().height || defaultHeight);
        } catch (_) {
            applyHeight(defaultHeight);
        }

        let dragState = null;
        const finishDrag = event => {
            if (!dragState || (event?.pointerId != null && event.pointerId !== dragState.pointerId)) return;
            const pointerId = dragState.pointerId;
            dragState = null;
            document.body.classList.remove('video-prompt-resizing');
            handle.removeAttribute('aria-grabbed');
            applyHeight(input.getBoundingClientRect().height, true);
            if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        };

        handle.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            dragState = {
                pointerId: event.pointerId,
                startY: event.clientY,
                startHeight: input.getBoundingClientRect().height
            };
            handle.setPointerCapture?.(event.pointerId);
            handle.setAttribute('aria-grabbed', 'true');
            document.body.classList.add('video-prompt-resizing');
        });
        handle.addEventListener('pointermove', event => {
            if (!dragState || event.pointerId !== dragState.pointerId) return;
            event.preventDefault();
            applyHeight(dragState.startHeight - (event.clientY - dragState.startY));
        });
        handle.addEventListener('pointerup', finishDrag);
        handle.addEventListener('pointercancel', finishDrag);
        handle.addEventListener('lostpointercapture', finishDrag);
        handle.addEventListener('dblclick', event => {
            event.preventDefault();
            applyHeight(defaultHeight, true);
        });
        handle.addEventListener('keydown', event => {
            if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
            event.preventDefault();
            const currentHeight = input.getBoundingClientRect().height;
            const nextHeight = event.key === 'Home'
                ? defaultHeight
                : currentHeight + (event.key === 'ArrowUp' ? 16 : -16);
            applyHeight(nextHeight, true);
        });
    }

    _renderImageReferences() {
        this._scheduleProjectComposerSave();
        const isReferenceMode = this.imageGenerationMode === 'reference';
        this.imageGenerationModeControl?.querySelectorAll('[data-image-generation-mode]').forEach(button => {
            const active = button.dataset.imageGenerationMode === this.imageGenerationMode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (this.imageReferencePanel) this.imageReferencePanel.hidden = !isReferenceMode;
        if (this.imageReferenceCount) this.imageReferenceCount.textContent = `已选 ${this.imageReferenceSelections.length} 张`;
        if (this.imageCompressReferencesBtn) this.imageCompressReferencesBtn.hidden = this.imageReferenceSelections.length === 0;
        if (this.imageClearReferencesBtn) this.imageClearReferencesBtn.hidden = this.imageReferenceSelections.length === 0;
        const selecting = this.activeReferenceWorkspace === 'image';
        this.imageAddReferenceBtn?.classList.toggle('active', selecting);
        this.imageAddReferenceBtn?.setAttribute('aria-pressed', String(selecting));
        const addLabel = this.imageAddReferenceBtn?.querySelector('span');
        if (addLabel) addLabel.textContent = selecting ? '选择图片中' : '添加参考图';
        if (!this.imageReferenceList) return;
        this.imageReferenceList.replaceChildren();
        if (this.imageReferenceSelections.length === 0) {
            const empty = document.createElement('span');
            empty.className = 'creation-image-reference-empty';
            empty.textContent = '点击“添加参考图”，再从画布中选择图片';
            this.imageReferenceList.appendChild(empty);
            return;
        }
        this.imageReferenceSelections.forEach((entry, index) => {
            const item = document.createElement('div');
            item.className = 'creation-image-reference-item';
            const order = document.createElement('b');
            order.textContent = String(index + 1);
            const name = document.createElement('span');
            name.textContent = String(entry.filePath || '').split(/[\\/]/).pop() || `参考图 ${index + 1}`;
            name.title = entry.filePath || '';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.dataset.removeImageReference = entry.id || entry.itemId || entry.filePath;
            remove.title = '移除参考图';
            remove.setAttribute('aria-label', `移除参考图 ${index + 1}`);
            remove.innerHTML = '<svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-close"></use></svg>';
            item.append(order, name, remove);
            this.imageReferenceList.appendChild(item);
        });
    }

    _renderVideoProviderContext() {
        const provider = this._getVideoProvider();
        const providerName = provider?.name || '\u672a\u914d\u7f6e\u89c6\u9891 API';
        const model = provider?.model || '\u672a\u9009\u62e9\u6a21\u578b';
        this._renderSelectedVideoModelCard(provider);
        this._renderVideoModelCapabilities(provider);
        if (this.videoPromptProviderChip) this.videoPromptProviderChip.textContent = providerName;
        if (this.videoPromptModelChip) this.videoPromptModelChip.textContent = model;
    }

    _renderImageModelCapabilities(provider = this._getImageProvider()) {
        if (!this.imageSizeSelect) return;
        const gptImage2 = isGptImage2Model(provider?.model);
        const sizes = this._getImageModelSizes(provider);
        const previousValue = this.imageSizeSelect.value;
        this.imageSizeSelect.innerHTML = '';
        sizes.forEach(size => {
            const option = document.createElement('option');
            option.value = size.value;
            option.textContent = size.label;
            this.imageSizeSelect.appendChild(option);
        });
        const largestSize = sizes
            .filter(size => /^\d+x\d+$/i.test(String(size.value || '')))
            .sort((left, right) => {
                const area = value => {
                    const [width, height] = String(value.value).split('x').map(Number);
                    return width * height;
                };
                return area(right) - area(left);
            })[0]?.value || '';
        this.imageSizeSelect.value = gptImage2
            ? (previousValue && sizes.some(size => size.value === previousValue) ? previousValue : largestSize)
            : (sizes.some(size => size.value === previousValue) ? previousValue : '');
        if (this.imageApiOptions) this.imageApiOptions.hidden = !gptImage2;
        if (gptImage2) {
            if (this.imageResponseFormatSelect && !this.imageResponseFormatSelect.value) {
                this.imageResponseFormatSelect.value = 'url';
            }
            if (this.imageHistoryDisabled) this.imageHistoryDisabled.checked = this.imageHistoryDisabled.checked !== false;
        }
    }

    _getImageModelSizes(provider = this._getImageProvider()) {
        const marker = `${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        return /ai\.ravenhash\.org|ravenhash/.test(marker)
            ? RAVENHASH_IMAGE_SIZES
            : DEFAULT_IMAGE_SIZES;
    }

    _videoModelFavorites() {
        try {
            const saved = JSON.parse(localStorage.getItem('flow-canvas-video-model-favorites') || '[]');
            return new Set(Array.isArray(saved) ? saved.map(String) : []);
        } catch (error) {
            return new Set();
        }
    }

    _toggleSelectedVideoModelFavorite() {
        const provider = this._getVideoProvider();
        if (!provider?.id) return;
        const favorites = this._videoModelFavorites();
        if (favorites.has(String(provider.id))) {
            favorites.delete(String(provider.id));
        } else {
            favorites.add(String(provider.id));
        }
        localStorage.setItem('flow-canvas-video-model-favorites', JSON.stringify([...favorites]));
        this._renderSelectedVideoModelCard(provider);
        this._renderVideoModelPicker();
    }

    async _copySelectedVideoModelId() {
        const model = this._getVideoProvider()?.model;
        if (!model) return;
        try {
            await navigator.clipboard.writeText(model);
        } catch (error) {
            const textarea = document.createElement('textarea');
            textarea.value = model;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        if (this.videoModelCopyBtn) {
            this.videoModelCopyBtn.classList.add('copied');
            this.videoModelCopyBtn.title = '\u5df2\u590d\u5236';
            setTimeout(() => {
                this.videoModelCopyBtn?.classList.remove('copied');
                if (this.videoModelCopyBtn) this.videoModelCopyBtn.title = '\u590d\u5236\u6a21\u578b ID';
            }, 1200);
        }
    }

    _formatResolution(value) {
        const key = String(value || '').toLowerCase();
        const dimensions = {
            '480p': '854 \u00d7 480',
            '720p': '1280 \u00d7 720',
            '1080p': '1920 \u00d7 1080',
            '2k': '2560 \u00d7 1440',
            '4k': '3840 \u00d7 2160'
        }[key];
        return dimensions ? `${value} (${dimensions})` : String(value);
    }

    _renderSelectedVideoModelCard(provider) {
        if (!provider) return;
        const profile = this._getVideoModelProfile(provider) || DEFAULT_VIDEO_MODEL_PROFILE;
        const resolutions = profile.resolutions || [];
        const durations = profile.durations || [];
        const ratios = profile.ratios || [];
        const providerTypes = {
            openai: 'OpenAI \u517c\u5bb9',
            google: 'Google Gemini',
            anthropic: 'Anthropic'
        };
        const durationSummary = profile.durationControl === 'slider' && durations.length > 1
            ? `${Math.min(...durations)}\u2013${Math.max(...durations)} \u79d2`
            : durations.map(value => Number(value) === -1 ? '\u667a\u80fd' : `${value} \u79d2`).join(' / ');
        const ratioSummary = ratios.map(value => value === 'adaptive' ? '\u81ea\u9002\u5e94' : value).join(' / ');

        if (this.videoSelectedModelName) this.videoSelectedModelName.textContent = provider.name || provider.model;
        if (this.videoSelectedModelId) this.videoSelectedModelId.textContent = provider.model;
        if (this.videoSelectedModelProfile) this.videoSelectedModelProfile.textContent = profile.label || '\u89c6\u9891\u6a21\u578b';
        if (this.videoSelectedModelRoute) {
            this.videoSelectedModelRoute.textContent = profile.routeLabel || '';
            this.videoSelectedModelRoute.hidden = !profile.routeLabel;
        }
        if (this.videoSelectedModelPrice) {
            const priceText = formatVideoModelPrice(profile.price);
            this.videoSelectedModelPrice.textContent = priceText;
            this.videoSelectedModelPrice.hidden = !priceText;
        }
        if (this.videoSelectedModelProviderType) this.videoSelectedModelProviderType.textContent = providerTypes[provider.type] || '\u81ea\u5b9a\u4e49 API';
        if (this.videoSelectedModelResolutions) {
            const text = resolutions.length ? resolutions.map(value => this._formatResolution(value)).join(' / ') : '\u63a5\u53e3\u9ed8\u8ba4';
            this.videoSelectedModelResolutions.textContent = text;
            this.videoSelectedModelResolutions.title = text;
        }
        if (this.videoSelectedModelDurations) {
            const text = durationSummary || '\u63a5\u53e3\u9ed8\u8ba4';
            this.videoSelectedModelDurations.textContent = text;
            this.videoSelectedModelDurations.title = text;
        }
        if (this.videoSelectedModelRatios) {
            const text = ratioSummary || '\u63a5\u53e3\u9ed8\u8ba4';
            this.videoSelectedModelRatios.textContent = text;
            this.videoSelectedModelRatios.title = text;
        }
        if (this.videoModelFavoriteBtn) {
            const favorite = this._videoModelFavorites().has(String(provider.id));
            this.videoModelFavoriteBtn.classList.toggle('active', favorite);
            this.videoModelFavoriteBtn.setAttribute('aria-pressed', String(favorite));
            this.videoModelFavoriteBtn.title = favorite ? '\u53d6\u6d88\u6536\u85cf' : '\u6536\u85cf\u6a21\u578b';
        }
    }

    _getVideoModelProfile(provider) {
        return getVideoModelProfile(provider);
    }

    _getVideoReferenceLimits(profile) {
        return {
            ...VIDEO_REFERENCE_LIMITS,
            ...(profile?.referenceLimits || {})
        };
    }

    _applyVideoModelControls(profile) {
        const limits = this._getVideoReferenceLimits(profile);
        if (this.activeVideoReferenceType === 'mixed' && !Object.values(limits).some(limit => limit > 0)) {
            this.options.endMediaReferencePick?.();
        }
        ['image', 'video', 'audio'].forEach(type => {
            const entries = this.videoReferenceSelections[type] || [];
            const trimmed = entries.slice(0, Math.max(0, limits[type]));
            if (trimmed.length !== entries.length) {
                this.videoReferenceSelections[type] = trimmed;
                this.options.updateMediaReferencePick?.(type, trimmed);
            }
        });
        if (this.videoAddMediaBtn) {
            this.videoAddMediaBtn.hidden = !Object.values(limits).some(limit => limit > 0);
        }

        const toggleControls = [
            [this.videoCameraFixed, profile?.supportsCameraFixed !== false],
            [this.videoGenerateAudio, profile?.supportsGeneratedAudio !== false],
            [this.videoWatermark, profile?.supportsWatermark !== false]
        ];
        toggleControls.forEach(([input, supported]) => {
            if (!input) return;
            const field = input.closest('.creation-switch-control');
            if (field) field.hidden = !supported;
            if (!supported) input.checked = false;
        });
        this._renderVideoReferencePickState();
    }

    _replaceSelectOptions(select, values, preferredValue, formatter) {
        if (!select) return;
        const previousValue = select.value;
        select.innerHTML = '';
        values.forEach(value => {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = formatter(value);
            select.appendChild(option);
        });
        const supportedValues = values.map(String);
        select.value = supportedValues.includes(previousValue)
            ? previousValue
            : supportedValues.includes(String(preferredValue))
                ? String(preferredValue)
                : (supportedValues[0] || '');
        select.disabled = values.length === 0;
    }

    _renderVideoRatios(profile) {
        if (!this.videoRatioGrid || !this.videoRatioSelect) return;
        const ratios = profile?.ratios || [];
        const previousValue = this.videoRatioSelect.value;
        const selectedValue = ratios.includes(previousValue)
            ? previousValue
            : ratios.includes(profile?.defaultRatio)
                ? profile.defaultRatio
                : (ratios[0] || '');
        this.videoRatioSelect.value = selectedValue;
        this.videoRatioGrid.innerHTML = '';

        ratios.forEach(ratio => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.ratio = ratio;
            button.classList.toggle('active', ratio === selectedValue);

            const shape = document.createElement('span');
            shape.className = `ratio-shape ratio-${ratio.replace(':', '-')}`;
            if (ratio === 'adaptive') shape.textContent = 'A';
            button.append(shape, document.createTextNode(ratio === 'adaptive' ? '自适应' : ratio));
            button.addEventListener('click', () => {
                this.videoRatioSelect.value = ratio;
                this.videoRatioGrid.querySelectorAll('[data-ratio]').forEach(item => {
                    item.classList.toggle('active', item === button);
                });
            });
            this.videoRatioGrid.appendChild(button);
        });
    }

    _resolveVideoRequestRatio(profile, imageReferences = []) {
        const selected = this.videoRatioSelect?.value || profile?.defaultRatio || '16:9';
        if (selected !== 'adaptive' || profile?.resolveAdaptiveRatio !== true) return selected;
        const first = imageReferences[0] || null;
        return inferClosestAspectRatio(
            first?.width,
            first?.height,
            profile?.ratios,
            profile?.adaptiveFallbackRatio || '16:9'
        );
    }

    _setVideoDurationValue(value) {
        if (this.videoDurationSelect) this.videoDurationSelect.value = String(value);
    }

    _renderVideoDuration(profile) {
        if (!this.videoDurationControl || !this.videoDurationSelect) return;
        const durations = profile?.durations || [];
        const previousValue = this.videoDurationSelect.value;
        const selectedValue = durations.map(String).includes(previousValue)
            ? Number(previousValue)
            : durations.includes(profile?.defaultDuration)
                ? profile.defaultDuration
                : durations[0];

        this.videoDurationControl.innerHTML = '';
        this._setVideoDurationValue(selectedValue ?? '');
        if (durations.length === 0) return;

        if (profile.durationControl === 'slider') {
            const row = document.createElement('div');
            row.className = 'creation-duration-slider';
            const range = document.createElement('input');
            range.type = 'range';
            range.min = String(Math.min(...durations));
            range.max = String(Math.max(...durations));
            range.step = '1';
            range.value = String(selectedValue);
            range.setAttribute('aria-label', '视频时长');
            const output = document.createElement('output');
            output.textContent = `${selectedValue} 秒`;
            range.addEventListener('input', () => {
                this._setVideoDurationValue(range.value);
                output.textContent = `${range.value} 秒`;
            });
            row.append(range, output);
            this.videoDurationControl.appendChild(row);
            return;
        }

        if (profile.durationControl === 'select') {
            const select = document.createElement('select');
            select.className = 'creation-duration-select';
            durations.forEach(value => {
                const option = document.createElement('option');
                option.value = String(value);
                option.textContent = Number(value) === -1 ? '智能选择 (-1)' : `${value} 秒`;
                select.appendChild(option);
            });
            select.value = String(selectedValue);
            select.addEventListener('change', () => this._setVideoDurationValue(select.value));
            this.videoDurationControl.appendChild(select);
            return;
        }

        const segmented = document.createElement('div');
        segmented.className = 'creation-duration-segmented';
        durations.forEach(value => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `${value} 秒`;
            button.classList.toggle('active', value === selectedValue);
            button.addEventListener('click', () => {
                this._setVideoDurationValue(value);
                segmented.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
            });
            segmented.appendChild(button);
        });
        this.videoDurationControl.appendChild(segmented);
    }

    _renderVideoModelCapabilities(provider) {
        const profile = this._getVideoModelProfile(provider);
        const webSearchModelKey = provider ? `${provider.id || ''}:${provider.model || ''}` : '';
        if (!profile) {
            this._replaceSelectOptions(this.videoResolutionSelect, [''], '', () => '\u8bf7\u5148\u9009\u62e9\u89c6\u9891\u6a21\u578b');
            if (this.videoResolutionSelect) this.videoResolutionSelect.disabled = true;
            if (this.videoRatioField) this.videoRatioField.hidden = true;
            if (this.videoResolutionField) this.videoResolutionField.hidden = true;
            if (this.videoDurationField) this.videoDurationField.hidden = true;
            if (this.videoWebSearchField) this.videoWebSearchField.hidden = true;
            if (this.videoWebSearch) {
                this.videoWebSearch.checked = false;
                this.videoWebSearch.dataset.modelKey = '';
            }
            this._renderVideoRatios(DEFAULT_VIDEO_MODEL_PROFILE);
            this._renderVideoDuration(DEFAULT_VIDEO_MODEL_PROFILE);
            return;
        }

        const resolutions = profile.resolutions || [];
        const durations = profile.durations || [];
        const ratios = profile.ratios || [];
        this._applyVideoModelControls(profile);
        this._renderVideoRatios(profile);
        this._replaceSelectOptions(
            this.videoResolutionSelect,
            resolutions,
            profile.defaultResolution,
            value => this._formatResolution(value)
        );
        this._renderVideoDuration(profile);
        if (this.videoRatioField) this.videoRatioField.hidden = ratios.length === 0;
        if (this.videoResolutionField) this.videoResolutionField.hidden = resolutions.length === 0;
        if (this.videoDurationField) this.videoDurationField.hidden = durations.length === 0;
        if (this.videoWebSearchField) this.videoWebSearchField.hidden = !profile.supportsWebSearch;
        if (this.videoWebSearch) {
            if (!profile.supportsWebSearch) {
                this.videoWebSearch.checked = false;
            } else if (this.videoWebSearch.dataset.modelKey !== webSearchModelKey) {
                this.videoWebSearch.checked = false;
            }
            this.videoWebSearch.dataset.modelKey = webSearchModelKey;
        }
    }

    _setWorkspaceMessage(element, type, message) {
        if (!element) return;
        element.className = 'creation-workspace-message';
        if (type) element.classList.add(type);
        element.textContent = message || '';
    }

    _setImageWorkspaceStatus(status, label) {
        if (!this.imageWorkspaceStatus) return;
        this.imageWorkspaceStatus.dataset.status = status || 'idle';
        this.imageWorkspaceStatus.textContent = label || '待机';
    }

    _loadGenerationTasks() {
        try {
            const saved = JSON.parse(localStorage.getItem(GENERATION_TASKS_STORAGE_KEY) || '[]');
            if (!Array.isArray(saved)) return;
            let changed = false;
            this.generationTasks = saved
                .filter(task => task && ['image', 'video'].includes(task.kind))
                .slice(0, GENERATION_TASK_LIMIT)
                .map(task => {
                    const normalized = {
                        ...task,
                        params: task.params && typeof task.params === 'object' ? task.params : {},
                        sourcePaths: Array.isArray(task.sourcePaths) ? task.sourcePaths.map(String) : [],
                        attempts: Number.isFinite(task.attempts) ? task.attempts : 1
                    };
                    if (task.status !== 'running') return normalized;
                    changed = true;
                    return {
                        ...normalized,
                        status: 'disconnected',
                        error: '应用已重新启动，与生成服务的连接已中断，可重新传输此任务。',
                        updatedAt: new Date().toISOString()
                    };
                });
            if (changed) this._saveGenerationTasks();
        } catch (error) {
            console.warn('[Agent] 任务记录读取失败', error);
            this.generationTasks = [];
        }
    }

    _saveGenerationTasks() {
        try {
            localStorage.setItem(
                GENERATION_TASKS_STORAGE_KEY,
                JSON.stringify(this.generationTasks.slice(0, GENERATION_TASK_LIMIT))
            );
        } catch (error) {
            console.warn('[Agent] 任务记录保存失败', error);
        }
    }

    _loadBrowserSyncEventIds() {
        try {
            const saved = JSON.parse(localStorage.getItem(BROWSER_SYNC_EVENT_IDS_KEY) || '[]');
            this.processedBrowserSyncEventIds = new Set(Array.isArray(saved) ? saved.map(String) : []);
        } catch (_) {
            this.processedBrowserSyncEventIds = new Set();
        }
    }

    _saveBrowserSyncEventIds() {
        const recent = [...this.processedBrowserSyncEventIds].slice(-1000);
        this.processedBrowserSyncEventIds = new Set(recent);
        localStorage.setItem(BROWSER_SYNC_EVENT_IDS_KEY, JSON.stringify(recent));
    }

    _handleTaskSubmitted(event = {}) {
        const clientTaskId = String(event.clientTaskId || '').trim();
        const remoteTaskId = String(event.remoteTaskId || event.taskId || '').trim();
        if (!remoteTaskId) return;
        const task = this.generationTasks.find(item => item.id === clientTaskId)
            || this.generationTasks.find(item => item.taskId === remoteTaskId);
        if (!task) return;
        const syncStage = event.recovering === true
            ? 'recovering'
            : event.recovered === true
                ? null
                : task.params?.syncStage || null;
        this._updateGenerationTask(task.id, {
            taskId: remoteTaskId,
            params: {
                ...(task.params || {}),
                syncStage,
                targetDir: event.targetDir || task.params?.targetDir || null
            }
        });
        if (event.recovering === true) {
            this._setWorkspaceMessage(
                this.videoGenerateMessage,
                '',
                '\u670d\u52a1\u5668\u5df2\u63a5\u6536\u4efb\u52a1\uff0c\u6b63\u5728\u6062\u590d\u4efb\u52a1\u8fde\u63a5...'
            );
        } else if (event.recovered === true) {
            this._setWorkspaceMessage(this.videoGenerateMessage, '', '\u4efb\u52a1\u8fde\u63a5\u5df2\u6062\u590d\uff0c\u6b63\u5728\u751f\u6210...');
        }
    }

    _handleTaskCompleted(event = {}) {
        const clientTaskId = String(event.clientTaskId || '').trim();
        const remoteTaskId = String(event.remoteTaskId || event.taskId || '').trim();
        const task = this.generationTasks.find(item => item.id === clientTaskId)
            || this.generationTasks.find(item => item.taskId === remoteTaskId);
        if (!task) return;
        if (this.recoveringGenerationTasks?.has(task.id) && !event.recovered) return;
        this._updateGenerationTask(task.id, {
            status: 'success',
            taskId: remoteTaskId || task.taskId || null,
            filePath: event.filePath || task.filePath || null,
            filePaths: event.filePaths || task.filePaths || [],
            error: null
        });
    }

    async _pollBrowserSyncEvents() {
        if (this.browserSyncPolling || !window.flowCanvas?.browserSync?.getEvents) return;
        this.browserSyncPolling = true;
        try {
            const events = await window.flowCanvas.browserSync.getEvents();
            for (const event of Array.isArray(events) ? events : []) {
                const eventId = String(event?.eventId || '').trim();
                if (!eventId || this.processedBrowserSyncEventIds.has(eventId)) continue;
                this._mergeBrowserSyncEvent(event);
                this.processedBrowserSyncEventIds.add(eventId);
            }
            this._saveBrowserSyncEventIds();
        } catch (error) {
            console.warn('[Agent] 浏览器任务同步失败', error);
        } finally {
            this.browserSyncPolling = false;
        }
    }

    _mergeBrowserSyncEvent(event = {}) {
        const remoteTaskId = String(event.remoteTaskId || event.taskId || '').trim();
        if (!remoteTaskId) return;
        const routeClientTaskId = String(event.clientTaskId || '').trim();
        let task = this.generationTasks.find(item => item.taskId === remoteTaskId)
            || this.generationTasks.find(item => item.id === routeClientTaskId);

        if (!task) {
            const eventTime = new Date(event.createdAt || event.timestamp || 0).getTime();
            task = this.generationTasks.find(item => {
                if (item.kind !== 'video' || item.status !== 'running') return false;
                if (event.model && item.model && event.model !== item.model) return false;
                const taskTime = new Date(item.createdAt || 0).getTime();
                return eventTime > 0 && Math.abs(taskTime - eventTime) < 10 * 60 * 1000;
            });
        }

        const stage = String(event.status || event.stage || '').toLowerCase();
        const filePath = String(event.filePath || '').trim() || null;
        const nextStatus = filePath || ['imported', 'downloaded'].includes(stage)
            ? 'success'
            : ['failed', 'error'].includes(stage)
                ? 'failed'
                : 'running';
        const syncError = nextStatus === 'failed'
            ? (event.error || '云端任务失败')
            : null;

        if (task) {
            this._updateGenerationTask(task.id, {
                taskId: remoteTaskId,
                status: nextStatus,
                filePath: filePath || task.filePath || null,
                error: syncError,
                providerName: task.providerName || event.sourceHost || '浏览器同步',
                model: task.model || event.model || '',
                params: {
                    ...(task.params || {}),
                    syncStage: stage,
                    targetDir: event.targetDir || task.params?.targetDir || null
                }
            });
            return;
        }

        const now = event.createdAt || event.timestamp || new Date().toISOString();
        this.generationTasks.unshift({
            id: routeClientTaskId || `browser-${remoteTaskId}`,
            kind: 'video',
            projectId: event.projectId || this.options.getActiveProjectId?.() || null,
            status: nextStatus,
            providerId: null,
            providerName: event.sourceHost || '浏览器同步',
            model: event.model || '',
            prompt: event.prompt || '从云端账号同步的视频任务',
            params: {
                syncStage: stage,
                targetDir: event.targetDir || null,
                videoSourcePaths: []
            },
            sourcePaths: [],
            createdAt: now,
            updatedAt: event.timestamp || new Date().toISOString(),
            filePath,
            taskId: remoteTaskId,
            error: syncError,
            attempts: 1
        });
        this.generationTasks = this.generationTasks.slice(0, GENERATION_TASK_LIMIT);
        this._saveGenerationTasks();
        this._renderGenerationTasks();
    }

    _createGenerationTask(kind, provider, prompt, params = {}, sourcePaths = []) {
        const now = new Date().toISOString();
        const id = globalThis.crypto?.randomUUID?.()
            || `task-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const task = {
            id,
            kind,
            projectId: this.options.getActiveProjectId?.() || null,
            status: 'running',
            providerId: provider?.id || null,
            providerName: this._providerLabel(provider),
            model: provider?.model || '',
            prompt: String(prompt || ''),
            params: JSON.parse(JSON.stringify(params || {})),
            sourcePaths: sourcePaths.map(String).filter(Boolean),
            createdAt: now,
            updatedAt: now,
            filePath: null,
            taskId: null,
            error: null,
            attempts: 1
        };
        this.generationTasks.unshift(task);
        this.generationTasks = this.generationTasks.slice(0, GENERATION_TASK_LIMIT);
        this._saveGenerationTasks();
        this._renderGenerationTasks();
        return task;
    }

    createGenerationTask({ kind = 'image', provider = null, prompt = '', params = {}, sourcePaths = [] } = {}) {
        return this._createGenerationTask(kind, provider, prompt, params, sourcePaths);
    }

    _updateGenerationTask(id, patch = {}) {
        const index = this.generationTasks.findIndex(task => task.id === id);
        if (index < 0) return null;
        const current = this.generationTasks[index];
        this.generationTasks[index] = {
            ...current,
            ...patch,
            ...(patch.params && typeof patch.params === 'object' ? {
                params: { ...(current.params || {}), ...patch.params }
            } : {}),
            updatedAt: new Date().toISOString()
        };
        this._saveGenerationTasks();
        this._renderGenerationTasks();
        return this.generationTasks[index];
    }

    updateGenerationTask(id, patch = {}) {
        return this._updateGenerationTask(id, patch);
    }

    getGenerationRecoveryTaskForNode(nodeId) {
        const normalizedNodeId = String(nodeId || '').trim();
        if (!normalizedNodeId) return null;
        return this.generationTasks.find(task =>
            ['disconnected', 'failed', 'canceled'].includes(task?.status)
            && Boolean(task?.taskId)
            && String(task?.params?.nodeId || '') === normalizedNodeId
        ) || null;
    }

    retryGenerationTask(taskId, options = {}) {
        return this._retryGenerationTask(taskId, options);
    }

    _isGenerationDisconnect(error) {
        // 主进程已经明确判定「结果未知」时以此为准（见 imageRequestFailure 的
        // submissionUnknown）。这类失败的语义是"可能已受理、无法确认"，既不该
        // 引导用户重复提交，也不该只当成普通网络失败。下面的关键词匹配仅作为
        // 兜底，覆盖没有结构化标记的其它来源。
        if (error?.submissionUnknown === true) return true;
        const marker = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`;
        return /network|fetch failed|failed to fetch|econn|etimedout|socket|connection|timeout|timed out|aborterror|断开|断连|连接失败|网络|超时/i.test(marker);
    }

    _isVideoPromptModerationFailure(error) {
        const marker = `${error?.message || error || ''}`;
        return /提示词.*(?:审核|未通过|违规)|(?:审核|审核不通过|内容安全).*(?:提示词|prompt)|prompt.*(?:moderation|review|violation|safety)/i.test(marker);
    }

    _recordGenerationError(taskId, error) {
        if (this.recoveringGenerationTasks?.has(taskId)) return this.generationTasks.find(task => task.id === taskId);
        const current = this.generationTasks.find(task => task.id === taskId);
        if (current?.status === 'canceled') return current;
        const message = error?.message || String(error || '请求失败');
        const promptModerationFailed = current?.kind === 'video'
            && Boolean(current?.taskId)
            && this._isVideoPromptModerationFailure(message);
        return this._updateGenerationTask(taskId, {
            status: this._isGenerationDisconnect(error) ? 'disconnected' : 'failed',
            error: message,
            ...(promptModerationFailed ? {
                params: { syncStage: 'prompt_moderation_failed' }
            } : {})
        });
    }

    recordGenerationError(taskId, error) {
        return this._recordGenerationError(taskId, error);
    }

    _isGenerationTaskCanceled(taskId) {
        return this.generationTasks.find(task => task.id === taskId)?.status === 'canceled';
    }

    _generationCancellationError() {
        const error = new Error('生成任务已中断');
        error.name = 'AbortError';
        error.code = 'GENERATION_CANCELED';
        return error;
    }

    /**
     * 把主进程返回的失败结果转成 Error，并保留其结构化语义。
     * `submissionUnknown` 表示「可能已受理、结果无法确认」，必须带上去，
     * 否则 _isGenerationDisconnect 只能靠错误文案里的关键词猜，
     * 会把这类任务误判为可安全重试的普通失败。
     */
    _generationFailureError(result, fallbackMessage = '请求失败') {
        const error = new Error(result?.error || fallbackMessage);
        if (result?.submissionUnknown === true) error.submissionUnknown = true;
        return error;
    }

    async _cancelGenerationTask(taskId) {
        const task = this.generationTasks.find(item => item.id === taskId);
        if (!task || task.status !== 'running') return false;
        this._updateGenerationTask(taskId, {
            status: 'canceled',
            error: null,
            params: { syncStage: 'canceled', progress: null }
        });
        if (this.activeVideoWorkspaceTaskId === taskId) this.activeVideoWorkspaceTaskId = null;
        try {
            await window.flowCanvas?.mcp?.cancelGeneration?.(taskId);
        } catch (error) {
            console.warn('[Agent] 中断生成请求失败', error);
        }
        return true;
    }

    cancelGenerationTask(taskId) {
        return this._cancelGenerationTask(taskId);
    }

    async cancelGenerationTasksForNode(nodeId) {
        const taskIds = this.generationTasks
            .filter(task => task.status === 'running' && task.params?.nodeId === nodeId)
            .map(task => task.id);
        await Promise.all(taskIds.map(taskId => this._cancelGenerationTask(taskId)));
        return taskIds.length > 0;
    }

    _setTaskHistoryOpen(open) {
        const nextOpen = Boolean(open);
        this.taskHistoryOpen = nextOpen;
        if (this.taskHistoryPanel) this.taskHistoryPanel.hidden = !nextOpen;
        if (this.taskHistoryBtn) {
            this.taskHistoryBtn.classList.toggle('active', nextOpen);
            this.taskHistoryBtn.setAttribute('aria-expanded', String(nextOpen));
            this.taskHistoryBtn.title = nextOpen ? '关闭任务记录' : '打开任务记录';
            this.taskHistoryBtn.setAttribute('aria-label', this.taskHistoryBtn.title);
        }
        if (nextOpen) {
            this._renderGenerationTasks();
            void this._syncRecoverableGenerations();
        }
    }

    _escapeTaskText(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

    _formatTaskTime(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).format(date);
    }

    _taskParameterSummary(task) {
        if (task.kind === 'image') {
            const qualityLabel = {
                auto: '自动质量',
                low: '低质量',
                medium: '中等质量',
                high: '高质量'
            }[task.params?.quality || 'high'];
            return [task.params?.size || '自动尺寸', qualityLabel].filter(Boolean).join(' · ');
        }
        return [
            task.params?.resolution,
            task.params?.ratio,
            task.params?.duration != null ? `${task.params.duration} 秒` : null
        ].filter(Boolean).join(' · ') || '模型默认参数';
    }

    _renderGenerationTasks() {
        this.options.onGenerationTasksChanged?.(this.generationTasks);
        const visibleTasks = this.taskHistoryFilter === 'all'
            ? this.generationTasks
            : this.generationTasks.filter(task => task.kind === this.taskHistoryFilter);
        const pendingCount = visibleTasks.filter(task => task.status === 'running').length;
        const readyCount = visibleTasks.filter(task => task.status === 'running' && task.params?.syncStage === 'ready').length;
        const downloadingCount = visibleTasks.filter(task => task.status === 'running' && task.params?.syncStage === 'downloading').length;
        const generatingCount = Math.max(0, pendingCount - readyCount - downloadingCount);
        const disconnectedCount = visibleTasks.filter(task => task.status === 'disconnected').length;
        const badgeCount = this.generationTasks.filter(task => ['running', 'disconnected'].includes(task.status)).length;
        if (this.taskHistoryBadge) {
            this.taskHistoryBadge.textContent = String(badgeCount);
        }
        if (this.taskHistorySummary) {
            const pieces = [this.taskHistoryFilter === 'all'
                ? `共 ${this.generationTasks.length} 条`
                : `${this.taskHistoryFilter === 'image' ? '图片' : '视频'} ${visibleTasks.length} 条`];
            if (generatingCount) pieces.push(`${generatingCount} 条生成中`);
            if (readyCount) pieces.push(`${readyCount} 条待下载`);
            if (downloadingCount) pieces.push(`${downloadingCount} 条下载中`);
            if (disconnectedCount) pieces.push(`${disconnectedCount} 条待重传`);
            this.taskHistorySummary.textContent = visibleTasks.length ? pieces.join(' · ') : '还没有生成任务';
        }
        if (!this.taskHistoryList) return;
        if (visibleTasks.length === 0) {
            this.taskHistoryList.innerHTML = `
                <div class="agent-task-history-empty">
                    <svg class="flow-icon flow-icon-lg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-history"></use></svg>
                    <strong>暂无任务记录</strong>
                    <span>${this.taskHistoryFilter === 'all' ? '图片和视频生成任务会显示在这里' : `还没有${this.taskHistoryFilter === 'image' ? '图片' : '视频'}任务`}</span>
                </div>`;
            return;
        }

        const statusLabels = {
            running: '生成中',
            success: '已完成',
            failed: '失败',
            disconnected: '待重传',
            canceled: '已中断'
        };
        this.taskHistoryList.innerHTML = visibleTasks.map(task => {
            const status = statusLabels[task.status] ? task.status : 'failed';
            let syncStageLabel = status === 'running' && task.params?.syncStage === 'ready'
                ? '待下载'
                : status === 'running' && task.params?.syncStage === 'downloading'
                    ? '下载中'
                    : status === 'running' && task.params?.syncStage === 'recovering'
                        ? '\u6062\u590d\u8fde\u63a5\u4e2d'
                        : status === 'failed' && task.params?.syncStage === 'prompt_moderation_failed'
                            ? '提示词审核失败'
                        : statusLabels[status];
            if (status === 'running' && task.params?.syncStage === 'upload') {
                syncStageLabel = '上传素材中';
            } else if (status === 'running' && task.params?.syncStage === 'submit') {
                syncStageLabel = '提交任务中';
            } else if (status === 'running' && task.params?.syncStage === 'queued') {
                syncStageLabel = '等待模型处理';
            } else if (status === 'running' && task.params?.syncStage === 'processing') {
                const progress = Number(task.params?.progress);
                syncStageLabel = Number.isFinite(progress) ? `模型生成中 ${progress}%` : '模型生成中';
            }
            const sourceCount = (Array.isArray(task.sourcePaths) ? task.sourcePaths.length : 0)
                + (task.params?.videoSourcePaths?.length || 0)
                + (task.params?.audioSourcePaths?.length || 0);
            const recovering = this.recoveringGenerationTasks?.has(task.id);
            const promptModerationFailed = task.kind === 'video'
                && task.params?.syncStage === 'prompt_moderation_failed'
                && Boolean(task.taskId);
            const canRetry = !task.taskId && !task.filePath && (status === 'failed' || status === 'disconnected');
            const retryLabel = '重新提交';
            const errorCopy = status === 'disconnected'
                ? task.error || '与生成服务断开，任务 ID 和参数已保留。'
                : task.error || (recovering ? task.params?.recoveryError : null);
            return `
                <article class="agent-task-item status-${status}">
                    <div class="agent-task-item-topline">
                        <span class="agent-task-kind">${task.kind === 'video' ? '视频' : '图片'}</span>
                        <span class="agent-task-status"><i aria-hidden="true"></i>${syncStageLabel}</span>
                        <time>${this._escapeTaskText(this._formatTaskTime(task.updatedAt || task.createdAt))}</time>
                    </div>
                    <div class="agent-task-prompt-row">
                        <p class="agent-task-prompt" title="${this._escapeTaskText(task.prompt)}">${this._escapeTaskText(task.prompt)}</p>
                        <button class="agent-task-copy-prompt" type="button" data-copy-task-prompt="${this._escapeTaskText(task.id)}" title="复制提示词" aria-label="复制提示词">
                            <svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-copy"></use></svg>
                        </button>
                    </div>
                    <div class="agent-task-meta">
                        <span title="${this._escapeTaskText(task.providerName)}">${this._escapeTaskText(task.providerName || 'API 已移除')}</span>
                        <span title="${this._escapeTaskText(task.model)}">${this._escapeTaskText(task.model || '未知模型')}</span>
                        <span>${this._escapeTaskText(this._taskParameterSummary(task))}</span>
                        ${sourceCount ? `<span>${sourceCount} 个参考素材</span>` : ''}
                    </div>
                    ${task.filePath ? `<p class="agent-task-file" title="${this._escapeTaskText(task.filePath)}">${this._escapeTaskText(task.filePath)}</p>` : ''}
                    ${errorCopy ? `<p class="agent-task-error" title="${this._escapeTaskText(errorCopy)}">${this._escapeTaskText(errorCopy)}</p>` : ''}
                    <div class="agent-task-recovery">
                        <code title="${this._escapeTaskText(task.taskId || '')}">${this._escapeTaskText(task.taskId || '未记录上游任务 ID')}</code>
                        ${task.taskId ? `<button type="button" data-copy-remote-task="${this._escapeTaskText(task.id)}" title="复制任务 ID" aria-label="复制任务 ID"><svg class="flow-icon flow-icon-xs"><use href="./icons/flow-icons.svg#icon-copy"></use></svg></button>` : ''}
                        <button type="button" data-recover-task="${this._escapeTaskText(task.id)}" data-edit-task-id="true" title="补填任务 ID" aria-label="补填任务 ID" ${recovering ? 'disabled' : ''}><svg class="flow-icon flow-icon-xs"><use href="./icons/flow-icons.svg#icon-connections"></use></svg></button>
                        <button type="button" data-recover-task="${this._escapeTaskText(task.id)}" ${recovering ? 'disabled' : ''}>${recovering ? '正在恢复' : (promptModerationFailed ? '继续恢复' : '拉取产物')}</button>
                        ${recovering ? `<button type="button" data-stop-recovery="${this._escapeTaskText(task.id)}">停止</button>` : ''}
                    </div>
                    ${canRetry ? `
                        <div class="agent-task-retry-row">
                            <span>没有任务 ID，重新提交会创建新任务</span>
                            <button type="button" data-retry-task="${this._escapeTaskText(task.id)}">
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                                    <path d="M20 7v5h-5"></path><path d="M4 17v-5h5"></path><path d="M6.1 9a7 7 0 0 1 11.4-2L20 12M4 12l2.5 5a7 7 0 0 0 11.4-2"></path>
                                </svg>
                                ${retryLabel}
                            </button>
                        </div>` : ''}
                </article>`;
        }).join('');
    }

    async _copyGenerationTaskPrompt(taskId, button) {
        const task = this.generationTasks.find(item => item.id === taskId);
        const prompt = String(task?.prompt || '');
        if (!prompt) return;

        try {
            const result = await window.flowCanvas?.clipboard?.writeText?.(prompt);
            if (result && result.success === false) throw new Error(result.error || '复制失败');
            if (!window.flowCanvas?.clipboard?.writeText) await navigator.clipboard.writeText(prompt);
            button.classList.remove('copy-failed');
            button.classList.add('copied');
            button.title = '已复制';
            button.setAttribute('aria-label', '提示词已复制');
        } catch (error) {
            console.warn('[Agent] 复制任务提示词失败', error);
            button.classList.remove('copied');
            button.classList.add('copy-failed');
            button.title = '复制失败';
            button.setAttribute('aria-label', '提示词复制失败');
        }

        setTimeout(() => {
            if (!button.isConnected) return;
            button.classList.remove('copied', 'copy-failed');
            button.title = '复制提示词';
            button.setAttribute('aria-label', '复制提示词');
        }, 1400);
    }

    async _syncRecoverableGenerations() {
        if (!window.flowCanvas?.mcp?.listRecoverableGenerations || this.syncingRecoverableGenerations) return;
        this.syncingRecoverableGenerations = true;
        try {
            const records = await window.flowCanvas.mcp.listRecoverableGenerations();
            for (const record of records) {
                let task = this.generationTasks.find(item => item.id === record.clientTaskId);
                if (!task) {
                    if (!record.taskId && !record.filePath) continue;
                    task = { id: record.clientTaskId, kind: record.kind, projectId: record.projectId,
                        providerId: record.providerId, providerName: record.model, model: record.model,
                        prompt: record.prompt, sourcePaths: record.sourcePaths || [], params: record.params || {}, attempts: 1,
                        createdAt: record.createdAt || record.updatedAt, updatedAt: record.updatedAt,
                        status: 'disconnected' };
                    this.generationTasks.unshift(task);
                }
                if (this.recoveringGenerationTasks?.has(task.id)) continue;
                task.taskId = record.taskId || task.taskId;
                task.filePath = record.filePath || task.filePath;
                task.filePaths = record.filePaths?.length ? record.filePaths : task.filePaths;
                task.params = { ...task.params, nodeId: task.params?.nodeId || record.nodeId,
                    targetDir: record.targetDir || task.params?.targetDir };
            }
            this._saveGenerationTasks();
            this._renderGenerationTasks();
        } catch (error) { console.warn('[Agent] 恢复记录同步失败', error); }
        finally { this.syncingRecoverableGenerations = false; }
    }

    async _recoverGenerationTask(taskId, editId = false) {
        const task = this.generationTasks.find(item => item.id === taskId);
        if (!task) return;
        this.recoveringGenerationTasks ||= new Set();
        if (this.recoveringGenerationTasks.has(taskId)) return;
        let remoteTaskId = task.taskId;
        if (editId || (!remoteTaskId && !task.filePath)) {
            remoteTaskId = await requestRecoveryTaskId(task);
            if (!remoteTaskId) return;
        }
        if (this.recoveringGenerationTasks.has(taskId)) return;
        const sourceProviderId = String(task.providerId || '').split('::model:')[0];
        const currentProvider = this.providers.find(item => item.id === sourceProviderId);
        this.recoveringGenerationTasks.add(taskId);
        this._updateGenerationTask(taskId, { status: 'running', error: null, taskId: remoteTaskId,
            ...(remoteTaskId !== task.taskId ? { filePath: null, filePaths: [] } : {}),
            params: { syncStage: 'recovering', recoveryStartedAt: Date.now() } });
        try {
            if (!window.flowCanvas?.mcp?.recoverGeneration) throw new Error('请重启 Flow Canvas 以启用新版任务恢复接口');
            const result = await window.flowCanvas.mcp.recoverGeneration({
                clientTaskId: task.id, taskId: remoteTaskId, kind: task.kind,
                projectId: task.projectId || this.options.getActiveProjectId?.(), nodeId: task.params?.nodeId,
                prompt: task.prompt, params: task.params, sourcePaths: task.sourcePaths,
                targetDir: task.params?.targetDir,
                providerConfig: { ...currentProvider, sourceProviderId, model: task.model || currentProvider?.model }
            });
            if (result?.success === false) {
                this._updateGenerationTask(taskId, { status: result.canceled ? 'canceled' : 'disconnected', error: result.error });
                return;
            }
            this._updateGenerationTask(taskId, { status: 'success', error: null,
                projectId: result.projectId || task.projectId,
                taskId: result.taskId || remoteTaskId, filePath: result.filePath, filePaths: result.filePaths || [result.filePath],
                params: { nodeId: result.nodeId || task.params?.nodeId, syncStage: 'completed' } });
        } catch (error) {
            this._updateGenerationTask(taskId, { status: 'disconnected', error: error.message });
        } finally {
            this.recoveringGenerationTasks.delete(taskId);
            this._renderGenerationTasks();
        }
    }

    async _retryGenerationTask(taskId, options = {}) {
        const task = this.generationTasks.find(item => item.id === taskId);
        if (task?.taskId || task?.filePath) return this._recoverGenerationTask(taskId);
        if (!task || !['failed', 'disconnected'].includes(task.status)) return;
        const originalNodeId = String(task.params?.nodeId || '').trim();
        const restoreOnOriginalNode = options.restoreOnOriginalNode === true
            && Boolean(originalNodeId)
            && typeof this.options.completeGenerationTaskOnNode === 'function';
        const shouldResumeVideo = task.kind === 'video'
            && Boolean(task.taskId)
            && (task.status === 'disconnected'
                || task.params?.syncStage === 'download'
                || task.params?.syncStage === 'prompt_moderation_failed')
            && Boolean(window.flowCanvas?.mcp?.resumeVideo);
        const sourceProviderId = String(task.providerId || '').split('::model:')[0];
        const currentProvider = this.providers.find(item => item.id === sourceProviderId);
        const provider = currentProvider
            ? {
                ...currentProvider,
                id: task.providerId,
                sourceProviderId,
                model: task.model || currentProvider.model
            }
            : null;
        if (!provider?.apiKey || !provider?.endpoint || !provider?.model) {
            this._updateGenerationTask(task.id, {
                status: 'failed',
                error: '原任务使用的 API 配置已移除或不完整，请先在设置中恢复该 API。'
            });
            return;
        }

        let retryImageReferences = task.kind === 'image'
            ? task.sourcePaths.map(filePath => ({ filePath }))
            : [];
        if (retryImageReferences.length > 0) {
            try {
                const prepared = await this._prepareImageReferencesForGeneration(retryImageReferences);
                if (prepared === CANCELED_IMAGE_REFERENCES) {
                    this._updateGenerationTask(task.id, {
                        error: '已取消参考图处理，未重新提交任务'
                    });
                    return;
                }
                if (!prepared) return;
                retryImageReferences = prepared.references;
            } catch (error) {
                this._recordGenerationError(task.id, error);
                return;
            }
        }
        this._updateGenerationTask(task.id, {
            status: 'running',
            error: null,
            attempts: (task.attempts || 1) + 1,
            params: {
                syncStage: shouldResumeVideo ? 'recovering' : 'submit'
            },
            ...(task.kind === 'image' ? {
                sourcePaths: retryImageReferences.map(reference => reference.filePath).filter(Boolean)
            } : {})
        });
        let placeholder = null;
        let result = null;
        try {
            if (task.kind === 'image') {
                placeholder = restoreOnOriginalNode ? null : this.options.beginImageGeneration?.({
                    size: task.params?.size,
                    sourceReferences: retryImageReferences,
                    onCancel: () => this._cancelGenerationTask(task.id)
                }) || null;
                if (!window.flowCanvas?.mcp?.generateImage) throw new Error('本地生图接口不可用');
                result = await window.flowCanvas.mcp.generateImage({
                    provider: 'openai',
                    providerConfig: provider,
                    clientTaskId: task.id,
                    prompt: task.prompt,
                    size: task.params?.size || undefined,
                    quality: task.params?.quality || 'high',
                    responseFormat: task.params?.responseFormat || 'url',
                    historyDisabled: task.params?.historyDisabled !== false,
                    stream: task.params?.stream === true,
                    sourceReferences: retryImageReferences,
                    x: placeholder?.x,
                    y: placeholder?.y,
                    canvasWidth: placeholder?.width,
                    canvasHeight: placeholder?.height,
                    addToCanvas: !restoreOnOriginalNode
                });
            } else {
                if (!window.flowCanvas?.mcp?.generateVideo && !shouldResumeVideo) throw new Error('本地视频接口不可用');
                placeholder = restoreOnOriginalNode ? null : this.options.beginVideoGeneration?.({
                    ratio: task.params?.ratio || '16:9',
                    sourceReferences: task.sourcePaths.map(filePath => ({ filePath })),
                    onCancel: () => this._cancelGenerationTask(task.id)
                }) || null;
                result = shouldResumeVideo
                    ? await window.flowCanvas.mcp.resumeVideo({
                        providerConfig: provider,
                        clientTaskId: task.id,
                        taskId: task.taskId,
                        prompt: task.prompt,
                        targetDir: task.params?.targetDir || undefined,
                        x: placeholder?.x,
                        y: placeholder?.y,
                        canvasWidth: placeholder?.width,
                        canvasHeight: placeholder?.height,
                        addToCanvas: !restoreOnOriginalNode
                    })
                    : await window.flowCanvas.mcp.generateVideo({
                    provider: 'openai-video',
                    providerConfig: provider,
                    clientTaskId: task.id,
                    prompt: task.prompt,
                    sourceReferences: task.sourcePaths.map(filePath => ({ filePath })),
                    videoReferences: (task.params?.videoSourcePaths || []).map(filePath => ({ filePath })),
                    audioReferences: (task.params?.audioSourcePaths || []).map(filePath => ({ filePath })),
                    resolution: task.params?.resolution || undefined,
                    ratio: task.params?.ratio || undefined,
                    duration: task.params?.duration ?? undefined,
                    cameraFixed: task.params?.cameraFixed,
                    generateAudio: task.params?.generateAudio,
                    webSearch: task.params?.webSearch,
                    watermark: task.params?.watermark,
                    compressReferenceImages: task.params?.compressReferenceImages === true,
                    x: placeholder?.x,
                    y: placeholder?.y,
                    canvasWidth: placeholder?.width,
                    canvasHeight: placeholder?.height,
                    addToCanvas: !restoreOnOriginalNode
                });
            }
            if (this._isGenerationTaskCanceled(task.id) || result?.canceled) {
                throw this._generationCancellationError();
            }
            if (result?.success === false) throw this._generationFailureError(result, '生成请求失败');
            if (restoreOnOriginalNode) {
                const restored = await this.options.completeGenerationTaskOnNode({
                    nodeId: originalNodeId,
                    kind: task.kind,
                    taskId: task.id,
                    result
                });
                if (!restored) throw new Error('原生成节点已不存在，无法恢复到原位置');
            }
            this._updateGenerationTask(task.id, {
                status: 'success',
                error: null,
                filePath: result?.filePath || null,
                taskId: result?.taskId || null
            });
        } catch (error) {
            this._recordGenerationError(task.id, error);
        } finally {
            if (placeholder?.id) {
                if (task.kind === 'image') this.options.endImageGeneration?.(placeholder.id, result?.item?.id);
                else this.options.endVideoGeneration?.(placeholder.id, result?.item?.id);
            }
        }
    }

    async _inspectLargeReferenceImages(references, thresholdBytes = VIDEO_REFERENCE_LARGE_TOTAL_BYTES) {
        if (!window.flowCanvas?.file?.inspect || references.length === 0) return null;
        const entries = (await Promise.all(references.map(async reference => {
            try {
                const inspection = await window.flowCanvas.file.inspect(reference.filePath);
                if (!inspection?.exists || !inspection?.isFile || !Number.isFinite(inspection.size)) return null;
                return {
                    filePath: reference.filePath,
                    name: String(reference.filePath || '').split(/[\\/]/).pop() || '\u672a\u547d\u540d\u56fe\u7247',
                    size: inspection.size
                };
            } catch (_) {
                return null;
            }
        }))).filter(Boolean);
        const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
        if (totalBytes <= thresholdBytes) return null;
        return {
            entries,
            totalBytes,
            encodedBytes: Math.ceil(totalBytes * 4 / 3)
        };
    }

    _formatFileSize(bytes) {
        const value = Number(bytes) || 0;
        if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
        return `${(value / (1024 * 1024)).toFixed(2)} MB`;
    }

    _showReferenceCompressionDialog(summary, mode = 'video', { manual = false } = {}) {
        const isImageMode = mode === 'image';
        const note = isImageMode
            ? '批量转小会生成压缩副本并替换当前参考选择，原图不会被修改。你可以选择是否把副本放入画板。'
            : '压缩会生成新图片并放到画板上，原图不会被修改。压缩完成后不会自动生成视频。';
        const confirmLabel = isImageMode
            ? (manual ? '转小并放入画板' : '转小到画板并继续')
            : '压缩到画板';
        // 同一时刻只允许存在一个参考图处理弹层。若已经有一个（例如侧栏提交
        // 挂起时用户又按了 Ctrl+Enter 从画布触发了同一条准备流程），必须先让它
        // 正常结束：直接 remove 掉 DOM 会留下一个永不 settle 的 Promise，
        // 调用方的 await 永久挂起、finally 不执行 → 「生成」按钮永久 disabled
        // 且没有任何提示，另外还会残留一个 document keydown 监听器。
        const previous = this._activeCompressionDialog;
        this._activeCompressionDialog = null;
        if (previous) {
            try {
                previous('cancel');
            } catch (error) {
                console.error('[AgentSidebar] 关闭上一个参考图处理弹层失败:', error);
            }
        }

        return new Promise(resolve => {
            let settled = false;
            const finish = choice => {
                if (settled) return;
                settled = true;
                if (this._activeCompressionDialog === finish) this._activeCompressionDialog = null;
                document.removeEventListener('keydown', onKeyDown);
                overlay.remove();
                resolve(choice);
            };

            const overlay = document.createElement('div');
            overlay.className = `video-compression-dialog-overlay${isImageMode ? ' image-reference-compression' : ''}`;
            overlay.innerHTML = `
                <div class="video-compression-dialog" role="dialog" aria-modal="true" aria-labelledby="videoCompressionDialogTitle">
                    <div class="video-compression-dialog-header">
                        <div>
                            <h2 id="videoCompressionDialogTitle">\u53c2\u8003\u56fe\u8f83\u5927</h2>
                            <p>\u4e0a\u4f20\u7f16\u7801\u540e\u7ea6 ${this._formatFileSize(summary.encodedBytes)}\uff0c\u53ef\u80fd\u88ab API \u7f51\u5173\u62d2\u7edd\u3002</p>
                        </div>
                        <button class="video-compression-dialog-close" type="button" aria-label="\u5173\u95ed">\u00d7</button>
                    </div>
                    <div class="video-compression-file-list"></div>
                    <p class="video-compression-dialog-note">${note}</p>
                    <div class="video-compression-dialog-actions">
                        <button class="video-compression-cancel" type="button">\u53d6\u6d88</button>
                        ${isImageMode ? '<button class="video-compression-temporary" type="button">转小但不放画板</button>' : ''}
                        ${manual ? '' : '<button class="video-compression-original" type="button">使用原图继续生成</button>'}
                        <button class="video-compression-confirm" type="button">${confirmLabel}</button>
                    </div>
                </div>
            `;
            const list = overlay.querySelector('.video-compression-file-list');
            summary.entries.forEach(entry => {
                const row = document.createElement('div');
                row.className = 'video-compression-file-row';
                const name = document.createElement('span');
                name.textContent = entry.name;
                name.title = entry.filePath;
                const size = document.createElement('strong');
                size.textContent = this._formatFileSize(entry.size);
                row.append(name, size);
                list.appendChild(row);
            });

            const onKeyDown = event => {
                if (event.key === 'Escape') finish('cancel');
            };
            overlay.querySelector('.video-compression-dialog-close')?.addEventListener('click', () => finish('cancel'));
            overlay.querySelector('.video-compression-cancel')?.addEventListener('click', () => finish('cancel'));
            overlay.querySelector('.video-compression-original')?.addEventListener('click', () => finish('original'));
            overlay.querySelector('.video-compression-temporary')?.addEventListener('click', () => finish('compress-temporary'));
            overlay.querySelector('.video-compression-confirm')?.addEventListener('click', () => finish('compress'));
            overlay.addEventListener('click', event => {
                if (event.target === overlay) finish('cancel');
            });
            document.addEventListener('keydown', onKeyDown);
            document.body.appendChild(overlay);
            // 到此为止 overlay / onKeyDown / finish 都已就绪，再登记为"当前弹层"，
            // 供下一次调用顶替时正常收尾（避免上面提到的永久挂起）。
            this._activeCompressionDialog = finish;
            overlay.querySelector('.video-compression-confirm')?.focus();
        });
    }

    async _generateVideoFromWorkspace() {
        if (this.videoGenerateBtn?.disabled) return;
        const provider = this._getVideoProvider();
        const prompt = this.videoPromptInput?.value?.trim() || '';
        if (!prompt) {
            this._setWorkspaceMessage(this.videoGenerateMessage, 'error', '\u8bf7\u5148\u8f93\u5165\u89c6\u9891\u63d0\u793a\u8bcd');
            return;
        }
        if (!provider?.apiKey || !provider?.endpoint || !provider?.model) {
            this._setWorkspaceMessage(this.videoGenerateMessage, 'error', '\u8bf7\u5148\u5728\u8bbe\u7f6e\u6a21\u5f0f\u914d\u7f6e\u89c6\u9891 API');
            return;
        }
        if (!window.flowCanvas?.mcp?.generateVideo) {
            this._setWorkspaceMessage(this.videoGenerateMessage, 'error', '\u672c\u5730\u89c6\u9891\u63a5\u53e3\u4e0d\u53ef\u7528');
            return;
        }

        const imageReferences = this.videoReferenceSelections.image.map(entry => ({
            itemId: entry.itemId || entry.id,
            filePath: entry.filePath,
            width: Number(entry.width) || null,
            height: Number(entry.height) || null
        }));
        const videoReferences = this.videoReferenceSelections.video.map(entry => ({
            itemId: entry.itemId || entry.id,
            filePath: entry.filePath
        }));
        const audioReferences = this.videoReferenceSelections.audio.map(entry => ({
            itemId: entry.itemId || entry.id,
            filePath: entry.filePath
        }));
        if (this.videoGenerateBtn) this.videoGenerateBtn.disabled = true;
        const compressionSummary = await this._inspectLargeReferenceImages(imageReferences);
        if (compressionSummary) {
            const compressionChoice = await this._showReferenceCompressionDialog(compressionSummary, 'video');
            if (compressionChoice === 'cancel') {
                if (this.videoGenerateBtn) this.videoGenerateBtn.disabled = false;
                this._setWorkspaceMessage(this.videoGenerateMessage, '', '');
                return;
            }
            if (compressionChoice === 'compress') {
                if (!window.flowCanvas?.mcp?.compressVideoReferences) {
                    if (this.videoGenerateBtn) this.videoGenerateBtn.disabled = false;
                    this._setWorkspaceMessage(this.videoGenerateMessage, 'error', '\u538b\u7f29\u63a5\u53e3\u4e0d\u53ef\u7528\uff0c\u8bf7\u5b8c\u5168\u9000\u51fa\u5e76\u91cd\u65b0\u542f\u52a8 Flow Canvas');
                    return;
                }
                this._setWorkspaceMessage(this.videoGenerateMessage, '', '\u6b63\u5728\u538b\u7f29\u53c2\u8003\u56fe...');
                try {
                    const compressionResult = await window.flowCanvas.mcp.compressVideoReferences({
                        sourceReferences: imageReferences
                    });
                    if (compressionResult?.success === false) {
                        throw new Error(compressionResult.error || '\u53c2\u8003\u56fe\u538b\u7f29\u5931\u8d25');
                    }
                    const replacements = new Map((compressionResult?.outputs || []).map(output => [
                        String(output.sourceItemId || output.sourceFilePath),
                        output
                    ]));
                    this.videoReferenceSelections.image = this.videoReferenceSelections.image.map(entry => {
                        const replacement = replacements.get(String(entry.itemId || entry.id))
                            || replacements.get(String(entry.filePath));
                        if (!replacement?.item) return entry;
                        return {
                            id: replacement.item.id,
                            itemId: replacement.item.id,
                            filePath: replacement.filePath,
                            mediaType: 'image',
                            width: Number(replacement.item.width) || null,
                            height: Number(replacement.item.height) || null
                        };
                    });
                    this.options.clearMediaReferenceSelections?.();
                    this._renderVideoSourcePreview();
                    const count = compressionResult?.outputs?.length || 0;
                    this._setWorkspaceMessage(
                        this.videoGenerateMessage,
                        'success',
                        `\u5df2\u5c06 ${count} \u5f20\u538b\u7f29\u56fe\u6dfb\u52a0\u5230\u753b\u677f\uff0c\u8bf7\u68c0\u67e5\u540e\u518d\u70b9\u51fb\u751f\u6210\u89c6\u9891`
                    );
                } catch (error) {
                    this._setWorkspaceMessage(this.videoGenerateMessage, 'error', error?.message || String(error));
                } finally {
                    if (this.videoGenerateBtn) this.videoGenerateBtn.disabled = false;
                }
                return;
            }
        }
        // The expensive generation request is independent per task. Only the optional
        // compression preflight keeps the button locked; submissions may run in parallel.
        if (this.videoGenerateBtn) this.videoGenerateBtn.disabled = false;
        const durationValue = this.videoDurationSelect?.value;
        const profile = this._getVideoModelProfile(provider) || DEFAULT_VIDEO_MODEL_PROFILE;
        const ratio = this._resolveVideoRequestRatio(profile, imageReferences);
        const videoParams = {
            resolution: this.videoResolutionSelect?.value || null,
            ratio,
            ratioMode: this.videoRatioSelect?.value === 'adaptive' ? 'auto' : 'manual',
            duration: durationValue === '' || durationValue == null ? null : Number(durationValue),
            cameraFixed: Boolean(this.videoCameraFixed?.checked),
            generateAudio: Boolean(this.videoGenerateAudio?.checked),
            webSearch: profile.supportsWebSearch ? Boolean(this.videoWebSearch?.checked) : null,
            watermark: Boolean(this.videoWatermark?.checked),
            compressReferenceImages: false,
            videoSourcePaths: videoReferences.map(reference => reference.filePath).filter(Boolean),
            audioSourcePaths: audioReferences.map(reference => reference.filePath).filter(Boolean)
        };
        const generationTask = this._createGenerationTask(
            'video',
            provider,
            prompt,
            videoParams,
            imageReferences.map(reference => reference.filePath).filter(Boolean)
        );
        this.activeVideoWorkspaceTaskId = generationTask.id;
        if (this.videoWorkspaceStatus) this.videoWorkspaceStatus.textContent = '\u751f\u6210\u4e2d';
        this._setWorkspaceMessage(this.videoGenerateMessage, '', '\u6b63\u5728\u63d0\u4ea4\u4efb\u52a1...');
        const placeholder = this.options.beginVideoGeneration?.({
            ratio,
            sourceReferences: imageReferences,
            onCancel: () => this._cancelGenerationTask(generationTask.id)
        }) || null;
        let result = null;

        try {
            result = await window.flowCanvas.mcp.generateVideo({
                provider: 'openai-video',
                providerConfig: provider,
                clientTaskId: generationTask.id,
                prompt,
                sourceReferences: imageReferences,
                videoReferences,
                audioReferences,
                resolution: videoParams.resolution || undefined,
                ratio: videoParams.ratio || undefined,
                duration: videoParams.duration ?? undefined,
                cameraFixed: videoParams.cameraFixed,
                generateAudio: videoParams.generateAudio,
                webSearch: videoParams.webSearch ?? undefined,
                watermark: videoParams.watermark,
                compressReferenceImages: videoParams.compressReferenceImages,
                x: placeholder?.x,
                y: placeholder?.y,
                canvasWidth: placeholder?.width,
                canvasHeight: placeholder?.height,
                addToCanvas: true
            });
            if (this._isGenerationTaskCanceled(generationTask.id) || result?.canceled) {
                throw this._generationCancellationError();
            }
            if (result?.success === false) throw new Error(result.error || '\u89c6\u9891\u751f\u6210\u8bf7\u6c42\u5931\u8d25');
            this._updateGenerationTask(generationTask.id, {
                status: 'success',
                error: null,
                filePath: result?.filePath || null,
                taskId: result?.taskId || null
            });
            if (this.videoWorkspaceStatus) this.videoWorkspaceStatus.textContent = '\u5df2\u5b8c\u6210';
            this._setWorkspaceMessage(
                this.videoGenerateMessage,
                'success',
                result?.filePath ? '\u5df2\u6dfb\u52a0\u5230\u753b\u677f\uff1a' + result.filePath : '\u89c6\u9891\u5df2\u751f\u6210'
            );
        } catch (error) {
            this._recordGenerationError(generationTask.id, error);
            const canceled = this._isGenerationTaskCanceled(generationTask.id);
            if (this.videoWorkspaceStatus) this.videoWorkspaceStatus.textContent = canceled ? '已中断' : '\u5931\u8d25';
            this._setWorkspaceMessage(
                this.videoGenerateMessage,
                canceled ? '' : 'error',
                canceled ? '生成任务已中断' : (error?.message || String(error))
            );
        } finally {
            if (placeholder?.id) this.options.endVideoGeneration?.(placeholder.id, result?.item?.id);
        }
    }

    _referencePathKey(filePath) {
        return String(filePath || '').replaceAll('/', '\\').toLowerCase();
    }

    _applyCompressedImageReferences(outputs = []) {
        const replacements = new Map();
        outputs.forEach(output => {
            if (output?.sourceItemId) replacements.set(`id:${output.sourceItemId}`, output);
            if (output?.sourceFilePath) replacements.set(`path:${this._referencePathKey(output.sourceFilePath)}`, output);
        });
        this.imageReferenceSelections = this.imageReferenceSelections.map(entry => {
            const replacement = replacements.get(`id:${entry.itemId || entry.id}`)
                || replacements.get(`path:${this._referencePathKey(entry.filePath)}`);
            if (!replacement?.filePath) return entry;
            const replacementItemId = replacement.item?.id || entry.itemId || entry.id;
            return {
                ...entry,
                id: replacementItemId,
                itemId: replacementItemId,
                filePath: replacement.filePath,
                mediaType: 'image',
                temporary: !replacement.item,
                referenceId: replacement.referenceId || entry.referenceId || null,
                cacheReused: replacement.cacheReused === true
            };
        });
        this.options.updateMediaReferencePick?.('image', this.imageReferenceSelections);
        this._renderImageReferences();
    }

    async _compressImageReferences(references, {
        updateSelection = false,
        uploadBudgetBytes = IMAGE_REFERENCE_UPLOAD_BUDGET_BYTES,
        addToCanvas = true
    } = {}) {
        if (!window.flowCanvas?.mcp?.compressImageReferences) {
            throw new Error('批量转小接口不可用，请完全退出并重新启动 Flow Canvas');
        }
        const result = await window.flowCanvas.mcp.compressImageReferences({
            sourceReferences: references,
            uploadBudgetBytes,
            addToCanvas
        });
        if (result?.success === false) {
            throw new Error(result.error || '参考图批量转小失败');
        }
        const outputs = result?.outputs || [];
        const replacements = new Map(outputs.map(output => [
            this._referencePathKey(output.sourceFilePath),
            output
        ]));
        const nextReferences = references.map(reference => {
            const replacement = replacements.get(this._referencePathKey(reference.filePath));
            return replacement?.filePath
                ? {
                    itemId: replacement.item?.id || reference.itemId,
                    filePath: replacement.filePath,
                    temporary: !replacement.item,
                    referenceId: replacement.referenceId || reference.referenceId || null,
                    cacheReused: replacement.cacheReused === true
                }
                : reference;
        });
        if (updateSelection) this._applyCompressedImageReferences(outputs);
        return { references: nextReferences, outputs, addToCanvas };
    }

    async _prepareImageReferencesForGeneration(references, { updateSelection = false } = {}) {
        const summary = await this._inspectLargeReferenceImages(
            references,
            IMAGE_REFERENCE_UPLOAD_BUDGET_BYTES
        );
        if (!summary) return { references, outputs: [] };
        if (this.globalConfig.defaultTemporaryImageCompression === true) {
            return this._compressImageReferences(references, {
                updateSelection,
                addToCanvas: false
            });
        }
        const choice = await this._showReferenceCompressionDialog(summary, 'image');
        if (choice === 'cancel') return CANCELED_IMAGE_REFERENCES;
        if (choice === 'original') return { references, outputs: [] };
        return this._compressImageReferences(references, {
            updateSelection,
            addToCanvas: choice !== 'compress-temporary'
        });
    }

    async _compressSelectedImageReferences() {
        const references = this.imageReferenceSelections
            .filter(entry => entry?.filePath)
            .map(entry => ({ itemId: entry.itemId || entry.id, filePath: entry.filePath }));
        if (references.length === 0 || this.imageCompressReferencesBtn?.disabled) return;
        const summary = await this._inspectLargeReferenceImages(references, 0);
        if (!summary) return;
        const choice = await this._showReferenceCompressionDialog(summary, 'image', { manual: true });
        if (choice === 'cancel') return;
        const addToCanvas = choice !== 'compress-temporary';
        if (this.imageCompressReferencesBtn) this.imageCompressReferencesBtn.disabled = true;
        this._setWorkspaceMessage(this.imageGenerateMessage, '', '正在批量转小参考图...');
        try {
            const result = await this._compressImageReferences(references, {
                updateSelection: true,
                uploadBudgetBytes: IMAGE_REFERENCE_MANUAL_BUDGET_BYTES,
                addToCanvas
            });
            const count = result.outputs.length;
            this._setWorkspaceMessage(
                this.imageGenerateMessage,
                'success',
                addToCanvas
                    ? `已生成 ${count} 张较小副本并放入画板，原图保持不变`
                    : `已缓存 ${count} 张较小副本，未添加到画板，可在后续任务中复用`
            );
        } catch (error) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', error?.message || String(error));
        } finally {
            if (this.imageCompressReferencesBtn) this.imageCompressReferencesBtn.disabled = false;
        }
    }

    _handleVideoProgress(event = {}) {
        const clientTaskId = String(event.clientTaskId || '').trim();
        if (!clientTaskId) return;
        const task = this.generationTasks.find(item => item.id === clientTaskId);
        if (!task) return;

        const stage = String(event.stage || 'processing');
        const progress = Number.isFinite(Number(event.progress)) ? Number(event.progress) : null;
        this._updateGenerationTask(task.id, {
            params: {
                ...(task.params || {}),
                syncStage: stage,
                progress,
                recoveryError: event.lastError || null,
                remoteStatus: event.remoteStatus || null
            }
        });

        if (clientTaskId !== this.activeVideoWorkspaceTaskId) return;
        const mediaType = String(event.mediaType || '参考素材');
        const index = Number(event.current);
        const total = Number(event.total);
        const messages = {
            prepare: '正在读取参考素材...',
            submit: '参考素材准备完成，正在提交模型任务...',
            queued: '任务已提交，等待模型处理...',
            recovering: '服务器已接收任务，正在恢复任务连接...',
            download: '模型生成完成，正在下载视频...',
            completed: '视频已下载，正在写入画布...'
        };
        let message = messages[stage] || '模型生成中...';
        if (stage === 'upload') {
            message = Number.isFinite(index) && Number.isFinite(total) && total > 0
                ? `正在上传${mediaType}（${index}/${total}）...`
                : `正在上传${mediaType}...`;
        } else if (stage === 'processing' && progress !== null) {
            message = `模型生成中 · ${progress}%`;
        }
        if (this.videoWorkspaceStatus) this.videoWorkspaceStatus.textContent = stage === 'completed' ? '已完成' : '生成中';
        this._setWorkspaceMessage(this.videoGenerateMessage, '', message);
    }

    async _generateImageFromWorkspace() {
        const provider = this._getImageProvider();
        const prompt = this.imagePromptInput?.value?.trim() || '';
        if (!prompt) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', '\u8bf7\u5148\u8f93\u5165\u56fe\u7247\u63d0\u793a\u8bcd');
            return;
        }
        if (!provider?.apiKey || !provider?.endpoint || !provider?.model) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', '\u8bf7\u5148\u5728\u8bbe\u7f6e\u6a21\u5f0f\u914d\u7f6e\u751f\u56fe API');
            return;
        }
        if (!window.flowCanvas?.mcp?.generateImage) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', '\u672c\u5730\u751f\u56fe\u63a5\u53e3\u4e0d\u53ef\u7528');
            return;
        }

        const size = this.imageSizeSelect?.value || undefined;
        const quality = this.imageQualitySelect?.value || 'high';
        const gptImage2 = isGptImage2Model(provider.model);
        const responseFormat = gptImage2 ? (this.imageResponseFormatSelect?.value || 'url') : 'url';
        const historyDisabled = gptImage2 ? this.imageHistoryDisabled?.checked !== false : true;
        const stream = gptImage2 ? Boolean(this.imageStream?.checked) : false;
        let sourceReferences = this.imageGenerationMode === 'reference'
            ? this.imageReferenceSelections
                .filter(entry => entry?.filePath)
                .map(entry => ({ itemId: entry.itemId || entry.id, filePath: entry.filePath }))
            : [];
        if (this.imageGenerationMode === 'reference' && sourceReferences.length === 0) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', '\u8bf7\u5148\u4ece\u753b\u5e03\u4e2d\u9009\u62e9\u81f3\u5c11\u4e00\u5f20\u53c2\u8003\u56fe');
            return;
        }
        if (sourceReferences.length > 0) {
            if (this.imageGenerateBtn) this.imageGenerateBtn.disabled = true;
            this._setWorkspaceMessage(this.imageGenerateMessage, '', '正在检查参考图大小...');
            try {
                const prepared = await this._prepareImageReferencesForGeneration(sourceReferences, {
                    updateSelection: true
                });
                if (prepared === CANCELED_IMAGE_REFERENCES) {
                    this._setWorkspaceMessage(
                        this.imageGenerateMessage,
                        'error',
                        '已取消参考图处理，本次未开始生成。如需保持原图请重新生成并在提示中选择“保持原图”。'
                    );
                    return;
                }
                if (!prepared) {
                    this._setWorkspaceMessage(
                        this.imageGenerateMessage,
                        'error',
                        '参考图准备服务不可用，已中止生成以避免丢失参考图。'
                    );
                    return;
                }
                sourceReferences = prepared.references;
                if (prepared.outputs.length > 0) {
                    this._setWorkspaceMessage(
                        this.imageGenerateMessage,
                        'success',
                        `已批量转小 ${prepared.outputs.length} 张参考图，正在继续生成...`
                    );
                }
            } catch (error) {
                this._setWorkspaceMessage(this.imageGenerateMessage, 'error', error?.message || String(error));
                return;
            } finally {
                if (this.imageGenerateBtn) this.imageGenerateBtn.disabled = false;
            }
        }
        const sourcePaths = sourceReferences.map(reference => reference.filePath).filter(Boolean);
        const generationTask = this._createGenerationTask('image', provider, prompt, {
            size: size || null,
            quality,
            responseFormat,
            historyDisabled,
            stream
        }, sourcePaths);
        this._setImageWorkspaceStatus('running', '\u751f\u6210\u4e2d');
        this._setWorkspaceMessage(this.imageGenerateMessage, '', '\u6b63\u5728\u751f\u6210...');
        const placeholder = this.options.beginImageGeneration?.({
            size,
            sourceReferences,
            onCancel: () => this._cancelGenerationTask(generationTask.id)
        }) || null;
        let result = null;

        try {
            result = await window.flowCanvas.mcp.generateImage({
                provider: 'openai',
                providerConfig: provider,
                clientTaskId: generationTask.id,
                prompt,
                size,
                quality,
                responseFormat,
                historyDisabled,
                stream,
                sourceReferences,
                x: placeholder?.x,
                y: placeholder?.y,
                canvasWidth: placeholder?.width,
                canvasHeight: placeholder?.height,
                addToCanvas: true
            });
            if (this._isGenerationTaskCanceled(generationTask.id) || result?.canceled) {
                throw this._generationCancellationError();
            }
            if (result?.success === false) throw new Error(result.error || '\u56fe\u7247\u751f\u6210\u8bf7\u6c42\u5931\u8d25');
            this._updateGenerationTask(generationTask.id, {
                status: 'success',
                error: null,
                filePath: result?.filePath || null,
                taskId: result?.taskId || null
            });
            this._setImageWorkspaceStatus('success', '\u5df2\u5b8c\u6210');
            const sizeMessage = result?.actualSize
                ? `\uff0c\u5b9e\u9645\u5c3a\u5bf8 ${result.actualSize}${result.sizeMatchesRequest === false ? `\uff08\u8bf7\u6c42 ${result.requestedSize}\uff09` : ''}`
                : '';
            this._setWorkspaceMessage(
                this.imageGenerateMessage,
                'success',
                result?.filePath ? '\u5df2\u6dfb\u52a0\u5230\u753b\u677f\uff1a' + result.filePath + sizeMessage : '\u56fe\u7247\u5df2\u751f\u6210' + sizeMessage
            );
        } catch (error) {
            this._recordGenerationError(generationTask.id, error);
            const canceled = this._isGenerationTaskCanceled(generationTask.id);
            this._setImageWorkspaceStatus(canceled ? 'idle' : 'failed', canceled ? '已中断' : '\u5931\u8d25');
            this._setWorkspaceMessage(
                this.imageGenerateMessage,
                canceled ? '' : 'error',
                canceled ? '生成任务已中断' : (error?.message || String(error))
            );
        } finally {
            if (placeholder?.id) this.options.endImageGeneration?.(placeholder.id, result?.item?.id);
        }
    }

    open() {
        document.body.classList.add('agent-open');
        this._syncHudState();
        const focusTarget = null;
        if (focusTarget) setTimeout(() => focusTarget.focus(), 120);
    }

    close() {
        this._finishAgentSidebarResize?.();
        // 面板收起时务必解除快捷键录制，否则 _captureShortcut 仍会在 document
        // 捕获阶段吞掉全应用按键（详见 setMode 中的说明）。
        this._cancelShortcutCapture();
        this._closeAgentHeaderPopovers();
        document.body.classList.remove('agent-open');
        this._syncHudState();
    }

    toggle() {
        document.body.classList.toggle('agent-open');
        this._syncHudState();
    }

    _syncHudState() {
        const settingsButton = document.getElementById('agentSettingsBtn');
        const settingsOpen = this.currentMode === 'settings' && document.body.classList.contains('agent-open');
        settingsButton?.classList.toggle('active', settingsOpen);
        settingsButton?.setAttribute('aria-expanded', String(settingsOpen));
        const button = document.getElementById('agentToggleBtn');
        if (!button) return;
        const isOpen = document.body.classList.contains('agent-open');
        const label = isOpen
            ? '左键关闭侧边栏，右键收起画布'
            : '左键打开 AI Agent，右键收起画布';
        button.setAttribute('aria-expanded', String(isOpen));
        button.setAttribute('aria-label', label);
        button.title = label;
    }

    // ── 配置管理 ──
    _loadConfig() {
        try {
            const savedProviders = localStorage.getItem(API_PROVIDERS_STORAGE_KEY);
            const savedGlobal = localStorage.getItem(API_GLOBAL_STORAGE_KEY);
            const savedMeta = localStorage.getItem(API_META_STORAGE_KEY);
            this.localApiConfigPresent = savedProviders !== null || savedGlobal !== null;
            if (savedProviders) {
                const providers = JSON.parse(savedProviders);
                this.providers = (Array.isArray(providers) ? providers : []).map(provider => ({
                    ...provider,
                    capability: inferProviderCapability(provider)
                }));
            }

            if (savedGlobal) {
                this._applyLoadedGlobalConfig(JSON.parse(savedGlobal));
            }
            if (savedMeta) {
                const meta = JSON.parse(savedMeta);
                this.apiConfigRevision = Math.max(0, Number(meta?.revision) || 0);
                this.apiConfigUpdatedAt = typeof meta?.updatedAt === 'string' ? meta.updatedAt : '';
            }
        } catch (e) {
            console.warn('[Agent] 配置加载失败', e);
        }

        this._ensureProviderRoles();
    }

    _applyLoadedGlobalConfig(globalConfig = {}) {
        const source = globalConfig && typeof globalConfig === 'object' ? globalConfig : {};
        Object.assign(this.globalConfig, source);
        this.globalConfig.textProviderId ||= source.chatProviderId || null;
        this.globalConfig.agentExecutionMode = source.agentExecutionMode === 'ask' ? 'ask' : 'auto';
        const availableIds = new Set(this._agentSkills().map(skill => skill.id));
        this.globalConfig.agentSkillIds = (Array.isArray(source.agentSkillIds)
            ? source.agentSkillIds
            : []).filter(id => availableIds.has(id));
        this.globalConfig.imageGenerationPreferences = normalizeImageGenerationPreferences(
            source.imageGenerationPreferences
        );
        if (Number(source.imageIntentPipelineVersion) < 2) {
            this.globalConfig.imageIntentPipelineMode = 'compiled';
            this.globalConfig.imageIntentPipelineVersion = 2;
        }
    }

    _apiConfigSnapshot() {
        return {
            revision: Math.max(1, Number(this.apiConfigRevision) || 1),
            updatedAt: this.apiConfigUpdatedAt || new Date().toISOString(),
            providers: this.providers,
            globalConfig: this.globalConfig
        };
    }

    _writeLocalApiConfig() {
        localStorage.setItem(API_PROVIDERS_STORAGE_KEY, JSON.stringify(this.providers));
        localStorage.setItem(API_GLOBAL_STORAGE_KEY, JSON.stringify(this.globalConfig));
        localStorage.setItem(API_META_STORAGE_KEY, JSON.stringify({
            version: 1,
            revision: this.apiConfigRevision,
            updatedAt: this.apiConfigUpdatedAt
        }));
        this.localApiConfigPresent = true;
        document.dispatchEvent(new CustomEvent('agent-providers-updated'));
    }

    async _restoreDurableApiConfig() {
        const bridge = window.flowCanvas?.apiConfig;
        if (!bridge?.load || !bridge?.save) {
            this.apiConfigHydrated = true;
            return { success: false, unavailable: true };
        }

        try {
            const loaded = await bridge.load();
            if (!loaded?.success) throw new Error(loaded?.error || '耐久配置读取失败');
            const reconciled = reconcileApiConfig({
                localProviders: this.providers,
                localGlobalConfig: this.globalConfig,
                localPresent: this.localApiConfigPresent,
                localRevision: this.apiConfigRevision,
                durableConfig: loaded.config
            });
            this.providers = reconciled.providers.map(provider => ({
                ...provider,
                capability: inferProviderCapability(provider)
            }));
            this._applyLoadedGlobalConfig(reconciled.globalConfig);
            this.apiConfigRevision = Math.max(1, Number(reconciled.revision) || 1);
            this.apiConfigUpdatedAt = loaded.config?.updatedAt || this.apiConfigUpdatedAt || new Date().toISOString();
            this._ensureProviderRoles();
            this.apiConfigHydrated = true;
            this._writeLocalApiConfig();
            this._renderProviderList();
            this._renderModelSelect();
            this._renderAgentSkillList();
            this._renderAgentExecutionMode();
            if (this.defaultTemporaryCompressionToggle) {
                this.defaultTemporaryCompressionToggle.checked = this.globalConfig.defaultTemporaryImageCompression === true;
            }

            const saved = await bridge.save(this._apiConfigSnapshot());
            if (!saved?.success) throw new Error(saved?.error || '耐久配置保存失败');
            if (this.pendingDurableApiConfigSave) this._queueDurableApiConfigSave();
            return {
                success: true,
                source: reconciled.source,
                recoveredFromBackup: loaded.recoveredFromBackup === true
            };
        } catch (error) {
            this.apiConfigHydrated = true;
            console.warn('[Agent] API 自动恢复失败，已保留当前 Local Storage 配置', error);
            return { success: false, error: error?.message || String(error) };
        }
    }

    _queueDurableApiConfigSave() {
        if (!this.apiConfigHydrated) {
            this.pendingDurableApiConfigSave = true;
            return;
        }
        const bridge = window.flowCanvas?.apiConfig;
        if (!bridge?.save) return;
        this.pendingDurableApiConfigSave = false;
        clearTimeout(this.apiConfigSaveTimer);
        this.apiConfigSaveTimer = setTimeout(async () => {
            const result = await bridge.save(this._apiConfigSnapshot());
            if (!result?.success) {
                console.warn('[Agent] API 耐久配置保存失败', result?.error || '未知错误');
            }
        }, 160);
    }

    _saveConfig() {
        try {
            this.apiConfigRevision = Math.max(1, Number(this.apiConfigRevision) + 1 || 1);
            this.apiConfigUpdatedAt = new Date().toISOString();
            this._writeLocalApiConfig();
            this._queueDurableApiConfigSave();
        } catch (e) {
            console.warn('[Agent] 配置保存失败', e);
        }
    }

    _isImageProvider(provider) {
        return providerHasCapability(provider, 'image');
    }

    _isVideoProvider(provider) {
        return providerHasCapability(provider, 'video');
    }

    _isTextProvider(provider) {
        return providerHasCapability(provider, 'text');
    }

    _isAnthropicProvider(provider) {
        return provider?.type === 'anthropic' ||
            String(provider?.endpoint || '').includes('api.anthropic.com/v1/messages');
    }

    _findProvider(id) {
        return this._providerVariants().find(provider => provider.id === id) || null;
    }

    _providerModels(provider) {
        const source = Array.isArray(provider?.models) ? provider.models : [provider?.model];
        return [...new Set(source.map(model => String(model || '').trim()).filter(Boolean))];
    }

    _providerVariants() {
        return this.providers.flatMap(provider => {
            const models = this._providerModels(provider);
            return models.map((model, index) => ({
                ...provider,
                id: index === 0 ? provider.id : `${provider.id}::model:${encodeURIComponent(model)}`,
                sourceProviderId: provider.id,
                model
            }));
        });
    }

    _selectionUsesProvider(selectionId, providerId) {
        const selected = this._findProvider(selectionId);
        return (selected?.sourceProviderId || selected?.id) === providerId;
    }

    _getDefaultImageProviderId() {
        return this._providerVariants().find(provider => this._isImageProvider(provider))?.id || null;
    }

    _getDefaultTextProviderId() {
        return this._providerVariants().find(provider => this._isTextProvider(provider))?.id || null;
    }

    _ensureProviderRoles() {
        if (this.providers.length === 0) {
            this.globalConfig.textProviderId = null;
            this.globalConfig.imageProviderId = null;
            this.globalConfig.videoProviderId = null;
            return;
        }

        const currentTextProvider = this._findProvider(this.globalConfig.textProviderId);
        const currentImageProvider = this._findProvider(this.globalConfig.imageProviderId);
        const currentVideoProvider = this._findProvider(this.globalConfig.videoProviderId);
        if (!currentTextProvider || !this._isTextProvider(currentTextProvider)) {
            this.globalConfig.textProviderId = this._getDefaultTextProviderId();
        }
        if (!currentImageProvider || !this._isImageProvider(currentImageProvider)) {
            this.globalConfig.imageProviderId = this._getDefaultImageProviderId();
        }
        if (!currentVideoProvider || !this._isVideoProvider(currentVideoProvider)) {
            this.globalConfig.videoProviderId = null;
        }
    }

    _setTextProvider(id) {
        const provider = this._findProvider(id);
        if (!provider || !this._isTextProvider(provider)) return;
        this.globalConfig.textProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _setImageProvider(id) {
        const provider = this._findProvider(id);
        if (!provider || !this._isImageProvider(provider)) return;
        this.globalConfig.imageProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
        this._renderAgentSkillList();
        this._renderAgentExecutionMode();
    }

    setImageProvider(id) {
        const provider = this._findProvider(id);
        if (!provider || !this._isImageProvider(provider)) return false;
        this._setImageProvider(id);
        return true;
    }

    _setVideoProvider(id) {
        const provider = this._findProvider(id);
        if (!provider || !this._isVideoProvider(provider)) return;
        this.globalConfig.videoProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
        if (this.currentMode === 'video') this._renderVideoStage();
    }

    _getImageProvider() {
        return this._findProvider(this.globalConfig.imageProviderId);
    }

    _getTextProvider() {
        return this._findProvider(this.globalConfig.textProviderId);
    }

    _getVideoProvider() {
        return this._findProvider(this.globalConfig.videoProviderId);
    }

    _providerLabel(provider) {
        if (!provider) return '未知 API';
        return `${provider.name || '未命名 API'}（${provider.model || '未设置模型'}）`;
    }

    _getBoundProvider(binding, fallbackProvider) {
        if (!binding?.providerId && !binding?.sourceProviderId && !binding?.model) {
            return fallbackProvider || null;
        }
        const selected = binding?.providerId ? this._findProvider(binding.providerId) : null;
        const sourceId = binding?.sourceProviderId || selected?.sourceProviderId || selected?.id || binding?.providerId;
        const source = this.providers.find(provider => provider.id === sourceId) || selected;
        if (!source) return null;
        return {
            ...source,
            id: binding.providerId || selected?.id || source.id,
            sourceProviderId: source.id,
            model: binding.model || selected?.model || source.model
        };
    }

    getGenerationProviderOptions(kind) {
        return this._providerVariants()
            .filter(provider => kind === 'video'
                ? this._isVideoProvider(provider)
                : kind === 'text'
                    ? this._isTextProvider(provider)
                    : this._isImageProvider(provider))
            .map(provider => ({
                id: provider.id,
                sourceProviderId: provider.sourceProviderId || provider.id,
                name: provider.name || '未命名 API',
                routeLabel: kind === 'video' ? this._getVideoModelProfile(provider)?.routeLabel || '' : '',
                routeGroup: kind === 'video' ? this._getVideoModelProfile(provider)?.routeGroup || '' : '',
                routeModelLabel: kind === 'video' ? this._getVideoModelProfile(provider)?.routeModelLabel || '' : '',
                model: provider.model || ''
            }));
    }

    getImageProviderConfig(binding = null) {
        const provider = this._getBoundProvider(binding, this._getImageProvider());
        return provider ? { ...provider } : null;
    }

    getImageGenerationPreferences(binding = null) {
        return readImageGenerationPreferences(this.globalConfig.imageGenerationPreferences, binding || {});
    }

    saveImageGenerationPreferences(config = {}, binding = null) {
        const selected = binding || this._findProvider(config.providerId) || this._getImageProvider();
        const preferenceBinding = {
            providerId: config.providerId || selected?.id || null,
            sourceProviderId: config.sourceProviderId || selected?.sourceProviderId || selected?.id || null,
            model: config.model || selected?.model || ''
        };
        if (!preferenceBinding.model) return false;
        this.globalConfig.imageGenerationPreferences = writeImageGenerationPreferences(
            this.globalConfig.imageGenerationPreferences,
            config,
            preferenceBinding
        );
        this._saveConfig();
        return true;
    }

    getTextProviderConfig(binding = null) {
        const provider = this._getBoundProvider(binding, this._getTextProvider());
        return provider ? { ...provider } : null;
    }

    getImageIntentPipelineMode() {
        if (this.globalConfig.imageIntentPipelineMode === 'off') return 'off';
        if (this.globalConfig.imageIntentPipelineMode === 'shadow') return 'shadow';
        return 'compiled';
    }

    async setImageIntentPipelineEnabled(enabled) {
        if (enabled) {
            const provider = this._getTextProvider();
            const configured = Boolean(
                String(provider?.apiKey || '').trim()
                && String(provider?.endpoint || '').trim()
                && String(provider?.model || '').trim()
            );
            if (!configured) {
                await this._showMissingTextProviderDialog();
                return false;
            }
        }
        this.globalConfig.imageIntentPipelineMode = enabled ? 'compiled' : 'off';
        this._saveConfig();
        document.dispatchEvent(new CustomEvent('image-intent-pipeline-changed', {
            detail: { enabled: enabled === true }
        }));
        return enabled === true;
    }

    _showMissingTextProviderDialog() {
        return new Promise(resolve => {
            document.querySelector('.agent-provider-guide-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'agent-provider-guide-overlay';
            overlay.innerHTML = `
                <section class="agent-provider-guide" role="dialog" aria-modal="true" aria-labelledby="agentProviderGuideTitle">
                    <div class="agent-provider-guide-icon" aria-hidden="true">
                        <svg class="flow-icon"><use href="./icons/flow-icons.svg#icon-sparkles"></use></svg>
                    </div>
                    <div class="agent-provider-guide-copy">
                        <h2 id="agentProviderGuideTitle">Agent 模式需要文字模型</h2>
                        <p>请先配置“文本与视觉理解”API，规划器才能分析参考图并整理生成请求。</p>
                    </div>
                    <div class="agent-provider-guide-actions">
                        <button type="button" data-guide-cancel>取消</button>
                        <button type="button" data-guide-settings>打开 API 设置</button>
                        <button class="primary" type="button" data-guide-ravenhash>前往 RavenHash</button>
                    </div>
                </section>
            `;
            const finish = () => {
                document.removeEventListener('keydown', onKeyDown);
                overlay.remove();
                resolve(false);
            };
            const onKeyDown = event => {
                if (event.key === 'Escape') finish();
            };
            overlay.querySelector('[data-guide-cancel]')?.addEventListener('click', finish);
            overlay.querySelector('[data-guide-settings]')?.addEventListener('click', () => {
                finish();
                this.setMode('settings', 'api');
                this._showForm();
                this._applyTemplate('ravenhash-text');
                document.querySelectorAll('.agent-template-chip').forEach(chip => {
                    chip.classList.toggle('active', chip.dataset.template === 'ravenhash-text');
                });
            });
            overlay.querySelector('[data-guide-ravenhash]')?.addEventListener('click', async () => {
                try {
                    await window.flowCanvas?.shell?.openRavenHash?.('ai');
                } catch (error) {
                    console.error('[AgentSidebar] Failed to open RavenHash:', error);
                } finally {
                    finish();
                }
            });
            overlay.addEventListener('click', event => {
                if (event.target === overlay) finish();
            });
            document.addEventListener('keydown', onKeyDown);
            document.body.appendChild(overlay);
            overlay.querySelector('[data-guide-settings]')?.focus();
        });
    }

    getImageModelProfile(binding = null) {
        const provider = this._getBoundProvider(binding, this._getImageProvider());
        if (!provider) return null;
        const sizes = this._getImageModelSizes(provider).map(size => ({ ...size }));
        const availableTiers = new Set(sizes.map(size => {
            const match = /^(\d+)x(\d+)$/i.exec(String(size.value || ''));
            return match ? inferImageResolutionTier(Number(match[1]), Number(match[2])) : null;
        }).filter(Boolean));
        return {
            sizes,
            resolutionTiers: IMAGE_RESOLUTION_TIERS.filter(tier => availableTiers.has(tier)),
            defaultResolutionTier: availableTiers.has('1K') ? '1K' : ([...availableTiers][0] || '1K')
        };
    }

    getVideoProviderConfig(binding = null) {
        const provider = this._getBoundProvider(binding, this._getVideoProvider());
        return provider ? { ...provider } : null;
    }

    getVideoModelProfile(binding = null) {
        const provider = this._getBoundProvider(binding, this._getVideoProvider());
        const profile = this._getVideoModelProfile(provider);
        if (!profile) return null;
        const { match, ...plainProfile } = profile;
        return {
            ...plainProfile,
            ratios: [...(plainProfile.ratios || [])],
            resolutions: [...(plainProfile.resolutions || [])],
            durations: [...(plainProfile.durations || [])],
            referenceLimits: { ...VIDEO_REFERENCE_LIMITS, ...(plainProfile.referenceLimits || {}) }
        };
    }

    getClassificationProviderConfig() {
        const isCompatible = item => {
            if (!item?.apiKey || !item?.endpoint || !item?.model) return false;
            if (String(item.type || '').toLowerCase() === 'google') return false;
            return this._isTextProvider(item);
        };
        const selected = this._getTextProvider();
        const provider = isCompatible(selected)
            ? selected
            : this._providerVariants().find(isCompatible);
        return provider ? { ...provider } : null;
    }

    async classifyLibraryAsset(filePath, metadata = {}) {
        const provider = this.getClassificationProviderConfig();
        if (!provider) return { success: false, waiting: true, error: '请先配置支持图片输入的文本与视觉模型' };
        if (!window.flowCanvas?.ai?.classifyAsset || !window.flowCanvas?.asset?.updateMetadata) {
            return { success: false, error: '当前版本缺少素材分类接口' };
        }

        const attempts = Number(metadata?.classification?.attempts || 0) + 1;
        await window.flowCanvas.asset.updateMetadata(filePath, {
            classification: {
                status: 'running',
                attempts,
                providerName: provider.name || '',
                model: provider.model,
                startedAt: new Date().toISOString(),
                error: null
            }
        });

        const response = await window.flowCanvas.ai.classifyAsset(filePath, provider);
        if (!response?.success) {
            const status = response?.unsupported ? 'unsupported' : (attempts >= 2 ? 'failed' : 'pending');
            const update = await window.flowCanvas.asset.updateMetadata(filePath, {
                classification: {
                    status,
                    attempts,
                    error: response?.error || '分类请求失败',
                    updatedAt: new Date().toISOString()
                }
            });
            return { ...response, metadata: update?.metadata || null };
        }

        const result = response.result || {};
        const categories = [...new Set([
            ...(Array.isArray(metadata?.categories) ? metadata.categories : []),
            ...(Array.isArray(result.categories) ? result.categories : [])
        ].map(value => String(value || '').trim()).filter(Boolean))];
        const tags = [...new Set([
            ...(Array.isArray(metadata?.tags) ? metadata.tags : []),
            ...(Array.isArray(result.tags) ? result.tags : [])
        ].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 20);
        const update = await window.flowCanvas.asset.updateMetadata(filePath, {
            categories,
            tags,
            summary: result.summary || '',
            colors: Array.isArray(result.colors) ? result.colors : [],
            dimensions: result.dimensions || {},
            classification: {
                status: 'complete',
                attempts,
                providerName: provider.name || '',
                model: provider.model,
                error: null,
                completedAt: new Date().toISOString()
            }
        });
        return { success: update?.success === true, result, metadata: update?.metadata || null, error: update?.error };
    }

    // ── 表单及 UI 管理 ──
    _showForm(provider = null) {
        if (!this.apiForm) return;
        this.apiForm.style.display = 'block';
        this.addApiBtn.style.display = 'none';

        // 清除芯片选中态
        document.querySelectorAll('.agent-template-chip').forEach(c => c.classList.remove('active'));

        if (provider) {
            this.editingProviderId = provider.id;
            this.apiFormTitle.textContent = '编辑 API';
            this.formName.value = provider.name;
            this.formCapability.value = inferProviderCapability(provider);
            this.formType.value = this._isAnthropicProvider(provider) ? 'anthropic' : provider.type;
            this.formEndpoint.value = normalizeRavenHashEndpoint(provider.endpoint);
            this.formKey.value = provider.apiKey;
            const models = this._providerModels(provider);
            this.formModel.value = models[0] || '';
            this._resetModelSlots(models.slice(1));
        } else {
            this.editingProviderId = null;
            this.apiFormTitle.textContent = '添加 API';
            this._applyTemplate('ravenhash');
            this.formKey.value = '';
            this._resetModelSlots();
            document.querySelector('.agent-template-chip[data-template="ravenhash"]')?.classList.add('active');
        }
    }

    _hideForm() {
        if (!this.apiForm) return;
        this.apiForm.style.display = 'none';
        this.addApiBtn.style.display = 'flex';
        this.editingProviderId = null;
    }

    _applyTemplate(id) {
        const tpl = DEFAULT_TEMPLATES[id] || DEFAULT_TEMPLATES.ravenhash;
        if (this.formName) this.formName.value = tpl.name;
        if (this.formCapability) this.formCapability.value = tpl.capability;
        if (this.formType) this.formType.value = tpl.type;
        if (this.formEndpoint) this.formEndpoint.value = tpl.endpoint;
        if (this.formModel) this.formModel.value = tpl.model;
        this._resetModelSlots();
        this._resetFetchedModels();
    }

    _setModelFetchStatus(type, message) {
        if (!this.modelFetchStatus) return;
        this.modelFetchStatus.className = 'agent-model-fetch-status';
        if (type) this.modelFetchStatus.classList.add(type);
        this.modelFetchStatus.textContent = message || '';
    }

    _resetFetchedModels(clearStatus = true) {
        this.fetchedModels = [];
        if (this.fetchedModelOptions) this.fetchedModelOptions.innerHTML = '';
        if (this.fetchedModelSelect) {
            this.fetchedModelSelect.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = '选择拉取到的模型';
            this.fetchedModelSelect.appendChild(placeholder);
            this.fetchedModelSelect.hidden = true;
        }
        if (this.formModel) this.formModel.hidden = false;
        if (clearStatus) {
            this._setModelFetchStatus('', '');
        }
    }

    _renderFetchedModelOptions(models) {
        if (!this.fetchedModelSelect) return;
        this._resetFetchedModels(false);
        this.fetchedModels = [...models];
        models.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            this.fetchedModelSelect.appendChild(opt);
            if (this.fetchedModelOptions) {
                const datalistOption = document.createElement('option');
                datalistOption.value = model;
                this.fetchedModelOptions.appendChild(datalistOption);
            }
        });
        const hasModels = models.length > 0;
        this.fetchedModelSelect.hidden = !hasModels;
        if (this.formModel) this.formModel.hidden = hasModels;

        const currentModel = this.formModel?.value?.trim();
        if (currentModel && models.includes(currentModel)) {
            this.fetchedModelSelect.value = currentModel;
        }
    }

    _resetModelSlots(models = []) {
        if (!this.additionalModelsEl) return;
        this.additionalModelsEl.innerHTML = '';
        models.forEach(model => this._addModelSlot(model));
    }

    _addModelSlot(value = '') {
        if (!this.additionalModelsEl) return;
        const usedModels = new Set([
            this.formModel?.value?.trim(),
            ...Array.from(this.additionalModelsEl.querySelectorAll('.agent-additional-model-input'))
                .map(input => input.value.trim())
        ].filter(Boolean));
        const suggestedModel = value || this.fetchedModels.find(model => !usedModels.has(model)) || '';

        const row = document.createElement('div');
        row.className = 'agent-additional-model-row';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'agent-setting-input agent-additional-model-input';
        input.placeholder = '输入或选择模型';
        input.setAttribute('list', 'agentFetchedModelOptions');
        input.value = suggestedModel;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'agent-remove-model-slot';
        removeBtn.title = '移除模型位';
        removeBtn.setAttribute('aria-label', '移除模型位');
        removeBtn.textContent = '\u00d7';
        removeBtn.addEventListener('click', () => row.remove());
        row.append(input, removeBtn);
        this.additionalModelsEl.appendChild(row);
        input.focus();
    }

    async _fetchModelsForForm() {
        const type = this.formType?.value?.trim() || 'openai';
        const endpoint = normalizeRavenHashEndpoint(this.formEndpoint?.value);
        const apiKey = this.formKey?.value?.trim() || '';

        if (this.formEndpoint && endpoint) this.formEndpoint.value = endpoint;

        if (!endpoint && type !== 'google' && type !== 'anthropic') {
            this._setModelFetchStatus('error', '请先填写 API 端点');
            return;
        }
        if (!apiKey) {
            this._setModelFetchStatus('error', '请先填写 API Key');
            return;
        }
        if (!window.flowCanvas?.ai?.fetchModels) {
            this._setModelFetchStatus('error', '当前运行环境不支持拉取模型，请重启应用后再试');
            return;
        }

        const previousText = this.fetchModelsBtn?.textContent;
        if (this.fetchModelsBtn) {
            this.fetchModelsBtn.disabled = true;
            this.fetchModelsBtn.textContent = '拉取中...';
        }
        this._resetFetchedModels(false);
        this._setModelFetchStatus('loading', '正在拉取模型列表...');

        try {
            const result = await window.flowCanvas.ai.fetchModels({ type, endpoint, apiKey });
            if (!result?.success) {
                throw new Error(result?.error || '模型列表接口没有返回可用结果');
            }

            const models = Array.isArray(result.models)
                ? result.models.map(model => String(model).trim()).filter(Boolean)
                : [];
            if (models.length === 0) {
                throw new Error('没有拉取到可用模型');
            }

            this._renderFetchedModelOptions(models);
            this._setModelFetchStatus('success', `已拉取 ${models.length} 个模型，请从下拉框选择`);
        } catch (err) {
            this._resetFetchedModels(false);
            this._setModelFetchStatus('error', `拉取失败：${err.message || err}`);
        } finally {
            if (this.fetchModelsBtn) {
                this.fetchModelsBtn.disabled = false;
                this.fetchModelsBtn.textContent = previousText || '拉取模型';
            }
        }
    }

    _saveForm() {
        const name = this.formName.value.trim();
        const capability = this.formCapability?.value?.trim() || 'text';
        const type = this.formType.value.trim();
        const endpoint = normalizeRavenHashEndpoint(this.formEndpoint.value);
        const apiKey = this.formKey.value.trim();
        const models = [...new Set([
            this.formModel.value.trim(),
            ...Array.from(this.additionalModelsEl?.querySelectorAll('.agent-additional-model-input') || [])
                .map(input => input.value.trim())
        ].filter(Boolean))];
        const model = models[0] || '';

        if (!name || !endpoint || !apiKey || !model) {
            alert('请填写完整的 API 配置！');
            return;
        }

        if (this.editingProviderId) {
            const idx = this.providers.findIndex(p => p.id === this.editingProviderId);
            if (idx !== -1) {
                this.providers[idx] = { ...this.providers[idx], id: this.editingProviderId, name, capability, type, endpoint, apiKey, model, models };
            }
        } else {
            const newProvider = {
                id: 'api_' + Date.now() + Math.random().toString(36).substr(2, 5),
                name, capability, type, endpoint, apiKey, model, models
            };
            this.providers.push(newProvider);
            if (this._isTextProvider(newProvider)) {
                this.globalConfig.textProviderId = newProvider.id;
            } else if (this._isImageProvider(newProvider)) {
                this.globalConfig.imageProviderId = newProvider.id;
            } else if (this._isVideoProvider(newProvider)) {
                this.globalConfig.videoProviderId = newProvider.id;
            }
        }

        this._ensureProviderRoles();
        this._saveConfig();
        this._hideForm();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _deleteProvider(id) {
        if (!confirm('确定要删除此 API 配置吗？')) return;
        this.providers = this.providers.filter(p => p.id !== id);
        this._ensureProviderRoles();
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _setActiveProvider(id) {
        const provider = this._findProvider(id);
        if (!provider) return;
        if (this._isTextProvider(provider)) {
            this._setTextProvider(id);
        } else if (this._isVideoProvider(provider)) {
            this._setVideoProvider(id);
        } else if (this._isImageProvider(provider)) {
            this._setImageProvider(id);
        }
    }

    _renderProviderList() {
        if (!this.providerListEl) return;
        this.providerListEl.innerHTML = '';

        this.providers.forEach(p => {
            const card = document.createElement('div');
            const isText = this._selectionUsesProvider(this.globalConfig.textProviderId, p.id);
            const isImage = this._selectionUsesProvider(this.globalConfig.imageProviderId, p.id);
            const isVideo = this._selectionUsesProvider(this.globalConfig.videoProviderId, p.id);
            card.className = `agent-provider-card ${isText || isImage || isVideo ? 'active' : ''}`;

            const info = document.createElement('div');
            info.className = 'agent-provider-info';
            info.style.cursor = 'pointer';
            const nameEl = document.createElement('div');
            nameEl.className = 'agent-provider-name';
            nameEl.textContent = p.name || '未命名 API';
            const metaEl = document.createElement('div');
            metaEl.className = 'agent-provider-meta';
            const providerModels = this._providerModels(p);
            metaEl.textContent = providerModels.length > 1
                ? `${providerModels.length} 个模型 · ${providerModels.join('、')}`
                : (providerModels[0] || '未设置模型');
            metaEl.title = providerModels.join('\n');
            const roleEl = document.createElement('div');
            roleEl.className = 'agent-provider-roles';
            if (isText) {
                const badge = document.createElement('span');
                badge.className = 'agent-provider-role chat';
                badge.textContent = '文本 / 视觉';
                roleEl.appendChild(badge);
            }
            if (isImage) {
                const badge = document.createElement('span');
                badge.className = 'agent-provider-role image';
                badge.textContent = '生图';
                roleEl.appendChild(badge);
            }
            if (isVideo) {
                const badge = document.createElement('span');
                badge.className = 'agent-provider-role video';
                badge.textContent = '视频';
                roleEl.appendChild(badge);
            }
            info.appendChild(nameEl);
            info.appendChild(metaEl);
            if (roleEl.childNodes.length > 0) info.appendChild(roleEl);
            info.addEventListener('click', () => this._setActiveProvider(p.id));

            const actions = document.createElement('div');
            actions.className = 'agent-provider-actions';

            const editBtn = document.createElement('button');
            editBtn.className = 'agent-provider-action';
            editBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                </svg>
            `;
            editBtn.title = '编辑';
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showForm(p);
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'agent-provider-action delete';
            delBtn.innerHTML = '<svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-trash"></use></svg>';
            delBtn.title = '删除';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this._deleteProvider(p.id);
            });

            actions.appendChild(editBtn);
            // 允许删除唯一的 API
            actions.appendChild(delBtn);

            card.appendChild(info);
            card.appendChild(actions);
            this.providerListEl.appendChild(card);
        });
    }

    _renderModelSelect() {
        const selects = [
            { el: this.textModelSelectEl, role: 'text', selectedId: this.globalConfig.textProviderId },
            { el: this.imageModelSelectEl, role: 'image', selectedId: this.globalConfig.imageProviderId },
            { el: this.videoModelSelectEl, role: 'video', selectedId: this.globalConfig.videoProviderId }
        ].filter(item => item.el);

        selects.forEach(({ el }) => {
            el.innerHTML = '';
        });

        if (this.providers.length === 0) {
            selects.forEach(({ el }) => {
                const opt = document.createElement('option');
                opt.value = "";
                opt.textContent = "-- 请先添加 API --";
                el.appendChild(opt);
            });
            this._renderAgentComposerModels();
            this._renderVideoProviderContext();
            if (this.currentMode === 'video') this._renderVideoStage();
            return;
        }

        selects.forEach(({ el, role, selectedId }) => {
            const opt = document.createElement('option');
            opt.value = "";
            opt.textContent = role === 'text'
                ? '-- 选择文字 API --'
                : role === 'image'
                    ? '-- 选择生图 API --'
                    : '-- 选择视频 API --';
            el.appendChild(opt);

            this._providerVariants().forEach(p => {
                const matchesRole = role === 'video'
                    ? this._isVideoProvider(p)
                    : role === 'text'
                        ? this._isTextProvider(p)
                        : this._isImageProvider(p);
                if (!matchesRole) return;
                const option = document.createElement('option');
                option.value = p.id;
                const profileMeta = role === 'video'
                    ? formatVideoModelProfile(this._getVideoModelProfile(p), false)
                    : '';
                option.textContent = `${p.name} (${p.model})${profileMeta ? ` · ${profileMeta}` : ''}`;
                if (p.id === selectedId) {
                    option.selected = true;
                }
                el.appendChild(option);
            });
        });
        this._renderAgentComposerModels();
        this._renderVideoProviderContext();
        this._renderImageModelCapabilities();
        if (this.currentMode === 'video') this._renderVideoStage();
    }

}
