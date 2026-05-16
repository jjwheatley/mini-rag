export const APP_NAME = 'Mini-RAG';

export const VIEW_TYPE = APP_NAME.toLowerCase()+'-chat-window';

export const ICON_NAME = "brain";

export const FOLDER_NAME = APP_NAME + " Chats";

export const OLLAMA_API = {
	tags: "/api/tags",
	generate: "/api/generate",
	embed: "/api/embed",
	ps: "/api/ps",
} as const;

export const RAG_CONTEXT_TEMPLATE = "Use the following excerpts from the user's notes as context. Only use information from these excerpts if it is relevant to the question.\n\n---\n\n"

export const CSS_CLASS_PREFIX = "mini-rag-"
