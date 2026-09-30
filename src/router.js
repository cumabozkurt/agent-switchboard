import http from 'node:http';
import crypto from 'node:crypto';
import { t as i18n } from './i18n/index.js';
import { geminiToAnthropic, geminiSink, geminiError } from './gemini-wire.js';
import { meter } from './usage.js';
import { detectScenario, buildChain, createBreaker, BREAKER_DEFAULTS } from './routing.js';

// One breaker and one round-robin state per router process.
export const defaultBreaker = createBreaker();
const defaultBalanceState = new Map();

// Text the router injects into model-facing prompts is always English (models follow it best).
const IMG_NOTE = '[image output is in the next user message]';
const IMG_INTRO = 'Image(s) from the tool output:';
const ERR_PREFIX = '[ERROR] ';

// Yerel çeviri yönlendiricisi. İki yönde çalışır:
//  • /v1/messages  : Claude Code'un Anthropic Messages isteklerini modele göre OpenAI Chat Completions'a
//                    ya da OpenAI Responses'a çevirir (Anthropic uç noktası olan modellerde olduğu gibi iletir).
//  • /v1/responses : Codex'in OpenAI Responses isteklerini Chat Completions'a çevirir (güncel Codex yalnızca
//                    Responses API konuşur; DeepSeek, Kimi, GLM, Gemini gibi sağlayıcılar yalnızca Chat sunar).
// Yalnızca 127.0.0.1'e bağlanır; tarayıcıdan gelen (Origin başlıklı) istekler reddedilir.

// Thinking blocks synthesised from a provider's reasoning output carry this signature. They are shown in
// Claude Code but never forwarded to an Anthropic-compatible endpoint (which would reject the signature).
export const LOCAL_SIG = 'aswitch:local';
const reasoningText = d => (typeof d?.reasoning_content === 'string' && d.reasoning_content) || (typeof d?.reasoning === 'string' && d.reasoning) || '';
// Anthropic thinking budget → OpenAI reasoning effort.
export function effortFor(thinking) {
  if (!thinking || (thinking.type !== 'enabled' && thinking.type !== 'adaptive')) return null;
  const b = Number(thinking.budget_tokens) || 8000;
  return b < 4000 ? 'low' : b < 16000 ? 'medium' : 'high';
}

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
        const imgNote = items.some(it => it?.type === 'image') ? (c ? '\n' : '') + IMG_NOTE : '';
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? ERR_PREFIX : '') + (c || '') + imgNote });
      } else if (b.type === 'text') {
        parts.push({ type: 'text', text: b.text });
      } else if (b.type === 'image') {
        const img = imagePart(b); if (img) parts.push(img);
      }
    }
    // Chat Completions'ta araç mesajı görsel taşıyamaz; araçtan dönen görseller ayrı bir kullanıcı mesajıyla iletilir.
    if (toolImages.length) parts.unshift({ type: 'text', text: IMG_INTRO }, ...toolImages);
    if (parts.length) messages.push({ role: 'user', content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts });
  }
  const out = { model: model || req.model, messages, stream: !!req.stream };
  setMaxTokens(out, req.max_tokens, baseUrl);
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  // OpenAI-style APIs accept at most 4 stop sequences.
  if (req.stop_sequences?.length) out.stop = req.stop_sequences.slice(0, 4);
  // Extended thinking: OpenRouter takes a token budget (https://openrouter.ai/docs/use-cases/reasoning-tokens);
  // other Chat providers get nothing extra (unknown fields are rejected by some of them).
  if (effortFor(req.thinking) && /openrouter\.ai/.test(baseUrl || '')) out.reasoning = req.thinking.budget_tokens ? { max_tokens: req.thinking.budget_tokens } : { effort: effortFor(req.thinking) };
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
  const thought = reasoningText(msg);
  if (thought) content.push({ type: 'thinking', thinking: thought, signature: LOCAL_SIG });
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
  const close = () => {
    if (!open) return;
    if (open === 'thinking') send('content_block_delta', { index, delta: { type: 'signature_delta', signature: LOCAL_SIG } });
    send('content_block_stop', { index }); open = null;
  };
  return {
    chunk(obj) {
      if (ended) return;
      if (obj.error) { this.error(obj.error.message || JSON.stringify(obj.error), obj.error.code); return; }
      start();
      if (obj.usage) { usage.input_tokens = obj.usage.prompt_tokens || 0; usage.output_tokens = obj.usage.completion_tokens || 0; }
      const ch = obj.choices?.[0];
      if (!ch) return;
      const d = ch.delta || ch.message || {};
      const thought = reasoningText(d);
      if (thought) {
        if (open !== 'thinking') { close(); index++; open = 'thinking'; send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }); }
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: thought } });
      }
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
      tools.push({ type: 'function', function: { name: t.name, description: `${t.description || ''}${t.format?.definition ? `\n\nInput format (${t.format.syntax || 'grammar'}):\n${t.format.definition}` : ''}`.trim(), parameters: { type: 'object', properties: { [CUSTOM_PARAM]: { type: 'string', description: 'Raw input for the tool' } }, required: [CUSTOM_PARAM] } } });
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
// Claude Code: Anthropic Messages ⇄ OpenAI Responses
// (yalnızca /responses ile sunulan modeller için; ör. OpenCode Go/Zen gpt-*, grok-*, muse-*)

function responsesImage(b) {
  if (b.source?.type === 'base64') return { type: 'input_image', image_url: `data:${b.source.media_type};base64,${b.source.data}`, detail: 'auto' };
  if (b.source?.type === 'url') return { type: 'input_image', image_url: b.source.url, detail: 'auto' };
  return null;
}

export function anthropicToResponses(req, { model } = {}) {
  const input = [];
  for (const m of req.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    if (m.role === 'assistant') {
      // thinking / redacted_thinking blokları taşınmaz.
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      for (const b of blocks) {
        if (b.type === 'tool_use') input.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
      }
      continue;
    }
    const parts = [];
    const toolImages = [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const items = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : (b.content || []);
        const c = textOf(items);
        for (const it of items) { const img = it?.type === 'image' && responsesImage(it); if (img) toolImages.push(img); }
        const imgNote = items.some(it => it?.type === 'image') ? (c ? '\n' : '') + IMG_NOTE : '';
        input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: (b.is_error ? ERR_PREFIX : '') + (c || '') + imgNote });
      } else if (b.type === 'text') {
        parts.push({ type: 'input_text', text: b.text });
      } else if (b.type === 'image') {
        const img = responsesImage(b); if (img) parts.push(img);
      }
    }
    if (toolImages.length) parts.unshift({ type: 'input_text', text: IMG_INTRO }, ...toolImages);
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
  }
  const out = { model: model || req.model, input, stream: !!req.stream, store: false };
  const sys = textOf(req.system);
  if (sys) out.instructions = sys;
  if (req.max_tokens != null) out.max_output_tokens = req.max_tokens;
  if (req.temperature != null) out.temperature = req.temperature;
  if (req.top_p != null) out.top_p = req.top_p;
  // stop_sequences'in Responses API'de karşılığı yok; atlanır.
  // Extended thinking → reasoning effort + a readable summary (retried without it if the model rejects it).
  if (effortFor(req.thinking)) out.reasoning = { effort: effortFor(req.thinking), summary: 'auto' };
  if (req.tools?.length) {
    const tools = req.tools.filter(t => t.input_schema).map(t => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.input_schema, strict: false }));
    if (tools.length) {
      out.tools = tools;
      const tc = req.tool_choice;
      if (tc?.type === 'any') out.tool_choice = 'required';
      else if (tc?.type === 'tool') out.tool_choice = { type: 'function', name: tc.name };
      else if (tc?.type === 'none') out.tool_choice = 'none';
      else if (tc?.type === 'auto') out.tool_choice = 'auto';
      if (tc?.disable_parallel_tool_use) out.parallel_tool_calls = false;
    }
  }
  return out;
}

const parseArgs = a => { try { return JSON.parse(a || '{}'); } catch { return { _raw: a }; } };
const anthUsage = u => ({ input_tokens: u?.input_tokens || 0, output_tokens: u?.output_tokens || 0 });

function responsesStop(r, sawTool) {
  if (r?.status === 'incomplete') return r.incomplete_details?.reason === 'content_filter' ? 'refusal' : 'max_tokens';
  return sawTool ? 'tool_use' : 'end_turn';
}

export function responsesToAnthropic(res, model) {
  if (res.error || res.status === 'failed') throw Object.assign(new Error(res.error?.message || i18n('router.upstreamFailed')), { status: 502 });
  const content = [];
  let sawTool = false;
  for (const it of res.output || []) {
    if (it.type === 'reasoning') {
      const text = (it.summary || []).map(p => p.text || '').join('\n');
      if (text) content.push({ type: 'thinking', thinking: text, signature: LOCAL_SIG });
    } else if (it.type === 'message') {
      const text = (it.content || []).map(p => p.type === 'output_text' ? p.text : p.type === 'refusal' ? p.refusal : '').join('');
      if (text) content.push({ type: 'text', text });
    } else if (it.type === 'function_call') {
      sawTool = true;
      content.push({ type: 'tool_use', id: it.call_id || it.id || 'toolu_' + crypto.randomUUID(), name: it.name, input: parseArgs(it.arguments) });
    }
    // reasoning ve diğer öğeler atlanır.
  }
  if (!content.length) content.push({ type: 'text', text: typeof res.output_text === 'string' ? res.output_text : '' });
  return {
    id: 'msg_' + String(res.id || crypto.randomUUID()).replace(/^resp_/, ''),
    type: 'message', role: 'assistant', model, content,
    stop_reason: responsesStop(res, sawTool), stop_sequence: null,
    usage: anthUsage(res.usage)
  };
}

// Responses SSE olaylarını Anthropic SSE olaylarına çeviren durum makinesi.
export function createAnthropicFromResponsesStream(model, emit) {
  let index = -1, started = false, ended = false, sawTool = false, openKey = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  const blocks = new Map(); // öğe anahtarı → { index, kind, gotArgs }
  const send = (event, data) => emit(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  const start = () => {
    if (started) return; started = true;
    send('message_start', { message: { id: 'msg_' + crypto.randomUUID(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage } } });
  };
  const keyOf = e => e.item_id || e.item?.id || (e.output_index != null ? 'o' + e.output_index : 'x');
  const close = () => {
    if (openKey == null) return;
    const b = blocks.get(openKey);
    if (b.kind === 'thinking') send('content_block_delta', { index: b.index, delta: { type: 'signature_delta', signature: LOCAL_SIG } });
    send('content_block_stop', { index: b.index }); openKey = null;
  };
  const openThinking = key => {
    if (openKey === key && blocks.get(key)?.kind === 'thinking') return blocks.get(key);
    close(); index++;
    const b = { index, kind: 'thinking' }; blocks.set(key, b); openKey = key;
    send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    return b;
  };
  const openText = key => {
    if (openKey === key && blocks.get(key)?.kind === 'text') return blocks.get(key);
    close(); index++;
    const b = { index, kind: 'text' }; blocks.set(key, b); openKey = key;
    send('content_block_start', { index, content_block: { type: 'text', text: '' } });
    return b;
  };
  const openTool = (key, item) => {
    if (blocks.has(key)) return blocks.get(key);
    close(); index++; sawTool = true;
    const b = { index, kind: 'tool', gotArgs: false }; blocks.set(key, b); openKey = key;
    send('content_block_start', { index, content_block: { type: 'tool_use', id: item.call_id || item.id || 'toolu_' + crypto.randomUUID(), name: item.name || '', input: {} } });
    return b;
  };
  const tr = {
    event(e) {
      if (ended || !e || typeof e !== 'object') return;
      const t = e.type || '';
      if (t === 'error' || (!t && e.error)) { tr.error(e.message || e.error?.message || JSON.stringify(e.error || e), e.code || e.error?.code); return; }
      if (t === 'response.failed') { const er = e.response?.error; tr.error(er?.message || i18n('router.upstreamFailed'), er?.code); return; }
      start();
      if (t === 'response.reasoning_summary_text.delta' || t === 'response.reasoning_text.delta') {
        if (e.delta) send('content_block_delta', { index: openThinking('r' + keyOf(e)).index, delta: { type: 'thinking_delta', thinking: e.delta } });
      } else if (t === 'response.output_item.added' && e.item?.type === 'function_call') {
        openTool(keyOf(e), e.item);
      } else if (t === 'response.output_text.delta' || t === 'response.refusal.delta') {
        if (e.delta) send('content_block_delta', { index: openText(keyOf(e)).index, delta: { type: 'text_delta', text: e.delta } });
      } else if (t === 'response.function_call_arguments.delta') {
        const b = blocks.get(keyOf(e)) || openTool(keyOf(e), { id: e.item_id });
        if (e.delta) { b.gotArgs = true; send('content_block_delta', { index: b.index, delta: { type: 'input_json_delta', partial_json: e.delta } }); }
      } else if (t === 'response.function_call_arguments.done' || (t === 'response.output_item.done' && e.item?.type === 'function_call')) {
        const key = keyOf(e);
        const b = blocks.get(key) || openTool(key, e.item || { id: e.item_id, name: e.name });
        const args = e.arguments ?? e.item?.arguments;
        if (!b.gotArgs && args) { b.gotArgs = true; send('content_block_delta', { index: b.index, delta: { type: 'input_json_delta', partial_json: args } }); }
        if (t === 'response.output_item.done' && openKey === key) close();
      } else if (t === 'response.output_item.done' && e.item?.type === 'message') {
        // Delta gelmeden tamamlanan metin öğeleri (bazı sağlayıcılar) için metni tek parçada gönder.
        const key = keyOf(e);
        if (!blocks.has(key)) {
          const text = (e.item.content || []).map(p => p.type === 'output_text' ? p.text : p.type === 'refusal' ? p.refusal : '').join('');
          if (text) send('content_block_delta', { index: openText(key).index, delta: { type: 'text_delta', text } });
        }
        if (openKey === key) close();
      } else if (t === 'response.completed' || t === 'response.incomplete') {
        if (e.response?.usage) usage = anthUsage(e.response.usage);
        tr.finish(responsesStop(e.response, sawTool));
      }
    },
    error(message, code) {
      if (ended) return; ended = true;
      close();
      send('error', { error: { type: ERR_TYPE[code] || 'api_error', message: String(message).slice(0, 2000) } });
    },
    finish(stop) {
      if (ended) return; ended = true;
      start(); close();
      send('message_delta', { delta: { stop_reason: stop || (sawTool ? 'tool_use' : 'end_turn'), stop_sequence: null }, usage: { ...usage } });
      send('message_stop', {});
    },
    end() { tr.finish(null); }
  };
  return tr;
}

// Tamamlanmış bir Anthropic mesajını Anthropic SSE olayları olarak yayınlar (akış istendi ama JSON geldiyse).
export function emitAnthropicMessage(msg, emit) {
  const send = (event, data) => emit(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: msg.usage.input_tokens, output_tokens: 0 } } });
  msg.content.forEach((b, index) => {
    if (b.type === 'tool_use') {
      send('content_block_start', { index, content_block: { ...b, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
    } else if (b.type === 'thinking') {
      send('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      if (b.thinking) send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      send('content_block_delta', { index, delta: { type: 'signature_delta', signature: b.signature || LOCAL_SIG } });
    } else {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      if (b.text) send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: msg.stop_reason, stop_sequence: null }, usage: { ...msg.usage } });
  send('message_stop', {});
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

// Thinking blocks we synthesised (LOCAL_SIG) are dropped before a request goes to a real Anthropic-compatible
// endpoint, which would reject their signature.
export function stripLocalThinking(body) {
  const messages = (body.messages || []).map(m => Array.isArray(m.content)
    ? { ...m, content: m.content.filter(b => !((b.type === 'thinking' || b.type === 'redacted_thinking') && b.signature === LOCAL_SIG)) }
    : m).filter(m => !Array.isArray(m.content) || m.content.length);
  return { ...body, messages };
}

const RETRYABLE = s => s === 408 || s === 429 || s >= 500;

// Picks the upstream model for a Claude Code request: haiku-class → fast model, other claude-* → main model.
function claudeModel(t, requested) {
  // Fallback / balance / scenario candidates always use their own model (the requested id belongs to the primary).
  if (t.fixedModel) return /haiku/i.test(requested || '') && t.fastModel ? t.fastModel : t.model;
  if (!requested) return t.model;
  if (/haiku/i.test(requested) && t.fastModel) return t.fastModel;
  if (/^claude-/i.test(requested) && t.model) return t.model;
  return requested;
}

// Gemini CLI asks for gemini-*-flash / -lite models for quick internal tasks: those go to the fast model.
function geminiModel(t, requested) {
  if (/(flash|lite)/i.test(requested || '') && t.fastModel) return t.fastModel;
  return t.model || requested;
}

// One upstream attempt. Returns { up, api, model, oreq, kinds, pass } without touching the client response.
async function attempt(kind, t, body, reqHeaders, fetchImpl) {
  const base = (t.baseUrl || '').replace(/\/$/, '');
  const auth = t.key ? { authorization: `Bearer ${t.key}` } : {};
  if (kind === 'claude') {
    const model = claudeModel(t, body.model);
    let api = (typeof t.apiFor === 'function' ? t.apiFor(model) : t.api) || 'chat';
    if (api === 'messages' && t.anthropicBase) {
      const headers = { 'content-type': 'application/json', 'anthropic-version': reqHeaders['anthropic-version'] || '2023-06-01' };
      if (reqHeaders['anthropic-beta']) headers['anthropic-beta'] = reqHeaders['anthropic-beta'];
      if (t.key) { headers.authorization = `Bearer ${t.key}`; headers['x-api-key'] = t.key; }
      const up = await fetchImpl(`${t.anthropicBase.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(stripLocalThinking({ ...body, model })) });
      return { up, api, model, pass: true };
    }
    let oreq;
    if (api === 'responses') oreq = anthropicToResponses(body, { model });
    else { api = 'chat'; oreq = anthropicToOpenAI(body, { model, baseUrl: t.baseUrl }); }
    const send = o => fetchImpl(`${base}/${api === 'responses' ? 'responses' : 'chat/completions'}`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: o.stream ? 'text/event-stream' : 'application/json', ...auth }, body: JSON.stringify(o)
    });
    let up = await send(oreq);
    // Some models reject reasoning parameters: retry once without them.
    if (up.status === 400 && oreq.reasoning) { const { reasoning, ...rest } = oreq; oreq = rest; up = await send(oreq); }
    return { up, api, model, oreq };
  }
  // Codex (Responses API). A fallback provider that serves /responses itself gets the request unchanged.
  const model = t.model || body.model;
  const api = typeof t.codexApi === 'function' ? t.codexApi(model) : 'chat';
  if (api === 'responses') {
    const up = await fetchImpl(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json', ...auth }, body: JSON.stringify({ ...body, model }) });
    return { up, api, model, pass: true };
  }
  const { body: oreq, kinds } = responsesToChat(body, { model, baseUrl: t.baseUrl });
  const up = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', accept: oreq.stream ? 'text/event-stream' : 'application/json', ...auth }, body: JSON.stringify(oreq) });
  return { up, api: 'chat', model, oreq, kinds };
}

// Serves one Claude Code (Anthropic Messages) or Codex (Responses) request, trying the fallback chain on
// 429/5xx/network errors as long as nothing has been sent to the client yet. `res` may be a real HTTP
// response or a sink (Gemini translation, metering). `info` receives provider/model/fallback details.
export async function serveRequest(kind, reqHeaders, res, t, body, { fetchImpl = fetch, log = () => {}, info = {}, breaker = defaultBreaker, balanceState = defaultBalanceState, requestedModel } = {}) {
  const isClaude = kind === 'claude';
  const sendJson = (code, obj) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const errJson = (code, msg) => isClaude ? { type: 'error', error: { type: ERR_TYPE[code] || 'api_error', message: msg } } : { error: { message: msg, type: 'upstream_error', code: String(code) } };
  // Scenario routing (image / long context / web search / thinking / background → a dedicated model).
  let scenarioTarget = null;
  if (t.scenarios && Object.keys(t.scenarios).length) {
    const tokens = kind === 'codex' ? Math.ceil(JSON.stringify(body.input ?? '').length / 4) : estimateTokens(body);
    const scen = detectScenario(kind, body, { tokens, threshold: t.longContextThreshold, requestedModel: requestedModel ?? body.model });
    if (scen && t.scenarios[scen]) { scenarioTarget = t.scenarios[scen]; info.scenario = scen; }
  }
  const breakerCfg = t.breaker || BREAKER_DEFAULTS;
  const { chain, skipped } = buildChain({ primary: t, scenario: scenarioTarget, balance: t.balance, fallbacks: t.fallbacks || [], breaker, breakerCfg, balanceState, balanceKey: kind });
  if (skipped.length) log(i18n('router.breakerSkip', { providers: skipped.join(', ') }));
  let tr = null, a = null;
  try {
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const last = i === chain.length - 1;
      info.provider = c.provider; info.fallback = i;
      breaker?.begin(c.provider);
      try {
        a = await attempt(kind, c, body, reqHeaders, fetchImpl);
      } catch (e) {
        breaker?.failure(c.provider, breakerCfg);
        if (last) throw Object.assign(new Error(i18n('router.upstreamUnreachable', { reason: e.cause?.code || e.message })), { status: 502 });
        log(i18n('router.fallback', { from: c.provider, to: chain[i + 1].provider, reason: e.cause?.code || e.message }));
        continue;
      }
      info.model = a.model; info.api = a.api;
      if (a.up.ok) breaker?.success(c.provider);
      else if (RETRYABLE(a.up.status)) breaker?.failure(c.provider, breakerCfg);
      if (!a.up.ok && RETRYABLE(a.up.status) && !last) {
        log(i18n('router.fallback', { from: c.provider, to: chain[i + 1].provider, reason: 'HTTP ' + a.up.status }));
        try { await a.up.text(); } catch { /* drain */ }
        continue;
      }
      break;
    }
    const { up, api, model, oreq, kinds } = a;
    if (a.pass) {
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache' });
      if (up.body) for await (const part of up.body) res.write(part);
      return res.end();
    }
    if (!up.ok) return sendJson(up.status, errJson(up.status, upstreamMessage(await up.text()).slice(0, 2000)));
    const ctype = up.headers.get('content-type') || '';
    if (!oreq.stream || !ctype.includes('text/event-stream')) {
      const text = await up.text();
      let json; try { json = JSON.parse(text); } catch { throw new Error(i18n('router.unexpected', { text: text.slice(0, 300) })); }
      if (json.error) throw Object.assign(new Error(json.error.message || JSON.stringify(json.error)), { status: 502 });
      if (api === 'responses') {
        const msg = responsesToAnthropic(json, model);
        if (!oreq.stream) return sendJson(200, msg);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        emitAnthropicMessage(msg, s => res.write(s));
        return res.end();
      }
      if (!oreq.stream) return sendJson(200, isClaude ? openAIToAnthropic(json, model) : chatToResponse(json, model, kinds));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      tr = isClaude ? createStreamTranslator(model, s => res.write(s)) : createResponsesStreamTranslator(model, s => res.write(s), kinds);
      const m = json.choices?.[0]?.message || {};
      tr.chunk({ ...json, choices: [{ index: 0, delta: { reasoning_content: reasoningText(m) || undefined, content: m.content, tool_calls: (m.tool_calls || []).map((c, i) => ({ index: i, ...c })) }, finish_reason: json.choices?.[0]?.finish_reason }] });
      tr.end(); return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (api === 'responses') {
      tr = createAnthropicFromResponsesStream(model, s => res.write(s));
      await readSse(up.body, obj => tr.event(obj));
    } else {
      tr = isClaude ? createStreamTranslator(model, s => res.write(s)) : createResponsesStreamTranslator(model, s => res.write(s), kinds);
      await readSse(up.body, obj => tr.chunk(obj));
    }
    tr.end(); res.end();
  } catch (e) {
    log(i18n('router.logError'), e.message);
    info.error = e.message;
    if (tr && res.headersSent) { tr.error(e.message); return res.end(); }
    if (res.headersSent) return res.end();
    sendJson(e.status || 500, errJson(e.status || 500, e.message));
  }
}

const isLocalHost = h => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h || '');
const GEMINI_PATH = /^\/(v1beta|v1|v1alpha)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/;

// targets: { claude?, codex?, gemini? } — or a function returning the current targets on every request, so
// "aswitch use" takes effect without restarting. The old single-target signature (target) is still accepted.
// onUsage(entry) receives one metadata record per request (see usage.js); omit it to disable logging.
export function startRouter({ port = 3456, target, targets, log = console.log, fetchImpl = fetch, onUsage, breaker = defaultBreaker }) {
  const balanceState = new Map();
  const getTargets = typeof targets === 'function' ? targets : () => targets || { claude: target, codex: target };
  const server = http.createServer(async (req, res0) => {
    const sendJson0 = (code, obj) => { if (!res0.headersSent) res0.writeHead(code, { 'content-type': 'application/json' }); res0.end(JSON.stringify(obj)); };
    try {
      // Tarayıcı kaynaklı (CSRF) ve DNS yeniden bağlama saldırılarına karşı: yalnızca yerel araçlar.
      if (req.headers.origin || !isLocalHost(req.headers.host)) return sendJson0(403, { type: 'error', error: { type: 'permission_error', message: i18n('router.localOnly') } });
      const url = new URL(req.url, 'http://127.0.0.1');
      let tg;
      try { tg = getTargets() || {}; } catch (e) { return sendJson0(503, { type: 'error', error: { type: 'api_error', message: e.message } }); }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const spec = f => `${f.provider}:${f.model}`;
        const extra = x => ({
          fallbacks: (x.fallbacks || []).map(spec),
          ...(x.balance?.members?.length ? { balance: { strategy: x.balance.strategy, members: x.balance.members.map(m => `${spec(m)}*${m.weight ?? 1}`) } } : {}),
          ...(x.scenarios && Object.keys(x.scenarios).length ? { scenarios: Object.fromEntries(Object.entries(x.scenarios).map(([k, v]) => [k, spec(v)])) } : {})
        });
        const desc = x => x ? { target: x.baseUrl, provider: x.provider, model: x.model, api: typeof x.apiFor === 'function' ? x.apiFor(x.model) : (x.api || 'chat'), ...extra(x) } : null;
        const bcfg = (tg.claude || tg.codex || tg.gemini)?.breaker || BREAKER_DEFAULTS;
        return sendJson0(200, { ok: true, claude: desc(tg.claude), codex: tg.codex ? { target: tg.codex.baseUrl, provider: tg.codex.provider, model: tg.codex.model, ...extra(tg.codex) } : null, gemini: desc(tg.gemini), breaker: { ...bcfg, providers: breaker.snapshot(bcfg) } });
      }
      if (req.method !== 'POST') return sendJson0(404, { type: 'error', error: { type: 'not_found_error', message: i18n('router.notFound') } });
      const chunks = []; for await (const c of req) chunks.push(c);
      let body;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { return sendJson0(400, { type: 'error', error: { type: 'invalid_request_error', message: i18n('router.badJson') } }); }

      const gm = url.pathname.match(GEMINI_PATH);
      const kind = url.pathname.startsWith('/v1/messages') ? 'claude' : (url.pathname === '/v1/responses' || url.pathname === '/responses') ? 'codex' : gm ? 'gemini' : null;
      if (!kind) return sendJson0(404, { type: 'error', error: { type: 'not_found_error', message: i18n('router.notFound') } });
      const t = tg[kind];
      const toolLabel = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI' }[kind];
      if (!t) {
        const msg = i18n('router.notConfigured', { tool: toolLabel, flag: kind });
        return sendJson0(503, kind === 'gemini' ? geminiError(503, msg) : { type: 'error', error: { type: 'api_error', message: msg } });
      }
      if (kind === 'claude' && url.pathname.startsWith('/v1/messages/count_tokens')) return sendJson0(200, { input_tokens: estimateTokens(body) });

      const info = { provider: t.provider, model: t.model };
      const res = onUsage ? meter(res0, m => onUsage({ ts: new Date().toISOString(), tool: kind, provider: info.provider, model: info.model, api: info.api, status: m.status, ms: m.ms, ttft: m.ttft, in: m.in, out: m.out, fallback: info.fallback || 0, ...(info.scenario ? { scenario: info.scenario } : {}), ...(info.error ? { error: String(info.error).slice(0, 300) } : {}) })) : res0;
      if (kind === 'gemini') {
        const areq = geminiToAnthropic(body, { model: geminiModel(t, gm[2]) });
        if (gm[3] === 'countTokens') {
          info.api = 'count';
          const n = estimateTokens(geminiToAnthropic(body.generateContentRequest || body, { model: '' }));
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ totalTokens: n }));
        }
        const stream = gm[3] === 'streamGenerateContent';
        areq.stream = stream;
        const sink = geminiSink(res, areq.model, stream);
        // The Gemini request is served as a Claude-style request against the same provider pipeline.
        // No model in the body: every candidate in the fallback chain then uses its own model.
        const ct = { ...t, model: areq.model, fastModel: areq.model };
        delete areq.model;
        return await serveRequest('claude', {}, sink, ct, areq, { fetchImpl, log, info, breaker, balanceState, requestedModel: gm[2] });
      }
      return await serveRequest(kind, req.headers, res, t, body, { fetchImpl, log, info, breaker, balanceState });
    } catch (e) {
      log(i18n('router.logError'), e.message);
      if (res0.headersSent) return res0.end();
      sendJson0(e.status || 500, { type: 'error', error: { type: 'api_error', message: e.message } });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server); });
  });
}
