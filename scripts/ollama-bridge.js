const OLLAMA_MODULE_ID = 'ollama-bridge';

/* ═══════════════════════════════════════════════════════════════════
   OLLAMA BRIDGE v1.1.0 — Native AI service for Foundry VTT
   Provides global API for any module/system to call Ollama (local
   or cloud) with configurable concurrency, batching, image
   generation, and error recovery.
   ═══════════════════════════════════════════════════════════════════ */

class OllamaBridge {
  /* ── request queue ── */
  static _queue = [];
  static _running = 0;

  /* ── global API registration ── */
  static registerAPI() {
    const mod = game.modules.get(OLLAMA_MODULE_ID);
    if (mod) mod.api = this;
    globalThis.OllamaBridge = this;
  }

  /* ── settings ── */
  static registerSettings() {
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaEnabled', {
      scope: 'world', config: true, type: Boolean, default: false,
      name: 'Ollama AI Enabled',
      hint: 'Master switch for the Ollama bridge.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaUrl', {
      scope: 'world', config: true, type: String, default: 'http://localhost:11434',
      name: 'Ollama URL',
      hint: 'Base URL of your Ollama instance. Use http://localhost:11434 for local, https://ollama.com for cloud, or http://localhost:3001 if running the companion proxy.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaModel', {
      scope: 'world', config: true, type: String, default: 'llama3',
      name: 'Default Model',
      hint: 'Model name to use when none is specified in the call.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaMaxConcurrent', {
      scope: 'world', config: true, type: Number, default: 3,
      name: 'Max Concurrent Requests',
      hint: 'How many requests to send in parallel. Ollama itself may queue extras.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaTemperature', {
      scope: 'world', config: true, type: Number, default: 0.7,
      name: 'Temperature',
      hint: 'Creativity randomness (0.0 = deterministic, 1.0 = creative).'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaSystemPrompt', {
      scope: 'world', config: true, type: String, default: 'You are a helpful AI assistant for a tabletop RPG. Be concise and creative.',
      name: 'System Prompt',
      hint: 'Default system prompt sent with every generation.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaTimeout', {
      scope: 'world', config: true, type: Number, default: 30000,
      name: 'Request Timeout (ms)',
      hint: 'Abort requests that take longer than this.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaApiKey', {
      scope: 'world', config: true, type: String, default: '',
      name: 'API Key (optional)',
      hint: 'Bearer token for ollama.com cloud API. Leave blank for local instances.'
    });
    game.settings.register(OLLAMA_MODULE_ID, 'ollamaImageModel', {
      scope: 'world', config: true, type: String, default: 'flux',
      name: 'Image Generation Model',
      hint: 'Model to use for AI image generation (e.g., flux, sd3.5-large-turbo, minicpm-v).'
    });
  }

  static get _config() {
    return {
      enabled:   game.settings.get(OLLAMA_MODULE_ID, 'ollamaEnabled'),
      url:       game.settings.get(OLLAMA_MODULE_ID, 'ollamaUrl').replace(/\/$/, '').replace(/\/api$/, ''),
      model:     game.settings.get(OLLAMA_MODULE_ID, 'ollamaModel'),
      maxConcurrent: Math.max(1, game.settings.get(OLLAMA_MODULE_ID, 'ollamaMaxConcurrent') || 3),
      temperature: game.settings.get(OLLAMA_MODULE_ID, 'ollamaTemperature'),
      system:    game.settings.get(OLLAMA_MODULE_ID, 'ollamaSystemPrompt'),
      timeout:   game.settings.get(OLLAMA_MODULE_ID, 'ollamaTimeout') || 30000,
      apiKey:    game.settings.get(OLLAMA_MODULE_ID, 'ollamaApiKey') || '',
      imageModel: game.settings.get(OLLAMA_MODULE_ID, 'ollamaImageModel') || 'flux'
    };
  }

  /* ── authenticated fetch wrapper (JSON response) ── */
  static async _makeRequest(endpoint, body, opts = {}) {
    return this._fetch(endpoint, body, { ...opts, parseJson: true });
  }

  /* ── authenticated fetch wrapper (raw response — for binary/image data) ── */
  static async _makeRequestRaw(endpoint, body, opts = {}) {
    return this._fetch(endpoint, body, { ...opts, parseJson: false });
  }

  /* ── core fetch logic ── */
  static async _fetch(endpoint, body, opts = {}) {
    const cfg = this._config;
    const headers = {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {})
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || cfg.timeout);

    try {
      const res = await fetch(`${cfg.url}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      clearTimeout(t);

      if (res.status === 401) throw new Error('Ollama authentication failed — check API key');
      if (res.status === 403) throw new Error('Ollama access denied — verify API key permissions');
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

      if (opts.parseJson) return await res.json();
      return res; // return raw Response for binary handlers
    } catch(e) {
      clearTimeout(t);
      throw e;
    }
  }

  static async _makeGetRequest(endpoint, opts = {}) {
    const cfg = this._config;
    const headers = {
      ...(cfg.apiKey ? { 'Authorization': `Bearer ${cfg.apiKey}` } : {})
    };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeout || cfg.timeout || 5000);
    try {
      const res = await fetch(`${cfg.url}${endpoint}`, { method: 'GET', headers, signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
      return await res.json();
    } catch(e) { clearTimeout(t); throw e; }
  }

  /* ── health check ── */
  static async ping() {
    const cfg = this._config;
    if (!cfg.enabled) return { ok: false, error: 'Ollama bridge is disabled in settings.' };
    try {
      const data = await this._makeGetRequest('/api/tags', { timeout: 5000 });
      const models = (data.models || []).map(m => m.name || m.model);
      return { ok: true, models };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ── single text generation (/api/generate) ── */
  static async generate(prompt, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const model = opts.model || cfg.model;
    const body = {
      model,
      prompt,
      stream: false,
      options: {
        temperature: opts.temperature ?? cfg.temperature
      }
    };
    if (opts.system !== undefined) body.system = opts.system;
    else if (cfg.system) body.system = cfg.system;
    if (opts.format) body.format = opts.format;
    if (opts.images) body.images = opts.images;

    const data = await this._makeRequest('/api/generate', body, opts);
    return data.response || '';
  }

  /* ── chat completion (/api/chat) ── */
  static async chat(messages, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const model = opts.model || cfg.model;
    const body = {
      model,
      messages,
      stream: false,
      options: {
        temperature: opts.temperature ?? cfg.temperature
      }
    };
    if (opts.format) body.format = opts.format;
    if (opts.images) body.images = opts.images;
    if (opts.tools) body.tools = opts.tools;

    const data = await this._makeRequest('/api/chat', body, opts);
    return data.message?.content || '';
  }

  /* ── embeddings (/api/embed) ── */
  static async embed(input, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const model = opts.embedModel || opts.model || cfg.model;
    const body = { model, input };

    const data = await this._makeRequest('/api/embed', body, opts);
    return data.embeddings || [];
  }

  /* ── batch generate (respects maxConcurrent) ── */
  static async generateBatch(prompts, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const max = opts.maxConcurrent || cfg.maxConcurrent;
    const results = [];
    for (let i = 0; i < prompts.length; i += max) {
      const batch = prompts.slice(i, i + max);
      const promises = batch.map(p =>
        this.generate(p, opts).catch(e => ({ _error: true, message: e.message }))
      );
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }
    return results;
  }

  /* ── batch chat (respects maxConcurrent) ── */
  static async chatBatch(conversations, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const max = opts.maxConcurrent || cfg.maxConcurrent;
    const results = [];
    for (let i = 0; i < conversations.length; i += max) {
      const batch = conversations.slice(i, i + max);
      const promises = batch.map(msgs =>
        this.chat(msgs, opts).catch(e => ({ _error: true, message: e.message }))
      );
      const batchResults = await Promise.all(promises);
      results.push(...batchResults);
    }
    return results;
  }

  /* ── image generation (/api/generate with image model) ── */
  static async generateImage(prompt, opts = {}) {
    const cfg = this._config;
    if (!cfg.enabled) throw new Error('Ollama bridge is disabled.');
    const model = opts.model || game.settings.get(OLLAMA_MODULE_ID, 'ollamaImageModel') || 'flux';

    const body = {
      model,
      prompt,
      stream: false,
      options: { temperature: opts.temperature ?? 0.7 }
    };

    const timeout = opts.timeout || 180000;

    // Try JSON response first (most common for Ollama image models)
    try {
      const json = await this._makeRequest('/api/generate', body, { timeout });
      if (json.image && typeof json.image === 'string') return json.image;
      if (json.images && Array.isArray(json.images) && json.images.length > 0) {
        const img = json.images[0];
        // Some models return base64 without prefix
        if (typeof img === 'string') {
          if (img.startsWith('data:image/')) return img;
          if (img.startsWith('/9j/')) return `data:image/jpeg;base64,${img}`;
          if (img.startsWith('iVBOR')) return `data:image/png;base64,${img}`;
          return `data:image/png;base64,${img}`;
        }
      }
      // Check text response for embedded base64 image
      const txt = json.response || '';
      if (txt.startsWith('data:image/') || txt.startsWith('/9j/') || txt.startsWith('iVBOR')) {
        if (txt.startsWith('data:image/')) return txt;
        if (txt.startsWith('/9j/')) return `data:image/jpeg;base64,${txt}`;
        return `data:image/png;base64,${txt}`;
      }

      // If JSON didn't contain image data, the model may send raw image bytes
      // Fall through to raw request
    } catch (e) {
      // For models that send raw image bytes, _makeRequest may fail to parse JSON
      // or the model simply doesn't return JSON — try raw
    }

    // Raw image response path (flux, etc. — they return image/png directly)
    try {
      const res = await this._makeRequestRaw('/api/generate', body, { timeout });
      const contentType = res.headers.get('Content-Type') || '';

      if (contentType.includes('image') || contentType.includes('octet-stream')) {
        const blob = await res.blob();
        return await OllamaBridge._blobToBase64(blob);
      }

      // If it returned JSON after all, try to parse it manually
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.image && typeof json.image === 'string') {
          if (json.image.startsWith('data:image/')) return json.image;
          const prefix = json.image.startsWith('/9j/') ? 'data:image/jpeg;base64,' : 'data:image/png;base64,';
          return prefix + json.image;
        }
        if (json.images && Array.isArray(json.images) && json.images.length > 0) {
          const img = json.images[0];
          if (img.startsWith('data:image/')) return img;
          const prefix = img.startsWith('/9j/') ? 'data:image/jpeg;base64,' : 'data:image/png;base64,';
          return prefix + img;
        }
      } catch { /* not JSON either */ }

      throw new Error(
        `Ollama image model "${model}" returned content-type "${contentType}" without valid image data. `
        + 'Check that the model is an image-generation model (e.g., flux, sd3.5-large-turbo). '
        + `Response preview: ${text.slice(0, 100)}`
      );
    } catch(e) {
      throw e;
    }
  }

  /* ── blob to base64 data URI ── */
  static _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  /* ── simple wrapper for NPC flavour ── */
  static async narrate(context, opts = {}) {
    const system = opts.system || 'You are a creative RPG narrator. Write vivid, concise prose. No OOC text.';
    return this.generate(context, { ...opts, system });
  }

  /* ── UI: quick prompt dialog ── */
  static async promptDialog() {
    const cfg = this._config;
    const health = await this.ping();
    const modelList = health.ok ? health.models.join(', ') : 'unreachable';

    const template = `
      <form>
        <div class="form-group"><label>Ollama Status</label><input type="text" value="${health.ok ? 'Online' : 'Offline: ' + health.error}" disabled></div>
        <div class="form-group"><label>Available Models</label><input type="text" value="${modelList}" disabled></div>
        <hr>
        <div class="form-group"><label>Prompt</label><textarea name="prompt" rows="4" placeholder="Ask the AI something..."></textarea></div>
        <div class="form-group"><label>Model</label><input type="text" name="model" value="${cfg.model}"></div>
        <div class="form-group"><label>Temperature</label><input type="number" name="temp" value="${cfg.temperature}" step="0.1" min="0" max="2"></div>
      </form>
    `;

    return new Promise((resolve) => {
      new Dialog({
        title: 'Ollama Bridge — Quick Prompt',
        content: template,
        buttons: {
          send: {
            icon: '<i class="fas fa-paper-plane"></i>',
            label: 'Send',
            callback: async (html) => {
              const form = html[0].querySelector('form');
              const prompt = form.prompt.value.trim();
              const model = form.model.value.trim();
              const temp = parseFloat(form.temp.value);
              if (!prompt) { ui.notifications.warn('Enter a prompt.'); resolve(null); return; }
              try {
                ui.notifications.info('Ollama is thinking…');
                const reply = await this.generate(prompt, { model, temperature: temp });
                await ChatMessage.create({
                  user: game.userId,
                  speaker: ChatMessage.getSpeaker({ alias: 'Ollama AI' }),
                  content: `<div class="ollama-reply" style="border-left:3px solid #8b5cf6;padding-left:8px;"><p><strong>Prompt:</strong> ${prompt}</p><hr><p>${reply.replace(/\n/g, '<br>')}</p></div>`
                });
                resolve(reply);
              } catch (e) {
                ui.notifications.error(`Ollama error: ${e.message}`);
                resolve(null);
              }
            }
          },
          cancel: { icon: '<i class="fas fa-times"></i>', label: 'Cancel', callback: () => resolve(null) }
        },
        default: 'send'
      }).render(true);
    });
  }
}

/* ── Hooks ── */
Hooks.on('init', () => {
  OllamaBridge.registerSettings();
});

Hooks.on('ready', () => {
  OllamaBridge.registerAPI();
  if (game.settings.get(OLLAMA_MODULE_ID, 'ollamaEnabled')) {
    console.log('%c[Ollama Bridge] Ready — call OllamaBridge.generate(prompt) or game.modules.get("ollama-bridge").api.generate(prompt)', 'color:#8b5cf6;font-weight:bold');
  }
});

/* ── Expose ── */
globalThis.OllamaBridge = OllamaBridge;
