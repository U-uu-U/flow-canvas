module.exports = {
    // API Key 限制
    API_KEY_MAX_LENGTH: 4096,

    // 媒体文件配置
    MEDIA_MAX_SIZE_BYTES: 512 * 1024 * 1024, // 512MB
    MEDIA_EXPIRATION_HOURS: 24,

    // 普通 JSON 请求体限制
    DEFAULT_JSON_BODY_LIMIT_BYTES: 2 * 1024 * 1024,

    // 速率限制
    DEFAULT_RATE_LIMIT_PER_HOUR: 20,

    // Key 验证配置
    KEY_VALIDATION_TIMEOUT_MS: 10000,
    KEY_VALIDATION_CACHE_TTL_MS: 5 * 60 * 1000 // 5 分钟
};
