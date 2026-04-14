import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';
import { INBOX_KEY } from './useInbox';
import { normalizeOutboxResponse, OUTBOX_KEY } from './useOutbox';

export const TRACKING_KEY = (userId, filters = {}) => ['tracking', userId ?? 'anonymous', filters];

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
  };
};

const dedupeTasks = (rows = []) =>
  Array.from(new Map(rows.map((task) => [task.id, task])).values());

export function useTracking(filters = {}, options = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const {
    enabled = true,
    staleTime = 1000 * 60,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: TRACKING_KEY(user?.id, filters),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async ({ signal }) => {
      const [inboxData, outboxData] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: INBOX_KEY(user?.id, {}),
          queryFn: async () => normalizeInboxResponse(await taskAPI.getInbox({}, { signal })),
          staleTime,
        }).catch(() => ({ tasks: [] })),
        queryClient.fetchQuery({
          queryKey: OUTBOX_KEY(user?.id, {}),
          queryFn: async () => normalizeOutboxResponse(await taskAPI.getOutbox({}, { signal })),
          staleTime,
        }).catch(() => ({ tasks: [] })),
      ]);

      const tasks = dedupeTasks([
        ...(Array.isArray(inboxData?.tasks) ? inboxData.tasks : []),
        ...(Array.isArray(outboxData?.tasks) ? outboxData.tasks : []),
      ]).filter((task) => task?.status !== 'draft');

      return {
        tasks,
        count: tasks.length,
      };
    },
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}
