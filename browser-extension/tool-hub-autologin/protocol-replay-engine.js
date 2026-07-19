#!/usr/bin/env node
// protocol-replay-engine.js
//
// Standalone, browser-independent replay of a raw-frame archive (exported
// via window.__rmwExportRawFrames() in content-chatgpt-network.js) through
// the exact same frame-dispatch/patch-application logic the live extension
// uses. Reproduces a capture bug deterministically - no browser, no
// ChatGPT, no network, no waiting for a live stream to happen again.
//
// IMPORTANT: applyJsonPointerPatch()/classifyFrame()/determineFrameAction()
// below are intentionally DUPLICATED from content-chatgpt-network.js (that
// file runs in a browser content-script context with no module system;
// this one runs under plain Node, so it can't just `require()` the other
// file). If the live parser's dispatch/patch logic ever changes, update
// BOTH copies - grep content-chatgpt-network.js for "determineFrameAction"
// to find the current source of truth. Keeping this a plain duplication
// (rather than trying to force a shared module across a browser content
// script and a Node script) is a deliberate simplicity trade-off for a
// tool that's meant to be temporary, for this investigation.
//
// Usage:
//   node protocol-replay-engine.js <raw-frame-archive.json>
//
// Input shape (one array element per archived frame):
//   { correlationId, frameIndex, arrivalTimestamp, frame: <raw parsed SSE frame> }
//
// Output: prints a per-turn summary to stdout, and writes a full
// <input>.replay-output.json with the complete mutation log and final
// reconstructed text for every turn found in the archive.

const fs = require('fs');
const path = require('path');

// ---- BEGIN duplicated pure logic (keep in sync with content-chatgpt-network.js) ----

function applyJsonPointerPatch(root, pointer, value, op) {
  const parts = `${pointer || ''}`.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) return { before: undefined, after: undefined, mutated: false };
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextKey = parts[i + 1];
    if (node[key] == null || typeof node[key] !== 'object') {
      node[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    node = node[key];
  }
  const lastKey = parts[parts.length - 1];
  const before = node[lastKey];
  if (op === 'append' && typeof value === 'string') {
    node[lastKey] = `${typeof before === 'string' ? before : ''}${value}`;
  } else {
    node[lastKey] = value;
  }
  return { before, after: node[lastKey], mutated: true };
}

function classifyFrame(frame, resolvedPointer) {
  if (frame.message && typeof frame.message === 'object') return 'ROOT_PATCH';
  if (frame.p === '' || resolvedPointer === '') return 'ROOT_PATCH';
  const pointer = `${resolvedPointer ?? frame.p ?? ''}`;
  if (pointer) {
    if (/\/status$/.test(pointer) || /\/end_turn$/.test(pointer)) return 'STATUS_PATCH';
    if (/content_references/.test(pointer) && /images/.test(pointer)) return 'IMAGE_TOKEN';
    if (/content_references/.test(pointer)) return 'ENTITY_TOKEN';
    if (/\/metadata/.test(pointer)) return 'METADATA';
    if (/content\/parts\/\d+$/.test(pointer)) return 'TEXT_DELTA';
  }
  if (!frame.type && typeof frame.v === 'string' && !frame.p && !frame.o) return 'TEXT_DELTA';
  if (frame.type === 'title_generation') return 'TITLE_PATCH';
  if (frame.type === 'message_marker') return 'MESSAGE_MARKER';
  return 'UNKNOWN';
}

function determineFrameAction(frame) {
  if (frame.message && typeof frame.message === 'object') {
    return { action: 'full_message_replace', message: frame.message };
  }
  if (frame.o === 'patch' && Array.isArray(frame.v)) {
    return {
      action: 'batched_patch',
      operations: frame.v.map((operation) => ({ operation, cursor: operation?.c ?? frame.c })),
    };
  }
  if (typeof frame.p === 'string' && frame.o) {
    return { action: 'single_patch', operation: frame, cursor: frame.c };
  }
  if (typeof frame.v === 'string' && !frame.type) {
    return {
      action: 'bare_delta',
      operation: { p: '/message/content/parts/0', o: 'append', v: frame.v },
      cursor: frame.c,
    };
  }
  return { action: 'unrecognized' };
}

// ---- END duplicated pure logic --------------------------------------------

function replayOneTurn(correlationId, entries) {
  entries.sort((a, b) => a.frameIndex - b.frameIndex);
  let assembledMessage = null;
  const mutationLog = [];
  const classificationCounts = {};

  function applyOperation(frameIndex, operation, cursor) {
    if (!operation || typeof operation.p !== 'string' || !operation.o) return;
    const { p: rawPath, o: op, v: value } = operation;
    if (rawPath === '') {
      if (value && typeof value === 'object') {
        assembledMessage = value.message && typeof value.message === 'object' ? value.message : value;
      }
      mutationLog.push({ frameIndex, action: 'root_replace_via_patch', messageId: assembledMessage?.id || null });
      return;
    }
    if (!assembledMessage || typeof assembledMessage !== 'object') assembledMessage = {};
    const messagePath = rawPath.startsWith('/message') ? rawPath.slice('/message'.length) : rawPath;
    const result = applyJsonPointerPatch(assembledMessage, messagePath, value, op);
    const beforeLength = typeof result.before === 'string' ? result.before.length : null;
    const afterLength = typeof result.after === 'string' ? result.after.length : null;
    mutationLog.push({
      frameIndex,
      pointer: messagePath,
      op,
      cursor: cursor ?? null,
      beforeLength,
      afterLength,
      shrank: beforeLength !== null && afterLength !== null && afterLength < beforeLength,
    });
  }

  for (const entry of entries) {
    const frame = entry.frame;
    const classification = classifyFrame(frame, frame.p);
    classificationCounts[classification] = (classificationCounts[classification] || 0) + 1;

    const decision = determineFrameAction(frame);
    if (decision.action === 'full_message_replace') {
      assembledMessage = decision.message;
      mutationLog.push({ frameIndex: entry.frameIndex, action: 'full_message_replace', messageId: decision.message?.id || null });
    } else if (decision.action === 'batched_patch') {
      decision.operations.forEach(({ operation, cursor }) => applyOperation(entry.frameIndex, operation, cursor));
    } else if (decision.action === 'single_patch' || decision.action === 'bare_delta') {
      applyOperation(entry.frameIndex, decision.operation, decision.cursor);
    } else {
      mutationLog.push({ frameIndex: entry.frameIndex, action: 'unrecognized', frameKeys: Object.keys(frame) });
    }
  }

  const finalText = Array.isArray(assembledMessage?.content?.parts)
    ? assembledMessage.content.parts.filter((part) => typeof part === 'string').join('')
    : '';

  return {
    correlationId,
    frameCount: entries.length,
    classificationCounts,
    finalMessageId: assembledMessage?.id || null,
    finalRole: assembledMessage?.author?.role || null,
    finalRecipient: assembledMessage?.recipient || null,
    finalTextLength: finalText.length,
    finalText,
    mutationLog,
  };
}

function replay(archiveEntries) {
  const byCorrelation = new Map();
  for (const entry of archiveEntries) {
    if (!byCorrelation.has(entry.correlationId)) byCorrelation.set(entry.correlationId, []);
    byCorrelation.get(entry.correlationId).push(entry);
  }
  const results = [];
  for (const [correlationId, entries] of byCorrelation) {
    results.push(replayOneTurn(correlationId, entries));
  }
  return results;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node protocol-replay-engine.js <raw-frame-archive.json>');
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const results = replay(raw);

  for (const result of results) {
    console.log(`\n=== Turn ${result.correlationId} ===`);
    console.log(`Frames: ${result.frameCount}`);
    console.log(`Classification counts: ${JSON.stringify(result.classificationCounts)}`);
    console.log(`Final message id: ${result.finalMessageId} (role=${result.finalRole}, recipient=${result.finalRecipient})`);
    console.log(`Final text length: ${result.finalTextLength}`);
    console.log(`Final text:\n${result.finalText}`);
  }

  const outputPath = path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, '.json')}.replay-output.json`
  );
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nFull replay output (including per-frame mutation log) written to:\n${outputPath}`);
}

if (require.main === module) {
  main();
}

module.exports = { replay, replayOneTurn, applyJsonPointerPatch, classifyFrame, determineFrameAction };
