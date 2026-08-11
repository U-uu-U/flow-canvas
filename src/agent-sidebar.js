// ============================================================
// Flow Canvas — Agent Sidebar (AI 对话右侧边栏)
// ============================================================

const DEFAULT_TEMPLATES = {
    'ravenhash-chat': { name: 'RavenHash Chat', type: 'openai', endpoint: 'https://ai.ravenhash.org', model: '' },
    ravenhash: { name: 'RavenHash Image', type: 'openai', endpoint: 'https://ai.ravenhash.org', model: 'gpt-image-2' },
    'ravenhash-video': { name: 'RavenHash Video', type: 'openai', endpoint: 'https://art.ravenhash.org', model: 'doubao-seedance-2-0' }
};

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
        referenceLimits: { image: 5, video: 0, audio: 1 },
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
const GENERATION_TASKS_STORAGE_KEY = 'flow-canvas-generation-tasks';
const GENERATION_TASK_LIMIT = 100;
const BROWSER_SYNC_EVENT_IDS_KEY = 'flow-canvas-browser-sync-event-ids';

export class AgentSidebar {
    constructor(options = {}) {
        this.options = options;
        // 全局配置：系统提示词，选中的 provider ID 等
        this.globalConfig = {
            systemPrompt: '你是一个有用的 AI 助手，正在帮助用户管理和分析他们白板上的内容。',
            chatProviderId: null,
            imageProviderId: null,
            videoProviderId: null,
            activeProviderId: null
        };
        // 存储所有的 provider { id, name, type, endpoint, apiKey, model }
        this.providers = [];

        this.messages = []; // { role: 'user'|'assistant', content: string }
        this.isStreaming = false;
        this.editingProviderId = null;
        this.availableSkills = [];
        this.imageGenerationMode = 'text';
        this.imageReferenceSelections = [];
        this.videoReferenceSelections = { image: [], video: [], audio: [] };
        this.activeReferenceWorkspace = null;
        this.activeVideoReferenceType = null;

        // DOM 引用
        this.messagesEl = document.getElementById('agentMessages');
        this.inputEl = document.getElementById('agentInput');
        this.sendBtn = document.getElementById('agentSendBtn');
        this.settingsPanel = document.getElementById('agentSettings');

        // Settings elements
        this.providerListEl = document.getElementById('agentProviderList');
        this.addApiBtn = document.getElementById('agentAddApiBtn');
        this.apiForm = document.getElementById('agentApiForm');
        this.apiFormCloseBtn = document.getElementById('agentApiFormClose');
        this.apiFormTitle = document.getElementById('agentApiFormTitle');
        this.modelSelectEl = document.getElementById('agentModelSelect');
        this.imageModelSelectEl = document.getElementById('agentImageModelSelect');
        this.videoModelSelectEl = document.getElementById('agentVideoModelSelect');
        this.systemPromptEl = document.getElementById('agentSystemPrompt');
        this.fetchSkillsBtn = document.getElementById('agentFetchSkillsBtn');
        this.skillSelect = document.getElementById('agentSkillSelect');
        this.skillDescription = document.getElementById('agentSkillDescription');
        this.useSkillBtn = document.getElementById('agentUseSkillBtn');
        this.removeSkillBtn = document.getElementById('agentRemoveSkillBtn');
        this.promptSkillStatusEl = document.getElementById('agentPromptSkillStatus');
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
        this.videoAddImageBtn = document.getElementById('videoAddImageBtn');
        this.videoAddVideoBtn = document.getElementById('videoAddVideoBtn');
        this.videoAddAudioBtn = document.getElementById('videoAddAudioBtn');
        this.videoClearSourcesBtn = document.getElementById('videoClearSourcesBtn');
        this.videoWorkspaceStatus = document.getElementById('videoWorkspaceStatus');
        this.videoGenerateBtn = document.getElementById('videoGenerateBtn');
        this.videoGenerateMessage = document.getElementById('videoGenerateMessage');
        this.videoPromptProviderChip = document.getElementById('videoPromptProviderChip');
        this.videoPromptModelChip = document.getElementById('videoPromptModelChip');
        this.imageWorkspace = document.getElementById('imageWorkspace');
        this.imagePromptInput = document.getElementById('imagePromptInput');
        this.imageGenerationModeControl = document.getElementById('imageGenerationModeControl');
        this.imageReferencePanel = document.getElementById('imageReferencePanel');
        this.imageReferenceCount = document.getElementById('imageReferenceCount');
        this.imageReferenceList = document.getElementById('imageReferenceList');
        this.imageAddReferenceBtn = document.getElementById('imageAddReferenceBtn');
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
        this.modePickerHideTimer = null;
        this.lastCanvasSelection = this.options.getSelectedCanvasEntries?.() || [];

        // Form inputs
        this.formName = document.getElementById('agentFormName');
        this.formType = document.getElementById('agentFormType');
        this.formEndpoint = document.getElementById('agentFormEndpoint');
        this.formKey = document.getElementById('agentFormKey');
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
        this._pollBrowserSyncEvents();
        this.browserSyncTimer = setInterval(() => this._pollBrowserSyncEvents(), 4000);
        this.options.subscribeCanvasSelection?.((entries) => {
            this.lastCanvasSelection = Array.isArray(entries) ? entries : [];
        });
        this.options.subscribeMediaReferenceSelection?.((payload) => {
            const type = payload?.type;
            if (this.activeReferenceWorkspace === 'image' && type === 'image') {
                this.imageReferenceSelections = Array.isArray(payload.entries) ? payload.entries : [];
                this._renderImageReferences();
                return;
            }
            if (this.activeReferenceWorkspace !== 'video') return;
            if (!VIDEO_REFERENCE_LIMITS[type]) return;
            this.videoReferenceSelections[type] = (Array.isArray(payload.entries) ? payload.entries : [])
                .slice(0, VIDEO_REFERENCE_LIMITS[type]);
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
        this.videoAddImageBtn?.addEventListener('click', () => this._toggleVideoReferencePick('image'));
        this.videoAddVideoBtn?.addEventListener('click', () => this._toggleVideoReferencePick('video'));
        this.videoAddAudioBtn?.addEventListener('click', () => this._toggleVideoReferencePick('audio'));
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
        this.imageClearReferencesBtn?.addEventListener('click', () => this._clearImageReferences());
        this.imageReferenceList?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-remove-image-reference]');
            if (button) this._removeImageReference(button.dataset.removeImageReference);
        });
        this.imageGenerateBtn?.addEventListener('click', () => this._generateImageFromWorkspace());
        document.getElementById('videoChangeModelBtn')?.addEventListener('click', () => this._showVideoModelPicker());
        this.videoModelFavoriteBtn?.addEventListener('click', () => this._toggleSelectedVideoModelFavorite());
        this.videoModelCopyBtn?.addEventListener('click', () => this._copySelectedVideoModelId());
        document.getElementById('videoPromptModelChip')?.addEventListener('click', () => this._showVideoModelPicker());
        document.getElementById('videoModelOpenSettingsBtn')?.addEventListener('click', () => this.setMode('settings'));
        this.videoModelSearchInput?.addEventListener('input', () => this._renderVideoModelPicker());

        document.getElementById('agentCollapseBtn')?.addEventListener('click', () => this.close());

        // 退出当前模式并回到普通画板。
        document.getElementById('creationModeCloseBtn')?.addEventListener('click', exitCreationMode);

        // 清空按钮
        document.getElementById('agentClearBtn')?.addEventListener('click', () => this.clearMessages());

        document.getElementById('agentPlanBtn')?.addEventListener('click', () => this._assistPlanning());

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
        document.querySelectorAll('[data-ravenhash-site]').forEach(button => {
            button.addEventListener('click', async () => {
                const site = button.dataset.ravenhashSite;
                button.disabled = true;
                try {
                    await window.flowCanvas?.shell?.openRavenHash?.(site);
                } catch (err) {
                    console.error('[AgentSidebar] Failed to open RavenHash:', err);
                } finally {
                    button.disabled = false;
                }
            });
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

        // 系统提示词实时保存
        this.systemPromptEl?.addEventListener('input', () => {
            this.globalConfig.systemPrompt = this.systemPromptEl.value;
            this._saveConfig();
            this._renderSystemPromptSkillState({ preserveMessage: true });
        });

        this.fetchSkillsBtn?.addEventListener('click', () => this._fetchAvailableSkills());
        this.skillSelect?.addEventListener('change', () => this._renderSelectedSkillDetails());
        this.useSkillBtn?.addEventListener('click', () => this._applySelectedSkill());
        this.removeSkillBtn?.addEventListener('click', () => this._removeActiveSkill());

        // 顶部下拉框切换
        this.modelSelectEl?.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) {
                this._setChatProvider(id);
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

        // 发送消息
        this.sendBtn?.addEventListener('click', () => this._send());

        // Enter 发送，Shift+Enter 换行
        this.inputEl?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this._send();
            }
        });

        // 自动调整输入框高度
        this.inputEl?.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
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
    }

    _toggleVideoReferencePick(type) {
        if (this.activeVideoReferenceType === type) {
            this.options.endMediaReferencePick?.();
            return;
        }
        const profile = this._getVideoModelProfile(this._getVideoProvider()) || DEFAULT_VIDEO_MODEL_PROFILE;
        const limits = this._getVideoReferenceLimits(profile);
        if ((limits[type] || 0) <= 0) return;
        this.options.endMediaReferencePick?.({ silent: true });
        this.activeReferenceWorkspace = 'video';
        this.options.beginMediaReferencePick?.(
            type,
            this.videoReferenceSelections[type],
            limits[type],
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
        const activeType = this.activeVideoReferenceType;
        this.videoAddImageBtn?.classList.toggle('active', activeType === 'image');
        this.videoAddVideoBtn?.classList.toggle('active', activeType === 'video');
        this.videoAddAudioBtn?.classList.toggle('active', activeType === 'audio');
        if (this.videoAddImageBtn) {
            this.videoAddImageBtn.querySelector('span').textContent = activeType === 'image' ? '选择图片中' : '添加图片';
            this.videoAddImageBtn.setAttribute('aria-pressed', String(activeType === 'image'));
        }
        if (this.videoAddVideoBtn) {
            this.videoAddVideoBtn.querySelector('span').textContent = activeType === 'video' ? '选择视频中' : '添加视频';
            this.videoAddVideoBtn.setAttribute('aria-pressed', String(activeType === 'video'));
        }
        if (this.videoAddAudioBtn) {
            this.videoAddAudioBtn.querySelector('span').textContent = activeType === 'audio' ? '选择音频中' : '添加音频';
            this.videoAddAudioBtn.setAttribute('aria-pressed', String(activeType === 'audio'));
        }
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
    }

    _renderImageReferences() {
        const isReferenceMode = this.imageGenerationMode === 'reference';
        this.imageGenerationModeControl?.querySelectorAll('[data-image-generation-mode]').forEach(button => {
            const active = button.dataset.imageGenerationMode === this.imageGenerationMode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        if (this.imageReferencePanel) this.imageReferencePanel.hidden = !isReferenceMode;
        if (this.imageReferenceCount) this.imageReferenceCount.textContent = `已选 ${this.imageReferenceSelections.length} 张`;
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
        if (this.activeVideoReferenceType && limits[this.activeVideoReferenceType] <= 0) {
            this.options.endMediaReferencePick?.();
        }
        const referenceButtons = {
            image: this.videoAddImageBtn,
            video: this.videoAddVideoBtn,
            audio: this.videoAddAudioBtn
        };
        Object.entries(referenceButtons).forEach(([type, button]) => {
            if (button) button.hidden = limits[type] <= 0;
            const entries = this.videoReferenceSelections[type] || [];
            const trimmed = entries.slice(0, Math.max(0, limits[type]));
            if (trimmed.length !== entries.length) {
                this.videoReferenceSelections[type] = trimmed;
                this.options.updateMediaReferencePick?.(type, trimmed);
            }
        });

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
            const syncStageLabel = status === 'running' && task.params?.syncStage === 'ready'
                ? '待下载'
                : status === 'running' && task.params?.syncStage === 'downloading'
                    ? '下载中'
                    : status === 'running' && task.params?.syncStage === 'recovering'
                        ? '\u6062\u590d\u8fde\u63a5\u4e2d'
                        : statusLabels[status];
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

        this._updateGenerationTask(task.id, {
            status: 'running',
            error: null,
            attempts: (task.attempts || 1) + 1
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
                    sourceReferences: task.sourcePaths.map(filePath => ({ filePath })),
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

    async _inspectLargeVideoReferenceImages(references) {
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
        if (totalBytes <= VIDEO_REFERENCE_LARGE_TOTAL_BYTES) return null;
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

    _showVideoReferenceCompressionDialog(summary) {
        return new Promise(resolve => {
            document.querySelector('.video-compression-dialog-overlay')?.remove();
            const overlay = document.createElement('div');
            overlay.className = 'video-compression-dialog-overlay';
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
                    <p class="video-compression-dialog-note">\u538b\u7f29\u4f1a\u751f\u6210\u65b0\u56fe\u7247\u5e76\u653e\u5230\u753b\u677f\u4e0a\uff0c\u539f\u56fe\u4e0d\u4f1a\u88ab\u4fee\u6539\u3002\u538b\u7f29\u5b8c\u6210\u540e\u4e0d\u4f1a\u81ea\u52a8\u751f\u6210\u89c6\u9891\u3002</p>
                    <div class="video-compression-dialog-actions">
                        <button class="video-compression-cancel" type="button">\u53d6\u6d88</button>
                        <button class="video-compression-original" type="button">\u4f7f\u7528\u539f\u56fe\u7ee7\u7eed\u751f\u6210</button>
                        <button class="video-compression-confirm" type="button">\u538b\u7f29\u5230\u753b\u677f</button>
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
        const compressionSummary = await this._inspectLargeVideoReferenceImages(imageReferences);
        if (compressionSummary) {
            const compressionChoice = await this._showVideoReferenceCompressionDialog(compressionSummary);
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
        const sourcePaths = this.imageGenerationMode === 'reference'
            ? this.imageReferenceSelections.map(entry => entry.filePath).filter(Boolean)
            : [];
        if (this.imageGenerationMode === 'reference' && sourcePaths.length === 0) {
            this._setWorkspaceMessage(this.imageGenerateMessage, 'error', '\u8bf7\u5148\u4ece\u753b\u5e03\u4e2d\u9009\u62e9\u81f3\u5c11\u4e00\u5f20\u53c2\u8003\u56fe');
            return;
        }
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
                sourceReferences: sourcePaths.map(filePath => ({ filePath })),
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

        // 回填系统提示词
        if (this.systemPromptEl) {
            this.systemPromptEl.value = this.globalConfig.systemPrompt;
        }
        this._renderSystemPromptSkillState();
    }

    _saveConfig() {
        try {
            this.globalConfig.activeProviderId = this.globalConfig.chatProviderId || this.globalConfig.activeProviderId;
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

    _getDefaultChatProviderId() {
        return this._providerVariants().find(provider => !this._isImageProvider(provider) && !this._isVideoProvider(provider))?.id || null;
    }

    _getDefaultImageProviderId() {
        return this._providerVariants().find(provider => this._isImageProvider(provider) && !this._isVideoProvider(provider))?.id || null;
    }

    _ensureProviderRoles() {
        if (this.providers.length === 0) {
            this.globalConfig.chatProviderId = null;
            this.globalConfig.imageProviderId = null;
            this.globalConfig.videoProviderId = null;
            this.globalConfig.activeProviderId = null;
            return;
        }

        const legacyId = this.globalConfig.activeProviderId;
        const legacyProvider = this._findProvider(legacyId);
        const currentChatProvider = this._findProvider(this.globalConfig.chatProviderId);
        const currentImageProvider = this._findProvider(this.globalConfig.imageProviderId);
        const currentVideoProvider = this._findProvider(this.globalConfig.videoProviderId);
        if (!currentChatProvider || this._isImageProvider(currentChatProvider) || this._isVideoProvider(currentChatProvider)) {
            this.globalConfig.chatProviderId = legacyProvider && !this._isImageProvider(legacyProvider) && !this._isVideoProvider(legacyProvider)
                ? legacyProvider.id
                : this._getDefaultChatProviderId();
        }
        if (!currentImageProvider || !this._isImageProvider(currentImageProvider) || this._isVideoProvider(currentImageProvider)) {
            this.globalConfig.imageProviderId = legacyProvider && this._isImageProvider(legacyProvider) && !this._isVideoProvider(legacyProvider)
                ? legacyProvider.id
                : this._getDefaultImageProviderId();
        }
        if (!currentVideoProvider || !this._isVideoProvider(currentVideoProvider)) {
            this.globalConfig.videoProviderId = null;
        }
        this.globalConfig.activeProviderId = this.globalConfig.chatProviderId;
    }

    _setChatProvider(id) {
        if (!this._findProvider(id)) return;
        this.globalConfig.chatProviderId = id;
        this.globalConfig.activeProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
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

    _getChatProvider() {
        return this._findProvider(this.globalConfig.chatProviderId || this.globalConfig.activeProviderId);
    }

    _getImageProvider() {
        return this._findProvider(this.globalConfig.imageProviderId);
    }

    _getVideoProvider() {
        return this._findProvider(this.globalConfig.videoProviderId);
    }

    _getProviderFallbackChain(kind) {
        const selectedId = kind === 'image'
            ? this.globalConfig.imageProviderId
            : kind === 'video'
                ? this.globalConfig.videoProviderId
                : (this.globalConfig.chatProviderId || this.globalConfig.activeProviderId);
        const isMatchingKind = provider => {
            if (kind === 'image') return this._isImageProvider(provider) && !this._isVideoProvider(provider);
            if (kind === 'video') return this._isVideoProvider(provider);
            return !this._isImageProvider(provider) && !this._isVideoProvider(provider);
        };

        const selected = this._findProvider(selectedId);
        const candidates = [
            selected && isMatchingKind(selected) ? selected : null,
            ...this._providerVariants().filter(provider => provider?.id !== selectedId && isMatchingKind(provider))
        ].filter(provider => provider?.apiKey && provider?.endpoint && provider?.model);

        return candidates.slice(0, 2);
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

    _setSystemPrompt(value) {
        this.globalConfig.systemPrompt = value;
        if (this.systemPromptEl) {
            this.systemPromptEl.value = value;
        }
        this._saveConfig();
        this._renderSystemPromptSkillState();
    }

    _escapeRegExp(value) {
        return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    _getSkillStartMarker(skillId) {
        return `[Flow Canvas Skill: ${skillId}]`;
    }

    _getSkillEndMarker(skillId) {
        return `[/Flow Canvas Skill: ${skillId}]`;
    }

    _getSystemPromptSkillBlock(skill) {
        const lines = [
            this._getSkillStartMarker(skill.id),
            `Skill Name: ${skill.name || skill.id}`,
            `Skill Source: ${skill.sourceLabel || skill.source || 'Local Skill'}`,
            skill.relativePath ? `Skill Path: ${skill.relativePath}` : '',
            skill.description ? `Skill Description: ${skill.description}` : '',
            '',
            'Use the following local skill instructions when they are relevant to the user request.',
            'If Flow Canvas cannot access a tool mentioned by the skill, explain the intended workflow instead of pretending the tool was used.',
            '',
            '--- SKILL.md ---',
            skill.content || skill.description || '',
            '--- END SKILL.md ---',
            this._getSkillEndMarker(skill.id)
        ].filter(line => line !== null && line !== undefined).join('\n');

        return lines.replace(/\n{3,}/g, '\n\n');
    }

    _removeSystemPromptSkillBlocks(prompt) {
        const pattern = /\n*\[Flow Canvas Skill: [^\]\r\n]+\][\s\S]*?\[\/Flow Canvas Skill: [^\]\r\n]+\]\n*/g;
        return String(prompt || '').replace(pattern, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    _getActiveSkillBlocks() {
        const prompt = String(this.globalConfig.systemPrompt || '');
        const blocks = [];
        const pattern = /\[Flow Canvas Skill: ([^\]\r\n]+)\]([\s\S]*?)\[\/Flow Canvas Skill: \1\]/g;
        let match;

        while ((match = pattern.exec(prompt)) !== null) {
            const id = match[1];
            const knownSkill = this.availableSkills.find(skill => skill.id === id);
            const nameMatch = match[2].match(/Skill Name:\s*(.+)/);
            blocks.push({
                id,
                name: knownSkill?.name || nameMatch?.[1]?.trim() || id
            });
        }

        return blocks;
    }

    _setSkillStatus(type, message) {
        if (!this.promptSkillStatusEl) return;
        this.promptSkillStatusEl.className = 'agent-prompt-skill-status';
        if (type) this.promptSkillStatusEl.classList.add(type);
        this.promptSkillStatusEl.textContent = message || '';
    }

    _renderSkillOptions() {
        if (!this.skillSelect) return;

        this.skillSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = '选择拉取到的技能';
        this.skillSelect.appendChild(placeholder);

        this.availableSkills.forEach(skill => {
            const option = document.createElement('option');
            option.value = skill.id;
            option.textContent = `${skill.name || skill.id} · ${skill.sourceLabel || skill.source || 'Local'}`;
            this.skillSelect.appendChild(option);
        });

        this.skillSelect.hidden = this.availableSkills.length === 0;
    }

    _renderSelectedSkillDetails() {
        const skill = this.availableSkills.find(item => item.id === this.skillSelect?.value);
        if (this.skillDescription) {
            if (skill) {
                const parts = [
                    skill.description || '该技能没有提供简介。',
                    `${skill.sourceLabel || skill.source || 'Local'} / ${skill.relativePath || skill.id}`
                ];
                this.skillDescription.textContent = parts.join('\n');
            } else {
                this.skillDescription.textContent = this.availableSkills.length
                    ? '请选择一个技能后再使用。'
                    : '';
            }
        }

        if (this.useSkillBtn) {
            this.useSkillBtn.disabled = !skill;
        }
    }

    async _fetchAvailableSkills() {
        if (!window.flowCanvas?.ai?.listSkills) {
            this._setSkillStatus('error', '当前运行环境不支持拉取技能列表，请重启应用后再试');
            return;
        }

        const previousText = this.fetchSkillsBtn?.textContent;
        if (this.fetchSkillsBtn) {
            this.fetchSkillsBtn.disabled = true;
            this.fetchSkillsBtn.textContent = '拉取中...';
        }
        if (this.useSkillBtn) this.useSkillBtn.disabled = true;
        if (this.skillDescription) this.skillDescription.textContent = '';
        this._setSkillStatus('loading', '正在拉取本地技能列表...');

        try {
            const result = await window.flowCanvas.ai.listSkills();
            if (!result?.success) {
                throw new Error(result?.error || '技能列表接口没有返回可用结果');
            }

            this.availableSkills = Array.isArray(result.skills) ? result.skills : [];
            this._renderSkillOptions();
            this._renderSelectedSkillDetails();

            if (this.availableSkills.length === 0) {
                this._setSkillStatus('error', '没有拉取到可用技能');
                return;
            }

            this._setSkillStatus('success', `已拉取 ${this.availableSkills.length} 个技能，请选择后使用`);
        } catch (err) {
            this.availableSkills = [];
            this._renderSkillOptions();
            this._renderSelectedSkillDetails();
            this._setSkillStatus('error', `拉取失败：${err.message || err}`);
        } finally {
            if (this.fetchSkillsBtn) {
                this.fetchSkillsBtn.disabled = false;
                this.fetchSkillsBtn.textContent = previousText || '拉取技能列表';
            }
            this._renderSystemPromptSkillState();
        }
    }

    async _applySelectedSkill() {
        const skillId = this.skillSelect?.value;
        if (!skillId) {
            this._setSkillStatus('error', '请先选择一个技能');
            return;
        }
        if (!window.flowCanvas?.ai?.getSkill) {
            this._setSkillStatus('error', '当前运行环境不支持读取技能内容，请重启应用后再试');
            return;
        }

        const previousText = this.useSkillBtn?.textContent;
        if (this.useSkillBtn) {
            this.useSkillBtn.disabled = true;
            this.useSkillBtn.textContent = '读取中...';
        }
        this._setSkillStatus('loading', '正在读取技能内容...');

        try {
            const result = await window.flowCanvas.ai.getSkill(skillId);
            if (!result?.success || !result.skill) {
                throw new Error(result?.error || '没有读取到该技能内容');
            }

            const promptWithoutOldSkill = this._removeSystemPromptSkillBlocks(this.globalConfig.systemPrompt);
            const nextPrompt = [promptWithoutOldSkill, this._getSystemPromptSkillBlock(result.skill)]
                .filter(Boolean)
                .join('\n\n');
            this._setSystemPrompt(nextPrompt);
            this._setSkillStatus('success', `已注入：${result.skill.name || result.skill.id}`);
        } catch (err) {
            this._setSkillStatus('error', `使用失败：${err.message || err}`);
        } finally {
            if (this.useSkillBtn) {
                this.useSkillBtn.disabled = !this.skillSelect?.value;
                this.useSkillBtn.textContent = previousText || '使用选中技能';
            }
        }
    }

    _removeActiveSkill() {
        const nextPrompt = this._removeSystemPromptSkillBlocks(this.globalConfig.systemPrompt);
        this._setSystemPrompt(nextPrompt);
    }

    _renderSystemPromptSkillState({ preserveMessage = false } = {}) {
        const activeSkills = this._getActiveSkillBlocks();
        if (this.removeSkillBtn) {
            this.removeSkillBtn.disabled = activeSkills.length === 0;
        }

        if (preserveMessage) return;

        if (activeSkills.length > 0) {
            this._setSkillStatus('', `已注入：${activeSkills.map(skill => skill.name).join('、')}`);
        } else if (this.promptSkillStatusEl && !this.promptSkillStatusEl.classList.contains('loading')) {
            this._setSkillStatus('', '未注入技能片段');
        }
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
            this.formEndpoint.value = provider.endpoint;
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
        const endpoint = this.formEndpoint?.value?.trim() || '';
        const apiKey = this.formKey?.value?.trim() || '';

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
        const endpoint = this.formEndpoint.value.trim();
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
            } else if (!this._isVideoProvider(newProvider) && !this._findProvider(this.globalConfig.chatProviderId)) {
                this.globalConfig.chatProviderId = newProvider.id;
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
        } else {
            this._setChatProvider(id);
        }
    }

    _renderProviderList() {
        if (!this.providerListEl) return;
        this.providerListEl.innerHTML = '';

        this.providers.forEach(p => {
            const card = document.createElement('div');
            const isChat = this._selectionUsesProvider(this.globalConfig.chatProviderId, p.id);
            const isImage = this._selectionUsesProvider(this.globalConfig.imageProviderId, p.id);
            const isVideo = this._selectionUsesProvider(this.globalConfig.videoProviderId, p.id);
            card.className = `agent-provider-card ${isChat || isImage || isVideo ? 'active' : ''}`;

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
            if (isChat) {
                const badge = document.createElement('span');
                badge.className = 'agent-provider-role chat';
                badge.textContent = '对话';
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
            { el: this.modelSelectEl, role: 'chat', selectedId: this.globalConfig.chatProviderId },
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
            opt.textContent = role === 'image' ? "-- 选择生图 API --" : "-- 选择对话 API --";
            el.appendChild(opt);
            if (role === 'video') opt.textContent = '-- \u9009\u62e9\u89c6\u9891 API --';

            this._providerVariants().forEach(p => {
                const matchesRole = role === 'video'
                    ? this._isVideoProvider(p)
                    : role === 'image'
                        ? this._isImageProvider(p) && !this._isVideoProvider(p)
                        : !this._isImageProvider(p) && !this._isVideoProvider(p);
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

    // ── 消息渲染 ──
    _addMessage(role, content) {
        if (!this.messagesEl) return null;
        // 隐藏欢迎消息
        const welcome = this.messagesEl.querySelector('.agent-welcome');
        if (welcome) welcome.style.display = 'none';

        const div = document.createElement('div');
        div.className = `agent-msg ${role}`;
        div.textContent = content;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _addTypingIndicator() {
        if (!this.messagesEl) return null;
        const div = document.createElement('div');
        div.className = 'agent-msg assistant agent-typing';
        div.innerHTML = '<span class="agent-loading-ring" aria-hidden="true"></span><span class="agent-typing-line"></span>';
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _addErrorMessage(text) {
        if (!this.messagesEl) {
            console.error('[Agent]', text);
            return;
        }
        const div = document.createElement('div');
        div.className = 'agent-msg error';
        div.textContent = text;
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
    }

    _scrollToBottom() {
        requestAnimationFrame(() => {
            if (this.messagesEl) {
                this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
            }
        });
    }

    // ── 获取活跃的 API 配置 ──
    _getActiveProvider() {
        return this._getChatProvider();
    }

    _isNativeGeminiProvider(provider) {
        return provider?.type === 'google' && String(provider.endpoint || '').includes('generateContent');
    }

    _isAnthropicProvider(provider) {
        return provider?.type === 'anthropic' ||
            String(provider?.endpoint || '').includes('api.anthropic.com/v1/messages');
    }

    _buildOpenAiChatEndpoint(endpoint) {
        const value = String(endpoint || '').trim();
        if (!value) return value;

        try {
            const url = new URL(value);
            let pathName = url.pathname.replace(/\/+$/, '');
            if (!pathName || pathName === '/') {
                pathName = '/v1/chat/completions';
            } else if (/\/v1$/i.test(pathName)) {
                pathName += '/chat/completions';
            } else if (/\/models$/i.test(pathName)) {
                pathName = pathName.replace(/\/models$/i, '/chat/completions');
            }
            url.pathname = pathName;
            return url.toString();
        } catch (err) {
            return value;
        }
    }

    _compactPlanningContext(context) {
        if (!context || typeof context !== 'object') return null;

        return {
            schema: context.schema || 'flow-canvas.agent-planning-context.v1',
            activeGroup: context.activeGroup || null,
            plans: Array.isArray(context.plans)
                ? context.plans.map(plan => ({
                    id: plan.id,
                    title: plan.title,
                    rowCount: plan.rowCount ?? plan.rows?.length ?? 0,
                    columns: Array.isArray(plan.columns) ? plan.columns : [],
                    rows: Array.isArray(plan.rows) ? plan.rows : []
                }))
                : [],
            selectedFiles: Array.isArray(context.selectedFiles) ? context.selectedFiles : []
        };
    }

    _getBoardContextPrompt() {
        const getContext = this.options.getPlanningContext;
        if (typeof getContext !== 'function') return '';

        let context = null;
        try {
            context = this._compactPlanningContext(getContext());
        } catch (err) {
            console.warn('[Agent] Failed to read board context:', err);
            return '';
        }

        if (!context) return '';

        let payload = '';
        try {
            payload = JSON.stringify(context, null, 2);
        } catch (err) {
            console.warn('[Agent] Failed to serialize board context:', err);
            return '';
        }

        const maxChars = 24000;
        const truncated = payload.length > maxChars;
        if (truncated) payload = payload.slice(0, maxChars);

        return [
            'Flow Canvas live board context is auto-injected below.',
            'Use it as the current source of truth for the user board, planning matrices, rows, columns, row references, and selected files.',
            'If the `plans` array contains rows, do not say you cannot see the planning table. Answer from this structured context.',
            truncated ? 'The context was truncated because it was too large; say what may be missing if needed.' : '',
            '',
            '```json',
            payload,
            '```'
        ].filter(Boolean).join('\n');
    }

    _buildSystemPrompt() {
        return [
            String(this.globalConfig.systemPrompt || '').trim(),
            this._getBoardContextPrompt()
        ].filter(Boolean).join('\n\n');
    }

    _buildRequestPayload(provider) {
        const systemPrompt = this._buildSystemPrompt();

        if (this._isNativeGeminiProvider(provider)) {
            const endpoint = String(provider.endpoint || '');
            const usesQueryKey = endpoint.includes('?key=');
            return {
                targetUrl: usesQueryKey ? `${endpoint}${provider.apiKey}` : endpoint,
                headers: usesQueryKey
                    ? { 'Content-Type': 'application/json' }
                    : { 'Content-Type': 'application/json', 'x-goog-api-key': provider.apiKey },
                body: {
                    system_instruction: {
                        parts: [{ text: systemPrompt }]
                    },
                    contents: this.messages.map(message => ({
                        role: message.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: message.content }]
                    }))
                },
                responseMode: 'geminiJson'
            };
        }

        if (this._isAnthropicProvider(provider)) {
            return {
                targetUrl: provider.endpoint,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': provider.apiKey,
                    'anthropic-version': '2023-06-01',
                    'anthropic-dangerous-direct-browser-access': 'true'
                },
                body: {
                    model: provider.model,
                    max_tokens: 2048,
                    ...(systemPrompt ? { system: systemPrompt } : {}),
                    messages: this.messages.map(message => ({
                        role: message.role,
                        content: message.content
                    }))
                },
                responseMode: 'anthropicJson'
            };
        }

        return {
            targetUrl: this._buildOpenAiChatEndpoint(provider.endpoint),
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`
            },
            body: {
                model: provider.model,
                messages: [
                    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
                    ...this.messages
                ],
                stream: false
            },
            responseMode: 'openaiJson'
        };
    }

    _extractGeminiText(payload) {
        const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
        const parts = candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const text = parts
                .map(part => typeof part?.text === 'string' ? part.text : '')
                .join('');
            if (text) return text;
        }

        const blockReason = payload?.promptFeedback?.blockReason;
        return blockReason ? `Gemini 返回被拦截: ${blockReason}` : '';
    }

    _extractAnthropicText(payload) {
        const blocks = Array.isArray(payload?.content) ? payload.content : [];
        return blocks
            .map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '')
            .join('');
    }

    _extractOpenAiText(payload) {
        const choices = Array.isArray(payload?.choices) ? payload.choices : [];
        const firstChoice = choices[0] || {};
        const content = firstChoice.message?.content;

        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .map(part => {
                    if (typeof part === 'string') return part;
                    if (typeof part?.text === 'string') return part.text;
                    if (typeof part?.content === 'string') return part.content;
                    return '';
                })
                .join('');
        }

        if (typeof firstChoice.text === 'string') return firstChoice.text;
        if (typeof payload?.output_text === 'string') return payload.output_text;

        const output = Array.isArray(payload?.output) ? payload.output : [];
        return output
            .flatMap(item => Array.isArray(item?.content) ? item.content : [])
            .map(part => typeof part?.text === 'string' ? part.text : '')
            .join('');
    }

    _extractOpenAiSseText(text) {
        return String(text || '')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .filter(data => data && data !== '[DONE]')
            .map(data => {
                try {
                    const json = JSON.parse(data);
                    return json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || '';
                } catch (err) {
                    return '';
                }
            })
            .join('');
    }

    _extractChatResultText(responseMode, payload, text) {
        if (responseMode === 'geminiJson') return this._extractGeminiText(payload);
        if (responseMode === 'anthropicJson') return this._extractAnthropicText(payload);
        if (responseMode === 'openaiSse') return this._extractOpenAiSseText(text);
        if (responseMode === 'openaiJson') {
            return this._extractOpenAiText(payload) || (!payload ? String(text || '') : '');
        }
        return this._extractOpenAiText(payload)
            || this._extractGeminiText(payload)
            || this._extractAnthropicText(payload)
            || String(text || '');
    }

    _emptyChatResponseMessage(responseMode) {
        if (responseMode === 'geminiJson') return 'Gemini 没有返回可显示的文本内容。';
        if (responseMode === 'anthropicJson') return 'Claude 没有返回可显示的文本内容。';
        return '模型没有返回可显示的文本内容。';
    }

    async _requestChatCompletion(request) {
        const aiChat = window.flowCanvas?.ai?.chat;
        if (typeof aiChat === 'function') {
            try {
                const result = await aiChat(request);
                if (!result?.success) {
                    throw new Error(result?.error || 'API 请求失败');
                }
                return {
                    responseMode: result.responseMode || request.responseMode,
                    payload: result.payload,
                    text: result.text || ''
                };
            } catch (err) {
                const message = err?.message || String(err);
                if (/No handler registered.*ai:chat/i.test(message)) {
                    throw new Error('FlowCanvas 主进程还没有加载聊天代理，请完全退出并重新启动应用后再试（只刷新窗口不够）。');
                }
                throw err;
            }
        }

        const response = await fetch(request.targetUrl, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body)
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        let payload = null;
        try {
            payload = JSON.parse(text);
        } catch (err) {
            // Keep plain text responses available for compatible providers.
        }

        return {
            responseMode: request.responseMode,
            payload,
            text
        };
    }

    _assistPlanning() {
        const provider = this._getActiveProvider();
        if (!provider || !provider.apiKey) {
            this.open();
            this._addErrorMessage('请先在设置中添加并选择有效的 API，再使用辅助规划');
            this.settingsPanel?.classList.add('show');
            return;
        }

        const context = this.options.getPlanningContext?.();
        const payload = JSON.stringify(context || {}, null, 2);
        const prompt = [
            '请基于下面的 Flow Canvas 当前文件夹组、已有规划表和选中的素材，补全或优化规划矩阵。',
            '要求：保持它是通用规划，不要限定为 PPT；输出可以直接复制进表格的行内容。',
            '如果已有规划表为空，请给出 3-6 行建议；如果已有内容不完整，请优先补缺。',
            '最后单独输出一个 JSON 数组，数组每项使用这些键：stage, title, role, content, assets, output, status, notes。',
            '',
            '上下文：',
            payload
        ].join('\n');

        this.open();
        if (this.inputEl) {
            this.inputEl.value = prompt;
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
            this.inputEl.focus();
            this._send();
        }
    }

    _attachPlanApplyAction(messageEl, content) {
        if (!this.options.applyPlanSuggestion || !messageEl) return;
        const rows = this._extractPlanRows(content);
        if (!rows || rows.length === 0) return;

        const actions = document.createElement('div');
        actions.className = 'agent-msg-actions';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-apply-plan-btn';
        button.textContent = '应用到规划表';
        button.addEventListener('click', () => {
            const ok = this.options.applyPlanSuggestion(rows);
            button.textContent = ok ? '已应用' : '应用失败';
            button.disabled = true;
        });
        actions.appendChild(button);
        messageEl.appendChild(actions);
    }

    _extractPlanRows(content) {
        const text = String(content || '');
        const candidates = [];
        const fenceMatches = text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi);
        for (const match of fenceMatches) candidates.push(match[1]);
        candidates.push(text);

        for (const candidate of candidates) {
            const start = candidate.indexOf('[');
            const end = candidate.lastIndexOf(']');
            if (start === -1 || end === -1 || end <= start) continue;
            try {
                const parsed = JSON.parse(candidate.slice(start, end + 1));
                if (Array.isArray(parsed) && parsed.length > 0) return parsed;
            } catch (err) {
                // Ignore non-JSON prose.
            }
        }
        return null;
    }

    _isImageGenerationRequest(text) {
        const value = String(text || '').trim();
        if (!value) return false;

        const isTroubleshootingQuestion = /(怎么|为什么|为何|哪里|用不了|不能用|失效|报错|错误|看看|检查|排查|修|坏了|debug)/i.test(value);
        const hasDirectAction = /(直接|现在|马上|立刻|按|用|帮我|给我|开始).{0,18}(生图|出图|生成|画|image\s*2|image2|gpt-image)/i.test(value);
        if (isTroubleshootingQuestion && !hasDirectAction) return false;

        return /(生图|出图|生成.{0,12}(图片|图像|图|海报|主视觉|插画|封面|头像)|画一?张|用\s*(image\s*2|image2|gpt-image)[^\n]*(生图|生成|出图)|generate.{0,20}image)/i.test(value);
    }

    _isVideoGenerationRequest(text) {
        const value = String(text || '').trim();
        if (!value) return false;
        const isTroubleshootingQuestion = /(\u600e\u4e48|\u4e3a\u4ec0\u4e48|\u4e3a\u4f55|\u62a5\u9519|\u9519\u8bef|\u68c0\u67e5|\u6392\u67e5|\u4e0d\u80fd\u7528|\u5931\u6548|debug)/i.test(value);
        const hasDirectAction = /(\u76f4\u63a5|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u523b|\u7528|\u5e2e\u6211|\u7ed9\u6211|\u5f00\u59cb).{0,18}(\u751f\u6210|\u505a|\u5236\u4f5c|\u89c6\u9891|\u77ed\u7247|seedance)/i.test(value);
        if (isTroubleshootingQuestion && !hasDirectAction) return false;
        return /(\u751f\u6210|\u505a|\u5236\u4f5c|\u51fa).{0,10}(\u89c6\u9891|\u77ed\u7247|\u5f71\u7247)|(\u89c6\u9891|\u77ed\u7247).{0,8}(\u751f\u6210|\u51fa\u56fe)|seedance\s*2(?:\.0)?|generate.{0,20}video/i.test(value);
    }

    _stripVideoCommandText(text) {
        return String(text || '')
            .replace(/^\s*(\u8bf7|\u9ebb\u70e6|\u5e2e\u6211|\u7ed9\u6211|\u4f60)?\s*(\u76f4\u63a5|\u73b0\u5728|\u9a6c\u4e0a|\u7acb\u523b)?\s*/i, '')
            .replace(/^(?:\u7528\s*)?(?:seedance\s*2(?:\.0)?\s*)?/i, '')
            .replace(/^(?:\u751f\u6210|\u505a|\u5236\u4f5c|\u51fa)\s*(?:\u4e00\u6bb5|\u4e00\u4e2a)?\s*(?:\u89c6\u9891|\u77ed\u7247|\u5f71\u7247)?\s*[:\uff1a\uff0c,.\s]*/i, '')
            .trim();
    }

    _resolveVideoGenerationPrompt(text) {
        const explicitMatch = String(text || '').match(/(?:\u751f\u6210|\u505a|\u5236\u4f5c|\u51fa)\s*(?:\u4e00\u6bb5|\u4e00\u4e2a)?\s*(?:\u89c6\u9891|\u77ed\u7247|\u5f71\u7247)\s*[:\uff1a]\s*([\s\S]+)/i);
        const explicitPrompt = explicitMatch?.[1]?.trim();
        if (explicitPrompt && explicitPrompt.length >= 8) return explicitPrompt;

        const stripped = this._stripVideoCommandText(text);
        if (stripped.length >= 12 || /[\uff0c\u3002,.、\n]/.test(stripped)) return stripped;

        const lastAssistant = [...this.messages].reverse().find(message => message.role === 'assistant')?.content || '';
        const fencedPrompt = this._extractPromptFromFencedBlocks(lastAssistant);
        return fencedPrompt || stripped || String(text || '').trim();
    }

    _extractPromptFromFencedBlocks(content) {
        const blocks = [...String(content || '').matchAll(/```(?:text|prompt|markdown|md)?\s*([\s\S]*?)```/gi)]
            .map(match => match[1].trim())
            .filter(Boolean);
        if (blocks.length === 0) return '';

        const positiveBlock = blocks.find(block => !/^(负向|负面|negative|avoid|不要|反向)\s*[:：]/i.test(block));
        return positiveBlock || blocks[0];
    }

    _stripImageCommandText(text) {
        return String(text || '')
            .replace(/^(请|麻烦|帮我|给我|你)?\s*(直接|现在|马上|立刻)?\s*(用\s*(image\s*2|image2|gpt-image(?:-\d+(?:\.\d+)?)?)\s*)?/i, '')
            .replace(/^(按|根据|照着)?\s*(上面|上一个|刚才|这个|这版|这条|该)\s*(提示词|prompt|内容)?\s*/i, '')
            .replace(/^(生图|出图|生成(?:一张)?(?:图片|图像|图)?|画一?张)\s*[:：，,。 ]*/i, '')
            .trim();
    }

    _resolveImageGenerationPrompt(text) {
        const explicitMatch = String(text || '').match(/(?:生图|出图|生成(?:一张)?(?:图片|图像|图)?|画一?张)\s*[:：]\s*([\s\S]+)/i);
        const explicitPrompt = explicitMatch?.[1]?.trim();
        if (explicitPrompt && explicitPrompt.length >= 12) return explicitPrompt;

        const stripped = this._stripImageCommandText(text);
        if (stripped.length >= 24 || /[，。,.、\n]/.test(stripped)) return stripped;

        const lastAssistant = [...this.messages].reverse().find(message => message.role === 'assistant')?.content || '';
        const fencedPrompt = this._extractPromptFromFencedBlocks(lastAssistant);
        if (fencedPrompt) return fencedPrompt;

        return stripped || String(text || '').trim();
    }

    async _generateImageFromChat(text, imageProvider = this._getImageProvider()) {
        if (!imageProvider?.apiKey || !imageProvider?.model || !imageProvider?.endpoint) {
            throw new Error('请先在设置中选择可用的生图 API');
        }
        if (!window.flowCanvas?.mcp?.generateImage) {
            throw new Error('本地生图接口不可用，请完全退出并重新启动应用后再试');
        }

        const prompt = this._resolveImageGenerationPrompt(text);
        if (!prompt) throw new Error('没有找到可用于生图的提示词');

        const result = await window.flowCanvas.mcp.generateImage({
            provider: 'openai',
            providerConfig: imageProvider,
            prompt,
            title: 'Agent chat image',
            size: this.imageSizeSelect?.value || undefined,
            quality: this.imageQualitySelect?.value || 'high',
            responseFormat: 'url',
            sourceReferences: this._selectedImagePaths().map(filePath => ({ filePath })),
            addToCanvas: true
        });

        if (!result?.success && result?.error) throw new Error(result.error);
        const lines = [
            `已用 ${this._providerLabel(imageProvider)} 生成图片，并添加到白板。`,
            result?.actualSize ? `实际尺寸：${result.actualSize}${result.sizeMatchesRequest === false ? `（请求 ${result.requestedSize}）` : ''}` : '',
            result?.filePath ? `文件：${result.filePath}` : '',
            result?.targetDirFallback ? `保存目录回退：${result.targetDirFallback}` : ''
        ].filter(Boolean);
        return lines.join('\n');
    }

    async _generateVideoFromChat(text, videoProvider = this._getVideoProvider()) {
        if (!videoProvider?.apiKey || !videoProvider?.model || !videoProvider?.endpoint) {
            throw new Error('\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u9009\u62e9\u53ef\u7528\u7684\u89c6\u9891 API');
        }
        if (!window.flowCanvas?.mcp?.generateVideo) {
            throw new Error('\u672c\u5730\u89c6\u9891\u63a5\u53e3\u4e0d\u53ef\u7528\uff0c\u8bf7\u91cd\u542f\u5e94\u7528\u540e\u518d\u8bd5');
        }

        const prompt = this._resolveVideoGenerationPrompt(text);
        if (!prompt) throw new Error('\u6ca1\u6709\u627e\u5230\u53ef\u7528\u4e8e\u89c6\u9891\u751f\u6210\u7684\u63d0\u793a\u8bcd');
        const selectedPaths = this.options.getSelectedFilePaths?.() || [];
        const profile = this._getVideoModelProfile(videoProvider) || DEFAULT_VIDEO_MODEL_PROFILE;
        const placeholder = this.options.beginVideoGeneration?.({ ratio: '16:9' }) || null;
        let result = null;
        try {
            result = await window.flowCanvas.mcp.generateVideo({
                provider: 'openai-video',
                providerConfig: videoProvider,
                prompt,
                sourceReferences: selectedPaths.map(filePath => ({ filePath })),
                resolution: profile.defaultResolution || undefined,
                ratio: '16:9',
                duration: profile.defaultDuration ?? undefined,
                x: placeholder?.x,
                y: placeholder?.y,
                addToCanvas: true
            });

            if (!result?.success && result?.error) throw new Error(result.error);
            return [
                '\u5df2\u7528 ' + this._providerLabel(videoProvider) + ' \u751f\u6210\u89c6\u9891\uff0c\u5e76\u6dfb\u52a0\u5230\u767d\u677f\u3002',
                result?.filePath ? '\u6587\u4ef6\uff1a' + result.filePath : '',
                result?.taskId ? '\u4efb\u52a1\uff1a' + result.taskId : '',
                result?.targetDirFallback ? '\u4fdd\u5b58\u76ee\u5f55\u56de\u9000\uff1a' + result.targetDirFallback : ''
            ].filter(Boolean).join('\n');
        } finally {
            if (placeholder?.id) this.options.endVideoGeneration?.(placeholder.id, result?.item?.id);
        }
    }

    async _tryProviderChain(providers, action) {
        const errors = [];
        for (let index = 0; index < providers.length; index += 1) {
            const provider = providers[index];
            try {
                const content = await action(provider, index);
                return {
                    provider,
                    switched: index > 0,
                    previousErrors: errors,
                    content
                };
            } catch (err) {
                const message = err?.message || String(err);
                errors.push(`${this._providerLabel(provider)}：${message}`);
                console.warn('[Agent] provider request failed:', provider?.name || provider?.id, err);
            }
        }

        throw new Error(errors.length ? errors.join('\n') : '没有可用 API');
    }

    // ── 发送消息 ──
    async _send() {
        if (!this.inputEl || !this.sendBtn) return;
        const text = this.inputEl.value.trim();
        if (!text || this.isStreaming) return;

        const wantsVideoGeneration = this._isVideoGenerationRequest(text);
        const wantsImageGeneration = !wantsVideoGeneration && this._isImageGenerationRequest(text);
        const generationKind = wantsVideoGeneration ? 'video' : wantsImageGeneration ? 'image' : 'chat';
        const providerChain = this._getProviderFallbackChain(generationKind);

        // 检查 API 配置
        if (providerChain.length === 0) {
            if (wantsVideoGeneration) {
                this._addErrorMessage('\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u6dfb\u52a0\u5e76\u9009\u62e9\u6709\u6548\u7684\u89c6\u9891 API');
                this.settingsPanel.classList.add('show');
                return;
            }
            this._addErrorMessage(wantsImageGeneration ? '请先在设置中添加并选择有效的生图 API' : '请先在设置中添加并选择有效的对话 API');
            this.settingsPanel.classList.add('show');
            return;
        }

        // 显示用户消息
        this._addMessage('user', text);
        this.messages.push({ role: 'user', content: text });

        // 清空输入框
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';

        // 开始请求
        this.isStreaming = true;
        this.sendBtn.disabled = true;

        const typingEl = this._addTypingIndicator();

        try {
            let fullContent = '';
            let msgEl = null;

            if (wantsVideoGeneration) {
                const result = await this._tryProviderChain(providerChain, provider => this._generateVideoFromChat(text, provider));
                fullContent = [
                    result.switched ? '\u7b2c\u4e00\u6761 API \u8bf7\u6c42\u5931\u8d25\uff0c\u5df2\u81ea\u52a8\u5207\u6362\u5230\u5907\u7528 API\uff1a' + this._providerLabel(result.provider) : '',
                    result.content
                ].filter(Boolean).join('\n');
                typingEl?.remove();
                msgEl = this._addMessage('assistant', fullContent);
            } else if (wantsImageGeneration) {
                const result = await this._tryProviderChain(providerChain, provider => this._generateImageFromChat(text, provider));
                fullContent = [
                    result.switched ? `第一条 API 请求失败，已自动切换到备用 API：${this._providerLabel(result.provider)}` : '',
                    result.content
                ].filter(Boolean).join('\n');
                typingEl?.remove();
                msgEl = this._addMessage('assistant', fullContent);
            } else {
                const result = await this._tryProviderChain(providerChain, async provider => {
                    const request = this._buildRequestPayload(provider);
                    const response = await this._requestChatCompletion(request);
                    const resultMode = response.responseMode || request.responseMode;
                    const content = this._extractChatResultText(resultMode, response.payload, response.text).trim()
                        || this._emptyChatResponseMessage(resultMode);
                    return { content, resultMode };
                });

                typingEl?.remove();
                msgEl = this._addMessage('assistant', '');
                fullContent = [
                    result.switched ? `第一条 API 请求失败，已自动切换到备用 API：${this._providerLabel(result.provider)}\n` : '',
                    result.content.content
                ].filter(Boolean).join('');
                if (msgEl) msgEl.textContent = fullContent;
            }

            this.messages.push({ role: 'assistant', content: fullContent });
            this._attachPlanApplyAction(msgEl, fullContent);
            this._scrollToBottom();

        } catch (err) {
            typingEl?.remove();
            this._addErrorMessage(`请求失败: ${err.message}`);
            console.error('[Agent] API 请求失败:', err);
        } finally {
            this.isStreaming = false;
            if (this.sendBtn) this.sendBtn.disabled = false;
            this.inputEl?.focus();
        }
    }

    // 清空对话
    clearMessages() {
        this.messages = [];
        if (this.messagesEl) {
            this.messagesEl.innerHTML = `
                <div class="agent-welcome">
                    <div class="agent-welcome-icon" aria-hidden="true">
                        <svg viewBox="0 0 48 48" width="30" height="30" fill="none" stroke="currentColor"
                            stroke-width="2">
                            <rect x="12" y="10" width="24" height="25" rx="6"></rect>
                            <path d="M18 35l-4 6"></path>
                            <path d="M30 35l4 6"></path>
                            <path d="M19 21h.01"></path>
                            <path d="M29 21h.01"></path>
                            <path d="M19 28h10"></path>
                            <path d="M24 10V5"></path>
                        </svg>
                    </div>
                    <div class="agent-welcome-text">你好！我是 AI 助手。<br>有什么可以帮你的？</div>
                </div>
            `;
        }
    }
}
