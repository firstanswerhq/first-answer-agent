// Minimal OpenAI-compatible chat client for Vultr Serverless Inference.
// Per-call timeout, retry with exponential backoff on transient errors.
import { sleep } from './util.js';

export class LlmError extends Error {
  constructor(msg, { status = 0, retryable = false, hint = '' } = {}) {
    super(msg);
    this.status = status;
    this.retryable = retryable;
    this.hint = hint; // short lowercase excerpt of an error body, used only to decide which request option to drop; never shown
  }
}

export class LlmClient {
  constructor({ key, url, model, timeoutMs = 20000, retries = 2, fetchImpl = globalThis.fetch, backoffMs = 400, sleepFn = sleep, maxTokens = 2000, maxTokensCap = 4000, callTimeoutMs = 12000, maxCalls = 6, thinkingOff = true }) {
    // maxTokens is generous on purpose: models that think before answering can use a small budget up on thinking and return nothing.
    Object.assign(this, { key, url, model, timeoutMs, retries, fetchImpl, backoffMs, sleepFn, maxTokens, maxTokensCap, callTimeoutMs, maxCalls });
    // Optional request fields that ask the server to skip long hidden reasoning. Dropped for the life of the process if the server refuses one.
    this.dropped = new Set(thinkingOff ? [] : ['chat_template_kwargs', 'reasoning_effort']);
    this.toolChoiceSupport = 'object'; // lowered when the server answers 400 or 422 to a forced tool_choice
  }

  get configured() { return !!(this.key && this.model); }

  async request(path, body, method = 'POST', timeoutMs = this.timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // Never echo response bodies into logs or timelines beyond a short status. A 400 or 422 body is only searched for option names.
        let hint = '';
        if (res.status === 400 || res.status === 422) { try { hint = String(await res.text()).slice(0, 400).toLowerCase(); } catch { hint = ''; } }
        throw new LlmError(`Inference returned HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500, hint });
      }
      return await res.json();
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err.name === 'AbortError') throw new LlmError(`Inference call timed out after ${timeoutMs} ms`, { retryable: true });
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

  /**
   * budget (optional) is shared by all calls for one inquiry: { startedAt, deadlineMs, calls, maxCalls, now }.
   * Once the total deadline has passed or maxCalls upstream calls were made, no further request leaves this process.
   */
  async chat({ messages, tools, toolChoice = 'auto', maxTokens, budget = null }) {
    if (!this.configured) throw new LlmError('Inference is not configured');
    for (let tries = 0; tries < 4; tries += 1) {
      const choice = this.choiceFor(toolChoice);
      try {
        return await this.chatOnce({ messages, tools, choice, maxTokens, budget });
      } catch (err) {
        if (!(err instanceof LlmError) || (err.status !== 400 && err.status !== 422)) throw err;
        // A 400 or 422 only changes the request when the server names the option it refused.
        const forced = choice !== 'auto' && toolChoice !== 'auto';
        if (forced && /tool_choice|tool choice|\btools?\b/.test(err.hint) && this.toolChoiceSupport !== 'auto') {
          this.toolChoiceSupport = typeof choice === 'object' ? 'required' : 'auto';
          continue;
        }
        const named = ['chat_template_kwargs', 'enable_thinking', 'reasoning_effort'].filter((k) => err.hint.includes(k));
        if (named.length) {
          if (named.includes('reasoning_effort')) this.dropped.add('reasoning_effort');
          if (named.includes('chat_template_kwargs') || named.includes('enable_thinking')) this.dropped.add('chat_template_kwargs');
          continue;
        }
        throw err;
      }
    }
    throw new LlmError('Inference rejected the request');
  }

  /** Spend one upstream call from the budget, or refuse. Returns the per-call timeout. */
  spend(budget) {
    if (!budget) return this.timeoutMs;
    const now = (budget.now || Date.now)();
    if (budget.startedAt == null) budget.startedAt = now;
    const remaining = budget.deadlineMs - (now - budget.startedAt);
    if (remaining <= 0) throw new LlmError('Inference deadline reached (timed out)', { retryable: false });
    if ((budget.calls || 0) >= (budget.maxCalls ?? this.maxCalls)) throw new LlmError('Inference call limit reached for this inquiry', { retryable: false });
    budget.calls = (budget.calls || 0) + 1;
    return Math.max(50, Math.min(remaining, this.callTimeoutMs));
  }

  async chatOnce({ messages, tools, choice, maxTokens, budget = null }) {
    const body = {
      model: this.model, messages, temperature: 0.2, max_tokens: Math.min(maxTokens || this.maxTokens, this.maxTokensCap),
      tools: tools.map((t) => ({ type: 'function', function: t })), tool_choice: choice,
    };
    if (!this.dropped.has('chat_template_kwargs')) body.chat_template_kwargs = { enable_thinking: false };
    if (!this.dropped.has('reasoning_effort')) body.reasoning_effort = 'low';
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        const timeout = this.spend(budget);
        const data = await this.request('/chat/completions', body, 'POST', budget ? timeout : this.timeoutMs);
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
