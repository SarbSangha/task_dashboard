import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';

const normalizeOutboxResponse = (response) => {
  const tasks = Array.isArray(response?.data) ? response.data : [];
  return {
    ...response,
    tasks,
    count: response?.count ?? tasks.length,
    page: response?.page ?? 0,
    limit: response?.limit ?? 50,
    hasMore: Boolean(response?.hasMore),
  };
};

export const OUTBOX_KEY = (userId, params = {}) => ['outbox', userId ?? 'anonymous', params];

export function useOutbox(params = {}, options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 60 * 2,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: OUTBOX_KEY(user?.id, params),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async () => normalizeOutboxResponse(await taskAPI.getOutbox(params)),
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}
