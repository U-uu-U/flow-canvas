// ============================================================
// Flow Canvas — Node Type Definitions (节点类型注册表)
// ============================================================

/**
 * 每个节点类型定义：
 * - type:    唯一标识
 * - title:   显示名称
 * - color:   标题栏颜色
 * - icon:    emoji 图标
 * - width:   节点默认宽度
 * - inputs:  输入端口数组 [{ name, dataType }]
 * - outputs: 输出端口数组 [{ name, dataType }]
 * - config:  用户可编辑的参数 [{ key, label, type, default, options? }]
 * - execute: async (inputs, config, ctx) => outputs
 */

const NODE_TYPES = {};

// ── 文本输入节点 ──────────────────────────────────────────
NODE_TYPES['text_input'] = {
    type: 'text_input',
    title: '文本 / Prompt',
    icon: '✏️',
    color: '#6366f1',
    width: 240,
    inputs: [],
    outputs: [{ name: 'text', dataType: 'string' }],
    config: [
        { key: 'text', label: '文本内容', type: 'textarea', default: '' }
    ],
    async execute(inputs, config) {
        return { text: config.text || '' };
    }
};

// ── 数值输入节点 ──────────────────────────────────────────
NODE_TYPES['number_input'] = {
    type: 'number_input',
    title: '数值',
    icon: '🔢',
    color: '#0ea5e9',
    width: 200,
    inputs: [],
    outputs: [{ name: 'value', dataType: 'number' }],
    config: [
        { key: 'value', label: '数值', type: 'number', default: 512 }
    ],
    async execute(inputs, config) {
        return { value: Number(config.value) || 0 };
    }
};

// ── 图像生成节点（Nano Banana / OpenAI 兼容） ─────────────
NODE_TYPES['image_gen'] = {
    type: 'image_gen',
    title: '图像生成',
    icon: '🎨',
    color: '#f59e0b',
    width: 280,
    inputs: [
        { name: 'prompt', dataType: 'string' },
    ],
    outputs: [
        { name: 'image', dataType: 'image' }
    ],
    config: [
        { key: 'negativePrompt', label: '反向提示词', type: 'textarea', default: '' },
        { key: 'width', label: '宽度', type: 'number', default: 1024 },
        { key: 'height', label: '高度', type: 'number', default: 1024 },
    ],
    async execute(inputs, config, ctx) {
        const prompt = inputs.prompt || '';
        if (!prompt) throw new Error('请连接 Prompt 输入');

        // 从 agent-sidebar 的 provider 配置中获取 API 信息
        const provider = ctx.getActiveProvider();
        if (!provider || !provider.apiKey) {
            throw new Error('请先在 AI 助手设置中配置 API');
        }

        const requestBody = {
            model: provider.model,
            messages: [
                {
                    role: 'user',
                    content: prompt + (config.negativePrompt ? `\n\nNegative: ${config.negativePrompt}` : '')
                }
            ],
            // 图像生成参数（OpenAI 兼容格式，部分平台支持）
            max_tokens: 4096,
        };

        const response = await fetch(provider.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${provider.apiKey}`
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API 错误 ${response.status}: ${errText.slice(0, 200)}`);
        }

        const data = await response.json();

        // 尝试从返回中提取图片（支持多种格式）
        let imageUrl = null;

        // 格式1：OpenAI images/generations 格式
        if (data.data && data.data[0]?.url) {
            imageUrl = data.data[0].url;
        }
        // 格式2：OpenAI chat completions 返回 base64 图片
        else if (data.choices?.[0]?.message?.content) {
            const content = data.choices[0].message.content;
            // 检查是否是 base64 图片数据
            if (content.startsWith('data:image')) {
                imageUrl = content;
            } else {
                // 尝试从 markdown 图片语法中提取
                const imgMatch = content.match(/!\[.*?\]\((.*?)\)/);
                if (imgMatch) imageUrl = imgMatch[1];
                // 尝试从纯 URL 中提取
                else if (/^https?:\/\//.test(content.trim())) imageUrl = content.trim();
            }
        }
        // 格式3：直接 base64
        else if (data.data?.[0]?.b64_json) {
            imageUrl = `data:image/png;base64,${data.data[0].b64_json}`;
        }

        if (!imageUrl) {
            // 如果没有提取到图片，返回文本结果
            const textResult = data.choices?.[0]?.message?.content || JSON.stringify(data).slice(0, 200);
            throw new Error(`未能从 API 响应中提取图片。返回内容: ${textResult.slice(0, 100)}`);
        }

        return { image: imageUrl };
    }
};

// ── 图片预览节点 ──────────────────────────────────────────
NODE_TYPES['image_preview'] = {
    type: 'image_preview',
    title: '图片预览',
    icon: '🖼️',
    color: '#10b981',
    width: 300,
    inputs: [
        { name: 'image', dataType: 'image' }
    ],
    outputs: [],
    config: [],
    async execute(inputs) {
        // 预览节点不产生输出，只用于显示
        return { _preview: inputs.image || null };
    }
};

// ── 文本合并节点 ──────────────────────────────────────────
NODE_TYPES['text_merge'] = {
    type: 'text_merge',
    title: '文本合并',
    icon: '🔗',
    color: '#8b5cf6',
    width: 220,
    inputs: [
        { name: 'text_a', dataType: 'string' },
        { name: 'text_b', dataType: 'string' }
    ],
    outputs: [
        { name: 'merged', dataType: 'string' }
    ],
    config: [
        { key: 'separator', label: '分隔符', type: 'text', default: ', ' }
    ],
    async execute(inputs, config) {
        const sep = config.separator ?? ', ';
        const parts = [inputs.text_a, inputs.text_b].filter(Boolean);
        return { merged: parts.join(sep) };
    }
};

export { NODE_TYPES };
