// ============================================================
// Flow Canvas — Agent Sidebar (AI 对话右侧边栏)
// ============================================================

const DEFAULT_TEMPLATES = {
    openai: { name: 'OpenAI', type: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
    gemini: { name: 'Google Gemini', type: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=', model: 'gemini-1.5-pro-latest' },
    claude: { name: 'Claude', type: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-5-sonnet-latest' },
    deepseek: { name: 'DeepSeek', type: 'openai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
    custom: { name: '自定义 API', type: 'openai', endpoint: '', model: '' }
};

export class AgentSidebar {
    constructor(options = {}) {
        this.options = options;
        // 全局配置：系统提示词，选中的 provider ID 等
        this.globalConfig = {
            systemPrompt: '你是一个有用的 AI 助手，正在帮助用户管理和分析他们白板上的内容。',
            chatProviderId: null,
            imageProviderId: null,
            activeProviderId: null
        };
        // 存储所有的 provider { id, name, type, endpoint, apiKey, model }
        this.providers = [];

        this.messages = []; // { role: 'user'|'assistant', content: string }
        this.isStreaming = false;
        this.editingProviderId = null;
        this.availableSkills = [];

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
        this.systemPromptEl = document.getElementById('agentSystemPrompt');
        this.fetchSkillsBtn = document.getElementById('agentFetchSkillsBtn');
        this.skillSelect = document.getElementById('agentSkillSelect');
        this.skillDescription = document.getElementById('agentSkillDescription');
        this.useSkillBtn = document.getElementById('agentUseSkillBtn');
        this.removeSkillBtn = document.getElementById('agentRemoveSkillBtn');
        this.promptSkillStatusEl = document.getElementById('agentPromptSkillStatus');

        // Form inputs
        this.formName = document.getElementById('agentFormName');
        this.formType = document.getElementById('agentFormType');
        this.formEndpoint = document.getElementById('agentFormEndpoint');
        this.formKey = document.getElementById('agentFormKey');
        this.formModel = document.getElementById('agentFormModel');
        this.fetchModelsBtn = document.getElementById('agentFetchModelsBtn');
        this.fetchedModelSelect = document.getElementById('agentFetchedModelSelect');
        this.modelFetchStatus = document.getElementById('agentModelFetchStatus');
        this.formSaveBtn = document.getElementById('agentFormSaveBtn');

        // 加载保存的设置
        this._loadConfig();

        // 绑定事件
        this._bindEvents();

        // 渲染 UI
        this._renderProviderList();
        this._renderModelSelect();
    }

    _bindEvents() {
        const exitCreationMode = () => {
            document.body.classList.remove('creation-mode');
            this.close();
        };

        // 开关边栏 — 创造模式风格
        const toggleBtn = document.getElementById('agentToggleBtn');
        toggleBtn?.addEventListener('click', () => {
            // 先播放流光溢彩激活动画
            toggleBtn.classList.add('activating');
            document.body.classList.add('creation-mode');
            // 延迟打开侧边栏，让动画先播完
            setTimeout(() => {
                this.open();
            }, 400);
            // 动画结束后移除 activating class
            setTimeout(() => {
                toggleBtn.classList.remove('activating');
            }, 700);
        });

        // 收起边栏按钮（只关侧边栏，不退出创造模式）
        document.getElementById('agentCollapseBtn')?.addEventListener('click', () => this.close());

        // 创造模式关闭按钮（退出创造模式 + 关闭侧边栏）
        document.getElementById('creationModeCloseBtn')?.addEventListener('click', exitCreationMode);

        // 清空按钮
        document.getElementById('agentClearBtn')?.addEventListener('click', () => this.clearMessages());

        document.getElementById('agentPlanBtn')?.addEventListener('click', () => this._assistPlanning());

        // 设置面板
        document.getElementById('agentSettingsBtn')?.addEventListener('click', () => {
            this.settingsPanel.classList.toggle('show');
            if (!this.settingsPanel.classList.contains('show')) {
                this._hideForm();
            }
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
        this.apiFormCloseBtn?.addEventListener('click', () => this._hideForm());
        this.formSaveBtn?.addEventListener('click', () => this._saveForm());
        this.fetchModelsBtn?.addEventListener('click', () => this._fetchModelsForForm());
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

    open() {
        document.body.classList.add('agent-open');
        setTimeout(() => this.inputEl?.focus(), 350);
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

    _findProvider(id) {
        return this.providers.find(provider => provider.id === id) || null;
    }

    _getDefaultChatProviderId() {
        return (this.providers.find(provider => !this._isImageProvider(provider)) || this.providers[0])?.id || null;
    }

    _getDefaultImageProviderId() {
        return this.providers.find(provider => this._isImageProvider(provider))?.id || null;
    }

    _ensureProviderRoles() {
        if (this.providers.length === 0) {
            this.globalConfig.chatProviderId = null;
            this.globalConfig.imageProviderId = null;
            this.globalConfig.activeProviderId = null;
            return;
        }

        const legacyId = this.globalConfig.activeProviderId;
        const legacyProvider = this._findProvider(legacyId);
        const currentChatProvider = this._findProvider(this.globalConfig.chatProviderId);
        const currentImageProvider = this._findProvider(this.globalConfig.imageProviderId);
        const hasTextProvider = this.providers.some(provider => !this._isImageProvider(provider));
        const hasImageProvider = this.providers.some(provider => this._isImageProvider(provider));

        if (!currentChatProvider || (hasTextProvider && this._isImageProvider(currentChatProvider))) {
            this.globalConfig.chatProviderId = legacyProvider && !this._isImageProvider(legacyProvider)
                ? legacyProvider.id
                : this._getDefaultChatProviderId();
        }
        if (!currentImageProvider || (hasImageProvider && !this._isImageProvider(currentImageProvider))) {
            this.globalConfig.imageProviderId = legacyProvider && this._isImageProvider(legacyProvider)
                ? legacyProvider.id
                : this._getDefaultImageProviderId();
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

    _getChatProvider() {
        return this._findProvider(this.globalConfig.chatProviderId || this.globalConfig.activeProviderId);
    }

    _getImageProvider() {
        return this._findProvider(this.globalConfig.imageProviderId);
    }

    _getProviderFallbackChain(kind) {
        const selectedId = kind === 'image'
            ? this.globalConfig.imageProviderId
            : (this.globalConfig.chatProviderId || this.globalConfig.activeProviderId);
        const isMatchingKind = provider => kind === 'image'
            ? this._isImageProvider(provider)
            : !this._isImageProvider(provider);

        const selected = this._findProvider(selectedId);
        const candidates = [
            selected && isMatchingKind(selected) ? selected : null,
            ...this.providers.filter(provider => provider?.id !== selectedId && isMatchingKind(provider))
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
            this.formModel.value = provider.model;
        } else {
            this.editingProviderId = null;
            this.apiFormTitle.textContent = '添加 API';
            this._applyTemplate('openai'); // 默认模板
            this.formKey.value = '';
            document.querySelector('.agent-template-chip[data-template="openai"]')?.classList.add('active');
        }
    }

    _hideForm() {
        if (!this.apiForm) return;
        this.apiForm.style.display = 'none';
        this.addApiBtn.style.display = 'flex';
        this.editingProviderId = null;
    }

    _applyTemplate(id) {
        const tpl = DEFAULT_TEMPLATES[id] || DEFAULT_TEMPLATES.custom;
        if (this.formName) this.formName.value = tpl.name;
        if (this.formType) this.formType.value = tpl.type;
        if (this.formEndpoint) this.formEndpoint.value = tpl.endpoint;
        if (this.formModel) this.formModel.value = tpl.model;
        this._resetFetchedModels();
    }

    _setModelFetchStatus(type, message) {
        if (!this.modelFetchStatus) return;
        this.modelFetchStatus.className = 'agent-model-fetch-status';
        if (type) this.modelFetchStatus.classList.add(type);
        this.modelFetchStatus.textContent = message || '';
    }

    _resetFetchedModels(clearStatus = true) {
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
        models.forEach(model => {
            const opt = document.createElement('option');
            opt.value = model;
            opt.textContent = model;
            this.fetchedModelSelect.appendChild(opt);
        });
        this.fetchedModelSelect.hidden = models.length === 0;

        const currentModel = this.formModel?.value?.trim();
        if (currentModel && models.includes(currentModel)) {
            this.fetchedModelSelect.value = currentModel;
        }
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
        const model = this.formModel.value.trim();

        if (!name || !endpoint || !apiKey || !model) {
            alert('请填写完整的 API 配置！');
            return;
        }

        if (this.editingProviderId) {
            const idx = this.providers.findIndex(p => p.id === this.editingProviderId);
            if (idx !== -1) {
                this.providers[idx] = { id: this.editingProviderId, name, type, endpoint, apiKey, model };
            }
        } else {
            const newProvider = {
                id: 'api_' + Date.now() + Math.random().toString(36).substr(2, 5),
                name, type, endpoint, apiKey, model
            };
            this.providers.push(newProvider);
            if (this._isImageProvider(newProvider)) {
                this.globalConfig.imageProviderId = newProvider.id;
            } else if (!this._findProvider(this.globalConfig.chatProviderId)) {
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
        this._setChatProvider(id);
    }

    _renderProviderList() {
        if (!this.providerListEl) return;
        this.providerListEl.innerHTML = '';

        this.providers.forEach(p => {
            const card = document.createElement('div');
            const isChat = p.id === this.globalConfig.chatProviderId;
            const isImage = p.id === this.globalConfig.imageProviderId;
            card.className = `agent-provider-card ${isChat || isImage ? 'active' : ''}`;

            const info = document.createElement('div');
            info.className = 'agent-provider-info';
            info.style.cursor = 'pointer';
            const nameEl = document.createElement('div');
            nameEl.className = 'agent-provider-name';
            nameEl.textContent = p.name || '未命名 API';
            const metaEl = document.createElement('div');
            metaEl.className = 'agent-provider-meta';
            metaEl.textContent = p.model || '未设置模型';
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
            delBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            `;
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
            { el: this.imageModelSelectEl, role: 'image', selectedId: this.globalConfig.imageProviderId }
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
            return;
        }

        selects.forEach(({ el, role, selectedId }) => {
            const opt = document.createElement('option');
            opt.value = "";
            opt.textContent = role === 'image' ? "-- 选择生图 API --" : "-- 选择对话 API --";
            el.appendChild(opt);

            this.providers.forEach(p => {
                const option = document.createElement('option');
                option.value = p.id;
                option.textContent = `${p.name} (${p.model})`;
                if (p.id === selectedId) {
                    option.selected = true;
                }
                el.appendChild(option);
            });
        });
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
            width: 1024,
            height: 1024,
            addToCanvas: true
        });

        if (!result?.success && result?.error) throw new Error(result.error);
        const lines = [
            `已用 ${this._providerLabel(imageProvider)} 生成图片，并添加到白板。`,
            result?.filePath ? `文件：${result.filePath}` : '',
            result?.targetDirFallback ? `保存目录回退：${result.targetDirFallback}` : ''
        ].filter(Boolean);
        return lines.join('\n');
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

        const wantsImageGeneration = this._isImageGenerationRequest(text);
        const providerChain = this._getProviderFallbackChain(wantsImageGeneration ? 'image' : 'chat');

        // 检查 API 配置
        if (providerChain.length === 0) {
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

            if (wantsImageGeneration) {
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
