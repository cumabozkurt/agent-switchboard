import http from 'node:http';
import crypto from 'node:crypto';

// Yerel çeviri yönlendiricisi: Claude Code'un Anthropic Messages isteklerini
// yalnızca OpenAI uyumlu API sunan sağlayıcılara (OpenAI, Gemini, Groq, özel sunucu…) çevirir.

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

export function anthropicToOpenAI(req, { model } = {}) {
  const messages = [];
  const sys = textOf(req.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = m.content.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : textOf(b.content);
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[HATA] ' : '') + (c || '') });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image' && b.source?.type === 'base64') {
        parts.push({ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
      } else if (b.type === 'image' && b.source?.type === 'url') {
        parts.push({ type: 'image_url', image_url: { url: b.source.url } });
      }
    }
    if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  const out = { model: model || req.model, messages, max_tokens: req.max_tokens, stream: !!req.stream };
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    out.tools = req.tools.filter(t => t.input_schema).map(t => ({
      type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema }
    }));
    const tc = req.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

export function openAIToAnthropic(res, model) {
  const choice = res.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || 'toolu_' + crypto.randomUUID(), name: tc.function?.name, input });
  }
  return {
    id: 'msg_' + (res.id || crypto.randomUUID()),
    type: 'message', role: 'assistant', model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 }
  };
}

// OpenAI SSE parçalarını Anthropic SSE olaylarına çeviren durum makinesi.
export function createStreamTranslator(model, emit) {
  let index = -1, open = null, started = false, stop = 'end_turn';
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolIdx = new Map();
  const send = (event, data) => emit(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const start = () => {
    if (started) return; started = true;
    send('message_start', { message: { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  };
  const close = () => { if (open) { send('content_block_stop', { index }); open = null; } };
  return {
    chunk(obj) {
      start();
      if (obj.usage) { usage.input_tokens = obj.usage.prompt_tokens || 0; usage.output_tokens = obj.usage.completion_tokens || 0; }
      const ch = obj.choices?.[0];
      if (!ch) return;
      const d = ch.delta || {};
      if (d.content) {
        if (open !== 'text') { close(); index++; open = 'text'; send('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!toolIdx.has(k) || (tc.id && toolIdx.get(k).id !== tc.id)) {
          close(); index++; open = 'tool';
          const id = tc.id || 'toolu_' + crypto.randomUUID();
          toolIdx.set(k, { id, block: index });
          send('content_block_start', { index, content_block: { type: 'tool_use', id, name: tc.function?.name || '', input: {} } });
        }
        if (tc.function?.arguments) send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
      if (ch.finish_reason) stop = STOP_MAP[ch.finish_reason] || 'end_turn';
    },
    end() {
      start(); close();
      send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send('message_stop', {});
    }
  };
}

export function startRouter({ port = 3456, target, log = console.log, fetchImpl = fetch }) {
  // target: { baseUrl, key, model, fastModel }
  const pickModel = m => (!m ? target.model : /haiku/i.test(m) && target.fastModel ? target.fastModel : /^claude-/i.test(m) ? target.model : m);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, target: target.baseUrl, model: target.model }));
        return;
      }
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        const n = Math.ceil(JSON.stringify(body).length / 4);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: n }));
        return;
      }
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
      const model = pickModel(body.model);
      const oreq = anthropicToOpenAI(body, { model });
      const up = await fetchImpl(`${target.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
        body: JSON.stringify(oreq)
      });
      if (!up.ok) {
        const t = await up.text();
        res.writeHead(up.status, { 'content-type': 'application/json' })
          .end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: t.slice(0, 2000) } }));
        return;
      }
      if (!oreq.stream) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(openAIToAnthropic(await up.json(), model)));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const tr = createStreamTranslator(model, s => res.write(s));
      const dec = new TextDecoder(); let buf = '';
      for await (const part of up.body) {
        buf += dec.decode(part, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try { tr.chunk(JSON.parse(data)); } catch { /* bozuk parça atlanır */ }
        }
      }
      tr.end(); res.end();
    } catch (e) {
      log('Yönlendirici hatası:', e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
    }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}
