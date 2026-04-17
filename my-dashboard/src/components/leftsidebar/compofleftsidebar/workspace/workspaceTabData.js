import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { activityAPI, authAPI, isRequestCanceled, taskAPI } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import { INBOX_KEY, normalizeInboxResponse } from '../../../../hooks/useInbox';
import { normalizeOutboxResponse, OUTBOX_KEY } from '../../../../hooks/useOutbox';
import { resolvePermissionSnapshot } from '../../../../hooks/usePermissions';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  getTaskPanelCacheEntry,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import {
  formatDateTimeIndia as formatDateTimeIndiaShared,
} from '../../../../utils/dateTime';

const WORKSPACE_TASK_CACHE_TTL_MS = 90 * 1000;
const WORKSPACE_REFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;

export const ACTIVE_PROJECT_STATUSES = new Set([
  'pending',
  'forwarded',
  'assigned',
  'in_progress',
  'submitted',
  'under_review',
  'need_improvement',
  'approved',
]);

function mergeWorkspaceTasks(inboxTasks = [], outboxTasks = []) {
  return Array.from(
    new Map([...(inboxTasks || []), ...(outboxTasks || [])].map((task) => [task.id, task])).values()
  ).filter((task) => task.status !== 'draft');
}

export function formatProjectDate(value) {
  const formattedValue = formatDateTimeIndiaShared(value);
  return formattedValue === 'N/A' ? 'No recent activity' : formattedValue;
}

export function formatSeconds(seconds = 0) {
  const total = Number(seconds) || 0;
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hrs}h ${mins}m ${secs}s`;
}

export function formatDateTimeIndia(value) {
  return formatDateTimeIndiaShared(value);
}

export function useWorkspaceTaskDataset() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [tasks, setTasks] = useState([]);
  const [currentUser, setCurrentUser] = useState(user || null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });

  const cacheKeys = useMemo(() => {
    if (!user?.id) return null;
    return {
      inbox: buildTaskPanelCacheKey(user.id, 'inbox'),
      outbox: buildTaskPanelCacheKey(user.id, 'outbox'),
    };
  }, [user?.id]);

  const loadTasks = async ({ silent = false, signal } = {}) => {
    if (!cacheKeys || signal?.aborted) return;

    if (silent) setIsRefreshing(true);
    else setLoading(true);
    setError('');

    try {
      const [inboxRes, outboxRes] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: INBOX_KEY(user?.id, {}),
          queryFn: async () => normalizeInboxResponse(await taskAPI.getInbox({}, { signal })),
          staleTime: WORKSPACE_TASK_CACHE_TTL_MS,
        }).catch(() => ({ data: [], tasks: [] })),
        queryClient.fetchQuery({
          queryKey: OUTBOX_KEY(user?.id, {}),
          queryFn: async () => normalizeOutboxResponse(await taskAPI.getOutbox({}, { signal })),
          staleTime: WORKSPACE_TASK_CACHE_TTL_MS,
        }).catch(() => ({ data: [], tasks: [] })),
      ]);

      if (signal?.aborted) return;

      const inboxTasks = Array.isArray(inboxRes?.data) ? inboxRes.data : [];
      const outboxTasks = Array.isArray(outboxRes?.data) ? outboxRes.data : [];
      const mergedTasks = mergeWorkspaceTasks(inboxTasks, outboxTasks);

      setTasks(mergedTasks);
      setCurrentUser(user || null);
      setTaskPanelCache(cacheKeys.inbox, { tasks: inboxTasks });
      setTaskPanelCache(cacheKeys.outbox, { tasks: outboxTasks });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    } catch (loadError) {
      if (isRequestCanceled(loadError) || signal?.aborted) return;
      console.error('Failed to load workspace task dataset:', loadError);
      setError('Could not refresh workspace data right now.');
      if (!silent) {
        setTasks([]);
        setCurrentUser(user || null);
      }
    } finally {
      if (signal?.aborted) return;
      if (silent) setIsRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    if (!cacheKeys) return;

    const cachedInboxEntry = getTaskPanelCacheEntry(cacheKeys.inbox, WORKSPACE_TASK_CACHE_TTL_MS);
    const cachedOutboxEntry = getTaskPanelCacheEntry(cacheKeys.outbox, WORKSPACE_TASK_CACHE_TTL_MS);
    const cachedTasks = mergeWorkspaceTasks(cachedInboxEntry?.value?.tasks || [], cachedOutboxEntry?.value?.tasks || []);

    if (cachedTasks.length > 0) {
      setTasks(cachedTasks);
      setCurrentUser(user || null);
      setLoading(false);
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedInboxEntry?.cachedAt || cachedOutboxEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    const controller = new AbortController();
    void loadTasks({ silent: cachedTasks.length > 0, signal: controller.signal });

    return () => {
      controller.abort();
    };
  }, [cacheKeys, queryClient, user]);

  return {
    tasks,
    currentUser,
    loading,
    isRefreshing,
    error,
    cacheStatus,
    refresh: ({ silent = true } = {}) => loadTasks({ silent }),
  };
}

export function useWorkspaceTeamDirectory() {
  const { user } = useAuth();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [myDepartment, setMyDepartment] = useState('');
  const [isHodUser, setIsHodUser] = useState(false);
  const [activityByUser, setActivityByUser] = useState({});
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });

  const cacheKey = useMemo(
    () => (user?.id ? buildTaskPanelCacheKey(user.id, 'workspace_team_directory') : null),
    [user?.id]
  );

  const loadTeamDirectory = async ({ silent = false, signal } = {}) => {
    if (!cacheKey || signal?.aborted) return;

    if (silent) setIsRefreshing(true);
    else setLoading(true);

    try {
      const myDept = user?.department || '';
      const permissions = resolvePermissionSnapshot(user);
      const hod = permissions.roles.includes('hod');

      let users = [];
      if (myDept) {
        const deptUsersResponse = await authAPI.getUsersByDepartment(myDept, '', { signal }).catch(() => ({ users: [] }));
        users = (deptUsersResponse?.users || []).map((member) => ({
          id: member.id,
          name: member.name || `User ${member.id}`,
          department: member.department || myDept,
          position: member.position || 'Member',
        }));
      }

      let nextActivityByUser = {};
      if (hod) {
        try {
          const activityResponse = await activityAPI.department({ signal });
          const activityRows = activityResponse?.data || [];
          activityRows.forEach((row) => {
            nextActivityByUser[row.userId] = row;
          });
        } catch (activityError) {
          if (isRequestCanceled(activityError) || signal?.aborted) {
            return;
          }
          console.warn('Activity data unavailable for team:', activityError);
        }
      }

      if (signal?.aborted) return;

      setMembers(users);
      setMyDepartment(myDept);
      setIsHodUser(hod);
      setActivityByUser(nextActivityByUser);
      setTaskPanelCache(cacheKey, {
        members: users,
        myDepartment: myDept,
        isHodUser: hod,
        activityByUser: nextActivityByUser,
      });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    } catch (error) {
      if (isRequestCanceled(error) || signal?.aborted) return;
      console.error('Failed to load team data:', error);
      if (!silent) {
        setMembers([]);
        setMyDepartment('');
        setIsHodUser(false);
        setActivityByUser({});
      }
    } finally {
      if (signal?.aborted) return;
      if (silent) setIsRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    if (!cacheKey) return;

    const cachedEntry = getTaskPanelCacheEntry(cacheKey, WORKSPACE_REFERENCE_CACHE_TTL_MS);
    const cached = cachedEntry?.value || null;
    if (cached) {
      setMembers(cached.members || []);
      setMyDepartment(cached.myDepartment || '');
      setIsHodUser(!!cached.isHodUser);
      setActivityByUser(cached.activityByUser || {});
      setLoading(false);
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    const controller = new AbortController();
    void loadTeamDirectory({ silent: !!cached, signal: controller.signal });

    return () => {
      controller.abort();
    };
  }, [cacheKey]);

  return {
    members,
    loading,
    isRefreshing,
    myDepartment,
    isHodUser,
    activityByUser,
    cacheStatus,
  };
}

export function useWorkspaceCompanyDirectory() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canViewCompany, setCanViewCompany] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [selectedDepartment, setSelectedDepartment] = useState('');
  const [members, setMembers] = useState([]);
  const [membersByDepartment, setMembersByDepartment] = useState({});
  const [activityByUser, setActivityByUser] = useState({});
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });

  const cacheKey = useMemo(
    () => (user?.id ? buildTaskPanelCacheKey(user.id, 'workspace_company_directory') : null),
    [user?.id]
  );

  const persistCompanyCache = (nextState) => {
    if (!cacheKey) return;
    setTaskPanelCache(cacheKey, nextState);
  };

  const loadDepartmentMembers = async (departmentName, { cacheSnapshot = null, signal } = {}) => {
    if (!departmentName) {
      setMembers([]);
      return [];
    }

    if (cacheSnapshot?.membersByDepartment?.[departmentName]) {
      setMembers(cacheSnapshot.membersByDepartment[departmentName]);
    }

    const response = await authAPI.getUsersByDepartment(departmentName, '', { signal }).catch((error) => {
      if (isRequestCanceled(error) || signal?.aborted) {
        return { __canceled: true };
      }
      return { users: [] };
    });
    if (response?.__canceled || signal?.aborted) return [];
    const departmentMembers = response?.users || [];
    setMembers(departmentMembers);
    setMembersByDepartment((prev) => ({
      ...prev,
      [departmentName]: departmentMembers,
    }));
    return departmentMembers;
  };

  const loadCompanyDirectory = async ({ silent = false, signal } = {}) => {
    if (!cacheKey || signal?.aborted) return;

    if (silent) setIsRefreshing(true);
    else setLoading(true);

    try {
      const permissions = resolvePermissionSnapshot(user);
      const adminAccess = permissions.isAdmin;
      const companyAccess = permissions.can('view_company_members');
      setIsAdmin(adminAccess);
      setCanViewCompany(!!companyAccess);

      if (!companyAccess) {
        setDepartments([]);
        setSelectedDepartment('');
        setMembers([]);
        setMembersByDepartment({});
        setActivityByUser({});
        persistCompanyCache({
          isAdmin: false,
          canViewCompany: false,
          departments: [],
          selectedDepartment: '',
          members: [],
          membersByDepartment: {},
          activityByUser: {},
        });
        return;
      }

      const [deptRes, activityRes] = await Promise.all([
        authAPI.getDepartments({ signal }).catch(() => ({ departments: [] })),
        activityAPI.allUsers({ signal }).catch(() => ({ data: [] })),
      ]);

      if (signal?.aborted) return;

      const deptList = deptRes?.departments || [];
      const activityMap = {};
      (activityRes?.data || []).forEach((row) => {
        activityMap[row.userId] = row;
      });

      setDepartments(deptList);
      setActivityByUser(activityMap);

      const nextSelectedDepartment = selectedDepartment && deptList.includes(selectedDepartment)
        ? selectedDepartment
        : (deptList[0] || '');

      setSelectedDepartment(nextSelectedDepartment);
      const cachedSnapshot = getTaskPanelCache(cacheKey, WORKSPACE_REFERENCE_CACHE_TTL_MS);
      const departmentMembers = await loadDepartmentMembers(nextSelectedDepartment, {
        cacheSnapshot: cachedSnapshot,
        signal,
      });
      if (signal?.aborted) return;
      const mergedMembersByDepartment = {
        ...(cachedSnapshot?.membersByDepartment || {}),
        ...(nextSelectedDepartment ? { [nextSelectedDepartment]: departmentMembers } : {}),
      };

      persistCompanyCache({
        isAdmin: !!adminAccess,
        canViewCompany: true,
        departments: deptList,
        selectedDepartment: nextSelectedDepartment,
        members: departmentMembers,
        membersByDepartment: mergedMembersByDepartment,
        activityByUser: activityMap,
      });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
    } catch (error) {
      if (isRequestCanceled(error) || signal?.aborted) return;
      console.error('Failed to load company view data:', error);
      if (!silent) {
        setDepartments([]);
        setSelectedDepartment('');
        setMembers([]);
        setMembersByDepartment({});
        setActivityByUser({});
      }
    } finally {
      if (signal?.aborted) return;
      if (silent) setIsRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    if (!cacheKey) return;

    const cachedEntry = getTaskPanelCacheEntry(cacheKey, WORKSPACE_REFERENCE_CACHE_TTL_MS);
    const cached = cachedEntry?.value || null;
    if (cached) {
      setIsAdmin(!!cached.isAdmin);
      setCanViewCompany(
        Object.prototype.hasOwnProperty.call(cached, 'canViewCompany')
          ? !!cached.canViewCompany
          : !!cached.isAdmin
      );
      setDepartments(cached.departments || []);
      setSelectedDepartment(cached.selectedDepartment || '');
      setMembers(cached.members || []);
      setMembersByDepartment(cached.membersByDepartment || {});
      setActivityByUser(cached.activityByUser || {});
      setLoading(false);
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    const controller = new AbortController();
    void loadCompanyDirectory({ silent: !!cached, signal: controller.signal });

    return () => {
      controller.abort();
    };
  }, [cacheKey]);

  const selectDepartment = async (departmentName) => {
    setSelectedDepartment(departmentName);
    const cachedSnapshot = getTaskPanelCache(cacheKey, WORKSPACE_REFERENCE_CACHE_TTL_MS);
    if (cachedSnapshot?.membersByDepartment?.[departmentName]) {
      setMembers(cachedSnapshot.membersByDepartment[departmentName]);
      setIsRefreshing(true);
      try {
        const departmentMembers = await loadDepartmentMembers(departmentName, { cacheSnapshot: cachedSnapshot });
        persistCompanyCache({
          ...(cachedSnapshot || {}),
          isAdmin,
          canViewCompany,
          departments,
          selectedDepartment: departmentName,
          members: departmentMembers,
          membersByDepartment: {
            ...(cachedSnapshot?.membersByDepartment || {}),
            [departmentName]: departmentMembers,
          },
          activityByUser,
        });
      } finally {
        setIsRefreshing(false);
      }
      return;
    }

    setLoading(true);
    try {
      const departmentMembers = await loadDepartmentMembers(departmentName, { cacheSnapshot: cachedSnapshot });
      persistCompanyCache({
        ...(cachedSnapshot || {}),
        isAdmin,
        canViewCompany,
        departments,
        selectedDepartment: departmentName,
        members: departmentMembers,
        membersByDepartment: {
          ...(cachedSnapshot?.membersByDepartment || {}),
          [departmentName]: departmentMembers,
        },
        activityByUser,
      });
    } finally {
      setLoading(false);
    }
  };

  return {
    loading,
    isRefreshing,
    isAdmin,
    canViewCompany,
    departments,
    selectedDepartment,
    members,
    activityByUser,
    cacheStatus,
    selectDepartment,
  };
}

export function buildProjectSummaries(tasks = []) {
  const groups = new Map();

  tasks.forEach((task) => {
    const projectId = (task.projectId || '').trim();
    const projectName = (task.projectName || '').trim();
    if (!projectId && !projectName) return;

    const key = projectId ? `id:${projectId.toLowerCase()}` : `name:${projectName.toLowerCase()}`;
    const existing = groups.get(key) || {
      key,
      name: projectName || projectId,
      projectId,
      customerName: '',
      latestActivityAt: '',
      tasks: [],
      departments: new Set(),
      assignees: new Set(),
    };

    existing.name = existing.name || projectName || projectId;
    existing.projectId = existing.projectId || projectId;
    existing.customerName = existing.customerName || (task.customerName || '').trim();

    if (task.fromDepartment) existing.departments.add(task.fromDepartment);
    if (task.toDepartment) existing.departments.add(task.toDepartment);
    (task.assignedTo || []).forEach((member) => {
      existing.assignees.add(member.id || member.name || `${task.id}-assignee`);
    });

    const activityAt = task.updatedAt || task.createdAt || '';
    if (!existing.latestActivityAt || new Date(activityAt).getTime() > new Date(existing.latestActivityAt).getTime()) {
      existing.latestActivityAt = activityAt;
    }

    existing.tasks.push(task);
    groups.set(key, existing);
  });

  return Array.from(groups.values())
    .map((project) => {
      const projectTasks = [...project.tasks].sort(
        (a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
      const totalTasks = projectTasks.length;
      const completedTasks = projectTasks.filter((task) => (task.status || '').toLowerCase() === 'completed').length;
      const activeTasks = projectTasks.filter((task) => ACTIVE_PROJECT_STATUSES.has((task.status || '').toLowerCase())).length;
      const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      return {
        ...project,
        tasks: projectTasks,
        totalTasks,
        completedTasks,
        activeTasks,
        progress,
        statusClass: totalTasks > 0 && completedTasks === totalTasks ? 'completed' : 'active',
        statusLabel: totalTasks > 0 && completedTasks === totalTasks ? 'Completed' : 'Active',
        description:
          project.customerName ||
          `${totalTasks} task${totalTasks === 1 ? '' : 's'} across ${Math.max(project.departments.size, 1)} department${project.departments.size === 1 ? '' : 's'}`,
        departments: Array.from(project.departments).sort(),
        assigneeCount: project.assignees.size,
      };
    })
    .sort((a, b) => new Date(b.latestActivityAt || 0).getTime() - new Date(a.latestActivityAt || 0).getTime());
}

const ANALYTICS_FILTERS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'yesterday', label: 'Yesterday', days: 1 },
  { key: 'weekly', label: 'Weekly', days: 7 },
  { key: 'monthly', label: 'Monthly', days: 30 },
];

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function getAnalyticsRange(filterKey) {
  const todayStart = startOfDay(new Date());
  const config = ANALYTICS_FILTERS.find((item) => item.key === filterKey) || ANALYTICS_FILTERS[0];

  if (filterKey === 'yesterday') {
    const start = addDays(todayStart, -1);
    const end = todayStart;
    return {
      start,
      end,
      previousStart: addDays(start, -1),
      previousEnd: start,
      label: 'Yesterday',
    };
  }

  const start = filterKey === 'today' ? todayStart : addDays(todayStart, -(config.days - 1));
  const end = addDays(todayStart, 1);
  const previousStart = addDays(start, -config.days);
  const previousEnd = start;

  return {
    start,
    end,
    previousStart,
    previousEnd,
    label: config.label,
  };
}

function parseTaskDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getTaskRangeAnchor(task) {
  return parseTaskDate(task.completedAt || task.updatedAt || task.createdAt);
}

function getTasksForRange(tasks, start, end) {
  return tasks.filter((task) => {
    const anchor = getTaskRangeAnchor(task);
    return anchor && anchor >= start && anchor < end;
  });
}

function computeCompletionRate(tasks) {
  if (!tasks.length) return 0;
  const completed = tasks.filter((task) => (task.status || '').toLowerCase() === 'completed').length;
  return Math.round((completed / tasks.length) * 100);
}

function computeAverageDurationDays(tasks) {
  const durations = tasks
    .map((task) => {
      const start = parseTaskDate(task.createdAt);
      const end = parseTaskDate(task.completedAt || task.updatedAt || task.createdAt);
      if (!start || !end || end < start) return null;
      return (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    })
    .filter((value) => value !== null);

  if (!durations.length) return 0;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Number((total / durations.length).toFixed(1));
}

function computeProductivityScore(tasks, activityRow, filterKey) {
  if (filterKey === 'today' && activityRow?.totalSessionDuration) {
    const activeTime = Number(activityRow.activeTime || 0);
    const totalTime = Number(activityRow.totalSessionDuration || 0);
    if (totalTime > 0) {
      return Math.round((activeTime / totalTime) * 100);
    }
  }

  if (!tasks.length) return 0;

  const weightedScore = tasks.reduce((sum, task) => {
    const status = (task.status || '').toLowerCase();
    if (status === 'completed') return sum + 1;
    if (['approved', 'submitted', 'under_review'].includes(status)) return sum + 0.8;
    if (['in_progress', 'need_improvement'].includes(status)) return sum + 0.55;
    if (['assigned', 'forwarded', 'pending'].includes(status)) return sum + 0.3;
    return sum + 0.15;
  }, 0);

  return Math.round((weightedScore / tasks.length) * 100);
}

function buildTrend(currentValue, previousValue, invert = false) {
  const delta = Number((currentValue - previousValue).toFixed(1));
  const effectiveDelta = invert ? -delta : delta;
  const direction = effectiveDelta >= 0 ? 'positive' : 'negative';
  return {
    delta,
    direction,
  };
}

export function useWorkspaceAnalytics(filterKey) {
  const { tasks, loading: tasksLoading, isRefreshing, error: taskError, cacheStatus } = useWorkspaceTaskDataset();
  const [loading, setLoading] = useState(true);
  const [analyticsData, setAnalyticsData] = useState({
    completionRate: 0,
    averageTaskDuration: 0,
    productivityScore: 0,
    totalTasks: 0,
    completedTasks: 0,
    activeTasks: 0,
    comparisonLabel: 'previous period',
    completionTrend: { delta: 0, direction: 'positive' },
    durationTrend: { delta: 0, direction: 'positive' },
    productivityTrend: { delta: 0, direction: 'positive' },
  });
  const [error, setError] = useState('');

  const comparisonLabelMap = {
    today: 'yesterday',
    yesterday: 'the previous day',
    weekly: 'the previous week',
    monthly: 'the previous month',
  };

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    const loadAnalytics = async () => {
      setLoading(true);
      setError('');
      try {
        const activityRes = await activityAPI.myActivity({ signal: controller.signal }).catch((error) => {
          if (isRequestCanceled(error)) {
            return { __canceled: true };
          }
          return { data: null };
        });
        if (activityRes?.__canceled) return;
        const range = getAnalyticsRange(filterKey);
        const currentTasks = getTasksForRange(tasks, range.start, range.end);
        const previousTasks = getTasksForRange(tasks, range.previousStart, range.previousEnd);

        const completionRate = computeCompletionRate(currentTasks);
        const previousCompletionRate = computeCompletionRate(previousTasks);
        const averageTaskDuration = computeAverageDurationDays(currentTasks);
        const previousAverageDuration = computeAverageDurationDays(previousTasks);
        const productivityScore = computeProductivityScore(currentTasks, activityRes?.data, filterKey);
        const previousProductivityScore = computeProductivityScore(previousTasks, null, filterKey);

        const completedTasks = currentTasks.filter((task) => (task.status || '').toLowerCase() === 'completed').length;
        const activeTasks = currentTasks.filter((task) =>
          ACTIVE_PROJECT_STATUSES.has((task.status || '').toLowerCase())
        ).length;

        if (!mounted) return;

        setAnalyticsData({
          completionRate,
          averageTaskDuration,
          productivityScore,
          totalTasks: currentTasks.length,
          completedTasks,
          activeTasks,
          comparisonLabel: comparisonLabelMap[filterKey] || 'the previous period',
          completionTrend: buildTrend(completionRate, previousCompletionRate),
          durationTrend: buildTrend(averageTaskDuration, previousAverageDuration, true),
          productivityTrend: buildTrend(productivityScore, previousProductivityScore),
        });
      } catch (loadError) {
        if (isRequestCanceled(loadError)) return;
        console.error('Failed to load analytics:', loadError);
        if (mounted) {
          setError('Could not load analytics right now.');
        }
      } finally {
        if (mounted && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void loadAnalytics();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [filterKey, tasks]);

  return {
    loading,
    tasksLoading,
    isRefreshing,
    taskError,
    cacheStatus,
    analyticsData,
    error,
    activeFilter: ANALYTICS_FILTERS.find((filter) => filter.key === filterKey) || ANALYTICS_FILTERS[0],
    filters: ANALYTICS_FILTERS,
  };
}

export function formatTrendText(trend, suffix, comparisonLabel) {
  const absDelta = Math.abs(trend.delta);
  const arrow = trend.direction === 'positive' ? '↑' : '↓';
  return `${arrow} ${absDelta}${suffix} from ${comparisonLabel}`;
}
