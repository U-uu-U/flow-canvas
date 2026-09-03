// ============================================================
// Flow Canvas - Agent Sidebar (server-routed AI chat)
// ============================================================

export class AgentSidebar {
    constructor() {
        this.globalConfig = {
            systemPrompt: '你是一个有用的 AI 助手，正在帮助用户管理和分析他们白板上的内容。'
        };
        this.messages = [];
        this.isStreaming = false;

        this.messagesEl = document.getElementById('agentMessages');
        this.inputEl = document.getElementById('agentInput');
        this.sendBtn = document.getElementById('agentSendBtn');
        this.settingsPanel = document.getElementById('agentSettings');
        this.modelLabelEl = document.getElementById('agentModelSelect');
        this.baseUrlEl = document.getElementById('agentBaseUrl');
        this.serviceStatusEl = document.getElementById('agentServiceStatus');
        this.apiKeyEl = document.getElementById('agentRavenhashKey');
        this.apiKeyStatusEl = document.getElementById('agentKeyStatus');
        this.apiKeySaveBtn = document.getElementById('agentKeySaveBtn');
        this.apiKeyClearBtn = document.getElementById('agentKeyClearBtn');
        this.systemPromptEl = document.getElementById('agentSystemPrompt');
        this.gateway = window.flowCanvasGateway;

        this._loadConfig();
        this._bindEvents();
        this._renderServiceInfo();
        this._renderKeyStatus();
    }

    _bindEvents() {
        const toggleBtn = document.getElementById('agentToggleBtn');
        toggleBtn?.addEventListener('click', () => {
            toggleBtn.classList.add('activating');
            document.body.classList.add('creation-mode');
            setTimeout(() => this.open(), 400);
            setTimeout(() => toggleBtn.classList.remove('activating'), 700);
        });
        document.getElementById('agentCollapseBtn')?.addEventListener('click', () => this.close());
        document.getElementById('creationModeCloseBtn')?.addEventListener('click', () => {
            document.body.classList.remove('creation-mode');
            this.close();
        });
        document.getElementById('agentClearBtn')?.addEventListener('click', () => this.clearMessages());
        document.getElementById('agentSettingsBtn')?.addEventListener('click', () => {
            this.settingsPanel?.classList.toggle('show');
        });
        this.systemPromptEl?.addEventListener('input', () => {
            this.globalConfig.systemPrompt = this.systemPromptEl.value;
            this._saveConfig();
        });
        this.baseUrlEl?.addEventListener('input', () => {
            this.gateway?.setModelBaseUrl(this.baseUrlEl.value);
        });
        this.apiKeySaveBtn?.addEventListener('click', () => this._saveRavenhashKey());
        this.apiKeyClearBtn?.addEventListener('click', () => this._clearRavenhashKey());
        this.sendBtn?.addEventListener('click', () => this._send());
        this.inputEl?.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                this._send();
            }
        });
        this.inputEl?.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
        });
        this.gateway?.onChange(() => this._renderServiceInfo());
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

    _loadConfig() {
        try {
            // 旧版本可能把 API Key 放在 localStorage；只清理该配置，不上传迁移。
            localStorage.removeItem('flow-canvas-agent-providers');
            const savedGlobal = localStorage.getItem('flow-canvas-agent-global');
            if (savedGlobal) {
                const parsed = JSON.parse(savedGlobal);
                if (typeof parsed.systemPrompt === 'string') this.globalConfig.systemPrompt = parsed.systemPrompt;
            }
        } catch (error) {
            console.warn('[Agent] 配置加载失败', error);
        }
        if (this.systemPromptEl) this.systemPromptEl.value = this.globalConfig.systemPrompt;
        if (this.baseUrlEl) this.baseUrlEl.value = this.gateway?.modelBaseUrl || '';
    }

    _saveConfig() {
        try {
            localStorage.setItem('flow-canvas-agent-global', JSON.stringify({ systemPrompt: this.globalConfig.systemPrompt }));
        } catch (error) {
            console.warn('[Agent] 配置保存失败', error);
        }
    }

    _renderServiceInfo() {
        const route = this.gateway?.getRoute() || { type: 'free', baseUrl: '' };
        const premium = route.type === 'ravenhash';
        if (this.serviceStatusEl) {
            this.serviceStatusEl.dataset.route = route.type;
            this.serviceStatusEl.textContent = premium
                ? `RavenHash 服务 · ${route.baseUrl.includes('art.') ? '图片/视频' : 'AI'}`
                : '免费服务';
        }
        if (this.modelLabelEl) this.modelLabelEl.textContent = premium ? 'RavenHash' : '免费 AI';
    }

    async _renderKeyStatus(message = '') {
        if (!this.apiKeyStatusEl) return;
        const hasKey = await this.gateway?.hasRavenhashApiKey();
        this.apiKeyStatusEl.dataset.state = hasKey ? 'saved' : 'empty';
        this.apiKeyStatusEl.textContent = message || (hasKey ? 'API Key 已安全保存' : '尚未配置 API Key');
    }

    async _saveRavenhashKey() {
        const key = this.apiKeyEl?.value.trim();
        if (!key) return this._renderKeyStatus('请输入 API Key');
        this.apiKeySaveBtn.disabled = true;
        try {
            await this.gateway.setRavenhashApiKey(key);
            this.apiKeyEl.value = '';
            await this._renderKeyStatus();
        } catch (error) {
            await this._renderKeyStatus(error.message);
        } finally {
            this.apiKeySaveBtn.disabled = false;
        }
    }

    async _clearRavenhashKey() {
        this.apiKeyClearBtn.disabled = true;
        try {
            await this.gateway?.clearRavenhashApiKey();
            if (this.apiKeyEl) this.apiKeyEl.value = '';
            await this._renderKeyStatus();
        } finally {
            this.apiKeyClearBtn.disabled = false;
        }
    }

    _addMessage(role, content) {
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
            if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        });
    }

    async _send() {
        const text = this.inputEl.value.trim();
        if (!text || this.isStreaming) return;
        const gateway = this.gateway;
        if (!gateway) return this._addErrorMessage('AI 网关未初始化');

        this._addMessage('user', text);
        this.messages.push({ role: 'user', content: text });
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';
        this.isStreaming = true;
        this.sendBtn.disabled = true;
        const typingEl = this._addTypingIndicator();

        try {
            const response = await gateway.chat({
                model: 'server-selected',
                messages: [{ role: 'system', content: this.globalConfig.systemPrompt }, ...this.messages],
                stream: true
            });
            typingEl.remove();
            const msgEl = this._addMessage('assistant', '');
            let fullContent = '';
            const reader = response.body?.getReader();
            if (!reader) throw new Error('服务器没有返回流式响应');
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') continue;
                    try {
                        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                        if (delta) {
                            fullContent += delta;
                            msgEl.textContent = fullContent;
                            this._scrollToBottom();
                        }
                    } catch (_) { /* 忽略不完整或非 JSON 数据行 */ }
                }
            }
            this.messages.push({ role: 'assistant', content: fullContent });
        } catch (error) {
            typingEl.remove();
            this._addErrorMessage(`请求失败: ${error.message}`);
        } finally {
            this.isStreaming = false;
            this.sendBtn.disabled = false;
            this.inputEl.focus();
        }
    }

    clearMessages() {
        this.messages = [];
        if (this.messagesEl) {
            this.messagesEl.innerHTML = '<div class="agent-welcome"><div class="agent-welcome-icon">✦</div><div class="agent-welcome-text">你好！我是 AI 助手。<br>有什么可以帮你的？</div></div>';
        }
    }
}
