import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MESSAGE_PREVIEW_LIMIT = 240;
const MATCH_CONTEXT_LIMIT = 260;
const DEFAULT_EXPORT_DIR_NAME = 'thread-exports';

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];

    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

async function readJsonLines(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(rootDir) {
  const files = [];

  if (!(await pathExists(rootDir))) {
    return files;
  }

  const entries = await fs.readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function decodeMaybeMojibake(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if (!/[ÃÂâ€]/.test(value) && !/[锟鈥]/.test(value)) {
    return value;
  }

  try {
    return Buffer.from(value, 'latin1').toString('utf8');
  } catch {
    return value;
  }
}

function collectText(content) {
  if (!Array.isArray(content)) {
    return '';
  }

  const text = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') {
      continue;
    }

    if (typeof item.text === 'string') {
      text.push(item.text);
    }
  }

  return text.join('\n').trim();
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function previewText(value, maxLength = 120) {
  if (!value) {
    return '';
  }

  const normalized = normalizeWhitespace(value);

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}...`;
}

function tableCell(value) {
  return normalizeWhitespace(String(value ?? '')).replace(/\|/g, '\\|');
}

function formatNullable(value) {
  return value === null || value === undefined || value === '' ? '(none)' : String(value);
}

function formatInline(value) {
  return normalizeWhitespace(formatNullable(value)).replace(/`/g, "'");
}

function makeCodeFence(value) {
  const runs = String(value ?? '').match(/`+/g) ?? [];
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 3);
  return '`'.repeat(maxRun + 1);
}

function isoOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function findThreadById(threads, id) {
  if (!id || id === true) {
    throw new Error('missing thread id for --export-thread');
  }

  const normalizedId = String(id).trim().toLowerCase();
  const exact = threads.find((thread) => String(thread.id ?? '').toLowerCase() === normalizedId);

  if (exact) {
    return exact;
  }

  const prefixMatches = threads.filter((thread) =>
    String(thread.id ?? '').toLowerCase().startsWith(normalizedId),
  );

  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  if (prefixMatches.length > 1) {
    const candidates = prefixMatches
      .slice(0, 10)
      .map((thread) => `- ${thread.id} ${thread.title || '(untitled)'}`)
      .join('\n');
    throw new Error(`ambiguous thread id prefix: ${id}\n${candidates}`);
  }

  throw new Error(`thread not found: ${id}`);
}

function normalizeRequiredArg(value, flagName) {
  if (!value || value === true) {
    throw new Error(`missing value for ${flagName}`);
  }

  return String(value).trim();
}

function makeSearchHaystack(thread) {
  return [
    thread.id,
    thread.title,
    thread.modelProvider,
    thread.cwd,
    thread.preview,
    thread.firstUserMessage,
    thread.lastUserMessage,
    ...(thread.messages || []).map((message) => message.text),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function filterThreadsByQuery(threads, query) {
  const normalizedQuery = String(query ?? '').trim().toLowerCase();

  if (!normalizedQuery) {
    return threads;
  }

  return threads.filter((thread) => makeSearchHaystack(thread).includes(normalizedQuery));
}

function findQueryMatches(thread, query, maxMatches = 3) {
  if (!query) {
    return [];
  }

  const matches = [];

  for (const [field, value] of [
    ['title', thread.title],
    ['cwd', thread.cwd],
    ['preview', thread.preview],
  ]) {
    const text = String(value ?? '');
    const index = text.toLowerCase().indexOf(query);

    if (index !== -1) {
      matches.push({
        field,
        snippet: snippetAround(text, index, query.length),
      });
    }
  }

  const messages = Array.isArray(thread.messages) ? thread.messages : [];

  for (const message of messages) {
    if (matches.length >= maxMatches) {
      break;
    }

    const text = String(message.text ?? '');
    const index = text.toLowerCase().indexOf(query);

    if (index === -1) {
      continue;
    }

    matches.push({
      field: 'message',
      role: message.role,
      messageIndex: message.index,
      snippet: snippetAround(text, index, query.length),
    });
  }

  return matches.slice(0, maxMatches);
}

function snippetAround(value, startIndex, queryLength) {
  const halfContext = Math.floor((MATCH_CONTEXT_LIMIT - queryLength) / 2);
  const start = Math.max(0, startIndex - halfContext);
  const end = Math.min(value.length, startIndex + queryLength + halfContext);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < value.length ? '...' : '';

  return normalizeWhitespace(`${prefix}${value.slice(start, end)}${suffix}`);
}

function makeMessagePreviews(messages) {
  return messages.map((message) => ({
    index: message.index,
    role: message.role,
    length: message.text.length,
    preview: previewText(message.text, MESSAGE_PREVIEW_LIMIT),
  }));
}

function toOutputThread(thread, { query, includeFullMessages }) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const output = { ...thread };

  delete output.messages;
  output.messagePreviews = makeMessagePreviews(messages);

  if (query) {
    output.matches = findQueryMatches(thread, query);
  }

  if (includeFullMessages) {
    output.messages = messages;
  }

  return output;
}

function makeThreadExportMarkdown(exportData) {
  const { generatedAt, codexHome, commandLine, thread } = exportData;
  const lines = [];
  const messages = Array.isArray(thread.messages) ? thread.messages : [];

  lines.push('# Codex Thread Recovery Dossier');
  lines.push('');
  lines.push(`Generated: \`${generatedAt}\``);
  lines.push(`Codex home: \`${codexHome}\``);
  lines.push(`Command: \`${commandLine}\``);
  lines.push('');
  lines.push('## Continue Prompt');
  lines.push('');
  lines.push('Use this prompt in a new Codex thread when you want to resume from this recovered transcript:');
  lines.push('');
  lines.push('```text');
  lines.push('Continue from the recovered Codex transcript below. Treat the metadata and conversation as context, preserve the latest user intent, and proceed from the final user-facing state.');
  lines.push('```');
  lines.push('');
  lines.push('## Metadata');
  lines.push('');
  lines.push(`- ID: \`${formatInline(thread.id)}\``);
  lines.push(`- Title: ${formatInline(thread.title || '(untitled)')}`);
  lines.push(`- Updated: \`${formatInline(thread.updatedAt)}\``);
  lines.push(`- Created: \`${formatInline(thread.createdAt)}\``);
  lines.push(`- Provider: \`${formatInline(thread.modelProvider)}\``);
  lines.push(`- Bucket: \`${formatInline(thread.bucket)}\``);
  lines.push(`- CWD: \`${formatInline(thread.cwd)}\``);
  lines.push(`- Session file: \`${formatInline(thread.sessionPath)}\``);
  lines.push(`- User messages: ${thread.userMessageCount ?? 0}`);
  lines.push(`- Assistant messages: ${thread.assistantMessageCount ?? 0}`);
  lines.push('');
  lines.push('## Last User Message');
  lines.push('');

  const lastUserFence = makeCodeFence(thread.lastUserMessage);
  lines.push(`${lastUserFence}text`);
  lines.push(thread.lastUserMessage || '');
  lines.push(lastUserFence);
  lines.push('');
  lines.push('## Messages');
  lines.push('');

  if (messages.length === 0) {
    lines.push('(No message bodies were recovered.)');
    lines.push('');
    return lines.join('\n');
  }

  for (const message of messages) {
    const role = message.role || 'unknown';
    const text = message.text || '';
    const fence = makeCodeFence(text);

    lines.push(`### ${String(message.index ?? '').padStart(3, '0')} ${role}`);
    lines.push('');
    lines.push(`Length: ${text.length}`);
    lines.push('');
    lines.push(`${fence}text`);
    lines.push(text);
    lines.push(fence);
    lines.push('');
  }

  return lines.join('\n');
}

async function writeThreadExport(exportData, exportDir) {
  const threadId = exportData.thread.id || 'unknown-thread';
  const baseName = `thread-${threadId}`;
  const jsonPath = path.join(exportDir, `${baseName}.json`);
  const markdownPath = path.join(exportDir, `${baseName}.md`);

  await fs.mkdir(exportDir, { recursive: true });
  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(exportData, null, 2)}\n`, 'utf8'),
    fs.writeFile(markdownPath, `${makeThreadExportMarkdown(exportData)}\n`, 'utf8'),
  ]);

  return { jsonPath, markdownPath };
}

async function buildSessionRecord(sessionPath, bucket) {
  const lines = await readJsonLines(sessionPath);
  const metaLine = lines.find((line) => line.type === 'session_meta');
  const payload = metaLine?.payload ?? {};
  const messageItems = lines.filter(
    (line) => line.type === 'response_item' && line.payload?.type === 'message',
  );

  const userMessages = [];
  const assistantMessages = [];
  const messages = [];

  for (const [index, item] of messageItems.entries()) {
    const role = item.payload?.role;
    const content = collectText(item.payload?.content);

    if (!content) {
      continue;
    }

    if (role === 'user') {
      userMessages.push(content);
    } else if (role === 'assistant') {
      assistantMessages.push(content);
    }

    messages.push({ index, role, text: content });
  }

  const stats = await fs.stat(sessionPath);

  return {
    id: payload.id ?? path.basename(sessionPath).match(/[0-9a-f-]{36}/i)?.[0] ?? null,
    bucket,
    sessionPath,
    createdAt: isoOrNull(payload.timestamp) ?? stats.birthtime.toISOString(),
    fileUpdatedAt: stats.mtime.toISOString(),
    cwd: decodeMaybeMojibake(payload.cwd ?? ''),
    modelProvider: payload.model_provider ?? null,
    originator: payload.originator ?? null,
    source: payload.source ?? null,
    cliVersion: payload.cli_version ?? null,
    userMessageCount: userMessages.length,
    assistantMessageCount: assistantMessages.length,
    firstUserMessage: userMessages[0] ?? '',
    lastUserMessage: userMessages.at(-1) ?? '',
    lastAssistantMessage: assistantMessages.at(-1) ?? '',
    messages,
  };
}

function mergeThreadData(indexEntry, sessionEntry) {
  const title = decodeMaybeMojibake(indexEntry?.thread_name ?? '');
  const updatedAt = isoOrNull(indexEntry?.updated_at) ?? sessionEntry?.fileUpdatedAt ?? null;
  const createdAt = sessionEntry?.createdAt ?? updatedAt;
  const preview =
    previewText(sessionEntry?.lastUserMessage) ||
    previewText(sessionEntry?.firstUserMessage) ||
    '';

  return {
    id: sessionEntry?.id ?? indexEntry?.id ?? null,
    title,
    updatedAt,
    createdAt,
    bucket: sessionEntry?.bucket ?? 'unknown',
    modelProvider: sessionEntry?.modelProvider ?? null,
    cwd: sessionEntry?.cwd ?? '',
    source: sessionEntry?.source ?? null,
    cliVersion: sessionEntry?.cliVersion ?? null,
    sessionPath: sessionEntry?.sessionPath ?? null,
    userMessageCount: sessionEntry?.userMessageCount ?? 0,
    assistantMessageCount: sessionEntry?.assistantMessageCount ?? 0,
    preview,
    firstUserMessage: sessionEntry?.firstUserMessage ?? '',
    lastUserMessage: sessionEntry?.lastUserMessage ?? '',
    lastAssistantMessage: sessionEntry?.lastAssistantMessage ?? '',
    messages: sessionEntry?.messages ?? [],
  };
}

function byUpdatedAtDesc(left, right) {
  return new Date(right.updatedAt ?? 0).getTime() - new Date(left.updatedAt ?? 0).getTime();
}

function parseDateFilter(value, flagName) {
  if (!value) {
    return null;
  }

  const raw = normalizeRequiredArg(value, flagName);
  const bareDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = bareDate
    ? new Date(Number(bareDate[1]), Number(bareDate[2]) - 1, Number(bareDate[3]))
    : new Date(raw);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid date for ${flagName}: ${raw}`);
  }

  return date.getTime();
}

function parseRank(value) {
  if (value === undefined || value === null || value === '') {
    return 1;
  }

  const raw = normalizeRequiredArg(value, '--rank');
  const rank = Number.parseInt(raw, 10);

  if (!Number.isInteger(rank) || rank < 1) {
    throw new Error(`invalid rank for --rank: ${raw}`);
  }

  return rank;
}

function applyDateFilters(threads, { before, after }) {
  const beforeTime = parseDateFilter(before, '--before');
  const afterTime = parseDateFilter(after, '--after');

  return threads.filter((thread) => {
    const updatedTime = new Date(thread.updatedAt ?? thread.createdAt ?? 0).getTime();

    if (Number.isNaN(updatedTime)) {
      return false;
    }

    if (beforeTime !== null && updatedTime >= beforeTime) {
      return false;
    }

    if (afterTime !== null && updatedTime < afterTime) {
      return false;
    }

    return true;
  });
}

function makeMarkdown(indexData, commandLine) {
  const lines = [];
  const generatedAt = new Date().toISOString();

  lines.push('# Codex Thread Index');
  lines.push('');
  lines.push(`Generated: \`${generatedAt}\``);
  lines.push(`Codex home: \`${indexData.codexHome}\``);
  lines.push(`Command: \`${commandLine}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total threads: **${indexData.summary.totalThreads}**`);
  lines.push(`- Active session files: **${indexData.summary.activeSessions}**`);
  lines.push(`- Archived session files: **${indexData.summary.archivedSessions}**`);
  lines.push(`- Providers: **${Object.keys(indexData.summary.byProvider).length}**`);
  lines.push('');
  lines.push('## By Provider');
  lines.push('');

  const providerEntries = Object.entries(indexData.summary.byProvider).sort((left, right) =>
    right[1] - left[1],
  );

  for (const [provider, count] of providerEntries) {
    lines.push(`- \`${provider}\`: ${count}`);
  }

  lines.push('');
  lines.push('## Threads');
  lines.push('');
  lines.push('| Updated | Provider | Bucket | Title | ID | Preview / Match |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const thread of indexData.threads) {
    const title = tableCell(thread.title || '(untitled)');
    const provider = tableCell(thread.modelProvider || 'unknown');
    const bucket = tableCell(thread.bucket || 'unknown');
    const match = tableCell(thread.matches?.[0]?.snippet || thread.preview || '');
    lines.push(
      `| ${thread.updatedAt ?? ''} | ${provider} | ${bucket} | ${title} | \`${thread.id ?? ''}\` | ${match} |`,
    );
  }

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const codexHome =
    path.resolve(args.home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const outDir = path.resolve(args.out ?? path.join(process.cwd(), 'output', 'codex-thread-index'));
  const exportDir = path.resolve(
    args['export-out'] ?? path.join(outDir, DEFAULT_EXPORT_DIR_NAME),
  );
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const includeFullMessages = args['include-full-messages'] === true;
  const exportThreadId = args['export-thread'] ?? args.thread ?? '';
  const exportQueryValue = args['export-query'] ?? args.recover ?? '';
  const rank = parseRank(args.rank);
  const before = args.before ?? '';
  const after = args.after ?? '';
  const commandLine = `node ${path.basename(process.argv[1])}${process.argv
    .slice(2)
    .map((part) => ` ${part}`)
    .join('')}`;

  const sessionIndexPath = path.join(codexHome, 'session_index.jsonl');
  const sessionsDir = path.join(codexHome, 'sessions');
  const archivedDir = path.join(codexHome, 'archived_sessions');

  if (!(await pathExists(sessionIndexPath))) {
    throw new Error(`session index not found: ${sessionIndexPath}`);
  }

  const [indexLines, activeFiles, archivedFiles] = await Promise.all([
    readJsonLines(sessionIndexPath),
    walkFiles(sessionsDir),
    walkFiles(archivedDir),
  ]);

  const sessionFiles = [
    ...activeFiles.map((filePath) => ({ bucket: 'sessions', filePath })),
    ...archivedFiles.map((filePath) => ({ bucket: 'archived_sessions', filePath })),
  ].filter(({ filePath }) => filePath.endsWith('.jsonl'));

  const sessionRecords = await Promise.all(
    sessionFiles.map(async ({ bucket, filePath }) => {
      try {
        return await buildSessionRecord(filePath, bucket);
      } catch (error) {
        return {
          id: path.basename(filePath).match(/[0-9a-f-]{36}/i)?.[0] ?? null,
          bucket,
          sessionPath: filePath,
          parseError: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const sessionMap = new Map();

  for (const session of sessionRecords) {
    if (!session.id) {
      continue;
    }

    const existing = sessionMap.get(session.id);

    if (!existing || byUpdatedAtDesc(session, existing) < 0) {
      sessionMap.set(session.id, session);
    }
  }

  const threads = [];
  const seenIds = new Set();

  for (const indexEntry of indexLines) {
    const sessionEntry = sessionMap.get(indexEntry.id);
    const thread = mergeThreadData(indexEntry, sessionEntry);
    seenIds.add(thread.id);
    threads.push(thread);
  }

  for (const sessionEntry of sessionMap.values()) {
    if (seenIds.has(sessionEntry.id)) {
      continue;
    }

    threads.push(mergeThreadData(null, sessionEntry));
  }

  threads.sort(byUpdatedAtDesc);
  const scopedThreads = applyDateFilters(threads, { before, after });

  if (exportThreadId) {
    const thread = findThreadById(scopedThreads, exportThreadId);
    const exportData = {
      generatedAt: new Date().toISOString(),
      codexHome,
      commandLine,
      filters: { before: before || null, after: after || null },
      thread: toOutputThread(thread, { query: '', includeFullMessages: true }),
    };
    const { jsonPath, markdownPath } = await writeThreadExport(exportData, exportDir);

    console.log([
      `Exported thread: ${thread.id}`,
      `Title: ${thread.title || '(untitled)'}`,
      `JSON: ${jsonPath}`,
      `Markdown: ${markdownPath}`,
    ].join('\n'));
    return;
  }

  if (exportQueryValue) {
    const exportQuery = normalizeRequiredArg(exportQueryValue, '--export-query').toLowerCase();
    const matches = filterThreadsByQuery(scopedThreads, exportQuery);

    if (matches.length === 0) {
      throw new Error(`no threads matched export query: ${exportQuery}`);
    }

    if (rank > matches.length) {
      throw new Error(`--rank ${rank} is outside the ${matches.length} matching thread(s)`);
    }

    const thread = matches[rank - 1];
    const exportData = {
      generatedAt: new Date().toISOString(),
      codexHome,
      commandLine,
      exportQuery,
      filters: { before: before || null, after: after || null },
      matchCount: matches.length,
      selectedRank: rank,
      thread: toOutputThread(thread, { query: exportQuery, includeFullMessages: true }),
    };
    const { jsonPath, markdownPath } = await writeThreadExport(exportData, exportDir);

    console.log([
      `Exported latest matching thread: ${thread.id}`,
      `Title: ${thread.title || '(untitled)'}`,
      `Query: ${exportQuery}`,
      `Matches: ${matches.length}`,
      `Rank: ${rank}`,
      `JSON: ${jsonPath}`,
      `Markdown: ${markdownPath}`,
    ].join('\n'));
    return;
  }

  const filteredThreads = filterThreadsByQuery(scopedThreads, query);

  const byProvider = {};

  for (const thread of threads) {
    const provider = thread.modelProvider || 'unknown';
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
  }

  const indexData = {
    generatedAt: new Date().toISOString(),
    codexHome,
    query: query || null,
    summary: {
      totalThreads: filteredThreads.length,
      totalThreadsUnfiltered: threads.length,
      totalThreadsAfterDateFilters: scopedThreads.length,
      activeSessions: activeFiles.length,
      archivedSessions: archivedFiles.length,
      byProvider,
    },
    threads: filteredThreads.map((thread) =>
      toOutputThread(thread, { query, includeFullMessages }),
    ),
  };

  await fs.mkdir(outDir, { recursive: true });

  const jsonPath = path.join(outDir, query ? 'threads.filtered.json' : 'threads.json');
  const markdownPath = path.join(outDir, query ? 'threads.filtered.md' : 'threads.md');

  await Promise.all([
    fs.writeFile(jsonPath, `${JSON.stringify(indexData, null, 2)}\n`, 'utf8'),
    fs.writeFile(markdownPath, `${makeMarkdown(indexData, commandLine)}\n`, 'utf8'),
  ]);

  const consoleLines = [
    `Indexed ${filteredThreads.length} thread(s).`,
    `JSON: ${jsonPath}`,
    `Markdown: ${markdownPath}`,
  ];

  if (query) {
    consoleLines.push(`Query: ${query}`);
  }

  console.log(consoleLines.join('\n'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
