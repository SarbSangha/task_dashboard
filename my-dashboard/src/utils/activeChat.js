// The conversation currently open in the Messages panel, so background alerts
// can stay quiet for a message the user is already looking at.
let activeChat = null;

export const setActiveChat = (scope, threadId) => {
  activeChat = scope && threadId ? { scope, threadId: Number(threadId) } : null;
};

export const clearActiveChat = () => {
  activeChat = null;
};

export const isViewingChat = (scope, threadId) =>
  typeof document !== 'undefined'
  && document.visibilityState === 'visible'
  && document.hasFocus()
  && !!activeChat
  && activeChat.scope === scope
  && activeChat.threadId === Number(threadId);
