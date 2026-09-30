import crypto from 'node:crypto';

// Gemini API (generateContent / streamGenerateContent) ⇄ Anthropic Messages.
// Used by the local router so Gemini CLI can talk to any provider aswitch supports: the Gemini request is
// turned into an Anthropic Messages request, served by the same pipeline Claude Code uses, and the
// Anthropic answer (JSON or SSE) is turned back into Gemini's format.
// Reference: https://ai.google.dev/api/generate-content

const FINISH = { end_turn: 'STOP', tool_use: 'STOP', stop_sequence: 'STOP', max_tokens: 'MAX_TOKENS', refusal: 'SAFETY', pause_turn: 'STOP' };

// Gemini "OpenAPI subset" schemas use upper-case types (OBJECT, STRING…); JSON Schema wants lower case.
export function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else if (k === 'nullable') continue;
    else out[k] = typeof v === 'object' ? toJsonSchema(v) : v;
  }
  if (s.nullable === true && typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

const textOfParts = parts => (parts || []).filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text).join('');

export function geminiToAnthropic(req, { model } = {}) {
  const messages = [];
  const pending = []; // tool calls waiting for their functionResponse: { id, name }
  let turn = 0;
  for (const c of req.contents || []) {
    const parts = c.parts || [];
    if (c.role === 'model') {
      const blocks = [];
      parts.forEach((p, i) => {
        if (p.thought) return; // the model's own thoughts are not sent back
        if (typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p.functionCall) {
          const id = p.functionCall.id || `toolu_g${turn}_${i}`;
          pending.push({ id, name: p.functionCall.name });
          blocks.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args || {} });
        }
      });
      if (blocks.length) messages.push({ role: 'assistant', content: blocks });
    } else {
      const blocks = [];
      for (const p of parts) {
        if (p.functionResponse) {
          const fr = p.functionResponse;
          let idx = fr.id ? pending.findIndex(x => x.id === fr.id) : -1;
          if (idx < 0) idx = pending.findIndex(x => x.name === fr.name);
          const id = idx >= 0 ? pending.splice(idx, 1)[0].id : fr.id || `toolu_orphan_${crypto.randomUUID()}`;
          const r = fr.response;
          const text = typeof r === 'string' ? r : r && typeof r.output === 'string' && Object.keys(r).length === 1 ? r.output : JSON.stringify(r ?? {});
          blocks.push({ type: 'tool_result', tool_use_id: id, content: text, ...(r && r.error ? { is_error: true } : {}) });
        } else if (typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
        else if (p.inlineData?.data && /^image\//.test(p.inlineData.mimeType || '')) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } });
        } else if (p.inlineData?.data) {
          blocks.push({ type: 'text', text: `[attachment ${p.inlineData.mimeType || 'binary'} omitted]` });
        }
      }
      // tool_result blocks must come first in an Anthropic user turn.
      blocks.sort((a, b) => (b.type === 'tool_result') - (a.type === 'tool_result'));
      if (blocks.length) messages.push({ role: 'user', content: blocks });
    }
    turn++;
  }
  // Anthropic requires alternating roles: merge consecutive turns of the same role.
  const merged = [];
  for (const m of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content); else merged.push(m);
  }
  const g = req.generationConfig || req.config || {};
  const out = { model, messages: merged, max_tokens: g.maxOutputTokens || 8192, stream: false };
  const sys = textOfParts(req.systemInstruction?.parts || (typeof req.systemInstruction === 'string' ? [{ text: req.systemInstruction }] : []));
  if (sys) out.system = sys;
  if (g.temperature != null) out.temperature = g.temperature;
  if (g.topP != null) out.top_p = g.topP;
  if (g.stopSequences?.length) out.stop_sequences = g.stopSequences;
  const budget = g.thinkingConfig?.thinkingBudget;
  if (g.thinkingConfig?.includeThoughts && budget !== 0) out.thinking = { type: 'enabled', budget_tokens: budget > 0 ? budget : 8000 };
  const tools = [];
  for (const t of req.tools || []) {
    for (const f of t.functionDeclarations || []) {
      tools.push({ name: f.name, description: f.description || '', input_schema: f.parametersJsonSchema || toJsonSchema(f.parameters) || { type: 'object', properties: {} } });
    }
  }
  if (tools.length) {
    out.tools = tools;
    const fc = req.toolConfig?.functionCallingConfig;
    const mode = String(fc?.mode || '').toUpperCase();
    if (mode === 'ANY') out.tool_choice = fc.allowedFunctionNames?.length === 1 ? { type: 'tool', name: fc.allowedFunctionNames[0] } : { type: 'any' };
    else if (mode === 'NONE') out.tool_choice = { type: 'none' };
  }
  return out;
}

const usageMeta = u => {
  const p = u?.input_tokens || 0, c = u?.output_tokens || 0;
  return { promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: p + c };
};

export function anthropicToGemini(msg, model) {
  const parts = [];
  for (const b of msg.content || []) {
    if (b.type === 'text' && b.text) parts.push({ text: b.text });
    else if (b.type === 'thinking' && b.thinking) parts.push({ text: b.thinking, thought: true });
    else if (b.type === 'tool_use') parts.push({ functionCall: { id: b.id, name: b.name, args: b.input || {} } });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: FINISH[msg.stop_reason] || 'STOP', index: 0 }],
    usageMetadata: usageMeta(msg.usage),
    modelVersion: model,
    responseId: String(msg.id || crypto.randomUUID())
  };
}

// Anthropic SSE events → Gemini SSE chunks ("data: {GenerateContentResponse}\n\n").
export function createGeminiStreamFromAnthropic(model, emit) {
  const blocks = new Map();
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stop = null, ended = false;
  const send = obj => emit(`data: ${JSON.stringify(obj)}\n\n`);
  const chunk = parts => send({ candidates: [{ content: { role: 'model', parts }, index: 0 }], modelVersion: model });
  return {
    event(e) {
      if (ended || !e) return;
      if (e.type === 'message_start') {
        usage.input_tokens = e.message?.usage?.input_tokens || usage.input_tokens;
      } else if (e.type === 'content_block_start') {
        const cb = e.content_block || {};
        blocks.set(e.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
        if (cb.type === 'text' && cb.text) chunk([{ text: cb.text }]);
      } else if (e.type === 'content_block_delta') {
        const b = blocks.get(e.index) || {};
        const d = e.delta || {};
        if (d.type === 'text_delta' && d.text) chunk([{ text: d.text }]);
        else if (d.type === 'thinking_delta' && d.thinking) chunk([{ text: d.thinking, thought: true }]);
        else if (d.type === 'input_json_delta') b.json += d.partial_json || '';
      } else if (e.type === 'content_block_stop') {
        const b = blocks.get(e.index);
        if (b?.type === 'tool_use') {
          let args = {};
          try { args = b.json ? JSON.parse(b.json) : {}; } catch { args = { _raw: b.json }; }
          chunk([{ functionCall: { id: b.id, name: b.name, args } }]);
        }
      } else if (e.type === 'message_delta') {
        if (e.delta?.stop_reason) stop = e.delta.stop_reason;
        if (e.usage) { usage.output_tokens = e.usage.output_tokens || usage.output_tokens; if (e.usage.input_tokens) usage.input_tokens = e.usage.input_tokens; }
      } else if (e.type === 'error') {
        this.error(e.error?.message || 'upstream error');
      }
    },
    error(message) {
      if (ended) return; ended = true;
      send({ error: { code: 500, message: String(message).slice(0, 2000), status: 'INTERNAL' } });
    },
    end() {
      if (ended) return; ended = true;
      send({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: FINISH[stop] || 'STOP', index: 0 }], usageMetadata: usageMeta(usage), modelVersion: model });
    }
  };
}

const STATUS = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED' };
export function geminiError(code, message) {
  return { error: { code, message: String(message || '').slice(0, 2000), status: STATUS[code] || 'UNKNOWN' } };
}

// A response-like sink handed to the Anthropic pipeline: it collects the Anthropic answer and writes the
// Gemini equivalent to the real HTTP response.
export function geminiSink(res, model, stream) {
  let status = 0, sse = false, buf = '', raw = '';
  const dec = new TextDecoder();
  const conv = createGeminiStreamFromAnthropic(model, s => res.write(s));
  const line = l => {
    const t = l.trim();
    if (!t.startsWith('data:')) return;
    try { conv.event(JSON.parse(t.slice(5).trim())); } catch { /* skip malformed chunk */ }
  };
  const sink = {
    headersSent: false,
    writeHead(code, headers = {}) {
      status = code; sink.headersSent = true;
      sse = code === 200 && String(headers['content-type'] || '').includes('text/event-stream');
      if (sse) res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-cache' });
      return sink;
    },
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
      if (!sse) { raw += text; return true; }
      buf += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      return true;
    },
    end(chunk) {
      if (chunk) sink.write(chunk);
      if (sse) {
        if (buf) line(buf);
        conv.end();
        return res.end();
      }
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not JSON */ }
      if (status === 200 && body && body.type === 'message') {
        const g = anthropicToGemini(body, model);
        if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write(`data: ${JSON.stringify(g)}\n\n`); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(g));
      }
      const code = status && status !== 200 ? status : 502;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(geminiError(code, body?.error?.message || body?.message || raw.slice(0, 500))));
    }
  };
  return sink;
}
