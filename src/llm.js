// Minimal OpenAI-compatible chat client for Vultr Serverless Inference.
// Per-call timeout, retry with exponential backoff on transient errors.
import { sleep } from './util.js';

export class LlmError extends Error {
  constructor(msg, { status = 0, retryable = false } = {}) {
    super(msg);
    this.status = status;
    this.retryable = retryable;
  }
}

export class LlmClient {
  constructor({ key, url, model, timeoutMs = 20000, retries = 2, fetchImpl = globalThis.fetch, backoffMs = 400, sleepFn = sleep, maxTokens = 1200 }) {
    // maxTokens is generous on purpose: models that think before answering can use a small budget up on thinking and return nothing.
    Object.assign(this, { key, url, model, timeoutMs, retries, fetchImpl, backoffMs, sleepFn, maxTokens });
    this.toolChoiceSupport = 'object'; // lowered when the server answers 400 or 422 to a forced tool_choice
  }

  get configured() { return !!(this.key && this.model); }

  async request(path, body, method = 'POST') {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Never echo response bodies into logs or timelines beyond a short status.
        throw new LlmError(`Inference returned HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      }
      return await res.json();
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err.name === 'AbortError') throw new LlmError(`Inference call timed out after ${this.timeoutMs} ms`, { retryable: true });
      throw new LlmError(`Inference network error: ${String(err.message).slice(0, 80)}`, { retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  /** What a forced tool_choice should look like for this server. Falls back from the object form to "required" to nothing. */
  choiceFor(toolChoice) {
    if (toolChoice === 'auto' || typeof toolChoice === 'string') return toolChoice;
    if (this.toolChoiceSupport === 'object') return toolChoice;
    if (this.toolChoiceSupport === 'required') return 'required';
    return 'auto';
  }

  async chat({ messages, tools, toolChoice = 'auto' }) {
    if (!this.configured) throw new LlmError('Inference is not configured');
    for (let tries = 0; tries < 3; tries += 1) {
      const choice = this.choiceFor(toolChoice);
      try {
        return await this.chatOnce({ messages, tools, choice });
      } catch (err) {
        // A server that does not understand a forced tool_choice answers 400 or 422. Remember it and use a simpler form next time.
        const forced = choice !== 'auto' && toolChoice !== 'auto';
        if (forced && err instanceof LlmError && (err.status === 400 || err.status === 422) && this.toolChoiceSupport !== 'auto') {
          this.toolChoiceSupport = typeof choice === 'object' ? 'required' : 'auto';
          continue;
        }
        throw err;
      }
    }
    throw new LlmError('Inference rejected the request');
  }

  async chatOnce({ messages, tools, choice }) {
    const body = {
      model: this.model, messages, temperature: 0.2, max_tokens: this.maxTokens,
      tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: choice,
    };
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const data = await this.request('/chat/completions', body);
        const raw = data?.choices?.[0]?.message;
        if (!raw || typeof raw !== 'object') throw new LlmError('Inference returned no message');
        return { message: normalizeMessage(raw), model: typeof data.model === 'string' ? data.model : this.model, attempts: attempt + 1, finishReason: String(data.choices[0].finish_reason || ''), reasoningOnly: !contentText(raw.content) && !!(raw.reasoning_content || raw.reasoning) };
      } catch (err) {
        lastErr = err;
        if (!(err instanceof LlmError) || !err.retryable || attempt === this.retries) break;
        await this.sleepFn(this.backoffMs * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  /** One tiny call that proves the key, the URL and the model name work together. Never retried, never sends customer data. */
  async ping() {
    if (!this.configured) throw new LlmError('Inference is not configured');
    const data = await this.request('/chat/completions', { model: this.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], temperature: 0, max_tokens: 5 });
    const msg = data?.choices?.[0]?.message;
    if (!msg || typeof msg !== 'object') throw new LlmError('Inference returned no message');
    return { model: typeof data.model === 'string' ? data.model : this.model };
  }

  async listModels() {
    const data = await this.request('/models', null, 'GET');
    return (data?.data || []).map((m) => m.id).filter((x) => typeof x === 'string');
  }
}

// Pick a chat-capable model when none is configured (best effort, never invented).
export function pickModel(ids) {
  const prefs = [/llama.*70b/i, /llama.*(3\.3|3\.1)/i, /qwen.*(32b|72b)/i, /mistral|mixtral/i, /llama|qwen|deepseek|gemma/i];
  for (const re of prefs) {
    const hit = ids.find((i) => re.test(i) && !/embed|rerank|whisper|vision|image|coder|tts/i.test(i));
    if (hit) return hit;
  }
  return '';
}

// Content may be a string or a list of parts ({type:"text", text}) depending on the server.
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}
function normalizeMessage(m) {
  return { ...m, content: contentText(m.content) };
}
