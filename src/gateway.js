import { normalizeBaseUrl } from './utils/url-utils.js';

const DEFAULT_GATEWAY_URL = 'http://localhost:8787';
const MODEL_BASE_URL_STORAGE_KEY = 'flow-canvas-model-base-url';

export const RAVENHASH_AI_BASE_URL = 'https://ai.ravenhash.org/v1';
export const RAVENHASH_ART_BASE_URL = 'https://art.ravenhash.org/v1';

function gatewayUrl() {
    return String(import.meta.env.VITE_FLOWCANVAS_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, '');
}

export function getRavenhashBaseUrl(value) {
    const normalized = normalizeBaseUrl(value);
    return normalized === RAVENHASH_AI_BASE_URL || normalized === RAVENHASH_ART_BASE_URL
        ? normalized
        : null;
}

export class GatewayClient {
    constructor() {
        this.gatewayBaseUrl = gatewayUrl();
        this.modelBaseUrl = localStorage.getItem(MODEL_BASE_URL_STORAGE_KEY) || '';
        this.listeners = new Set();
    }

    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    setModelBaseUrl(value) {
        this.modelBaseUrl = String(value || '').trim();
        if (this.modelBaseUrl) {
            localStorage.setItem(MODEL_BASE_URL_STORAGE_KEY, this.modelBaseUrl);
        } else {
            localStorage.removeItem(MODEL_BASE_URL_STORAGE_KEY);
        }
        this.listeners.forEach(listener => listener(this.getRoute()));
    }

    getRoute() {
        const ravenhashBaseUrl = getRavenhashBaseUrl(this.modelBaseUrl);
        return {
            type: ravenhashBaseUrl ? 'ravenhash' : 'free',
            baseUrl: ravenhashBaseUrl || '',
            requestedBaseUrl: this.modelBaseUrl
        };
    }

    async hasRavenhashApiKey() {
        return Boolean(await window.flowCanvas?.credentials?.hasRavenhashKey());
    }

    async setRavenhashApiKey(value) {
        const key = String(value || '').trim();
        if (!key) throw new Error('API Key 不能为空');
        const saved = await window.flowCanvas?.credentials?.setRavenhashKey(key);
        if (!saved) throw new Error('系统加密存储不可用');
        return true;
    }

    async clearRavenhashApiKey() {
        return Boolean(await window.flowCanvas?.credentials?.clearRavenhashKey());
    }

    async request(path, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set('X-FlowCanvas-Model-Base-URL', this.modelBaseUrl);
        headers.delete('Authorization');
        if (!headers.has('Content-Type') && options.body && !(options.body instanceof FormData)) {
            headers.set('Content-Type', 'application/json');
        }
        try {
            return await fetch(`${this.gatewayBaseUrl}${path}`, { ...options, headers });
        } catch (_) {
            throw new Error('无法连接 FlowCanvas 网关，请检查网络连接');
        }
    }

    async responseError(response, fallback) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `${fallback} (${response.status})`);
    }

    async chat(body) {
        const response = await this.request('/v1/chat/completions', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        if (!response.ok) await this.responseError(response, '请求失败');
        return response;
    }

    async imageGeneration(body) {
        const response = await this.request('/v1/images/generations', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        if (!response.ok) await this.responseError(response, '图片请求失败');
        return response.json();
    }

    async mediaUpload(path, formData) {
        const allowedPaths = new Set(['images/edits', 'videos', 'files', 'uploads']);
        if (!allowedPaths.has(path)) throw new Error('不支持的媒体上传路径');
        const response = await this.request(`/v1/${path}`, {
            method: 'POST',
            body: formData
        });
        if (!response.ok) await this.responseError(response, '媒体请求失败');
        return response.json();
    }

    async uploadMaterial(file, filename = 'material') {
        const formData = new FormData();
        formData.append('file', file, file.name || filename);
        const response = await this.request('/api/media/upload', {
            method: 'POST',
            body: formData
        });
        if (!response.ok) await this.responseError(response, '素材上传失败');
        return response.json();
    }
}
