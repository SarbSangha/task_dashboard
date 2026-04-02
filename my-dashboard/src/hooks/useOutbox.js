import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { draftAPI, taskAPI } from '../services/api';

export const normalizeOutboxResponse = (response) => {
  const tasks = Array.isArray(response?.data) ? response.data : [];
  return {
    ...response,
    tasks,
    count: response?.count ?? tasks.length,
    page: response?.page ?? 0,
    limit: response?.limit ?? 50,
    hasMore: Boolean(response?.hasMore),
    user: response?.user ?? null,
  };
};

export const OUTBOX_KEY = (userId, params = {}) => ['outbox', userId ?? 'anonymous', params];
export const DRAFTS_KEY = (userId) => ['drafts', userId ?? 'anonymous'];

export function useOutbox(params = {}, options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 60,
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

export function useDrafts(options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 60 * 5,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: DRAFTS_KEY(user?.id),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async () => {
      const response = await draftAPI.getDrafts();
      return Array.isArray(response?.data) ? response.data : [];
    },
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}
