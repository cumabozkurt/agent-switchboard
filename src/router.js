import http from 'node:http';
import crypto from 'node:crypto';

// Yerel çeviri yönlendiricisi. İki yönde çalışır:
//  • /v1/messages  : Claude Code'un Anthropic Messages isteklerini OpenAI Chat Completions'a çevirir.
//  • /v1/responses : Codex'in OpenAI Responses isteklerini Chat Completions'a çevirir (güncel Codex yalnızca
//                    Responses API konuşur; DeepSeek, Kimi, GLM, Gemini gibi sağlayıcılar yalnızca Chat sunar).
// Yalnızca 127.0.0.1'e bağlanır; tarayıcıdan gelen (Origin başlıklı) istekler reddedilir.

const STOP_MAP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const ERR_TYPE = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 529: 'overloaded_error' };

function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n');
}

function imagePart(b) {
  if (b.source?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
  if (b.source?.type === 'url') return { type: 'image_url', image_url: { url: b.source.url } };
  return null;
}

// OpenAI'nin yeni modelleri max_tokens yerine max_completion_tokens ister; diğer sağlayıcılar max_tokens bekler.
function setMaxTokens(out, n, baseUrl) {
  if (n == null) return;
  if (/^https:\/\/api\.openai\.com\//.test(baseUrl || '')) out.max_completion_tokens = n; else out.max_tokens = n;
}

export function anthropicToOpenAI(req, { model, baseUrl } = {}) {
  const messages = [];
  const sys = textOf(req.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of req.messages || []) {
    if (typeof m.content === 'string') { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      // thinking / redacted_thinking blokları OpenAI tarafında karşılığı olmadığı için atlanır.
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
      }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }
    const parts = [];
    const toolImages = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const items = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : (b.content || []);
        const c = textOf(items);
        for (const it of items) { const img = it?.type === 'image' && imagePart(it); if (img) toolImages.push(img); }
        const imgNote = items.some(it => it?.type === 'image') ? (c ? '\n' : '') + '[görsel çıktı bir sonraki kullanıcı mesajında]' : '';
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? '[HATA] ' : '') + (c || '') + imgNote });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        const img = imagePart(b); if (img) parts.push(img);
      }
    }
    // Chat Completions'ta araç mesajı görsel taşıyamaz; araçtan dönen görseller ayrı bir kullanıcı mesajıyla iletilir.
    if (toolImages.length) parts.unshift({ type: 'text', text: 'Araç çıktısındaki görsel(ler):' }, ...toolImages);
    if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  const out = { model: model || req.model, messages, stream: !!req.stream };
  setMaxTokens(out, req.max_tokens, baseUrl);
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.tools?.length) {
    const tools = req.tools.filter(t => t.input_schema).map(t => ({
      type: 'function', function: { name: t.name, description: t.description || '', parameters: t.input_schema }
    }));
    if (tools.length) {
      out.tools = tools;
      const tc = req.tool_choice;
      if (tc?.type === 'any') out.tool_choice = 'required';
      else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
      else if (tc?.type === 'none') out.tool_choice = 'none';
      if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
    }
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

export function openAIToAnthropic(res, model) {
  const choice = res.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: typeof msg.content === 'string' ? msg.content : textOf(msg.content) });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = { _raw: tc.function?.arguments }; }
    content.push({ type: 'tool_use', id: tc.id || 'toolu_' + crypto.randomUUID(), name: tc.function?.name, input });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: 'msg_' + (res.id || crypto.randomUUID()),
    type: 'message', role: 'assistant', model,
    content,
    stop_reason: STOP_MAP[choice.finish_reason] || (msg.tool_calls?.length ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens || 0, output_tokens: res.usage?.completion_tokens || 0 }
  };
}

// OpenAI SSE parçalarını Anthropic SSE olaylarına çeviren durum makinesi.
export function createStreamTranslator(model, emit) {
  let index = -1, open = null, started = false, stop = null, sawTool = false, ended = false;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const toolIdx = new Map();
  const send = (event, data) => emit(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const start = () => {
    if (started) return; started = true;
    send('message_start', { message: { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } } });
  };
  const close = () => { if (open) { send('content_block_stop', { index }); open = null; } };
  return {
    chunk(obj) {
      if (ended) return;
      if (obj.error) { this.error(obj.error.message || JSON.stringify(obj.error), obj.error.code); return; }
      start();
      if (obj.usage) { usage.input_tokens = obj.usage.prompt_tokens || 0; usage.output_tokens = obj.usage.completion_tokens || 0; }
      const ch = obj.choices?.[0];
      if (!ch) return;
      const d = ch.delta || ch.message || {};
      if (typeof d.content === 'string' && d.content) {
        if (open !== 'text') { close(); index++; open = 'text'; send('content_block_start', { index, content_block: { type: 'text', text: '' } }); }
        send('content_block_delta', { index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!toolIdx.has(k) || (tc.id && toolIdx.get(k).id !== tc.id)) {
          close(); index++; open = 'tool'; sawTool = true;
          const id = tc.id || 'toolu_' + crypto.randomUUID();
          toolIdx.set(k, { id, block: index });
          send('content_block_start', { index, content_block: { type: 'tool_use', id, name: tc.function?.name || '', input: {} } });
        }
        if (tc.function?.arguments) send('content_block_delta', { index: toolIdx.get(k).block, delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
      if (ch.finish_reason) stop = STOP_MAP[ch.finish_reason] || 'end_turn';
    },
    error(message, code) {
      if (ended) return; ended = true;
      close();
      send('error', { error: { type: ERR_TYPE[code] || 'api_error', message: String(message).slice(0, 2000) } });
    },
    end() {
      if (ended) return; ended = true;
      start(); close();
      send('message_delta', { delta: { stop_reason: stop || (sawTool ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } });
      send('message_stop', {});
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Codex: OpenAI Responses ⇄ Chat Completions

const CUSTOM_PARAM = 'input';
const partsText = c => typeof c === 'string' ? c : (c || []).filter(p => p && /text$/.test(p.type || '') || typeof p?.text === 'string').map(p => p.text ?? '').join('');

export function responsesToChat(req, { model, baseUrl } = {}) {
  const messages = [];
  const tools = [];
  const kinds = new Map(); // araç adı → 'function' | 'custom' | 'local_shell'
  for (const t of req.tools || []) {
    if (t.type === 'function') {
      tools.push({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } });
      kinds.set(t.name, 'function');
    } else if (t.type === 'custom') {
      // Serbest biçimli araç (ör. apply_patch): tek dizge parametreli bir fonksiyona çevrilir.
      tools.push({ type: 'function', function: { name: t.name, description: `${t.description || ''}${t.format?.definition ? `\n\nGirdi biçimi (${t.format.syntax || 'grammar'}):\n${t.format.definition}` : ''}`.trim(), parameters: { type: 'object', properties: { [CUSTOM_PARAM]: { type: 'string', description: 'Aracın ham girdisi' } }, required: [CUSTOM_PARAM] } } });
      kinds.set(t.name, 'custom');
    } else if (t.type === 'local_shell') {
      tools.push({ type: 'function', function: { name: 'local_shell', description: 'Run a shell command locally.', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } }, workdir: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] } } });
      kinds.set('local_shell', 'local_shell');
    }
    // web_search, image_generation vb. barındırılan araçların Chat karşılığı yok; atlanır.
  }
  if (req.instructions) messages.push({ role: 'system', content: req.instructions });
  const items = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : (req.input || []);
  let pendingAssistant = null;
  const flush = () => { if (pendingAssistant) { messages.push(pendingAssistant); pendingAssistant = null; } };
  const addCall = (id, name, args) => {
    if (!pendingAssistant) pendingAssistant = { role: 'assistant', content: null };
    (pendingAssistant.tool_calls ||= []).push({ id, type: 'function', function: { name, arguments: args } });
  };
  for (const it of items) {
    const type = it.type || (it.role ? 'message' : undefined);
    if (type === 'message') {
      if (it.role === 'assistant') {
        flush();
        pendingAssistant = { role: 'assistant', content: partsText(it.content) || null };
        continue;
      }
      flush();
      const role = it.role === 'developer' || it.role === 'system' ? 'system' : 'user';
      if (typeof it.content === 'string') { messages.push({ role, content: it.content }); continue; }
      const parts = [];
      for (const p of it.content || []) {
        if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') parts.push({ type: 'text', text: p.text });
        else if (p.type === 'input_image' && (p.image_url || p.url)) parts.push({ type: 'image_url', image_url: { url: p.image_url || p.url } });
      }
      if (role === 'system') messages.push({ role, content: parts.filter(p => p.type === 'text').map(p => p.text).join('\n') });
      else if (parts.length) messages.push({ role, content: parts.every(p => p.type === 'text') ? parts.map(p => p.text).join('\n') : parts });
    } else if (type === 'function_call') {
      addCall(it.call_id || it.id, it.name, it.arguments || '{}');
    } else if (type === 'custom_tool_call') {
      addCall(it.call_id || it.id, it.name, JSON.stringify({ [CUSTOM_PARAM]: it.input ?? '' }));
    } else if (type === 'local_shell_call') {
      const a = it.action || {};
      addCall(it.call_id || it.id, 'local_shell', JSON.stringify({ command: a.command || [], workdir: a.working_directory, timeout_ms: a.timeout_ms }));
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      flush();
      const o = it.output;
      const content = typeof o === 'string' ? o : (o && typeof o === 'object' && !Array.isArray(o) && 'content' in o) ? String(o.content) : partsText(o);
      messages.push({ role: 'tool', tool_call_id: it.call_id, content: content || '' });
    }
    // reasoning, web_search_call vb. öğeler Chat tarafına taşınmaz.
  }
  flush();
  const out = { model: model || req.model, messages, stream: !!req.stream };
  setMaxTokens(out, req.max_output_tokens, baseUrl);
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  if (tools.length) {
    out.tools = tools;
    const tc = req.tool_choice;
    if (tc === 'required' || tc === 'none') out.tool_choice = tc;
    else if (tc && typeof tc === 'object' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
    if (req.parallel_tool_calls === false) out.parallel_tool_calls = false;
  }
  if (out.stream) out.stream_options = { include_usage: true };
  return { body: out, kinds };
}

function callItem(kind, id, callId, name, args) {
  if (kind === 'custom') {
    let input = args;
    try { const j = JSON.parse(args || '{}'); if (typeof j[CUSTOM_PARAM] === 'string') input = j[CUSTOM_PARAM]; } catch { /* ham bırak */ }
    return { type: 'custom_tool_call', id, call_id: callId, name, input, status: 'completed' };
  }
  if (kind === 'local_shell') {
    let a = {};
    try { a = JSON.parse(args || '{}'); } catch { /* boş */ }
    return { type: 'local_shell_call', id, call_id: callId, status: 'completed', action: { type: 'exec', command: Array.isArray(a.command) ? a.command : [String(a.command ?? '')], working_directory: a.workdir, timeout_ms: a.timeout_ms } };
  }
  return { type: 'function_call', id, call_id: callId, name, arguments: args || '{}', status: 'completed' };
}

const respUsage = u => ({
  input_tokens: u?.prompt_tokens || 0,
  input_tokens_details: { cached_tokens: u?.prompt_tokens_details?.cached_tokens || 0 },
  output_tokens: u?.completion_tokens || 0,
  output_tokens_details: { reasoning_tokens: u?.completion_tokens_details?.reasoning_tokens || 0 },
  total_tokens: u?.total_tokens || ((u?.prompt_tokens || 0) + (u?.completion_tokens || 0))
});

function baseResponse(id, model, status) {
  return { id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output: [], parallel_tool_calls: true, tool_choice: 'auto', tools: [] };
}

export function chatToResponse(res, model, kinds = new Map()) {
  const r = baseResponse('resp_' + (res.id || crypto.randomUUID()).replace(/^resp_/, ''), model, 'completed');
  const msg = res.choices?.[0]?.message || {};
  const text = typeof msg.content === 'string' ? msg.content : partsText(msg.content);
  if (text) r.output.push({ type: 'message', id: 'msg_' + crypto.randomUUID(), role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const tc of msg.tool_calls || []) {
    const name = tc.function?.name;
    r.output.push(callItem(kinds.get(name), 'fc_' + crypto.randomUUID(), tc.id || 'call_' + crypto.randomUUID(), name, tc.function?.arguments));
  }
  if (res.choices?.[0]?.finish_reason === 'length') { r.status = 'incomplete'; r.incomplete_details = { reason: 'max_output_tokens' }; }
  r.usage = respUsage(res.usage);
  return r;
}

// Chat SSE → Responses SSE
export function createResponsesStreamTranslator(model, emit, kinds = new Map()) {
  const id = 'resp_' + crypto.randomUUID();
  let seq = 0, started = false, ended = false, text = null, finish = null, usage = null;
  const output = [];
  const calls = new Map(); // chat tool index → {item, args, outputIndex}
  const send = (type, data) => emit(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  const start = () => {
    if (started) return; started = true;
    const r = baseResponse(id, model, 'in_progress');
    send('response.created', { response: r });
    send('response.in_progress', { response: r });
  };
  const closeText = () => {
    if (!text) return;
    const item = { type: 'message', id: text.id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text.buf, annotations: [] }] };
    send('response.output_text.done', { item_id: text.id, output_index: text.outputIndex, content_index: 0, text: text.buf });
    send('response.content_part.done', { item_id: text.id, output_index: text.outputIndex, content_index: 0, part: item.content[0] });
    send('response.output_item.done', { output_index: text.outputIndex, item });
    output[text.outputIndex] = item;
    text = null;
  };
  return {
    chunk(obj) {
      if (ended) return;
      if (obj.error) { this.error(obj.error.message || JSON.stringify(obj.error), obj.error.code); return; }
      start();
      if (obj.usage) usage = obj.usage;
      const ch = obj.choices?.[0];
      if (!ch) return;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) {
        if (!text) {
          text = { id: 'msg_' + crypto.randomUUID(), buf: '', outputIndex: output.length };
          output.push(null);
          send('response.output_item.added', { output_index: text.outputIndex, item: { type: 'message', id: text.id, role: 'assistant', status: 'in_progress', content: [] } });
          send('response.content_part.added', { item_id: text.id, output_index: text.outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        text.buf += d.content;
        send('response.output_text.delta', { item_id: text.id, output_index: text.outputIndex, content_index: 0, delta: d.content });
      }
      for (const tc of d.tool_calls || []) {
        const k = tc.index ?? 0;
        let c = calls.get(k);
        if (!c || (tc.id && c.callId !== tc.id)) {
          closeText();
          c = { id: 'fc_' + crypto.randomUUID(), callId: tc.id || 'call_' + crypto.randomUUID(), name: tc.function?.name || '', args: '', outputIndex: output.length };
          output.push(null);
          calls.set(k, c);
          send('response.output_item.added', { output_index: c.outputIndex, item: { type: 'function_call', id: c.id, call_id: c.callId, name: c.name, arguments: '', status: 'in_progress' } });
        }
        if (tc.function?.name && !c.name) c.name = tc.function.name;
        if (tc.function?.arguments) {
          c.args += tc.function.arguments;
          send('response.function_call_arguments.delta', { item_id: c.id, output_index: c.outputIndex, delta: tc.function.arguments });
        }
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    },
    error(message, code) {
      if (ended) return; ended = true;
      start();
      const r = baseResponse(id, model, 'failed');
      r.error = { code: String(code || 'server_error'), message: String(message).slice(0, 2000) };
      send('response.failed', { response: r });
    },
    end() {
      if (ended) return; ended = true;
      start(); closeText();
      for (const c of calls.values()) {
        const item = callItem(kinds.get(c.name), c.id, c.callId, c.name, c.args);
        send('response.output_item.done', { output_index: c.outputIndex, item });
        output[c.outputIndex] = item;
      }
      const r = baseResponse(id, model, finish === 'length' ? 'incomplete' : 'completed');
      if (finish === 'length') r.incomplete_details = { reason: 'max_output_tokens' };
      r.output = output.filter(Boolean);
      r.usage = respUsage(usage);
      send(finish === 'length' ? 'response.incomplete' : 'response.completed', { response: r });
    }
  };
}

// ---------------------------------------------------------------------------------------------

// Kaba ama tutarlı token tahmini (≈4 karakter/token): yalnızca metin içerikleri sayılır.
export function estimateTokens(body) {
  let chars = textOf(body.system).length;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') { chars += m.content.length; continue; }
    for (const b of m.content || []) {
      if (b.type === 'text') chars += (b.text || '').length;
      else if (b.type === 'tool_use') chars += JSON.stringify(b.input ?? {}).length + (b.name || '').length;
      else if (b.type === 'tool_result') chars += (typeof b.content === 'string' ? b.content : textOf(b.content)).length;
      else if (b.type === 'image') chars += 1600 * 4; // Anthropic'in tipik görsel maliyeti ~1600 token
    }
  }
  for (const t of body.tools || []) chars += (t.name || '').length + (t.description || '').length + JSON.stringify(t.input_schema || {}).length;
  return Math.max(1, Math.ceil(chars / 4));
}

async function readSse(body, onData) {
  const dec = new TextDecoder(); let buf = '';
  const line = raw => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let obj; try { obj = JSON.parse(data); } catch { return; } // bozuk parça atlanır
    onData(obj);
  };
  for await (const part of body) {
    buf += dec.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
  buf += dec.decode();
  if (buf) line(buf);
}

function upstreamMessage(text) {
  try { const j = JSON.parse(text); return j.error?.message || j.message || text; } catch { return text; }
}

const isLocalHost = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h || '');

// targets: { claude?: {baseUrl,key,model,fastModel}, codex?: {baseUrl,key,model} } veya her istekte
// güncel hedefleri döndüren bir fonksiyon (böylece "aswitch use" sonrası yeniden başlatmak gerekmez).
// Eski imza (target) da desteklenir: iki uç nokta aynı hedefi kullanır.
export function startRouter({ port = 3456, target, targets, log = console.log, fetchImpl = fetch }) {
  const getTargets = typeof targets === 'function' ? targets : () => targets || { claude: target, codex: target };
  const server = http.createServer(async (req, res) => {
    let tr = null;
    const sendJson = (code, obj) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    try {
      // Tarayıcı kaynaklı (CSRF) ve DNS yeniden bağlama saldırılarına karşı: yalnızca yerel araçlar.
      if (req.headers.origin || !isLocalHost(req.headers.host)) return sendJson(403, { type: 'error', error: { type: 'permission_error', message: 'Yalnızca yerel araçlar kullanabilir.' } });
      const url = new URL(req.url, 'http://127.0.0.1');
      let tg;
      try { tg = getTargets() || {}; } catch (e) { return sendJson(503, { type: 'error', error: { type: 'api_error', message: e.message } }); }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        return sendJson(200, { ok: true, claude: tg.claude ? { target: tg.claude.baseUrl, model: tg.claude.model } : null, codex: tg.codex ? { target: tg.codex.baseUrl, model: tg.codex.model } : null });
      }
      if (req.method !== 'POST') return sendJson(404, { type: 'error', error: { type: 'not_found_error', message: 'Bulunamadı' } });
      const chunks = []; for await (const c of req) chunks.push(c);
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return sendJson(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Geçersiz JSON' } }); }

      const isClaude = url.pathname.startsWith('/v1/messages');
      const isCodex = url.pathname === '/v1/responses' || url.pathname === '/responses';
      if (!isClaude && !isCodex) return sendJson(404, { type: 'error', error: { type: 'not_found_error', message: 'Bulunamadı' } });
      const t = isClaude ? tg.claude : tg.codex;
      if (!t) return sendJson(503, { type: 'error', error: { type: 'api_error', message: `Yönlendirici ${isClaude ? 'Claude Code' : 'Codex'} için yapılandırılmamış. "aswitch use <sağlayıcı> --tools ${isClaude ? 'claude' : 'codex'}" çalıştırın.` } });
      if (isClaude && url.pathname.startsWith('/v1/messages/count_tokens')) return sendJson(200, { input_tokens: estimateTokens(body) });

      let oreq, model, kinds;
      if (isClaude) {
        model = !body.model ? t.model : /haiku/i.test(body.model) && t.fastModel ? t.fastModel : /^claude-/i.test(body.model) && t.model ? t.model : body.model;
        oreq = anthropicToOpenAI(body, { model, baseUrl: t.baseUrl });
      } else {
        model = t.model || body.model;
        ({ body: oreq, kinds } = responsesToChat(body, { model, baseUrl: t.baseUrl }));
      }
      const up = await fetchImpl(`${t.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: oreq.stream ? 'text/event-stream' : 'application/json', ...(t.key ? { authorization: `Bearer ${t.key}` } : {}) },
        body: JSON.stringify(oreq)
      });
      if (!up.ok) {
        const msg = upstreamMessage(await up.text()).slice(0, 2000);
        if (isClaude) return sendJson(up.status, { type: 'error', error: { type: ERR_TYPE[up.status] || 'api_error', message: msg } });
        return sendJson(up.status, { error: { message: msg, type: 'upstream_error', code: String(up.status) } });
      }
      const ctype = up.headers.get('content-type') || '';
      if (!oreq.stream || !ctype.includes('text/event-stream')) {
        // Akış istenmediyse ya da sağlayıcı akış yerine düz JSON döndürdüyse.
        const text = await up.text();
        let json; try { json = JSON.parse(text); } catch { throw new Error(`Sağlayıcıdan beklenmeyen yanıt: ${text.slice(0, 300)}`); }
        if (json.error) throw Object.assign(new Error(json.error.message || JSON.stringify(json.error)), { status: 502 });
        if (!oreq.stream) return sendJson(200, isClaude ? openAIToAnthropic(json, model) : chatToResponse(json, model, kinds));
        // Akış istendi ama JSON geldi: tek parçalık bir akışa dönüştür.
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        tr = isClaude ? createStreamTranslator(model, s => res.write(s)) : createResponsesStreamTranslator(model, s => res.write(s), kinds);
        const m = json.choices?.[0]?.message || {};
        tr.chunk({ ...json, choices: [{ index: 0, delta: { content: m.content, tool_calls: (m.tool_calls || []).map((c, i) => ({ index: i, ...c })) }, finish_reason: json.choices?.[0]?.finish_reason }] });
        tr.end(); return res.end();
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      tr = isClaude ? createStreamTranslator(model, s => res.write(s)) : createResponsesStreamTranslator(model, s => res.write(s), kinds);
      await readSse(up.body, obj => tr.chunk(obj));
      tr.end(); res.end();
    } catch (e) {
      log('Yönlendirici hatası:', e.message);
      if (tr && res.headersSent) { tr.error(e.message); return res.end(); }
      if (res.headersSent) return res.end();
      sendJson(e.status || 500, { type: 'error', error: { type: 'api_error', message: e.message } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server); });
  });
}
