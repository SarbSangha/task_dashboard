import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { activityAPI } from '../services/api';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const HEARTBEAT_MIN_GAP_MS = 25 * 1000;
const THROTTLE_MS = 5 * 1000;
const HEARTBEAT_LEADER_KEY = 'rmw_activity_heartbeat_leader_v1';
const HEARTBEAT_LEADER_TTL_MS = 45 * 1000;
const ACTIVITY_AUTH_BLOCK_KEY = 'rmw_activity_auth_block_until_v1';
const ACTIVITY_AUTH_BLOCK_MS = 60 * 1000;
const START_SESSION_DELAY_MS = 2500;

const STATUS = {
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
  AWAY: 'AWAY',
  OFFLINE: 'OFFLINE',
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function useActivityTracker({ enabled, onAuthFailure }) {
  const [status, setStatus] = useState(STATUS.ACTIVE);
  const [loginTime, setLoginTime] = useState(null);
  const [activeTime, setActiveTime] = useState(0);
  const [idleTime, setIdleTime] = useState(0);
  const [awayTime, setAwayTime] = useState(0);

  const lastInteractionRef = useRef(Date.now());
  const lastTickRef = useRef(Date.now());
  const statusRef = useRef(STATUS.ACTIVE);
  const activeTimeRef = useRef(0);
  const idleTimeRef = useRef(0);
  const awayTimeRef = useRef(0);
  const startedRef = useRef(false);
  const lastActivitySignalRef = useRef(0);
  const lastServerSyncAtRef = useRef(0);
  const heartbeatBackoffUntilRef = useRef(0);
  const heartbeatInFlightRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const serverSessionStartedRef = useRef(false);
  const authFailedRef = useRef(false);
  const tabIdRef = useRef(`tab-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  const markAuthFailed = useCallback(() => {
    authFailedRef.current = true;
    try {
      localStorage.setItem(ACTIVITY_AUTH_BLOCK_KEY, `${Date.now() + ACTIVITY_AUTH_BLOCK_MS}`);
    } catch {
      // no-op
    }
    if (typeof onAuthFailure === 'function') {
      onAuthFailure();
    }
  }, [onAuthFailure]);

  const isActivityBlockedByAuth = useCallback(() => {
    try {
      const raw = localStorage.getItem(ACTIVITY_AUTH_BLOCK_KEY);
      const until = Number(raw || 0);
      return Number.isFinite(until) && until > Date.now();
    } catch {
      return false;
    }
  }, []);

  const isHeartbeatLeader = useCallback(() => {
    try {
      const raw = localStorage.getItem(HEARTBEAT_LEADER_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed?.tabId || !parsed?.expiresAt) return false;
      if (Date.now() > Number(parsed.expiresAt)) return false;
      return parsed.tabId === tabIdRef.current;
    } catch {
      return false;
    }
  }, []);

  const tryAcquireHeartbeatLeadership = useCallback(() => {
    const now = Date.now();
    const next = {
      tabId: tabIdRef.current,
      expiresAt: now + HEARTBEAT_LEADER_TTL_MS,
    };

    try {
      const raw = localStorage.getItem(HEARTBEAT_LEADER_KEY);
      if (!raw) {
        localStorage.setItem(HEARTBEAT_LEADER_KEY, JSON.stringify(next));
        return true;
      }

      const current = JSON.parse(raw);
      const expired = !current?.expiresAt || now > Number(current.expiresAt);
      const mine = current?.tabId === tabIdRef.current;

      if (expired || mine) {
        localStorage.setItem(HEARTBEAT_LEADER_KEY, JSON.stringify(next));
        return true;
      }

      return false;
    } catch {
      return true;
    }
  }, []);

  const releaseHeartbeatLeadership = useCallback(() => {
    try {
      const raw = localStorage.getItem(HEARTBEAT_LEADER_KEY);
      if (!raw) return;
      const current = JSON.parse(raw);
      if (current?.tabId === tabIdRef.current) {
        localStorage.removeItem(HEARTBEAT_LEADER_KEY);
      }
    } catch {
      // no-op
    }
  }, []);

  const sessionDuration = useMemo(() => {
    if (!loginTime) return 0;
    return Math.max(0, Math.floor((Date.now() - loginTime) / 1000));
  }, [loginTime, activeTime, idleTime, awayTime]);

  const syncStatus = useCallback(async (nextStatus) => {
    if (!enabled) return;
    if (authFailedRef.current) return;
    if (isActivityBlockedByAuth()) return;
    if (statusRef.current === nextStatus) return;
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    try {
      await activityAPI.updateStatus({
        status: nextStatus,
        timestamp: new Date().toISOString(),
      });
      lastServerSyncAtRef.current = Date.now();
    } catch (error) {
      if (error?.response?.status === 401) {
        markAuthFailed();
        return;
      }
      console.warn('Activity status sync failed:', error?.message || error);
    }
  }, [enabled, markAuthFailed, isActivityBlockedByAuth]);

  const onUserActivity = useCallback(() => {
    if (!enabled) return;
    const now = Date.now();
    if (now - lastActivitySignalRef.current < THROTTLE_MS) return;
    lastActivitySignalRef.current = now;
    lastInteractionRef.current = now;
    if (document.visibilityState === 'visible' && statusRef.current !== STATUS.ACTIVE) {
      void syncStatus(STATUS.ACTIVE);
    }
  }, [enabled, syncStatus]);

  const flushEndSessionBeacon = useCallback(() => {
    if (!enabled || !startedRef.current) return;
    if (authFailedRef.current) return;
    if (isActivityBlockedByAuth()) return;
    const payload = JSON.stringify({
      status: STATUS.OFFLINE,
      timestamp: new Date().toISOString(),
    });
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(`${API_BASE}/api/activity/end-session`, blob);
  }, [enabled, isActivityBlockedByAuth]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let disposed = false;
    let startSessionTimerId = null;

    const start = async () => {
      if (startedRef.current) return;
      if (isActivityBlockedByAuth()) return;
      startedRef.current = true;
      const now = Date.now();
      activeTimeRef.current = 0;
      idleTimeRef.current = 0;
      awayTimeRef.current = 0;
      setActiveTime(0);
      setIdleTime(0);
      setAwayTime(0);
      setLoginTime(now);
      lastInteractionRef.current = now;
      lastTickRef.current = now;
      statusRef.current = document.visibilityState === 'hidden' ? STATUS.AWAY : STATUS.ACTIVE;
      setStatus(statusRef.current);

      try {
        await activityAPI.startSession();
        try {
          localStorage.removeItem(ACTIVITY_AUTH_BLOCK_KEY);
        } catch {
          // no-op
        }
        serverSessionStartedRef.current = true;
        authFailedRef.current = false;
        startedRef.current = true;
      } catch (error) {
        if (error?.response?.status === 401) {
          markAuthFailed();
          return;
        }
        console.warn('Activity session start failed:', error?.message || error);
      }
    };

    const tick = () => {
      const now = Date.now();
      const deltaSec = Math.max(0, Math.floor((now - lastTickRef.current) / 1000));
      lastTickRef.current = now;
      if (deltaSec <= 0) return;

      const hidden = document.visibilityState === 'hidden';
      const idle = now - lastInteractionRef.current >= IDLE_TIMEOUT_MS;

      if (hidden) {
        if (statusRef.current !== STATUS.AWAY) {
          void syncStatus(STATUS.AWAY);
        }
        awayTimeRef.current += deltaSec;
        setAwayTime(awayTimeRef.current);
        return;
      }

      if (idle) {
        if (statusRef.current !== STATUS.IDLE) {
          void syncStatus(STATUS.IDLE);
        }
        idleTimeRef.current += deltaSec;
        setIdleTime(idleTimeRef.current);
        return;
      }

      if (statusRef.current !== STATUS.ACTIVE) {
        void syncStatus(STATUS.ACTIVE);
      }
      activeTimeRef.current += deltaSec;
      setActiveTime(activeTimeRef.current);
    };

    const sendHeartbeat = async () => {
      if (disposed) return;
      if (authFailedRef.current) return;
      if (isActivityBlockedByAuth()) return;
      if (document.visibilityState !== 'visible') return;
      const becameLeader = tryAcquireHeartbeatLeadership();
      if (!becameLeader && !isHeartbeatLeader()) return;

      const now = Date.now();
      if (heartbeatInFlightRef.current) return;
      if (now < heartbeatBackoffUntilRef.current) return;
      if (now - lastServerSyncAtRef.current < HEARTBEAT_MIN_GAP_MS) return;

      heartbeatInFlightRef.current = true;
      try {
        await activityAPI.heartbeat({
          status: statusRef.current,
          active_seconds: activeTimeRef.current,
          idle_seconds: idleTimeRef.current,
          away_seconds: awayTimeRef.current,
          timestamp: new Date().toISOString(),
        });
        lastServerSyncAtRef.current = Date.now();
      } catch (error) {
        if (error?.response?.status === 401) {
          markAuthFailed();
          return;
        }
        if (error?.response?.status === 429) {
          heartbeatBackoffUntilRef.current = Date.now() + 60 * 1000;
        } else {
          console.warn('Activity heartbeat failed:', error?.message || error);
        }
      } finally {
        heartbeatInFlightRef.current = false;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        void syncStatus(STATUS.AWAY);
      } else {
        void tryAcquireHeartbeatLeadership();
        lastInteractionRef.current = Date.now();
        void syncStatus(STATUS.ACTIVE);
      }
    };

    const handleBeforeUnload = () => {
      flushEndSessionBeacon();
    };

    startSessionTimerId = window.setTimeout(() => {
      if (disposed) return;
      void start();
    }, START_SESSION_DELAY_MS);

    const events = ['mousemove', 'mousedown', 'keydown', 'keypress', 'scroll', 'touchstart'];
    events.forEach((eventName) => window.addEventListener(eventName, onUserActivity, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('beforeunload', handleBeforeUnload);

    timerIntervalRef.current = window.setInterval(tick, 1000);
    heartbeatIntervalRef.current = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
    window.setTimeout(() => {
      void sendHeartbeat();
    }, 3000 + Math.floor(Math.random() * 4000));

    return () => {
      disposed = true;
      const shouldEndServerSession = startedRef.current && serverSessionStartedRef.current && !authFailedRef.current;
      events.forEach((eventName) => window.removeEventListener(eventName, onUserActivity));
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (startSessionTimerId) window.clearTimeout(startSessionTimerId);
      if (timerIntervalRef.current) window.clearInterval(timerIntervalRef.current);
      if (heartbeatIntervalRef.current) window.clearInterval(heartbeatIntervalRef.current);
      timerIntervalRef.current = null;
      heartbeatIntervalRef.current = null;
      heartbeatInFlightRef.current = false;
      heartbeatBackoffUntilRef.current = 0;
      lastServerSyncAtRef.current = 0;
      releaseHeartbeatLeadership();

      if (shouldEndServerSession) {
        void activityAPI.endSession({
          status: STATUS.OFFLINE,
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      serverSessionStartedRef.current = false;
      authFailedRef.current = false;
      startedRef.current = false;
      statusRef.current = STATUS.OFFLINE;
      setStatus(STATUS.OFFLINE);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onUserActivity, syncStatus, flushEndSessionBeacon, isHeartbeatLeader, tryAcquireHeartbeatLeadership, releaseHeartbeatLeadership, markAuthFailed]);

  return {
    status,
    loginTime,
    activeTime,
    idleTime,
    awayTime,
    sessionDuration,
    setBreakMode: (away = true) => {
      if (!enabled) return;
      void syncStatus(away ? STATUS.AWAY : STATUS.ACTIVE);
    },
  };
}
