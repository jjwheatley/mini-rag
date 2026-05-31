# Mini-RAG
*Local Retrieval Augmented Generation for your Obsidian notes*

---

## What is Mini-RAG?
Mini-RAG lets you chat with a locally running LLM, in the context of selected Obsidian notes and folders. When you open a chat with a note or folder, Mini-RAG chunks the content into excerpts, generates vector embeddings for each chunk, and retrieves the most semantically relevant excerpts to include with each query. For the LLM, you can select any locally installed Ollama model (see: Configure Mini-RAG).

## Setting Up Mini-RAG
### Install Ollama
If you don't already have Ollama installed, you can download and install Ollama [here](https://ollama.com/download). 

This is necessary because Mini-RAG relies on a locally running instance of Ollama for its responses. This is the same reason that Mini-RAG is currently a desktop-only plugin.

### Configure Mini-RAG
Open "options" by clicking on the gear icon then navigate to `Community Plugins > Mini-RAG > Options`. Here you can set the:
- **Ollama URL**: If left unset, Ollama's default URL is used. The model list refreshes automatically when you change this.
- **Chat Model**: Dropdown list of models installed in your local Ollama setup. Use the refresh button to reload the list.
- **Temperature**: Higher temperatures give more creative responses; lower values give more focused and consistent ones.
- **Retrieved chunks (top-K)**: How many note excerpts are injected into each query (1–10). Higher values give the model more context but increase prompt size.
- **Enable context-free chats**: Provides the option to chat with an LLM without the context of a note or folder.
- **Use a dedicated embedding model**: When enabled, a separate Ollama model is used to generate embeddings instead of the chat model. Recommended if you want higher retrieval quality. If the selected embedding model is not yet installed, the settings panel shows the `ollama pull <model>` command to install it.


## Using Mini-RAG
### Opening a Mini-RAG Chat
You can open a chat from the right-click context menu, or via the Command Palette (`Ctrl/Cmd+P` → "Mini-RAG: Open chat panel"). You will see the Mini-RAG menu option when you:
- Right-Click within a note
- Right-Click a note in the sidebar
- Right-Click a folder in the sidebar
- Open a note's triple-dot menu

### Responses
Responses stream in token-by-token as the model generates them. This is by design, to give a more responsive feel to the behaviour.

### Copying Messages
Click any chat bubble (yours or the model's) to copy its text to the clipboard.

### Saving Conversations
To save a Mini-RAG conversation, click the **Save** (disk) icon. If you continue the conversation after saving, click Save again to update the file.

To save under a custom name, click the **chevron** (▾) next to the Save button and choose **Save as…**

### Summarizing
When a chat has context (opened from a file or folder), a **Summarize** (sparkles) button appears. Click it to ask the model to summarize the context file.

--- 

## Author
For more about the author visit [JJWheatley.com](https://www.jjwheatley.com/)
