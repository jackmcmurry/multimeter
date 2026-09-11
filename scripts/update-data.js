#!/usr/bin/env node
/* ============================================================================
 * update-data.js — entry point for the scheduled data job.
 *
 * Loads the shared src/lib modules, runs MP.pipeline against the live APIs and
 * writes whichever snapshots came back to docs/data/. Every decision lives in
 * src/lib/pipeline.js; this file is only I/O.
 *
 *   FMP_API_KEY=... ALPHAVANTAGE_API_KEY=... node scripts/update-data.js
 *   FORCE=all node scripts/update-data.js     # refresh regardless of schedule
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const MODULES = ['stats.js', 'format.js', 'sources.js', 'session.js', 'spotlight.js', 'pipeline.js'];

MODULES.forEach((file) => require(path.join(ROOT, 'src', 'lib', file)));
const { pipeline } = globalThis.MP;

function fileFor(name) {
  return path.join(DATA_DIR, name + '.json');
}

function read(name) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch (err) {
    return null;
  }
}

/* generatedAt changes on every run; ignore it when deciding whether to write. */
function sameContent(a, b) {
  const strip = (o) => JSON.stringify(Object.assign({}, o, { generatedAt: null }));
  return !!a && !!b && strip(a) === strip(b);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'multimeter-data-job' },
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === 'object'
      ? (body['Error Message'] || body.message || '')
      : String(body).slice(0, 160);
    const error = new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''));
    error.status = res.status;
    throw error;
  }
  return body;
}

/* GitHub Actions workflow commands inside Actions; plain lines elsewhere. */
function annotate(level, message) {
  const prefix = process.env.GITHUB_ACTIONS ? '::' + level + '::' : level.toUpperCase() + ': ';
  console.log(prefix + pipeline.redact(message));
}

async function main() {
  const result = await pipeline.run({ now: Date.now(), env: process.env, fetchJson, read });

  if (result.skipped) {
    annotate('warning', result.skipped);
    return 0;
  }

  for (const name of ['spotlight', 'quotes', 'history']) {
    const next = result.out[name];
    if (!next) {
      console.log(name + ': not due');
      continue;
    }
    if (sameContent(read(name), next)) {
      console.log(name + ': unchanged');
      continue;
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(fileFor(name), JSON.stringify(next) + '\n');
    console.log(name + ': written');
  }

  result.warnings.forEach((w) => annotate('warning', w));
  console.log('calls: FMP ' + result.calls.fmp + ' (' + result.failed.fmp + ' failed), ' +
    'Alpha Vantage ' + result.calls.av + ' (' + result.failed.av + ' failed), ' +
    'CoinGecko ' + result.calls.cg + ' (' + result.failed.cg + ' failed)');

  if (result.calls.fmp > 0 && result.failed.fmp === result.calls.fmp) {
    annotate('error', 'Every FMP request failed. Check that the FMP_API_KEY secret holds a valid key.');
    return 1;
  }
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}, (err) => {
  annotate('error', err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
