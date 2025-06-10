export const APP_NAME = 'Mini-RAG'

export const VIEW_TYPE = APP_NAME.toLowerCase()+'-chat-window';

export const ICON_NAME =  "brain"

export const FOLDER_NAME = APP_NAME + " Chats"

export const CONTEXT_TEMPLATE = "The following text may be referred to as a 'file', 'markdown file', 'text', 'document', etc. For this chat, you will use the text as context. \n\n The Text: "

export const OLLAMA_API = {
	tags: "/api/tags",
	generate: "/api/generate",
}
