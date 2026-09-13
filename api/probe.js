'use strict';

require('../src/lib/concepts.js');
require('../src/lib/probe.js');
require('../src/lib/probe-prompt.js');
const prompt = globalThis.MP.probePrompt;
// A bounded, per-instance burst guard. Provider spending limits remain necessary.
const callers = new Map();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const fail = (code, status) => res.status(status).json({ status: 'unavailable', code });
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return fail('method', 405); }
  const origin = req.headers.origin;
  if (origin && !['https://www.multimtr.com', 'https://multimtr.com',
    'https://' + process.env.VERCEL_URL, 'http://127.0.0.1:8789'].includes(origin)) return fail('origin', 403);
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return fail('content_type', 415);
  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch (_) { return fail('request', 400); }
  if (!body || JSON.stringify(body).length > 16000) return fail('request', 400);
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  const ctx = body.context;
  if (!question || question.length > 200 || !ctx || !ctx.subject ||
      typeof ctx.subject.symbol !== 'string' || typeof ctx.subject.name !== 'string') return fail('request', 400);
  // No browser-supplied news is trusted as external evidence.
  ctx.externalContext = null;
  if (!process.env.ANTHROPIC_API_KEY) return fail('not_configured', 503);
  const now = Date.now();
  for (const [ip, entry] of callers) if (now - entry.start > 60000) callers.delete(ip);
  const ip = String(req.headers['x-forwarded-for'] || 'unknown').split(',')[0];
  const entry = callers.get(ip) || { start: now, count: 0 };
  if (entry.count >= 8 || callers.size >= 2000) return fail('busy', 429);
  entry.count++; callers.set(ip, entry);
  try {
    const ask = prompt.buildRequest(ctx, question);
    const reply = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.PROBE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1500, system: ask.system,
        messages: [{ role: 'user', content: ask.user }] })
    });
    if (!reply.ok) return fail(reply.status === 429 ? 'busy' : 'provider', reply.status === 429 ? 429 : 502);
    const raw = prompt.parse(await reply.json());
    const check = prompt.validate(raw, ctx);
    if (!check.ok) return fail('unverified', 502);
    return res.status(200).json(prompt.toFinding(raw, check, question));
  } catch (_) { return fail('unavailable', 502); }
};
