import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';

const patchTaskRows = (rows = [], taskId, patch) => {
  if (!Array.isArray(rows) || !rows.length) return rows;

  let changed = false;
  const nextRows = rows.map((task) => {
    if (task?.id !== taskId) return task;
    changed = true;
    return {
      ...task,
      ...patch,
    };
  });

  return changed ? nextRows : rows;
};

const patchTaskCollection = (collection, taskId, patch) => {
  if (Array.isArray(collection)) {
    return patchTaskRows(collection, taskId, patch);
  }

  if (!collection || typeof collection !== 'object') {
    return collection;
  }

  let nextCollection = collection;
  let changed = false;

  if (Array.isArray(collection.tasks)) {
    const nextTasks = patchTaskRows(collection.tasks, taskId, patch);
    if (nextTasks !== collection.tasks) {
      nextCollection = nextCollection === collection ? { ...collection } : nextCollection;
      nextCollection.tasks = nextTasks;
      changed = true;
    }
  }

  if (Array.isArray(collection.data)) {
    const nextData = patchTaskRows(collection.data, taskId, patch);
    if (nextData !== collection.data) {
      nextCollection = nextCollection === collection ? { ...collection } : nextCollection;
      nextCollection.data = nextData;
      changed = true;
    }
  }

  return changed ? nextCollection : collection;
};

const restoreSnapshots = (queryClient, snapshots = []) => {
  snapshots.forEach(([queryKey, data]) => {
    queryClient.setQueryData(queryKey, data);
  });
};

export function useUpdateTaskStatus({
  onOptimisticUpdate,
  onRollback,
  onSettled,
} = {}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const userKey = user?.id ?? 'anonymous';
  const queryScopes = [
    ['inbox', userKey],
    ['outbox', userKey],
    ['tracking', userKey],
  ];

  return useMutation({
    mutationFn: async ({ execute }) => {
      if (typeof execute !== 'function') {
        throw new Error('Missing execute handler for task status update.');
      }

      return execute();
    },
    onMutate: async (variables) => {
      const { taskId, status } = variables;
      const optimisticPatch = {
        status,
        updatedAt: new Date().toISOString(),
      };

      await Promise.all(
        queryScopes.map((queryKey) => queryClient.cancelQueries({ queryKey }))
      );

      const previousQueries = queryScopes.flatMap((queryKey) =>
        queryClient.getQueriesData({ queryKey })
      );

      queryScopes.forEach((queryKey) => {
        queryClient.setQueriesData({ queryKey }, (current) =>
          patchTaskCollection(current, taskId, optimisticPatch)
        );
      });

      return {
        previousQueries,
        rollbackValue: onOptimisticUpdate?.(variables),
      };
    },
    onError: (_error, _variables, context) => {
      restoreSnapshots(queryClient, context?.previousQueries);
      if (typeof onRollback === 'function') {
        onRollback(context?.rollbackValue);
      }
    },
    onSettled: async (...args) => {
      await Promise.all(
        queryScopes.map((queryKey) => queryClient.invalidateQueries({ queryKey }))
      );

      if (typeof onSettled === 'function') {
        await onSettled(...args);
      }
    },
  });
}
