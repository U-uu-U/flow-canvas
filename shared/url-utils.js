/**
 * 规范化模型 Base URL
 * 1. 去除首尾空白和末尾斜杠
 * 2. scheme 和 hostname 转小写（路径保持原样）
 */
function normalizeBaseUrl(value) {
    const trimmed = String(value || '').trim().replace(/\/+$/, '');
    const match = /^(https):\/\/([^/?#:]+)(\/.*)?$/i.exec(trimmed);
    if (!match) return trimmed;
    return `https://${match[2].toLowerCase()}${match[3] || ''}`;
}

module.exports = { normalizeBaseUrl };
