import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';

const normalizeInboxResponse = (response) => {
  const tasks = Array.isArray(response?.data) ? response.data : [];
  return {
    ...response,
    tasks,
    count: response?.count ?? tasks.length,
    unreadCount:
      typeof response?.unreadCount === 'number'
        ? response.unreadCount
        : tasks.filter((task) => !(task?.isRead ?? task?.is_read ?? false)).length,
    page: response?.page ?? 0,
    limit: response?.limit ?? 50,
    hasMore: Boolean(response?.hasMore),
  };
};

export const INBOX_KEY = (userId, params = {}) => ['inbox', userId ?? 'anonymous', params];

export function useInbox(params = {}, options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 60,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: INBOX_KEY(user?.id, params),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async () => normalizeInboxResponse(await taskAPI.getInbox(params)),
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}

export function useMarkTaskSeen(params = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (taskId) => taskAPI.markSeen(taskId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox', user?.id ?? 'anonymous'] });
      queryClient.invalidateQueries({ queryKey: ['tracking', user?.id ?? 'anonymous'] });
      queryClient.invalidateQueries({ queryKey: INBOX_KEY(user?.id, params) });
    },
  });
}
