// Flow Canvas ESLint 配置（flat config）
//
// 设计原则：这个仓库有 7.6 万行代码，其中 canvas.js / agent-sidebar.js 是两个巨石
// 文件。一次性引入严格规则只会得到一片红，然后所有人学会忽略它。所以这里的规则
// 是**分诊过**的：能真正抓到缺陷的留下，与本仓库既有约定冲突的按"有意为之"处理
// 并用注释说明理由，纯风格偏好不引入（避免与同事正在进行的改动大面积冲突）。
//
// 允许存在 warning：CI 用 --max-warnings 控制阈值，新增问题会让流水线失败，
// 既有问题不会被一次性要求修完。
import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: [
            'dist/**',
            'release/**',
            'release-*/**',
            'node_modules/**',
            'output/**',
            '.analysis/**',
            '.playwright-cli/**',
            // 上游同步产物（scripts/sync-awesome-prompt-pack.mjs 生成）
            'src/prompt-packs/**'
        ]
    },

    js.configs.recommended,

    // ── 渲染进程（浏览器环境，ESM） ──────────────────────────
    {
        files: ['src/**/*.js'],
        ignores: ['src/**/*.test.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser }
        }
    },

    // ── 主进程 / 共享层 / MCP / 脚本（Node 环境） ─────────────
    {
        files: [
            'electron-main/**/*.{js,cjs,mjs}',
            'shared/**/*.{js,cjs,mjs}',
            'mcp/**/*.{js,cjs,mjs}',
            'scripts/**/*.{js,cjs,mjs}',
            '*.js'
        ],
        ignores: ['**/*.test.{js,cjs,mjs}'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.browser }
        }
    },

    // 主进程里的 .mjs 是 ESM
    {
        files: ['electron-main/**/*.mjs', 'shared/**/*.mjs', 'mcp/**/*.mjs', 'scripts/**/*.mjs'],
        languageOptions: { sourceType: 'module' }
    },

    // ── configserver（独立部署的 CONFIG 服务：Node + ESM） ────
    // 它有自己的 package.json（"type": "module"），但 flat config 不会去推断，
    // 所以这里显式声明 Node 环境与 ESM，否则 process/console/Buffer/URL 会被误报 no-undef。
    {
        files: ['configserver/**/*.mjs'],
        ignores: ['configserver/**/*.test.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node }
        }
    },

    // ── 测试文件（Node + 部分文件会伪装浏览器全局） ───────────
    {
        files: ['**/*.test.js', '**/*.test.cjs', '**/*.test.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        }
    },

    // ── 浏览器扩展（MV3） ───────────────────────────────────
    // 扩展本体跑在浏览器/Service Worker 里；
    // native-host/ 则是被 Chrome 以 stdio 启动的普通 Node CommonJS 进程，
    // 两者环境不同，必须分开声明，否则 require/Buffer/process 会被误报。
    {
        files: ['browser-extension/**/*.js'],
        ignores: ['browser-extension/**/native-host/**'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.webextensions }
        }
    },
    {
        files: ['browser-extension/**/native-host/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: { ...globals.node }
        }
    },

    // ── 构建配置（ESM） ─────────────────────────────────────
    {
        files: ['vite.config.js', '*.config.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { ...globals.node }
        }
    },

    // ── 规则（全仓库） ──────────────────────────────────────
    {
        files: ['**/*.{js,cjs,mjs}'],
        rules: {
            // ── 真正抓缺陷的规则 ──
            'no-undef': 'error',
            'no-const-assign': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-args': 'error',
            'no-dupe-class-members': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
            'no-func-assign': 'error',
            'no-obj-calls': 'error',
            'no-sparse-arrays': 'error',
            'no-unsafe-negation': 'error',
            'valid-typeof': 'error',
            'use-isnan': 'error',
            'no-self-assign': 'error',
            'no-self-compare': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-fallthrough': 'error',
            'no-redeclare': 'error',
            'no-debugger': 'error',
            'no-cond-assign': ['error', 'except-parens'],
            'require-atomic-updates': 'off', // 与既有 async 写法冲突过多，收益不明

            // ── 风格 / 一致性（只收那些能减少真实误用的） ──
            // 强制 === 与 !==：这里的取值大量来自 IPC / JSON，隐式转换是真实风险源
            eqeqeq: ['warn', 'smart'],
            'no-var': 'warn',
            // destructuring:'all' 只在整个解构模式都能用 const 时才提示；
            // ignoreReadBeforeAssign 放行 `let gate; ...; gate = h.gate()` 这种
            // 「先声明、稍后赋值、中间被闭包捕获」的既有写法（测试里大量使用），
            // 那是刻意的，改成 const 反而会破坏语义。
            'prefer-const': ['warn', { destructuring: 'all', ignoreReadBeforeAssign: true }],
            // curly 关闭（而非设为 multi-line）：本仓库既有风格是单语句 if 不加大括号，
            // 全仓库一致。开启后会有 51 处告警，全部只能靠改写 30 个文件来消除——
            // 那是纯格式噪音，会淹没真正需要 review 的改动，并且与同事正在进行的工作
            // 大面积冲突。真要统一括号风格，应当作为一次独立的、只做格式的提交来做。
            curly: 'off',
            'no-else-return': 'off', // 既有代码大量使用 else-return，不强行改
            'no-lonely-if': 'off',

            // ── 按"有意为之"放宽的规则（每条都有理由） ──

            // 空块：本仓库大量使用 `catch (_) { }` / `try { ... } catch { }` 做
            // 尽力而为的清理（删临时文件、prune 备份）。这是有意的容错，不是遗漏。
            // 空函数体同样允许：占位回调与 noop。
            'no-empty': ['error', { allowEmptyCatch: true }],

            // 未使用变量：降为 warn 并允许两种既有约定 ——
            //   1. 解构时省略属性：`const { secret, ...safe } = run`（用于脱敏/剔除字段）
            //   2. 下划线前缀：`catch (_)`、`(_req, res) =>`
            // 这两者都是刻意的，naive 报错会把正确的安全代码判成错误。
            'no-unused-vars': ['warn', {
                args: 'none',
                caughtErrors: 'none',
                ignoreRestSiblings: true,
                varsIgnorePattern: '^_',
                argsIgnorePattern: '^_'
            }],

            // 正则里的控制字符：本仓库用 \x00 做路径清洗（去掉 NUL 字节），属有意。
            'no-control-regex': 'off',

            // 多余转义：保留为 warn —— 它确实是无意义的噪音，但改动零风险。
            'no-useless-escape': 'warn',

            'no-prototype-builtins': 'warn',
            'no-async-promise-executor': 'warn',
            'no-unsafe-optional-chaining': 'error',
            'no-useless-catch': 'warn',
            'no-useless-return': 'off'
        }
    },

    // ── 测试文件额外放宽 ────────────────────────────────────
    {
        files: ['**/*.test.js', '**/*.test.cjs', '**/*.test.mjs'],
        rules: {
            // 测试里替换全局（global.window = ...）并断言其被恢复，属正常手法
            'no-global-assign': 'off',
            'no-import-assign': 'off'
        }
    }
];
