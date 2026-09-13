'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/probe.js');
const originalFetch = global.fetch;
const originalKey = process.env.ANTHROPIC_API_KEY;
after(() => { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalKey; });
const context = { subject: { symbol: 'BTC', name: 'Bitcoin', kind: 'crypto' }, mode: 'vol' };
async function call(overrides = {}) {
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(s) { this.code = s; return this; }, json(data) { this.data = data; return this; } };
  await handler({ method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://www.multimtr.com' }, body: { question: 'What is volatility?', context: structuredClone(context) }, ...overrides }, res);
  return res;
}
test('rejects invalid requests before contacting provider', async () => {
  global.fetch = () => { throw new Error('unexpected provider call'); };
  assert.equal((await call({ method: 'GET' })).code, 405);
  assert.equal((await call({ body: '{broken' })).code, 400);
  assert.equal((await call({ body: { question: 'x', context: {} } })).code, 400);
  assert.equal((await call({ headers: { origin: 'https://other.example' } })).code, 403);
});
test('missing configuration returns a safe unavailable response', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await call()).data.code, 'not_configured');
});
test('returns validated Claude explanation and strips untrusted news', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-only';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const sent = JSON.parse(options.body);
    assert.ok(!sent.messages[0].content.includes('made-up earnings'));
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ answer: { headline: 'Volatility measures variation', summary: 'It describes how much returns vary. No volatility figure is loaded here.' }, actions: [] }) }] }) };
  };
  const result = await call({ body: { question: 'What is volatility?', context: { ...context, externalContext: 'made-up earnings' } } });
  assert.equal(result.code, 200);
  assert.equal(result.data.origin, 'claude');
  assert.equal(result.headers['Cache-Control'], 'no-store');
});
test('provider failures and unsupported figures fall back safely', async () => {
  global.fetch = async () => ({ ok: false, status: 429 });
  assert.equal((await call()).code, 429);
  global.fetch = async () => { throw new Error('timeout'); };
  assert.equal((await call()).code, 502);
  global.fetch = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"answer":{"headline":"Price","summary":"The price is 98765."}}' }] }) });
  assert.equal((await call()).data.code, 'unverified');
});
