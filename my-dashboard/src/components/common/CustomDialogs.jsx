import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import './CustomDialogs.css';

const DialogContext = createContext(null);

export const CustomDialogProvider = ({ children }) => {
  const [queue, setQueue] = useState([]);
  const [promptValue, setPromptValue] = useState('');

  const activeDialog = queue[0] || null;

  useEffect(() => {
    if (!activeDialog) {
      setPromptValue('');
      return;
    }
    if (activeDialog.type === 'prompt') {
      setPromptValue(activeDialog.defaultValue || '');
    } else {
      setPromptValue('');
    }
  }, [activeDialog]);

  const enqueueDialog = (dialog) =>
    new Promise((resolve) => {
      setQueue((prev) => [...prev, { ...dialog, resolve }]);
    });

  const resolveActiveDialog = (result) => {
    if (!activeDialog) return;
    activeDialog.resolve(result);
    setQueue((prev) => prev.slice(1));
  };

  const value = useMemo(
    () => ({
      showAlert: (message, options = {}) =>
        enqueueDialog({ type: 'alert', message, title: options.title }),
      showConfirm: (message, options = {}) =>
        enqueueDialog({
          type: 'confirm',
          message,
          title: options.title,
          confirmText: options.confirmText,
          cancelText: options.cancelText,
        }),
      showPrompt: (message, options = {}) =>
        enqueueDialog({
          type: 'prompt',
          message,
          title: options.title,
          defaultValue: options.defaultValue || '',
          placeholder: options.placeholder || '',
          multiline: !!options.multiline,
          rows: options.rows || 5,
          confirmText: options.confirmText,
          cancelText: options.cancelText,
        }),
    }),
    []
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      {activeDialog && (
        <div className="custom-dialog-overlay" onClick={() => resolveActiveDialog(null)}>
          <div className="custom-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="custom-dialog-title">{activeDialog.title || 'Message'}</div>
            <div className="custom-dialog-message">{activeDialog.message}</div>
            {activeDialog.type === 'prompt' && !activeDialog.multiline && (
              <input
                className="custom-dialog-input"
                type="text"
                value={promptValue}
                placeholder={activeDialog.placeholder}
                onChange={(event) => setPromptValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    resolveActiveDialog(promptValue);
                  }
                }}
                autoFocus
              />
            )}
            {activeDialog.type === 'prompt' && activeDialog.multiline && (
              <textarea
                className="custom-dialog-textarea"
                value={promptValue}
                placeholder={activeDialog.placeholder}
                rows={activeDialog.rows || 5}
                onChange={(event) => setPromptValue(event.target.value)}
                autoFocus
              />
            )}
            <div className="custom-dialog-actions">
              {activeDialog.type !== 'alert' && (
                <button
                  type="button"
                  className="custom-dialog-btn secondary"
                  onClick={() => resolveActiveDialog(null)}
                >
                  {activeDialog.cancelText || 'Cancel'}
                </button>
              )}
              <button
                type="button"
                className="custom-dialog-btn primary"
                onClick={() =>
                  resolveActiveDialog(activeDialog.type === 'prompt' ? promptValue : true)
                }
              >
                {activeDialog.confirmText || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
};

export const useCustomDialogs = () => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useCustomDialogs must be used within CustomDialogProvider');
  }
  return context;
};
