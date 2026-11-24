import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { summarizeGeneration, summarizeSubagentTurnSpeed, summarizeTurnSpeed, summarizeTurnQueue } from './metrics.mjs';
import { classifyRequestError } from './errors.mjs';
import { summarizeSubagentExecution, summarizeSubagentTurnMetrics, summarizeTurnMetrics } from './turn_metrics.mjs';

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length && i - offset < 10) {
    const b = buf[i++];
    if (i - offset === 10 && b > 1) throw new RangeError('Invalid 64-bit protobuf varint');
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(val), i];
    }
    shift += 7n;
  }
  throw new RangeError('Truncated protobuf varint');
}

export function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function recordedTokenUsage(fields, confirmedZero = false) {
  const reported = confirmedZero || [2, 3, 5, 9, 10].some(key => fields.has(key));
  const value = key => fields.get(key)?.[0] || 0;
  const splitMatches = value(3) === value(9) + value(10);
  return {
    read: reported ? value(2) + value(5) : null,
    cachedRead: reported ? value(5) : null,
    uncachedRead: reported ? value(2) : null,
    write: reported && splitMatches ? value(10) : null,
    thinking: reported && splitMatches ? value(9) : null,
  };
}

export function parseGenRow(idx, data, includeTurnMetrics = true) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const stepIndices = [];
  for (const value of top.get(2) || []) {
    if (typeof value === 'number') stepIndices.push(value);
    else for (let offset = 0; offset < value.length;) {
      const [idx, next] = readVarint(value, offset);
      stepIndices.push(idx);
      offset = next;
    }
  }
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? usage.get(2)[0] : 0;
  const cachedIn = usage.has(5) ? usage.get(5)[0] : 0;
  const thinkTokens = usage.has(9) ? usage.get(9)[0] : 0;
  const outTokens = usage.has(10) ? usage.get(10)[0] : 0;
  const contextTokens = uncachedIn + cachedIn;
  const duration = field => {
    if (!m1.has(field)) return null;
    const fields = parsePbMap(m1.get(field)[0]);
    return (fields.get(1)?.[0] || 0) + (fields.get(2)?.[0] || 0) / 1e9;
  };
  const ttft = duration(11);
  const streaming = duration(12);
  // Verified against the installed ChatModelMetadata/RetryInfo descriptors and
  // 11 real RPC retry errors: ChatModelMetadata.retry_infos=17, RetryInfo.error=3.
  // Read the FINAL retry only; an earlier failed attempt must not survive success.
  const lastRetry = m1.get(17)?.at(-1);
  const retryError = lastRetry ? parsePbMap(lastRetry).get(3)?.[0] : null;
  const requestError = classifyRequestError(Buffer.isBuffer(retryError) ? retryError.toString('utf8') : '');
  // Proto usage.3 is TOTAL output; usage.9 and .10 are thinking and reply.
  // Missing usage/preflight rows must not become a fake zero-token result.
  const hasOutput = m1.has(4) && (usage.has(3) || (ttft !== null && streaming !== null));
  let attempts = [];
  let missingAttempts = 0;
  let pendingAttempt = false;
  if (includeTurnMetrics) {
    const retries = m1.get(17) || [];
    const count = m1.get(14)?.[0];
    const retryCount = Number.isInteger(count) && count >= 0 && count <= 0x7fffffff ? count : 0;
    const hasAttempt = retries.length > 0 || hasOutput || ttft !== null || streaming !== null || top.has(5) || retryCount > 0;
    attempts = retries.map((value, index) => {
      const info = parsePbMap(value);
      const counters = parsePbMap(info.get(2)?.[0] || Buffer.alloc(0));
      const finalSuccess = index === retries.length - 1 && !info.get(3)?.[0]?.length && hasOutput;
      const reported = [2, 3, 5, 9, 10].some(key => counters.has(key));
      return { usage: recordedTokenUsage(finalSuccess && !reported ? usage : counters, finalSuccess) };
    });
    if (hasAttempt && attempts.length === 0) attempts.push({ usage: recordedTokenUsage(usage, hasOutput) });
    if (hasAttempt) missingAttempts = Math.max(0, retryCount + 1 - attempts.length);
    pendingAttempt = !hasAttempt && stepIndices.length > 0;
  }

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0];
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? kv.get(1)[0].toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  return {
    turn: idx,
    uncachedIn,
    cachedIn,
    contextTokens,
    outTokens,
    thinkTokens,
    maxContextTokens,
    lastStepIndex,
    stepIndices,
    requestError,
    attempts,
    missingAttempts,
    pendingAttempt,
    modelDisplayName: Buffer.isBuffer(m1.get(21)?.[0]) ? m1.get(21)[0].toString('utf8').trim() : '',
    generation: {
      requestIndex: idx, ttft, streaming,
      output: hasOutput ? usage.get(3)?.[0] || 0 : null,
      reply: hasOutput ? outTokens : null,
      thinking: hasOutput ? thinkTokens : null,
    },
  };
}

function visibleLocalRequestError(request, steps) {
  const error = request?.requestError ?? classifyRequestError();
  if (error.kind === 'none' || !request.stepIndices.length) return error;
  // Steps can show the next response streaming before its gen_metadata row is saved.
  const lastOutputIndex = request.stepIndices.reduce((last, idx) => Math.max(last, idx), -1);
  const lastOutput = steps.find(step => step.idx === lastOutputIndex);
  if (!lastOutput) return error;
  const failedAt = lastOutput.recordedCompletedAtMs || lastOutput.terminalAtMs;
  const resumed = steps.some(step => step.idx > lastOutputIndex && step.step_type === 15 &&
    (step.status === 8 || (step.status === 3 && step.generatingAtMs > 0)) &&
    (!lastOutput.executionId || step.executionId === lastOutput.executionId) &&
    (!failedAt || step.createdAtMs >= failedAt));
  return resumed ? classifyRequestError() : error;
}

export function readConversationSnapshot(dbPath, includeTurnMetrics = true) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rawRows = [];
  let cpRows = [];
  let lastStepEpochMs = 0;
  let userStepIndex = null;
  let turnSteps = [];
  let metricsUserStepIndex = null;
  let executors = [];
  let subagent = false;
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_metadata_blob'").get()) {
      const blob = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id='main'").get()?.data;
      const meta = parsePbMap(Buffer.from(blob || []));
      // CortexTrajectoryMetadata.parent_conversation_id=5, subagent_spec=8.
      subagent = !!(meta.get(5)?.[0]?.length && meta.get(8)?.[0]?.length);
    }
    rawRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    cpRows = db.prepare('SELECT idx FROM steps WHERE step_type = 23 ORDER BY idx DESC').all();
    // A queued user input is not a new running turn until AGY consumes it.
    userStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 AND status != 11 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    if (includeTurnMetrics) metricsUserStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    const firstTurnStep = subagent ? 0 : userStepIndex ?? metricsUserStepIndex;
    if (firstTurnStep !== null) {
      turnSteps = db.prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx >= ? ORDER BY idx').all(firstTurnStep).map(step => {
        const fields = parsePbMap(Buffer.from(step.metadata || []));
        const stamp = fields.get(7)?.[0] || fields.get(8)?.[0];
        const time = stamp ? parsePbMap(stamp) : new Map();
        const epoch = value => { const parts = parsePbMap(value || Buffer.alloc(0)); return parts.has(1) ? parts.get(1)[0] * 1000 + (parts.get(2)?.[0] || 0) / 1e6 : null; };
        const transitions = (parsePbMap(fields.get(26)?.[0] || Buffer.alloc(0)).get(1) || []).map(value => parsePbMap(value));
        const generating = transitions.filter(item => item.get(1)?.[0] === 8).map(item => epoch(item.get(2)?.[0])).filter(value => value !== null);
        const terminal = transitions.filter(item => [3, 6, 7, 12].includes(item.get(1)?.[0])).map(item => epoch(item.get(2)?.[0])).filter(value => value !== null);
        let inputStartedAtMs = null;
        if (step.step_type === 14) {
          for (const item of transitions) {
            const status = item.get(1)?.[0];
            // Step creation may precede consumption by the entire time spent queued.
            if (status === 11) inputStartedAtMs = null;
            else if (status === 2 || status === 3) inputStartedAtMs ??= epoch(item.get(2)?.[0]);
          }
        }
        return {
          idx: step.idx, step_type: step.step_type, status: step.status,
          completedAtMs: (time.get(1)?.[0] || 0) * 1000 + (time.get(2)?.[0] || 0) / 1e6,
          recordedCompletedAtMs: epoch(fields.get(8)?.[0]),
          createdAtMs: epoch(fields.get(1)?.[0]),
          inputStartedAtMs,
          generatingAtMs: generating.length ? Math.min(...generating) : null,
          terminalAtMs: terminal.length ? Math.max(...terminal) : null,
          executionId: fields.get(12)?.[0]?.toString('utf8') || '',
        };
      });
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'").get()) {
        executors = db.prepare('SELECT data FROM executor_metadata ORDER BY idx').all().map(row => {
          const fields = parsePbMap(Buffer.from(row.data || []));
          return { reason: fields.get(1)?.[0] || 0, lastStepIndex: fields.size ? (fields.get(3)?.[0] ?? 0) : -1, executionId: fields.get(9)?.[0]?.toString('utf8') || '' };
        });
      }
    }
    const stepRow = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (stepRow?.metadata) {
      const sm = parsePbMap(Buffer.from(stepRow.metadata));
      if (sm.has(1)) {
        const tsMap = parsePbMap(sm.get(1)[0]);
        if (tsMap.has(1)) {
          lastStepEpochMs = Number(tsMap.get(1)[0]) * 1000;
        }
      }
    }
  } finally {
    db.close();
  }
  if (!lastStepEpochMs) {
    try {
      lastStepEpochMs = Math.max(statSync(dbPath).mtimeMs, existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').mtimeMs : 0);
    } catch {}
  }

  const turns = [];
  let maxContextTokens = 0;
  let latestGeneration = null;
  let latestTurnRequest = null;
  const parsedRequests = [];

  for (const row of rawRows) {
    const parsed = parseGenRow(row.idx, row.data, includeTurnMetrics);
    if (!parsed) continue;
    parsedRequests.push(parsed);
    latestGeneration = parsed.generation;
    // Known earlier requests may finish late; they cannot replace the current turn's error.
    const earlierRequest = userStepIndex !== null && parsed.lastStepIndex >= 0 && parsed.lastStepIndex < userStepIndex;
    if (!earlierRequest) latestTurnRequest = parsed;
    if (parsed.maxContextTokens > 0) {
      maxContextTokens = parsed.maxContextTokens;
    }
    if (parsed.contextTokens === 0) continue;
    turns.push(parsed);
  }

  // Start accumulating from the latest compaction checkpoint so pre-compaction
  // output/thinking tokens do not inflate the active context breakdown.
  let epochStart = 0;
  if (turns.length > 0) {
    for (const cp of cpRows) {
      const postIdx = turns.findIndex((t) => t.lastStepIndex >= cp.idx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    for (let i = epochStart + 1; i < turns.length; i++) {
      if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
        epochStart = i;
      }
    }
  }

  const latest = turns[turns.length - 1] || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
    outTokens: 0,
    thinkTokens: 0,
  };
  if (turns.length === 0 || latest.contextTokens === 0) {
    lastStepEpochMs = 0;
  }

  // latest.contextTokens is the prompt sent *before* latest generated its output/thinking,
  // so only accumulate prior turns within the active compaction epoch.
  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outTokens;
    rawThink += turns[i].thinkTokens;
  }

  const turn0Tokens = Math.min(turns[epochStart]?.contextTokens || 0, latest.contextTokens);
  const availGen = Math.max(0, latest.contextTokens - turn0Tokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const totalOutputTokens = Math.round(rawOut * genScale);
  const totalThinkingTokens = Math.round(rawThink * genScale);

  let turnQueue, requestError, turnSpeed = null, childTurnMetrics = null;
  if (subagent) {
    // Parent messages and task notifications can start fresh executions without
    // a USER_INPUT step. Never roll previous executions into this one's alerts.
    const latestStep = turnSteps.findLast(step => ![17, 23].includes(step.step_type));
    const executionId = latestStep?.executionId;
    const steps = executionId ? turnSteps.filter(step => step.executionId === executionId) : [];
    const executionByStep = new Map(turnSteps.map(step => [step.idx, step.executionId]));
    const requests = executionId ? parsedRequests.filter(request => {
      // The first request can still use the preceding execution's last step
      // as input. Its persisted output steps are stronger attribution.
      if (!request.stepIndices.length) return executionByStep.get(request.lastStepIndex) === executionId;
      const linked = request.stepIndices.map(idx => executionByStep.get(idx)).filter(Boolean);
      return linked.length > 0 && linked.every(id => id === executionId);
    }) : [];
    const childExecutors = executors.filter(item => item.executionId === executionId);
    turnQueue = summarizeTurnQueue(requests, steps, steps[0]?.idx, childExecutors, true);
    requestError = visibleLocalRequestError(requests.at(-1), steps);
    const execution = summarizeSubagentExecution(steps, childExecutors);
    if (execution) {
      let associationIncomplete = false;
      // Turn totals and speed both require unambiguous execution attribution.
      const executionRequests = parsedRequests.filter(request => {
        const fromCurrentInput = executionByStep.get(request.lastStepIndex) === executionId;
        if (!request.stepIndices.length) return fromCurrentInput;
        const linked = request.stepIndices.map(idx => executionByStep.get(idx));
        if (linked.every(id => id === executionId)) return true;
        if (includeTurnMetrics && (linked.includes(executionId) || (linked.includes(undefined) && fromCurrentInput)
          || (linked.every(id => !id) && request.stepIndices.some(idx => idx >= steps[0].idx)))) associationIncomplete = true;
        return false;
      });
      turnSpeed = summarizeSubagentTurnSpeed(executionRequests, steps, execution);
      if (includeTurnMetrics) childTurnMetrics = summarizeSubagentTurnMetrics(executionRequests, execution, associationIncomplete);
    }
  } else {
    turnQueue = summarizeTurnQueue(parsedRequests, turnSteps, userStepIndex, executors);
    turnSpeed = summarizeTurnSpeed(parsedRequests, turnSteps, userStepIndex);
    requestError = visibleLocalRequestError(latestTurnRequest, turnSteps);
  }

  return {
    ...(subagent && { subagent: { model: parsedRequests.at(-1)?.modelDisplayName || '' } }),
    turnSpeed,
    turnQueue,
    turnMetrics: subagent ? childTurnMetrics : includeTurnMetrics
      ? summarizeTurnMetrics(parsedRequests, turnSteps.map(step => ({ ...step, completedAtMs: step.recordedCompletedAtMs })), metricsUserStepIndex, executors) : null,
    requestError,
    generation: summarizeGeneration(latestGeneration),
    cachedIn: latest.cachedIn,
    uncachedIn: latest.uncachedIn,
    contextTokens: latest.contextTokens,
    contextRequestIndex: latest.turn ?? null,
    maxContextTokens: subagent ? latest.maxContextTokens || 0 : maxContextTokens,
    lastStepEpochMs,
    turn0Tokens,
    totalOutputTokens,
    totalThinkingTokens,
  };
}

const MIN_USAGE_EPOCH_S = 1577836800; // 2020-01-01T00:00:00Z
const isValidEpochSec = value => Number.isSafeInteger(value) && value >= MIN_USAGE_EPOCH_S && value < 4e9;

// One model request for the usage history: when it started, which model answered and what it
// consumed. Field numbers follow CortexStepGeneratorMetadata.chat_model (1) -> ChatModelMetadata
// .usage (4) and optional .chat_start_metadata (9).created_at (4); a step's own created_at
// is CortexStepMetadata field 1.
export function parseUsageRow(data, stepMetadata) {
  // Views, not copies: a scan walks every stored request.
  const bytes = value => (value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.alloc(0));
  const top = parsePbMap(bytes(data));
  const chat = parsePbMap(bytes(top.get(1)?.[0]));
  const usage = parsePbMap(bytes(chat.get(4)?.[0]));
  const count = field => (Number.isSafeInteger(usage.get(field)?.[0]) ? usage.get(field)[0] : 0);
  const text = field => bytes(usage.get(field)?.[0]).toString('utf8');
  // input_tokens (2) is the uncached part; cache reads (5) and writes (4) are reported beside it.
  const tokens = { uncached: count(2), cacheRead: count(5), cacheWrite: count(4), output: count(3) };
  // Preflight rows and failed attempts report no consumption.
  if (!Object.values(tokens).some(Boolean)) return null;
  const seconds = stamp => parsePbMap(bytes(stamp)).get(1)?.[0];
  let startedAt = seconds(parsePbMap(bytes(chat.get(9)?.[0])).get(4)?.[0]);
  if (!isValidEpochSec(startedAt)) {
    // Most rows carry no chat_start_metadata.created_at; date them by the first available step.
    startedAt = null;
    for (const entry of top.get(2) || []) {
      if (typeof entry === 'number') {
        const candidate = seconds(parsePbMap(bytes(stepMetadata(entry))).get(1)?.[0]);
        if (isValidEpochSec(candidate)) { startedAt = candidate; break; }
      } else if (entry?.length) {
        let offset = 0;
        while (offset < entry.length) {
          let stepIndex;
          try {
            [stepIndex, offset] = readVarint(entry, offset);
          } catch { break; }
          const candidate = seconds(parsePbMap(bytes(stepMetadata(stepIndex))).get(1)?.[0]);
          if (isValidEpochSec(candidate)) { startedAt = candidate; break; }
        }
        if (startedAt !== null) break;
      }
    }
  }
  // response_id (11), else message_id (7), within api_provider (6).
  const responseId = text(11);
  const messageId = text(7);
  // model_display_name (21), else response_model (19): preserves legacy records without display names.
  const name = field => bytes(chat.get(field)?.[0]).toString('utf8').trim().slice(0, 80);
  return {
    at: isValidEpochSec(startedAt) ? startedAt * 1000 : null,
    id: responseId ? `r${count(6)}:${responseId}` : messageId ? `m${count(6)}:${messageId}` : '',
    model: name(21) || name(19),
    ...tokens,
  };
}

export function readConversationUsage(dbPath, { immutable = true } = {}) {
  // Closed, idle conversations without a non-empty WAL are opened immutable so SQLite does not
  // leave stray -wal/-shm files beside them; active or recently modified ones use plain read-only.
  const hasActiveWal = (statSync(dbPath + '-wal', { throwIfNoEntry: false })?.size || 0) > 0;
  const useImmutable = immutable && !hasActiveWal;
  let location = dbPath;
  if (useImmutable) {
    location = pathToFileURL(dbPath);
    location.searchParams.set('immutable', '1');
  }
  const db = new DatabaseSync(location, { readOnly: true, timeout: 150 });
  try {
    if (!useImmutable) db.exec('PRAGMA busy_timeout = 150');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata'").get()) return [];
    const hasSteps = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='steps'").get());
    let stepRow = null;
    const stepMetadata = hasSteps
      ? index => (stepRow ??= db.prepare('SELECT metadata FROM steps WHERE idx = ?')).get(index)?.metadata
      : () => undefined;
    return db.prepare('SELECT data FROM gen_metadata ORDER BY idx ASC').all()
      .map(row => parseUsageRow(row.data, stepMetadata))
      .filter(Boolean);
  } finally {
    db.close();
  }
}
