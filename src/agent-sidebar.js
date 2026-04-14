// ============================================================
// Flow Canvas — Agent Sidebar (AI 对话右侧边栏)
// ============================================================

const DEFAULT_TEMPLATES = {
    openai: { name: 'OpenAI', type: 'openai', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o' },
    gemini: { name: 'Google Gemini', type: 'google', endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent?key=', model: 'gemini-1.5-pro-latest' },
    claude: { name: 'Claude (兼容)', type: 'openai', endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-3-opus-20240229' },
    deepseek: { name: 'DeepSeek', type: 'openai', endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
    custom: { name: '自定义 API', type: 'openai', endpoint: '', model: '' }
};

export class AgentSidebar {
    constructor() {
        // 全局配置：系统提示词，选中的 provider ID 等
        this.globalConfig = {
            systemPrompt: '你是一个有用的 AI 助手，正在帮助用户管理和分析他们白板上的内容。',
            activeProviderId: null
        };
        // 存储所有的 provider { id, name, type, endpoint, apiKey, model }
        this.providers = [];

        this.messages = []; // { role: 'user'|'assistant', content: string }
        this.isStreaming = false;
        this.editingProviderId = null;

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
        this.systemPromptEl = document.getElementById('agentSystemPrompt');

        // Form inputs
        this.formName = document.getElementById('agentFormName');
        this.formType = document.getElementById('agentFormType');
        this.formEndpoint = document.getElementById('agentFormEndpoint');
        this.formKey = document.getElementById('agentFormKey');
        this.formModel = document.getElementById('agentFormModel');
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
        document.getElementById('creationModeCloseBtn')?.addEventListener('click', () => {
            document.body.classList.remove('creation-mode');
            this.close();
        });

        // 清空按钮
        document.getElementById('agentClearBtn')?.addEventListener('click', () => this.clearMessages());

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

        // 系统提示词实时保存
        this.systemPromptEl?.addEventListener('input', () => {
            this.globalConfig.systemPrompt = this.systemPromptEl.value;
            this._saveConfig();
        });

        // 顶部下拉框切换
        this.modelSelectEl?.addEventListener('change', (e) => {
            const id = e.target.value;
            if (id) {
                this.globalConfig.activeProviderId = id;
                this._saveConfig();
                this._renderProviderList(); // 同步高亮选中项
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

        // 确保有一个被选中
        if (this.providers.length > 0 && !this.globalConfig.activeProviderId) {
            this.globalConfig.activeProviderId = this.providers[0].id;
        }

        // 回填系统提示词
        if (this.systemPromptEl) {
            this.systemPromptEl.value = this.globalConfig.systemPrompt;
        }
    }

    _saveConfig() {
        try {
            localStorage.setItem('flow-canvas-agent-providers', JSON.stringify(this.providers));
            localStorage.setItem('flow-canvas-agent-global', JSON.stringify(this.globalConfig));
        } catch (e) {
            console.warn('[Agent] 配置保存失败', e);
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
            this.formType.value = provider.type;
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
    }

    _saveForm() {
        const name = this.formName.value.trim();
        const type = this.formType.value.trim();
        const endpoint = this.formEndpoint.value.trim();
        const apiKey = this.formKey.value.trim();
        const model = this.formModel.value.trim();

        if (!name || (!endpoint && type !== 'google') || !apiKey || !model) {
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
            if (!this.globalConfig.activeProviderId) {
                this.globalConfig.activeProviderId = newProvider.id;
            }
        }

        this._saveConfig();
        this._hideForm();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _deleteProvider(id) {
        if (!confirm('确定要删除此 API 配置吗？')) return;
        this.providers = this.providers.filter(p => p.id !== id);
        if (this.globalConfig.activeProviderId === id) {
            this.globalConfig.activeProviderId = this.providers.length > 0 ? this.providers[0].id : null;
        }
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _setActiveProvider(id) {
        this.globalConfig.activeProviderId = id;
        this._saveConfig();
        this._renderProviderList();
        this._renderModelSelect();
    }

    _renderProviderList() {
        if (!this.providerListEl) return;
        this.providerListEl.innerHTML = '';

        this.providers.forEach(p => {
            const card = document.createElement('div');
            card.className = `agent-provider-card ${p.id === this.globalConfig.activeProviderId ? 'active' : ''}`;

            const info = document.createElement('div');
            info.className = 'agent-provider-info';
            // 点击信息区域直接设为活跃
            info.style.cursor = 'pointer';
            info.innerHTML = `
                <div class="agent-provider-name">${p.name}</div>
                <div class="agent-provider-meta">${p.model}</div>
            `;
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
        if (!this.modelSelectEl) return;
        this.modelSelectEl.innerHTML = '';

        if (this.providers.length === 0) {
            const opt = document.createElement('option');
            opt.value = "";
            opt.textContent = "-- 请先添加 API --";
            this.modelSelectEl.appendChild(opt);
            return;
        }

        this.providers.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.name} (${p.model})`;
            if (p.id === this.globalConfig.activeProviderId) {
                opt.selected = true;
            }
            this.modelSelectEl.appendChild(opt);
        });
    }

    // ── 消息渲染 ──
    _addMessage(role, content) {
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
        const div = document.createElement('div');
        div.className = 'agent-msg assistant agent-typing';
        div.innerHTML = '<span class="agent-typing-dot"></span><span class="agent-typing-dot"></span><span class="agent-typing-dot"></span>';
        this.messagesEl.appendChild(div);
        this._scrollToBottom();
        return div;
    }

    _addErrorMessage(text) {
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
        return this.providers.find(p => p.id === this.globalConfig.activeProviderId);
    }

    // ── 发送消息 ──
    async _send() {
        const text = this.inputEl.value.trim();
        if (!text || this.isStreaming) return;

        const provider = this._getActiveProvider();

        // 检查 API 配置
        if (!provider || !provider.apiKey) {
            this._addErrorMessage('请先在设置中添加并选择有效的 API');
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
            // 支持 OpenAI 兼容流式请求
            const body = {
                model: provider.model,
                messages: [
                    { role: 'system', content: this.globalConfig.systemPrompt },
                    ...this.messages
                ],
                stream: true
            };

            let targetUrl = provider.endpoint;
            let headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`
            };

            // 处理 Google Gemini (如果是 REST API directly)
            if (provider.type === 'google') {
                // 如果是 openai 兼容的 gemini 用法（部分代理），则保持
                // 但如果用户填的是 google 原生 API
                if (targetUrl.includes('generateContent')) {
                    // 原生 Gemini stream 需要不同的 body 和 url 处理
                    // 为了支持这里仅做最基本的演示
                    targetUrl = `${provider.endpoint}${provider.apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                    body.contents = this.messages.map(m => ({
                        role: m.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: m.content }]
                    }));
                    delete body.messages;
                    delete body.model;
                }
            }

            const response = await fetch(targetUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
            }

            // 移除打字动画
            typingEl.remove();

            // 创建 assistant 消息气泡
            const msgEl = this._addMessage('assistant', '');
            let fullContent = '';

            // 流式读取
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); // 保留不完整的行

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;

                    try {
                        const json = JSON.parse(data);
                        const delta = json.choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;
                            msgEl.textContent = fullContent;
                            this._scrollToBottom();
                        }
                    } catch (e) {
                        // 忽略解析错误
                    }
                }
            }

            this.messages.push({ role: 'assistant', content: fullContent });

        } catch (err) {
            typingEl.remove();
            this._addErrorMessage(`请求失败: ${err.message}`);
            console.error('[Agent] API 请求失败:', err);
        } finally {
            this.isStreaming = false;
            this.sendBtn.disabled = false;
            this.inputEl.focus();
        }
    }

    // 清空对话
    clearMessages() {
        this.messages = [];
        if (this.messagesEl) {
            this.messagesEl.innerHTML = `
                <div class="agent-welcome">
                    <div class="agent-welcome-icon">✦</div>
                    <div class="agent-welcome-text">你好！我是 AI 助手。<br>有什么可以帮你的？</div>
                </div>
            `;
        }
    }
}
