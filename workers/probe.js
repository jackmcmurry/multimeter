/* ============================================================================
 * workers/probe.js: the only piece of Multimeter that runs on a server.
 *
 * GitHub Pages serves a static document, so there is nowhere in the published
 * site for an API key to live. This is a small module worker (Cloudflare
 * Workers, or any runtime with the same fetch handler shape) that holds the
 * key in its environment and answers one question at a time.
 *
 * It is optional. With no endpoint configured the page uses its local
 * evidence engine and says PROBE UNAVAILABLE for anything that engine cannot
 * reach. Nothing else in the instrument depends on this file.
 *
 * Deploy:
 *   wrangler secret put ANTHROPIC_API_KEY
 *   wrangler deploy
 * then set PROBE_ENDPOINT in the page to the worker's URL.
 *
 * The validator runs here, on the server, before anything reaches a student.
 * ========================================================================== */

/* The page's own modules are plain IIFEs on a global, so the worker loads
 * them the way the data job does: bundle src/lib/concepts.js, src/lib/probe.js
 * and src/lib/probe-prompt.js ahead of this file (wrangler's build step, or a
 * plain concatenation) and read MP. Keeping one copy of the prompt and the
 * validator means the rules cannot drift between what the tests check and
 * what ships. */
const MP = globalThis.MP || (globalThis.MP = {});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS'
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json' }, CORS)
  });
}

/* Every failure is a named state the instrument can show, never a stack
 * trace and never a silent empty answer. */
function fail(code, message, status) {
  return json({ status: 'unavailable', code: code, message: message }, status || 200);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return fail('method', 'POST a context and a question.', 405);
    if (!env.ANTHROPIC_API_KEY) return fail('no_key', 'PROBE is not configured on this deployment.');

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return fail('bad_request', 'The request body was not JSON.', 400);
    }
    const question = typeof body.question === 'string' ? body.question.slice(0, 200) : '';
    const ctx = body.context && typeof body.context === 'object' ? body.context : null;
    if (!question || !ctx) return fail('bad_request', 'A question and a context are both required.', 400);

    const ask = MP.probePrompt.buildRequest(ctx, question);

    let reply;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01'
        },
        body: JSON.stringify({
          model: ask.model,
          max_tokens: ask.maxTokens,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'low' },
          fallbacks: 'default',
          system: ask.system,
          messages: [{ role: 'user', content: ask.user }]
        })
      });
      clearTimeout(timer);
      if (res.status === 429) return fail('rate_limit', 'PROBE is busy. Try again in a moment.');
      if (res.status === 401) return fail('no_key', 'PROBE is not configured on this deployment.');
      if (!res.ok) return fail('upstream', 'PROBE could not complete that investigation.');
      reply = await res.json();
    } catch (e) {
      return fail(e && e.name === 'AbortError' ? 'timeout' : 'network', 'PROBE could not be reached.');
    }

    const raw = MP.probePrompt.parse(reply);
    if (!raw) return fail('malformed', 'PROBE could not read that result.');

    /* The guard runs before a student sees anything. A reply that asserts a
     * cause without evidence, cites a figure that was never supplied, or
     * recommends a trade is discarded, and the page falls back to its own
     * arithmetic. */
    const check = MP.probePrompt.validate(raw, ctx);
    if (!check.ok) return json({ status: 'rejected', reason: check.reason });

    return json(MP.probePrompt.toFinding(raw, check, question));
  }
};
