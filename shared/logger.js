const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createLogger(module, options = {}) {
    const configuredLevel = String(options.level || process.env.LOG_LEVEL || 'info').toLowerCase();
    const threshold = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;
    const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';

    function log(level, message, meta = {}) {
        if (LOG_LEVELS[level] < threshold) return;

        const hasMeta = meta && typeof meta === 'object' && Object.keys(meta).length > 0;
        if (isProduction) {
            const entry = {
                timestamp: new Date().toISOString(),
                level,
                module,
                message,
                ...(hasMeta ? { meta } : {})
            };
            console.log(JSON.stringify(entry));
            return;
        }

        const colors = { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
        const reset = '\x1b[0m';
        const metaStr = hasMeta ? ` ${JSON.stringify(meta)}` : '';
        console.log(`${colors[level]}[${module}] ${message}${reset}${metaStr}`);
    }

    return {
        debug: (msg, meta) => log('debug', msg, meta),
        info: (msg, meta) => log('info', msg, meta),
        warn: (msg, meta) => log('warn', msg, meta),
        error: (msg, meta) => log('error', msg, meta)
    };
}

module.exports = createLogger;
