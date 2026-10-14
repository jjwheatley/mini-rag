# Mini-RAG
*Local Retrieval Augmented Generation for your Obsidian notes*

---

## What is Mini-RAG?
Mini-RAG lets you chat with a locally running LLM, in the context of selected Obsidian notes and folders. When you open a chat with a note or folder, Mini-RAG chunks the content into excerpts, generates vector embeddings for each chunk, and retrieves the most semantically relevant excerpts to include with each question.

It works with either of two local servers:
- **[Ollama](https://ollama.com)**
- **[llama.cpp](https://github.com/ggml-org/llama.cpp)** (its `llama-server`)

Everything runs on your machine, which is also why Mini-RAG is a desktop-only plugin.

## Setting Up Mini-RAG
Pick one server and set it up, then choose it under **Provider** in Mini-RAG's settings. You can switch at any time — each provider remembers its own URL and model choices.

### Ollama
1. [Download and install Ollama](https://ollama.com/download).
2. Pull a chat model, e.g. `ollama pull llama3.1`.
3. Optionally pull an embedding model for better retrieval, e.g. `ollama pull nomic-embed-text`.

Ollama runs on `http://localhost:11434` by default.

### llama.cpp
1. [Build or download llama.cpp](https://github.com/ggml-org/llama.cpp).
2. Start the server with a chat model. `-hf` downloads it from Hugging Face the first time; `-m your-model.gguf` runs a file you already have:

```
llama-server -hf bartowski/Qwen2.5-3B-Instruct-GGUF:Q4_K_M -ngl 99 -c 8192 --port 8080
```

`llama-server` serves exactly one model per process, and answers with that model whatever a request asks for. So Mini-RAG uses the models your servers are actually running: the **Chat Model** follows the chat server, and if the embedding model you pick isn't the one the embedding server is running, the settings say which one is in use and how to restart the server with yours. To use a different chat model, restart `llama-server` with it; the settings panel shows the command. To use a **dedicated embedding model**, start a second server with embeddings enabled and point **Embedding server URL** at it:

```
llama-server -hf nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0 --embeddings --port 8081
```

### Configure Mini-RAG
Open "options" by clicking on the gear icon then navigate to `Community Plugins > Mini-RAG > Options`.

The settings are laid out as three steps.

#### 1. Choose a provider
- **Provider**: Which local server Mini-RAG talks to.

#### 2. Connect to your provider
Named after the provider you chose, with a status beside it: **✓ Connected** once the server answers, or **Not connected**. These settings are remembered separately for each provider, so you can try another and come back without losing anything.
- **Server URL** (named for the provider, e.g. "llama.cpp URL"): If left unset, the provider's default is used. The model list refreshes automatically when you change this.
- **Chat Model**: The models your server reports. Use the refresh button to reload the list.
- **Use a dedicated embedding model**: Use a separate model to generate embeddings instead of the chat model. Recommended for higher retrieval quality. How you choose it depends on the provider:
  - *Ollama* — a list of well-known embedding models, split into installed and not installed. For one that isn't installed, the settings panel shows the `ollama pull <model>` command.
  - *llama.cpp* — the same well-known embedding models as Ollama, as Hugging Face GGUF builds, split into running and not running on your embedding server (plus whatever else it is running). For one that isn't running, the settings panel shows the `llama-server -hf <model> --embeddings --port 8081` command.
- **Embedding server URL** *(llama.cpp only, shown when the dedicated model is on)*: The second `llama-server`, running your embedding model (`http://localhost:8081` by default). The embedding model list comes from this server.

#### 3. Tune your chats
These are shared by every provider, and the defaults work well to start with.
- **Temperature**: Higher temperatures give more creative responses; lower values give more focused and consistent ones.
- **Retrieved chunks (top-K)**: How many note excerpts are included with each question (1–10). Higher values give the model more context but increase prompt size.
- **Enable context-free chats**: Provides the option to chat with an LLM without the context of a note or folder.
- **Cache embeddings on disk**: When enabled, note embeddings are saved so that re-opening a note or folder is near-instant instead of re-computing every time. See [Embedding cache](#embedding-cache) for what is stored and the privacy trade-off. Off by default.

If your chat model can't generate embeddings and no dedicated embedding model is set, Mini-RAG still works: it includes as much of the note or folder as fits the model's context with each question, instead of retrieving excerpts, and says if any notes were left out.


## Using Mini-RAG
### Opening a Mini-RAG Chat
You can open a chat from the right-click context menu, or via the Command Palette (`Ctrl/Cmd+P` → "Mini-RAG: Open chat panel"). You will see the Mini-RAG menu option when you:
- Right-Click within a note
- Right-Click a note in the sidebar
- Right-Click a folder in the sidebar
- Open a note's triple-dot menu

### Conversations
Follow-up questions remember the earlier turns of the chat. For each question, Mini-RAG retrieves fresh excerpts from your notes and sends them alongside it, so the excerpts always match what you're asking about. In a very long chat, the oldest turns are dropped first to keep within the model's context.

### The model's context window
Every request is sized to fit the chat model's context window, so nothing is silently cut off by the server. Mini-RAG asks the server how big the window is:
- **llama.cpp** reports the context size it was started with (`-c`).
- **Ollama** doesn't report it, so Mini-RAG assumes Ollama's default of 4,096 tokens. If you have raised Ollama's context size (for example with `OLLAMA_CONTEXT_LENGTH`), Mini-RAG still sizes requests for 4,096 tokens.

When notes have to be left out of a request, a short line in the chat says so, and says when the window was assumed.

Switching model (from the chevron beside the model name) or provider starts a fresh conversation.

### Responses
Responses stream in token-by-token as the model generates them. This is by design, to give a more responsive feel to the behaviour.

### Copying Messages
Click any chat bubble (yours or the model's) to copy its text to the clipboard.

### Saving Conversations
To save a Mini-RAG conversation, click the **Save** (disk) icon. If you continue the conversation after saving, click Save again to update the file.

To save under a custom name, click the **chevron** (▾) next to the Save button and choose **Save as…**

### Summarizing
When a chat has context (opened from a file or folder), a **Summarize** (sparkles) button appears. Click it to ask the model to summarize the context.

A note or folder that fits the model's context is summarized in one go. A larger one is summarized in stages: Mini-RAG summarizes it part by part, then combines the parts into one summary, so every note is covered. A line in the chat counts the parts as it goes ("Summarizing part 3 of 16…"), and the Summarize button becomes **Stop** while it runs. Larger folders take longer — each part is a separate request to the model.

The conversation remembers the summary, so you can ask follow-up questions about it.

---

## Embedding cache

Generating embeddings for a large folder can take a while. With **Cache embeddings on disk** enabled, Mini-RAG stores the results so that the next time you open the same note or folder, unchanged notes are loaded instantly and only new or edited notes are re-embedded.

The cache is stored per folder under `.obsidian/plugins/mini-rag/cache/`, mirroring your vault's folder structure. Each note's entry is keyed by a hash of its content, the chunking version, the provider, the embedding model, and the embedding server's address — so editing a note, or switching embedding model or provider, automatically re-embeds only what changed. Entries for deleted notes are cleaned up automatically.

If the embedding model behind a server changes without its name changing (for example, `llama-server` restarted on a different model on the same port), Mini-RAG notices that the embeddings no longer match, clears the cache, and asks you to rebuild.

**What the cache contains:** the cache files store your note **text** and its **embedding vectors** in plain (unencrypted) JSON. Embedding vectors are not anonymous — much of the original text can be reconstructed from them — so treat the cache as being as sensitive as the notes themselves.

**Keeping the cache private:**
- **Git** — Mini-RAG writes a `.gitignore` into the cache folder automatically, so the cache is never committed if your vault is a git repository.
- **Obsidian Sync / iCloud / Dropbox / etc.** — there is no per-file exclusion for the cache. If you sync the `.obsidian` configuration folder (including installed community plugins), the cache will sync with it. If your vault syncs to a location where you would not want note content copied, leave this setting **off** (the default).

## Upgrading from 2.2
Your settings are migrated automatically: your existing Ollama URL and models carry over, and Ollama stays selected. The embedding cache uses a new format, so it is rebuilt once the first time you open each note or folder.

## Privacy & Permissions

### Network Usage
Mini-RAG communicates only with the local server you configure (by default `http://localhost:11434` for Ollama, or `http://localhost:8080` for llama.cpp). No data is sent to any external server.

### Clipboard Access
Mini-RAG writes to the clipboard when you click a **Copy** button (e.g. to copy a chat message, or to copy a setup command such as `ollama pull` from the settings panel). It never reads clipboard content.

---

## Author
For more about the author visit [JJWheatley.com](https://www.jjwheatley.com/)
