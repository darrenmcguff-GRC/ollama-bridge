# Ollama Bridge for Foundry VTT

A standalone, general-purpose AI service module that connects Foundry VTT to any Ollama instance (local or cloud). Once enabled, **any module, system, or macro** can generate text, chat, embeddings, and batch requests through a shared global API with built-in concurrency control.

---

## Installation

### Manifest URL (Foundry → Add Module → Manifest URL)
```
https://raw.githubusercontent.com/darrenmcguff-GRC/ollama-bridge/main/module.json
```

### Requirements
- Foundry VTT v12+
- An Ollama instance reachable from your Foundry server or clients (local `http://localhost:11434`, cloud, or LAN)

---

## Setup

1. **Install** the module via manifest URL.
2. **Enable** it in Game Settings → Manage Modules.
3. Open **Configure Settings** → **Module Settings** → **Ollama Bridge**.
4. Set your **Ollama URL** (default `http://localhost:11434`).
5. Toggle **Ollama AI Enabled** to ON.
6. (Optional) Change default model, temperature, system prompt, concurrency, and timeout.

---

## API

All methods are available globally and via the module API:

```javascript
// Global
await OllamaBridge.generate("Describe a haunted forest.");
await OllamaBridge.chat([
  { role: 'system', content: 'You are a wise old sage.' },
  { role: 'user',   content: 'What is the meaning of life?' }
]);
await OllamaBridge.embed("ancient ruins");

// Via module (cleaner for dependency checking)
const api = game.modules.get('ollama-bridge')?.api;
if (api) {
  const reply = await api.generate("Roll initiative narration.");
}
```

### Methods

| Method | Purpose |
|--------|---------|
| `OllamaBridge.generate(prompt, opts)` | Single text generation via `/api/generate` |
| `OllamaBridge.chat(messages, opts)` | Chat completion via `/api/chat` |
| `OllamaBridge.embed(input, opts)` | Vector embedding via `/api/embeddings` |
| `OllamaBridge.generateBatch(prompts, opts)` | Batch generate with concurrency cap |
| `OllamaBridge.chatBatch(conversations, opts)` | Batch chat with concurrency cap |
| `OllamaBridge.narrate(context, opts)` | Flavour wrapper with RPG narrator system prompt |
| `OllamaBridge.promptDialog()` | GM dialog for quick prompts (posts to chat) |
| `OllamaBridge.ping()` | Health check returning `{ ok, models }` |

### Options

```javascript
await OllamaBridge.generate("Hello", {
  model: 'llama3.1',        // Override default model
  temperature: 0.9,           // Override default temperature
  system: 'You are a pirate.', // Override default system prompt
  timeout: 60000,            // Override default timeout (ms)
  format: 'json',            // Force JSON output
  images: ['base64...']      // Vision input (multimodal models)
});
```

### Batch processing

```javascript
const names = await OllamaBridge.generateBatch([
  "Name a goblin warlord.",
  "Name an orc shaman.",
  "Name a dragon.",
  "Name a necromancer.",
  "Name a rogue guild.",
], { maxConcurrent: 3 });
// Returns: ["Gruk the Crusher", "Zogthar", ...]
// Failed items return: { _error: true, message: '...' }
```

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Ollama AI Enabled | `false` | Master switch |
| Ollama URL | `http://localhost:11434` | Base URL |
| Default Model | `llama3` | Fallback model name |
| Max Concurrent Requests | `3` | Parallel request ceiling |
| Temperature | `0.7` | Creativity randomness |
| System Prompt | RPG assistant | Default persona |
| Request Timeout | `30000` | Abort slow calls (ms) |

---

## Ideas for module developers

| Use case | API |
|----------|-----|
| AI-generated NPC dialogue | `OllamaBridge.chat()` with personality prompts |
| Dynamic encounter descriptions | `OllamaBridge.narrate()` |
| Smart loot / item naming | `OllamaBridge.generate()` |
| Journal entry semantic search | `OllamaBridge.embed()` + cosine similarity |
| AI DM answering player questions | `OllamaBridge.chat()` |
| Ambient room descriptions | `OllamaBridge.narrate()` on scene change |

---

## License

MIT
