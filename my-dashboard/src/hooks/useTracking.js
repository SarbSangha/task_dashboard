import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';

export const TRACKING_KEY = (userId, filters = {}) => ['tracking', userId ?? 'anonymous', filters];

const normalizeTrackingResponse = (response) => {
  const tasks = (Array.isArray(response?.tasks) ? response.tasks : []).filter(
    (task) => `${task?.status || ''}`.toLowerCase() !== 'draft'
  );
  return {
    ...response,
    tasks,
    count: response?.count ?? tasks.length,
    page: response?.page ?? 0,
    limit: response?.limit ?? 50,
    hasMore: Boolean(response?.hasMore),
  };
};

export function useTracking(filters = {}, options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 60,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: TRACKING_KEY(user?.id, filters),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async ({ signal }) => normalizeTrackingResponse(await taskAPI.getTracking(filters, { signal })),
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}
