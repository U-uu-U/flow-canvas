// ============================================================
// Flow Canvas — Agent Sidebar (AI 对话右侧边栏)
// ============================================================

const DEFAULT_TEMPLATES = {
    ravenhash: { name: 'RavenHash Image', type: 'openai', endpoint: 'https://ai.ravenhash.org/v1', model: 'gpt-image-2' },
    'ravenhash-video': { name: 'RavenHash Video', type: 'openai', endpoint: 'https://art.ravenhash.org/v1', model: 'doubao-seedance-2-0' }
};

function normalizeRavenHashEndpoint(endpoint) {
    const value = String(endpoint || '').trim().replace(/\/+$/, '');
    if (/^https:\/\/(?:ai|art)\.ravenhash\.org$/i.test(value)) {
        return `${value}/v1`;
    }
    return value;
}

const VIDEO_MODEL_PROFILES = [
    {
        match: /seedance[^a-z0-9]*2(?:[._-]?0)?|doubao-seedance-2|artsdance[^a-z0-9]*2/i,
        label: 'Seedance 2.0',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p', '4K'],
        durations: Array.from({ length: 15 }, (_, index) => index + 1),
        durationControl: 'slider',
        supportsWebSearch: true,
        defaultRatio: '16:9',
        defaultResolution: '1080p',
        defaultDuration: 5
    },
    {
        match: /seedance[^a-z0-9]*(?:1[._-]?5|1[._-]?0[-_]?pro)/i,
        label: 'Seedance 1.5',
        ratios: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'],
        resolutions: ['480p', '720p', '1080p'],
        durations: [-1, 5, 10, 12],
        durationControl: 'select',
        supportsWebSearch: false,
        defaultRatio: '16:9',
        defaultResolution: '720p',
        defaultDuration: 5
    },
    {
        match: /minimax[^a-z0-9]*h3/i,
        label: 'MiniMax H3',
        ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
        resolutions: ['2k'],
        durations: Array.from({ length: 11 }, (_, index) => index + 5),
        durationControl: 'slider',
        supportsWebSearch: false,
        supportsCameraFixed: false,
        supportsGeneratedAudio: false,
        supportsWatermark: false,
        referenceLimits: { image: 5, video: 1, audio: 1 },
        defaultRatio: '16:9',
        defaultResolution: '2k',
        defaultDuration: 5
    },
    {
        match: /(?:dashscope|wanx|tongyi|通义万相|wan[^\s]*(?:t2v|i2v))/i,
        label: 'DashScope',
        ratios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        resolutions: ['720P', '1080P'],
        durations: [3, 5, 10, 15],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '1:1',
        defaultResolution: '720P',
        defaultDuration: 5
    },
    {
        match: /kling|可灵/i,
        label: 'Kling',
        ratios: ['16:9', '9:16', '1:1'],
        resolutions: [],
        durations: [3, 5, 10, 15],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '16:9',
        defaultResolution: null,
        defaultDuration: 5
    },
    {
        match: /tencent|vidu|腾讯/i,
        label: 'Tencent / Vidu',
        ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'],
        resolutions: [],
        durations: [5, 10],
        durationControl: 'segmented',
        supportsWebSearch: false,
        defaultRatio: '1:1',
        defaultResolution: null,
        defaultDuration: 5
    }
];

const DEFAULT_VIDEO_MODEL_PROFILE = {
    label: '未收录模型',
    ratios: [],
    resolutions: [],
    durations: [],
    durationControl: null,
    supportsWebSearch: false,
    defaultRatio: null,
    defaultResolution: null,
    defaultDuration: null
};

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
const VIDEO_REFERENCE_LABELS = Object.freeze({ image: '图片', video: '视频', audio: '音频' });
const VIDEO_REFERENCE_LARGE_TOTAL_BYTES = 10 * 1024 * 1024;
const IMAGE_REFERENCE_UPLOAD_BUDGET_BYTES = 6 * 1024 * 1024;
const IMAGE_REFERENCE_MANUAL_BUDGET_BYTES = 2 * 1024 * 1024;
const IMAGE_PROMPT_HEIGHT_STORAGE_KEY = 'flow-canvas-image-prompt-height';
const VIDEO_PROMPT_HEIGHT_STORAGE_KEY = 'flow-canvas-video-prompt-height';
const PROJECT_COMPOSER_CACHE_STORAGE_KEY = 'flow-canvas-project-composer-cache-v1';
const PROJECT_COMPOSER_DEFAULT_KEY = '__no_project__';
const GENERATION_TASKS_STORAGE_KEY = 'flow-canvas-generation-tasks';
const GENERATION_TASK_LIMIT = 100;
const BROWSER_SYNC_EVENT_IDS_KEY = 'flow-canvas-browser-sync-event-ids';

export class AgentSidebar {
    constructor(options = {}) {
        this.options = options;
        // 全局配置：图片和视频 provider 选择
        this.globalConfig = {
            imageProviderId: null,
            videoProviderId: null
        };
        // 存储所有的 provider { id, name, type, endpoint, apiKey, model }
        this.providers = [];

        this.editingProviderId = null;
        this.imageGenerationMode = 'text';
        this.imageReferenceSelections = [];
        this.videoReferenceSelections = { image: [], video: [], audio: [] };
        this.activeReferenceWorkspace = null;
        this.activeVideoReferenceType = null;
        this.activeProjectCacheKey = this._projectCacheKey(this.options.getActiveProjectId?.());
        this.projectComposerSaveTimer = null;
        this.restoringProjectComposer = false;

        // DOM 引用
        this.settingsPanel = document.getElementById('agentSettings');

        // Settings elements
        this.providerListEl = document.getElementById('agentProviderList');
        this.addApiBtn = document.getElementById('agentAddApiBtn');
        this.apiForm = document.getElementById('agentApiForm');
        this.apiFormCloseBtn = document.getElementById('agentApiFormClose');
        this.apiFormTitle = document.getElementById('agentApiFormTitle');
        this.imageModelSelectEl = document.getElementById('agentImageModelSelect');
        this.videoModelSelectEl = document.getElementById('agentVideoModelSelect');
        this.modePicker = document.getElementById('creationModePicker');
        this.modeTitle = document.getElementById('creationModeTitle');
        this.taskHistoryBtn = document.getElementById('agentTaskHistoryBtn');
        this.taskHistoryBadge = document.getElementById('agentTaskHistoryBadge');
        this.taskHistoryPanel = document.getElementById('agentTaskHistory');
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
        this.imageWorkspaceStatus = document.getElementById('imageWorkspaceStatus');
        this.imageGenerateBtn = document.getElementById('imageGenerateBtn');
        this.imageGenerateMessage = document.getElementById('imageGenerateMessage');
        this.currentMode = 'review';
        this.taskHistoryOpen = false;
        this.generationTasks = [];
        this.processedBrowserSyncEventIds = new Set();
        this.browserSyncPolling = false;
        this.activeVideoWorkspaceTaskId = null;
        this.modePickerHideTimer = null;
        this.lastCanvasSelection = this.options.getSelectedCanvasEntries?.() || [];

        // Form inputs
        this.formName = document.getElementById('agentFormName');
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

        // 渲染 UI
        this._renderProviderList();
        this._renderModelSelect();
        this._renderGenerationTasks();
        window.flowCanvas?.browserSync?.onTaskSubmitted?.((event) => this._handleTaskSubmitted(event));
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
    }

    _projectCacheKey(projectId) {
        const value = String(projectId || '').trim();
        return value || PROJECT_COMPOSER_DEFAULT_KEY;
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
            filePath: entry?.filePath || null
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
                quality: this.imageQualitySelect?.value || ''
            },
            videoSettings: {
                ratio: this.videoRatioSelect?.value || '',
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
        setSelectValue(this.videoResolutionSelect, state?.videoSettings?.resolution);

        const ratio = String(state?.videoSettings?.ratio || '');
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
        if (saveCurrent) this._saveProjectComposer(this.activeProjectCacheKey);
        this.options.endMediaReferencePick?.({ silent: true, clearHighlights: true });
        this.activeProjectCacheKey = nextKey;

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
    }

    _bindEvents() {
        const exitCreationMode = () => {
            this.setMode('review');
        };

        // 悬停选择创作模式，点击则把主窗口收进置顶浮动按钮。
        const toggleBtn = document.getElementById('agentToggleBtn');
        let collapsingToOrb = false;
        toggleBtn?.addEventListener('click', async () => {
            if (collapsingToOrb) return;
            collapsingToOrb = true;
            toggleBtn.classList.add('activating');
            toggleBtn.setAttribute('aria-busy', 'true');
            this.modePicker?.classList.remove('mode-picker-visible');

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
        });

        toggleBtn?.addEventListener('mouseenter', () => this._showModePicker());
        toggleBtn?.addEventListener('mouseleave', () => this._scheduleModePickerHide());
        this.modePicker?.addEventListener('mouseenter', () => this._showModePicker());
        this.modePicker?.addEventListener('mouseleave', () => this._scheduleModePickerHide());
        document.getElementById('creationModeImageBtn')?.addEventListener('click', () => this.setMode('image'));
        document.getElementById('creationModeVideoBtn')?.addEventListener('click', () => this.setMode('video'));
        document.getElementById('creationModeReviewBtn')?.addEventListener('click', () => this.setMode('review'));
        this.taskHistoryBtn?.addEventListener('click', () => this._setTaskHistoryOpen(!this.taskHistoryOpen));
        this.taskHistoryList?.addEventListener('click', (event) => {
            const copyPromptButton = event.target.closest('[data-copy-task-prompt]');
            if (copyPromptButton) {
                this._copyGenerationTaskPrompt(copyPromptButton.dataset.copyTaskPrompt, copyPromptButton);
                return;
            }
            const retryButton = event.target.closest('[data-retry-task]');
            if (retryButton) this._retryGenerationTask(retryButton.dataset.retryTask);
        });
        this.videoGenerateBtn?.addEventListener('click', () => this._generateVideoFromWorkspace());
        [this.videoPromptInput, this.imagePromptInput].forEach(input => {
            input?.addEventListener('input', () => this._scheduleProjectComposerSave());
        });
        [
            this.imageSizeSelect,
            this.imageQualitySelect,
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
        document.getElementById('videoModelOpenSettingsBtn')?.addEventListener('click', () => this.setMode('settings'));
        this.videoModelSearchInput?.addEventListener('input', () => this._renderVideoModelPicker());

        document.getElementById('agentCollapseBtn')?.addEventListener('click', () => this.close());

        // 退出当前模式并回到普通画板。
        document.getElementById('creationModeCloseBtn')?.addEventListener('click', exitCreationMode);

        // 设置模式只从右上角齿轮进入。
        document.getElementById('agentSettingsBtn')?.addEventListener('click', () => this.setMode('settings'));

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

    _showModePicker() {
        if (this.modePickerHideTimer) {
            clearTimeout(this.modePickerHideTimer);
            this.modePickerHideTimer = null;
        }
        this.modePicker?.classList.add('mode-picker-visible');
    }

    _scheduleModePickerHide() {
        if (this.modePickerHideTimer) clearTimeout(this.modePickerHideTimer);
        this.modePickerHideTimer = setTimeout(() => {
            this.modePicker?.classList.remove('mode-picker-visible');
            this.modePickerHideTimer = null;
        }, 160);
    }

    setMode(mode = 'review') {
        const nextMode = ['settings', 'image', 'video', 'review'].includes(mode) ? mode : 'review';
        const body = document.body;
        if (['image', 'video'].includes(this.currentMode) && nextMode !== this.currentMode) {
            this.options.endMediaReferencePick?.({ clearHighlights: true });
        }
        this.currentMode = nextMode;
        this._setTaskHistoryOpen(false);
        if (this.modeTitle) {
            this.modeTitle.textContent = {
                settings: '\u8bbe\u7f6e\u6a21\u5f0f',
                image: '\u56fe\u7247\u6a21\u5f0f',
                video: '\u89c6\u9891\u6a21\u5f0f'
            }[nextMode] || '';
        }

        body.classList.remove('settings-mode', 'image-mode', 'video-mode');
        document.querySelectorAll('.creation-mode-option').forEach(option => {
            const optionId = 'creationMode' + nextMode[0].toUpperCase() + nextMode.slice(1) + 'Btn';
            option.classList.toggle('active', option.id === optionId);
        });

        if (nextMode === 'review') {
            body.classList.remove('creation-mode');
            this.close();
            this.settingsPanel?.classList.remove('show');
            if (this.videoWorkspace) this.videoWorkspace.hidden = true;
            if (this.videoModelPicker) this.videoModelPicker.hidden = true;
            if (this.videoPromptDock) this.videoPromptDock.hidden = true;
            if (this.imageWorkspace) this.imageWorkspace.hidden = true;
            this.modePicker?.classList.remove('mode-picker-visible');
            return;
        }

        body.classList.add('creation-mode', nextMode + '-mode');
        body.classList.add('agent-open');
        if (nextMode === 'image' || nextMode === 'video') {
            body.classList.remove('sidebar-closed');
        }
        this.settingsPanel?.classList.toggle('show', nextMode === 'settings');
        if (this.videoWorkspace) this.videoWorkspace.hidden = true;
        if (this.videoModelPicker) this.videoModelPicker.hidden = true;
        if (this.videoPromptDock) this.videoPromptDock.hidden = nextMode !== 'video';
        if (this.imageWorkspace) this.imageWorkspace.hidden = nextMode !== 'image';

        if (nextMode === 'video') {
            this._renderVideoSourcePreview();
            this._renderVideoStage();
        } else if (nextMode === 'image') {
            this._renderImageReferences();
        }
        this.modePicker?.classList.remove('mode-picker-visible');
        this.open();
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
            if (detail) detail.textContent = keyword
                ? '换一个关键词，或到设置中检查模型名称。'
                : '请先在设置中添加 API，并填写视频模型名称。';
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
            const meta = document.createElement('small');
            meta.textContent = `${provider.name || '未命名 API'} · ${profile.label}`;
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
        const marker = `${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        const sizes = /ai\.ravenhash\.org|ravenhash/.test(marker)
            ? RAVENHASH_IMAGE_SIZES
            : DEFAULT_IMAGE_SIZES;
        const previousValue = this.imageSizeSelect.value;
        this.imageSizeSelect.innerHTML = '';
        sizes.forEach(size => {
            const option = document.createElement('option');
            option.value = size.value;
            option.textContent = size.label;
            this.imageSizeSelect.appendChild(option);
        });
        this.imageSizeSelect.value = sizes.some(size => size.value === previousValue) ? previousValue : '';
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
        if (!provider?.model) return null;
        const marker = `${provider.model} ${provider.name || ''} ${provider.endpoint || ''}`;
        return VIDEO_MODEL_PROFILES.find(profile => profile.match.test(marker)) || DEFAULT_VIDEO_MODEL_PROFILE;
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

    _updateGenerationTask(id, patch = {}) {
        const index = this.generationTasks.findIndex(task => task.id === id);
        if (index < 0) return null;
        this.generationTasks[index] = {
            ...this.generationTasks[index],
            ...patch,
            updatedAt: new Date().toISOString()
        };
        this._saveGenerationTasks();
        this._renderGenerationTasks();
        return this.generationTasks[index];
    }

    _isGenerationDisconnect(error) {
        const marker = `${error?.name || ''} ${error?.code || ''} ${error?.message || error || ''}`;
        return /network|fetch failed|failed to fetch|econn|etimedout|socket|connection|timeout|timed out|aborterror|断开|断连|连接失败|网络|超时/i.test(marker);
    }

    _recordGenerationError(taskId, error) {
        const message = error?.message || String(error || '请求失败');
        return this._updateGenerationTask(taskId, {
            status: this._isGenerationDisconnect(error) ? 'disconnected' : 'failed',
            error: message
        });
    }

    _setTaskHistoryOpen(open) {
        const nextOpen = Boolean(open) && ['image', 'video'].includes(this.currentMode);
        const modeLabel = this.currentMode === 'image' ? '图片模式' : '视频模式';
        this.taskHistoryOpen = nextOpen;
        document.body.classList.toggle('task-history-open', nextOpen);
        if (this.taskHistoryPanel) this.taskHistoryPanel.hidden = !nextOpen;
        if (this.modeTitle && ['image', 'video'].includes(this.currentMode)) {
            this.modeTitle.textContent = nextOpen ? '任务记录' : modeLabel;
        }
        if (this.taskHistoryBtn) {
            this.taskHistoryBtn.classList.toggle('active', nextOpen);
            this.taskHistoryBtn.setAttribute('aria-expanded', String(nextOpen));
            this.taskHistoryBtn.querySelector('.agent-task-history-label').textContent = nextOpen ? modeLabel : '任务记录';
            this.taskHistoryBtn.title = nextOpen ? `返回${modeLabel}` : '打开任务记录';
            this.taskHistoryBtn.setAttribute('aria-label', this.taskHistoryBtn.title);
        }
        if (nextOpen) this._renderGenerationTasks();
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
        const pendingCount = this.generationTasks.filter(task => task.status === 'running').length;
        const readyCount = this.generationTasks.filter(task => task.status === 'running' && task.params?.syncStage === 'ready').length;
        const downloadingCount = this.generationTasks.filter(task => task.status === 'running' && task.params?.syncStage === 'downloading').length;
        const generatingCount = Math.max(0, pendingCount - readyCount - downloadingCount);
        const disconnectedCount = this.generationTasks.filter(task => task.status === 'disconnected').length;
        const badgeCount = pendingCount + disconnectedCount;
        if (this.taskHistoryBadge) {
            this.taskHistoryBadge.hidden = badgeCount === 0;
            this.taskHistoryBadge.textContent = String(badgeCount);
        }
        if (this.taskHistorySummary) {
            const pieces = [`共 ${this.generationTasks.length} 条`];
            if (generatingCount) pieces.push(`${generatingCount} 条生成中`);
            if (readyCount) pieces.push(`${readyCount} 条待下载`);
            if (downloadingCount) pieces.push(`${downloadingCount} 条下载中`);
            if (disconnectedCount) pieces.push(`${disconnectedCount} 条待重传`);
            this.taskHistorySummary.textContent = this.generationTasks.length ? pieces.join(' · ') : '还没有生成任务';
        }
        if (!this.taskHistoryList) return;
        if (this.generationTasks.length === 0) {
            this.taskHistoryList.innerHTML = `
                <div class="agent-task-history-empty">
                    <svg class="flow-icon flow-icon-lg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-history"></use></svg>
                    <strong>暂无任务记录</strong>
                    <span>图片和视频生成任务会显示在这里</span>
                </div>`;
            return;
        }

        const statusLabels = {
            running: '生成中',
            success: '已完成',
            failed: '失败',
            disconnected: '待重传'
        };
        this.taskHistoryList.innerHTML = this.generationTasks.map(task => {
            const status = statusLabels[task.status] ? task.status : 'failed';
            let syncStageLabel = status === 'running' && task.params?.syncStage === 'ready'
                ? '待下载'
                : status === 'running' && task.params?.syncStage === 'downloading'
                    ? '下载中'
                    : status === 'running' && task.params?.syncStage === 'recovering'
                        ? '\u6062\u590d\u8fde\u63a5\u4e2d'
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
            const canRetry = status === 'failed' || status === 'disconnected';
            const retryLabel = status === 'disconnected' ? '重新连接' : '重试';
            const errorCopy = status === 'disconnected'
                ? '与生成服务断开，任务参数已保留。'
                : task.error;
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
                    ${errorCopy ? `<p class="agent-task-error">${this._escapeTaskText(errorCopy)}</p>` : ''}
                    ${canRetry ? `
                        <div class="agent-task-retry-row">
                            <span>${status === 'disconnected' ? (task.taskId ? '使用任务 ID 恢复，不会重复提交' : '缺少任务 ID，只能重新提交') : `第 ${task.attempts || 1} 次请求未完成`}</span>
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

    async _retryGenerationTask(taskId) {
        const task = this.generationTasks.find(item => item.id === taskId);
        if (!task || !['failed', 'disconnected'].includes(task.status)) return;
        const shouldResumeVideo = task.kind === 'video'
            && task.status === 'disconnected'
            && Boolean(task.taskId)
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
            ...(task.kind === 'image' ? {
                sourcePaths: retryImageReferences.map(reference => reference.filePath).filter(Boolean)
            } : {})
        });
        let placeholder = null;
        let result = null;
        try {
            if (task.kind === 'image') {
                placeholder = this.options.beginImageGeneration?.({ size: task.params?.size }) || null;
                if (!window.flowCanvas?.mcp?.generateImage) throw new Error('本地生图接口不可用');
                result = await window.flowCanvas.mcp.generateImage({
                    provider: 'openai',
                    providerConfig: provider,
                    prompt: task.prompt,
                    size: task.params?.size || undefined,
                    quality: task.params?.quality || 'high',
                    responseFormat: 'url',
                    sourceReferences: retryImageReferences,
                    x: placeholder?.x,
                    y: placeholder?.y,
                    addToCanvas: true
                });
            } else {
                if (!window.flowCanvas?.mcp?.generateVideo && !shouldResumeVideo) throw new Error('本地视频接口不可用');
                placeholder = this.options.beginVideoGeneration?.({ ratio: task.params?.ratio || '16:9' }) || null;
                result = shouldResumeVideo
                    ? await window.flowCanvas.mcp.resumeVideo({
                        providerConfig: provider,
                        clientTaskId: task.id,
                        taskId: task.taskId,
                        prompt: task.prompt,
                        targetDir: task.params?.targetDir || undefined,
                        x: placeholder?.x,
                        y: placeholder?.y,
                        addToCanvas: true
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
                    addToCanvas: true
                });
            }
            if (result?.success === false) throw new Error(result.error || '生成请求失败');
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
        return new Promise(resolve => {
            document.querySelector('.video-compression-dialog-overlay')?.remove();
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

            const finish = choice => {
                document.removeEventListener('keydown', onKeyDown);
                overlay.remove();
                resolve(choice);
            };
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
            filePath: entry.filePath
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
                            mediaType: 'image'
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
        const ratio = this.videoRatioSelect?.value || '16:9';
        const videoParams = {
            resolution: this.videoResolutionSelect?.value || null,
            ratio,
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
        const placeholder = this.options.beginVideoGeneration?.({ ratio }) || null;
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
                addToCanvas: true
            });
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
            if (this.videoWorkspaceStatus) this.videoWorkspaceStatus.textContent = '\u5931\u8d25';
            this._setWorkspaceMessage(this.videoGenerateMessage, 'error', error?.message || String(error));
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
                temporary: !replacement.item
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
                    temporary: !replacement.item
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
        const choice = await this._showReferenceCompressionDialog(summary, 'image');
        if (choice === 'cancel') return null;
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
                    : `已生成 ${count} 张临时较小副本，未添加到画板`
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
                if (!prepared) {
                    this._setWorkspaceMessage(this.imageGenerateMessage, '', '');
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
            quality
        }, sourcePaths);
        this._setImageWorkspaceStatus('running', '\u751f\u6210\u4e2d');
        this._setWorkspaceMessage(this.imageGenerateMessage, '', '\u6b63\u5728\u751f\u6210...');
        const placeholder = this.options.beginImageGeneration?.({ size }) || null;
        let result = null;

        try {
            result = await window.flowCanvas.mcp.generateImage({
                provider: 'openai',
                providerConfig: provider,
                prompt,
                size,
                quality,
                responseFormat: 'url',
                sourceReferences,
                x: placeholder?.x,
                y: placeholder?.y,
                addToCanvas: true
            });
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
            this._setImageWorkspaceStatus('failed', '\u5931\u8d25');
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', error?.message || String(error));
        } finally {
            if (placeholder?.id) this.options.endImageGeneration?.(placeholder.id, result?.item?.id);
        }
    }

    open() {
        document.body.classList.add('agent-open');
        const focusTarget = this.currentMode === 'video'
            ? (this._hasSelectedVideoProvider() ? this.videoPromptInput : this.videoModelSearchInput)
            : this.currentMode === 'image'
                ? this.imagePromptInput
                : null;
        if (focusTarget) setTimeout(() => focusTarget.focus(), 120);
    }

    close() {
        document.body.classList.remove('agent-open');
    }

    toggle() {
        document.body.classList.toggle('agent-open');
    }

    // ── 配置管理 ──
    _loadConfig() {
        try {
            const savedProviders = localStorage.getItem('flow-canvas-agent-providers');
            if (savedProviders) {
                this.providers = JSON.parse(savedProviders);
            }

            const savedGlobal = localStorage.getItem('flow-canvas-agent-global');
            if (savedGlobal) {
                Object.assign(this.globalConfig, JSON.parse(savedGlobal));
            }
        } catch (e) {
            console.warn('[Agent] 配置加载失败', e);
        }

        this._ensureProviderRoles();
    }

    _saveConfig() {
        try {
            localStorage.setItem('flow-canvas-agent-providers', JSON.stringify(this.providers));
            localStorage.setItem('flow-canvas-agent-global', JSON.stringify(this.globalConfig));
        } catch (e) {
            console.warn('[Agent] 配置保存失败', e);
        }
    }

    _isImageProvider(provider) {
        const marker = `${provider?.model || ''} ${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        return /(image|gpt-image|dall-e|imagen|flux|stable|sdxl|midjourney)/.test(marker);
    }

    _isVideoProvider(provider) {
        const marker = `${provider?.model || ''} ${provider?.endpoint || ''} ${provider?.name || ''}`.toLowerCase();
        return /(seedance|artsdance|dreamina|video|kling|可灵|sora|runway|veo|vidu|minimax[^a-z0-9]*h3|hunyuan|腾讯|通义.*视频|wan[^\s]*(?:t2v|i2v))/.test(marker);
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
        return this._providerVariants().find(provider => this._isImageProvider(provider) && !this._isVideoProvider(provider))?.id || null;
    }

    _ensureProviderRoles() {
        if (this.providers.length === 0) {
            this.globalConfig.imageProviderId = null;
            this.globalConfig.videoProviderId = null;
            return;
        }

        const currentImageProvider = this._findProvider(this.globalConfig.imageProviderId);
        const currentVideoProvider = this._findProvider(this.globalConfig.videoProviderId);
        if (!currentImageProvider || !this._isImageProvider(currentImageProvider) || this._isVideoProvider(currentImageProvider)) {
            this.globalConfig.imageProviderId = this._getDefaultImageProviderId();
        }
        if (!currentVideoProvider || !this._isVideoProvider(currentVideoProvider)) {
            this.globalConfig.videoProviderId = null;
        }
    }

    _setImageProvider(id) {
        if (!this._findProvider(id)) return;
        this.globalConfig.imageProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
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

    _getVideoProvider() {
        return this._findProvider(this.globalConfig.videoProviderId);
    }

    _providerLabel(provider) {
        if (!provider) return '未知 API';
        return `${provider.name || '未命名 API'}（${provider.model || '未设置模型'}）`;
    }

    getImageProviderConfig() {
        const provider = this._getImageProvider();
        return provider ? { ...provider } : null;
    }

    getVideoProviderConfig() {
        const provider = this._getVideoProvider();
        return provider ? { ...provider } : null;
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
        this.fetchedModelSelect.hidden = models.length === 0;

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
                this.providers[idx] = { ...this.providers[idx], id: this.editingProviderId, name, type, endpoint, apiKey, model, models };
            }
        } else {
            const newProvider = {
                id: 'api_' + Date.now() + Math.random().toString(36).substr(2, 5),
                name, type, endpoint, apiKey, model, models
            };
            this.providers.push(newProvider);
            if (this._isImageProvider(newProvider) && !this._isVideoProvider(newProvider)) {
                this.globalConfig.imageProviderId = newProvider.id;
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
        if (this._isVideoProvider(provider)) {
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
            const isImage = this._selectionUsesProvider(this.globalConfig.imageProviderId, p.id);
            const isVideo = this._selectionUsesProvider(this.globalConfig.videoProviderId, p.id);
            card.className = `agent-provider-card ${isImage || isVideo ? 'active' : ''}`;

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
            this._renderVideoProviderContext();
            if (this.currentMode === 'video') this._renderVideoStage();
            return;
        }

        selects.forEach(({ el, role, selectedId }) => {
            const opt = document.createElement('option');
            opt.value = "";
            opt.textContent = role === 'image' ? "-- 选择生图 API --" : "-- 选择视频 API --";
            el.appendChild(opt);
            if (role === 'video') opt.textContent = '-- \u9009\u62e9\u89c6\u9891 API --';

            this._providerVariants().forEach(p => {
                const matchesRole = role === 'video'
                    ? this._isVideoProvider(p)
                    : this._isImageProvider(p) && !this._isVideoProvider(p);
                if (!matchesRole) return;
                const option = document.createElement('option');
                option.value = p.id;
                option.textContent = `${p.name} (${p.model})`;
                if (p.id === selectedId) {
                    option.selected = true;
                }
                el.appendChild(option);
            });
        });
        this._renderVideoProviderContext();
        this._renderImageModelCapabilities();
        if (this.currentMode === 'video') this._renderVideoStage();
    }

}
