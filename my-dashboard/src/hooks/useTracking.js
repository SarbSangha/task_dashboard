import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';

const normalizeTrackingResponse = (response) => {
  const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
  return {
    ...response,
    tasks: tasks.filter((task) => task?.status !== 'draft'),
    count: response?.count ?? tasks.length,
    page: response?.page ?? 0,
    limit: response?.limit ?? 50,
    hasMore: Boolean(response?.hasMore),
  };
};

export const TRACKING_KEY = (userId, filters = {}) => ['tracking', userId ?? 'anonymous', filters];

export function useTracking(filters = {}, options = {}) {
  const { user } = useAuth();
  const {
    enabled = true,
    staleTime = 1000 * 30,
    ...queryOptions
  } = options;

  return useQuery({
    queryKey: TRACKING_KEY(user?.id, filters),
    enabled: Boolean(user?.id) && enabled,
    queryFn: async () => {
      const payload = { ...filters, user_id: user.id };
      return normalizeTrackingResponse(await taskAPI.getTracking(payload));
    },
    staleTime,
    placeholderData: (previousData) => previousData,
    ...queryOptions,
  });
}
