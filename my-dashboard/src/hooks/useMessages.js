import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { groupAPI } from '../services/api';

export const GROUP_MESSAGES_KEY = (groupId) => ['messages', groupId];

const replaceMessageById = (rows = [], messageId, nextMessage) => {
  if (!Array.isArray(rows) || !rows.length || !messageId || !nextMessage) return rows;

  let replaced = false;
  const nextRows = rows.map((row) => {
    if (row?.id !== messageId) return row;
    replaced = true;
    return nextMessage;
  });

  return replaced ? nextRows : [...rows, nextMessage];
};

export function useSendGroupMessage(
  groupId,
  {
    onOptimisticMessage,
    onConfirmedMessage,
    onRollbackMessage,
    onSettled,
  } = {}
) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const messagesKey = GROUP_MESSAGES_KEY(groupId);

  return useMutation({
    mutationFn: async (payload) => {
      if (!groupId) {
        throw new Error('Missing group id for group message send.');
      }

      return groupAPI.sendMessage(groupId, payload);
    },
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: messagesKey });

      const previous = queryClient.getQueryData(messagesKey);
      const tempId = `temp-${Date.now()}`;
      const optimisticMessage = {
        id: tempId,
        groupId,
        senderId: user?.id ?? null,
        senderName: user?.name || 'You',
        message: payload?.message || '',
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
        createdAt: new Date().toISOString(),
        editedAt: null,
        isOptimistic: true,
      };

      queryClient.setQueryData(messagesKey, (old = []) => [...old, optimisticMessage]);
      onOptimisticMessage?.(optimisticMessage);

      return { previous, tempId };
    },
    onError: (error, payload, context) => {
      queryClient.setQueryData(messagesKey, context?.previous);
      onRollbackMessage?.({ error, payload, context });
    },
    onSuccess: (response, _payload, context) => {
      const confirmedMessage = response?.data;
      if (!confirmedMessage) return;

      queryClient.setQueryData(messagesKey, (old = []) =>
        replaceMessageById(old, context?.tempId, confirmedMessage)
      );

      onConfirmedMessage?.({
        tempId: context?.tempId,
        message: confirmedMessage,
      });
    },
    onSettled: async (...args) => {
      await queryClient.invalidateQueries({ queryKey: messagesKey });
      if (typeof onSettled === 'function') {
        await onSettled(...args);
      }
    },
  });
}
