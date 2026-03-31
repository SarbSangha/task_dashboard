import React, { useEffect, useMemo, useRef, useState } from 'react';
import './GroupMessagePanel.css';
import { authAPI, directMessageAPI, fileAPI, groupAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
import { useAuth } from '../../../../context/AuthContext';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  getTaskPanelCacheEntry,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import ChatAttachmentGallery from '../../../common/chat/ChatAttachmentGallery';

const GROUP_PANEL_CACHE_TTL_MS = 2 * 60 * 1000;
const GROUP_MESSAGES_CACHE_TTL_MS = 90 * 1000;

const GroupMessagePanel = ({ isOpen = true, onClose, variant = 'embedded' }) => {
  const { user } = useAuth();
  const isActive = variant === 'embedded' || isOpen;
  const [activeTab, setActiveTab] = useState('groups');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isMessagesRefreshing, setIsMessagesRefreshing] = useState(false);
  const [groupsCacheStatus, setGroupsCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [messageCacheStatus, setMessageCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [allUsers, setAllUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [showAddMemberPanel, setShowAddMemberPanel] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [addMemberSelection, setAddMemberSelection] = useState([]);
  const [feedback, setFeedback] = useState('');
  const messageThreadRef = useRef(null);
  const directThreadRef = useRef(null);
  const selectedGroupIdRef = useRef(null);
  const groupMenuRef = useRef(null);
  const [directUsers, setDirectUsers] = useState([]);
  const [directConversations, setDirectConversations] = useState([]);
  const [selectedDirectUserId, setSelectedDirectUserId] = useState(null);
  const [directMessages, setDirectMessages] = useState([]);
  const [directLoading, setDirectLoading] = useState(true);
  const [directRefreshing, setDirectRefreshing] = useState(false);
  const [directMessagesRefreshing, setDirectMessagesRefreshing] = useState(false);
  const [directCacheStatus, setDirectCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [directMessageCacheStatus, setDirectMessageCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [directNewMessage, setDirectNewMessage] = useState('');
  const [sendingDirectMessage, setSendingDirectMessage] = useState(false);
  const [uploadingDirectAttachment, setUploadingDirectAttachment] = useState(false);
  const [directPendingAttachments, setDirectPendingAttachments] = useState([]);
  const selectedDirectUserIdRef = useRef(null);
  const activeTabRef = useRef(activeTab);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const realtimeRefreshTimersRef = useRef({
    groupIndex: null,
    groupMessages: null,
    directIndex: null,
    directMessages: null,
  });
  const syncGroupsPromiseRef = useRef(null);
  const syncDirectDataPromiseRef = useRef(null);
  const groupMessagesRequestRef = useRef({ groupId: null, promise: null });
  const directMessagesRequestRef = useRef({ userId: null, promise: null });
  const minimizedWindowStyle = useMinimizedWindowStack('group-message-panel', variant === 'overlay' && isOpen && isMinimized);
  selectedGroupIdRef.current = selectedGroupId;
  selectedDirectUserIdRef.current = selectedDirectUserId;
  activeTabRef.current = activeTab;

  const cacheKeys = useMemo(() => {
    if (!user?.id) return null;
    return {
      groupIndex: buildTaskPanelCacheKey(user.id, 'group_message_panel'),
      groupMessages: (groupId) => buildTaskPanelCacheKey(user.id, `group_message_panel_messages_${groupId}`),
      directIndex: buildTaskPanelCacheKey(user.id, 'direct_message_panel'),
      directMessages: (otherUserId) => buildTaskPanelCacheKey(user.id, `direct_message_panel_messages_${otherUserId}`),
    };
  }, [user?.id]);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const isSelectedGroupAdmin = !!selectedGroup && selectedGroup.myRole === 'admin';
  const selectedGroupPreviewNames = (selectedGroup?.members || [])
    .slice(0, 3)
    .map((member) => member.name)
    .join(', ');
  const selectedDirectUser = useMemo(
    () =>
      directUsers.find((directUser) => directUser.id === selectedDirectUserId) ||
      directConversations.find((conversation) => conversation.user?.id === selectedDirectUserId)?.user ||
      null,
    [directConversations, directUsers, selectedDirectUserId]
  );
  const directListItems = useMemo(() => {
    const seen = new Set();
    const items = [];

    directConversations.forEach((conversation) => {
      if (!conversation?.user?.id || seen.has(conversation.user.id)) return;
      seen.add(conversation.user.id);
      items.push({
        ...conversation.user,
        conversation,
      });
    });

    directUsers.forEach((directUser) => {
      if (!directUser?.id || seen.has(directUser.id)) return;
      seen.add(directUser.id);
      items.push({
        ...directUser,
        conversation: null,
      });
    });

    return items;
  }, [directConversations, directUsers]);

  const buildDayLabel = (value) => {
    if (!value) return 'Recent';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recent';
    const today = new Date();
    const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((todayDay.getTime() - messageDay.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: messageDay.getFullYear() === todayDay.getFullYear() ? undefined : 'numeric',
    });
  };

  const formatMessageTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const buildInitials = (value) =>
    (value || '')
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'G';

  const buildAvatarHue = (value) =>
    Array.from(value || 'group').reduce((total, char) => total + char.charCodeAt(0), 0) % 360;

  const getAttachmentLabel = (attachment) => getAttachmentDisplayName(attachment);

  const messageItems = useMemo(() => {
    const items = [];
    let lastLabel = null;

    messages.forEach((message) => {
      const label = buildDayLabel(message.createdAt);
      if (label !== lastLabel) {
        items.push({ type: 'separator', id: `separator-${label}-${message.id}`, label });
        lastLabel = label;
      }
      items.push({ type: 'message', id: `message-${message.id}`, message });
    });

    return items;
  }, [messages]);
  const directMessageItems = useMemo(() => {
    const items = [];
    let lastLabel = null;

    directMessages.forEach((message) => {
      const label = buildDayLabel(message.createdAt);
      if (label !== lastLabel) {
        items.push({ type: 'separator', id: `direct-separator-${label}-${message.id}`, label });
        lastLabel = label;
      }
      items.push({ type: 'message', id: `direct-message-${message.id}`, message });
    });

    return items;
  }, [directMessages]);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;
    setTaskPanelCache(cacheKeys.groupIndex, {
      allUsers,
      currentUserId,
      groups,
      selectedGroupId,
    });
  }, [allUsers, cacheKeys, currentUserId, groups, isActive, selectedGroupId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !selectedGroupId) return;
    setTaskPanelCache(cacheKeys.groupMessages(selectedGroupId), {
      messages,
    });
  }, [cacheKeys, isActive, messages, selectedGroupId]);

  const syncGroups = async ({ keepSelected = true, silent = false } = {}) => {
    if (syncGroupsPromiseRef.current) {
      return syncGroupsPromiseRef.current;
    }

    const request = (async () => {
      try {
        if (silent) {
          setIsRefreshing(true);
        }
        const response = await groupAPI.listGroups();
        const nextGroups = response?.data || [];
        setGroups(nextGroups);
        setGroupsCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
        if (nextGroups.length === 0) {
          setSelectedGroupId(null);
          setMessages([]);
          return;
        }

        const activeGroupId = selectedGroupIdRef.current;
        if (!keepSelected || !nextGroups.some((group) => group.id === activeGroupId)) {
          const fallbackGroupId = nextGroups[0].id;
          const cachedMessages = cacheKeys
            ? getTaskPanelCache(cacheKeys.groupMessages(fallbackGroupId), GROUP_MESSAGES_CACHE_TTL_MS)
            : null;
          if (cachedMessages?.messages) {
            setMessages(cachedMessages.messages);
          }
          setSelectedGroupId(fallbackGroupId);
        }
      } finally {
        if (silent) setIsRefreshing(false);
      }
    })();

    syncGroupsPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (syncGroupsPromiseRef.current === request) {
        syncGroupsPromiseRef.current = null;
      }
    }
  };

  const loadMessages = async (groupId, { silent = false } = {}) => {
    if (!groupId) {
      setMessages([]);
      return;
    }

    const activeRequest = groupMessagesRequestRef.current;
    if (activeRequest.groupId === groupId && activeRequest.promise) {
      return activeRequest.promise;
    }

    const request = (async () => {
      try {
        if (silent) setIsMessagesRefreshing(true);
        const response = await groupAPI.listMessages(groupId);
        if (selectedGroupIdRef.current !== groupId) return;
        setMessages(response?.data || []);
        setMessageCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
      } finally {
        if (silent) setIsMessagesRefreshing(false);
      }
    })();

    groupMessagesRequestRef.current = { groupId, promise: request };
    try {
      return await request;
    } finally {
      if (groupMessagesRequestRef.current.promise === request) {
        groupMessagesRequestRef.current = { groupId: null, promise: null };
      }
    }
  };

  const syncDirectData = async ({ keepSelected = true, silent = false } = {}) => {
    if (syncDirectDataPromiseRef.current) {
      return syncDirectDataPromiseRef.current;
    }

    const request = (async () => {
      try {
        if (silent) setDirectRefreshing(true);
        const [usersResponse, conversationsResponse] = await Promise.all([
          directMessageAPI.listUsers(),
          directMessageAPI.listConversations(),
        ]);
        const nextUsers = usersResponse?.data || [];
        const nextConversations = conversationsResponse?.data || [];
        setDirectUsers(nextUsers);
        setDirectConversations(nextConversations);
        setDirectCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));

        const activeUserId = selectedDirectUserIdRef.current;
        const userStillExists = nextUsers.some((directUser) => directUser.id === activeUserId)
          || nextConversations.some((conversation) => conversation.user?.id === activeUserId);
        if (!keepSelected || !userStillExists) {
          const fallbackUserId = nextConversations[0]?.user?.id || null;
          if (fallbackUserId && cacheKeys) {
            const cachedDirectMessages = getTaskPanelCache(cacheKeys.directMessages(fallbackUserId), GROUP_MESSAGES_CACHE_TTL_MS);
            if (cachedDirectMessages?.messages) {
              setDirectMessages(cachedDirectMessages.messages);
            }
          }
          setSelectedDirectUserId(fallbackUserId);
        }
      } finally {
        if (silent) setDirectRefreshing(false);
      }
    })();

    syncDirectDataPromiseRef.current = request;
    try {
      return await request;
    } finally {
      if (syncDirectDataPromiseRef.current === request) {
        syncDirectDataPromiseRef.current = null;
      }
    }
  };

  const loadDirectMessages = async (otherUserId, { silent = false } = {}) => {
    if (!otherUserId) {
      setDirectMessages([]);
      return;
    }

    const activeRequest = directMessagesRequestRef.current;
    if (activeRequest.userId === otherUserId && activeRequest.promise) {
      return activeRequest.promise;
    }

    const request = (async () => {
      try {
        if (silent) setDirectMessagesRefreshing(true);
        const response = await directMessageAPI.listMessages(otherUserId);
        if (selectedDirectUserIdRef.current !== otherUserId) return;
        setDirectMessages(response?.data || []);
        if (response?.conversationWith) {
          setDirectUsers((prev) => {
            if (prev.some((entry) => entry.id === response.conversationWith.id)) return prev;
            return [response.conversationWith, ...prev];
          });
        }
        setDirectMessageCacheStatus((prev) => ({
          showingCached: false,
          cachedAt: prev.cachedAt,
          liveUpdatedAt: Date.now(),
        }));
      } finally {
        if (silent) setDirectMessagesRefreshing(false);
      }
    })();

    directMessagesRequestRef.current = { userId: otherUserId, promise: request };
    try {
      return await request;
    } finally {
      if (directMessagesRequestRef.current.promise === request) {
        directMessagesRequestRef.current = { userId: null, promise: null };
      }
    }
  };

  const scheduleRealtimeRefresh = (key, callback, delay = 180) => {
    if (typeof window === 'undefined') return;
    if (realtimeRefreshTimersRef.current[key]) return;
    realtimeRefreshTimersRef.current[key] = window.setTimeout(() => {
      realtimeRefreshTimersRef.current[key] = null;
      callback().catch(() => {});
    }, delay);
  };

  const scheduleGroupIndexRefresh = (delay = 180) =>
    scheduleRealtimeRefresh('groupIndex', () => syncGroups({ silent: true }), delay);

  const scheduleGroupMessagesRefresh = (groupId, delay = 180) =>
    scheduleRealtimeRefresh('groupMessages', () => loadMessages(groupId, { silent: true }), delay);

  const scheduleDirectIndexRefresh = (delay = 180) =>
    scheduleRealtimeRefresh('directIndex', () => syncDirectData({ silent: true }), delay);

  const scheduleDirectMessagesRefresh = (otherUserId, delay = 180) =>
    scheduleRealtimeRefresh('directMessages', () => loadDirectMessages(otherUserId, { silent: true }), delay);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;

    const cachedGroupsEntry = getTaskPanelCacheEntry(cacheKeys.groupIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedGroups = cachedGroupsEntry?.value || null;

    if (cachedGroups) {
      setAllUsers(cachedGroups.allUsers || []);
      setCurrentUserId(cachedGroups.currentUserId || null);
      setGroups(cachedGroups.groups || []);
      setSelectedGroupId(cachedGroups.selectedGroupId || null);
      setLoading(false);
      setGroupsCacheStatus({
        showingCached: true,
        cachedAt: cachedGroupsEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      if (cachedGroups.selectedGroupId) {
        const cachedMessagesEntry = getTaskPanelCacheEntry(
          cacheKeys.groupMessages(cachedGroups.selectedGroupId),
          GROUP_MESSAGES_CACHE_TTL_MS
        );
        if (cachedMessagesEntry?.value?.messages) {
          setMessages(cachedMessagesEntry.value.messages);
          setMessageCacheStatus({
            showingCached: true,
            cachedAt: cachedMessagesEntry.cachedAt || 0,
            liveUpdatedAt: 0,
          });
        }
      }
    }

    const load = async () => {
      if (cachedGroups) setIsRefreshing(true);
      else setLoading(true);

      try {
        const [meResponse, usersResponse] = await Promise.all([
          authAPI.getCurrentUser().catch(() => ({ user: user || null })),
          groupAPI.listUsers(),
        ]);
        setCurrentUserId(meResponse?.user?.id || null);
        setAllUsers(usersResponse?.data || []);
        await syncGroups({ keepSelected: false, silent: !!cachedGroups });
      } catch (error) {
        console.error('Failed to load users for groups:', error);
        if (!cachedGroups) {
          setAllUsers([]);
          setGroups([]);
          setSelectedGroupId(null);
        }
      } finally {
        if (cachedGroups) setIsRefreshing(false);
        else setLoading(false);
      }
    };

    load();
  }, [cacheKeys, isActive, user]);

  useEffect(() => {
    if (!isActive) return;
    if (!selectedGroupId) {
      setMessages([]);
      return;
    }

    const cachedMessagesEntry = cacheKeys
      ? getTaskPanelCacheEntry(cacheKeys.groupMessages(selectedGroupId), GROUP_MESSAGES_CACHE_TTL_MS)
      : null;
    const cachedMessages = cachedMessagesEntry?.value || null;

    if (cachedMessages?.messages) {
      setMessages(cachedMessages.messages);
      setMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    loadMessages(selectedGroupId, { silent: !!cachedMessages }).catch((error) => {
      console.error('Failed to load messages:', error);
      if (!cachedMessages) {
        setMessages([]);
      }
      setIsMessagesRefreshing(false);
    });
  }, [cacheKeys, isActive, selectedGroupId]);

  useEffect(() => {
    if (!isActive) return;
    setShowAddMemberPanel(false);
    setShowGroupMenu(false);
    setAddMemberSelection([]);
    setPendingAttachments([]);
    setNewMessage('');
  }, [isActive, selectedGroupId]);

  useEffect(() => {
    if (variant !== 'overlay') return;
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen, variant]);

  useEffect(() => {
    if (!isActive || !showGroupMenu) return undefined;

    const handlePointerDown = (event) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target)) {
        setShowGroupMenu(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [isActive, showGroupMenu]);

  useEffect(() => {
    if (!isActive) return undefined;

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      scheduleGroupIndexRefresh();
      scheduleDirectIndexRefresh();

      if (activeTabRef.current === 'groups' && selectedGroupIdRef.current) {
        scheduleGroupMessagesRefresh(selectedGroupIdRef.current);
      }

      if (activeTabRef.current === 'direct' && selectedDirectUserIdRef.current) {
        scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current);
      }
    }, 90000);

    return () => clearInterval(interval);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;

        if (payload.eventType === 'group_message') {
          const groupId = payload?.metadata?.groupId;
          if (!groupId) return;
          scheduleGroupIndexRefresh();
          if (selectedGroupIdRef.current === groupId) {
            scheduleGroupMessagesRefresh(groupId);
          }
          return;
        }

        if (payload.eventType === 'direct_message') {
          const senderId = payload?.metadata?.senderId;
          if (!senderId) return;
          scheduleDirectIndexRefresh();
          if (selectedDirectUserIdRef.current === senderId) {
            scheduleDirectMessagesRefresh(senderId);
          }
        }
      },
      onOpen: () => {
        scheduleGroupIndexRefresh(120);
        if (selectedGroupIdRef.current) {
          scheduleGroupMessagesRefresh(selectedGroupIdRef.current, 120);
        }
        scheduleDirectIndexRefresh(120);
        if (selectedDirectUserIdRef.current) {
          scheduleDirectMessagesRefresh(selectedDirectUserIdRef.current, 120);
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, [isActive]);

  useEffect(() => {
    if (isActive) return;

    Object.values(realtimeRefreshTimersRef.current).forEach((timerId, index) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
      const timerKeys = ['groupIndex', 'groupMessages', 'directIndex', 'directMessages'];
      realtimeRefreshTimersRef.current[timerKeys[index]] = null;
    });
  }, [isActive]);

  useEffect(() => () => {
    Object.values(realtimeRefreshTimersRef.current).forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
  }, []);

  useEffect(() => {
    if (!isActive || !selectedGroupId) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      const thread = messageThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isActive, selectedGroupId, messageItems.length]);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;
    setTaskPanelCache(cacheKeys.directIndex, {
      directUsers,
      directConversations,
      selectedDirectUserId,
    });
  }, [cacheKeys, directConversations, directUsers, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !cacheKeys || !selectedDirectUserId) return;
    setTaskPanelCache(cacheKeys.directMessages(selectedDirectUserId), {
      messages: directMessages,
    });
  }, [cacheKeys, directMessages, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !cacheKeys) return;

    const cachedDirectEntry = getTaskPanelCacheEntry(cacheKeys.directIndex, GROUP_PANEL_CACHE_TTL_MS);
    const cachedDirectData = cachedDirectEntry?.value || null;
    if (cachedDirectData) {
      setDirectUsers(cachedDirectData.directUsers || []);
      setDirectConversations(cachedDirectData.directConversations || []);
      setSelectedDirectUserId(cachedDirectData.selectedDirectUserId || null);
      setDirectLoading(false);
      setDirectCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
      if (cachedDirectData.selectedDirectUserId) {
        const cachedDirectMessagesEntry = getTaskPanelCacheEntry(
          cacheKeys.directMessages(cachedDirectData.selectedDirectUserId),
          GROUP_MESSAGES_CACHE_TTL_MS
        );
        if (cachedDirectMessagesEntry?.value?.messages) {
          setDirectMessages(cachedDirectMessagesEntry.value.messages);
          setDirectMessageCacheStatus({
            showingCached: true,
            cachedAt: cachedDirectMessagesEntry.cachedAt || 0,
            liveUpdatedAt: 0,
          });
        }
      }
    }

    const load = async () => {
      if (cachedDirectData) setDirectRefreshing(true);
      else setDirectLoading(true);
      try {
        await syncDirectData({ keepSelected: false, silent: !!cachedDirectData });
      } catch (error) {
        console.error('Failed to load direct messages:', error);
        if (!cachedDirectData) {
          setDirectUsers([]);
          setDirectConversations([]);
          setSelectedDirectUserId(null);
        }
      } finally {
        if (cachedDirectData) setDirectRefreshing(false);
        else setDirectLoading(false);
      }
    };

    load();
  }, [cacheKeys, isActive]);

  useEffect(() => {
    if (!isActive) return;
    if (!selectedDirectUserId) {
      setDirectMessages([]);
      return;
    }

    const cachedDirectMessagesEntry = cacheKeys
      ? getTaskPanelCacheEntry(cacheKeys.directMessages(selectedDirectUserId), GROUP_MESSAGES_CACHE_TTL_MS)
      : null;
    const cachedDirectMessages = cachedDirectMessagesEntry?.value || null;
    if (cachedDirectMessages?.messages) {
      setDirectMessages(cachedDirectMessages.messages);
      setDirectMessageCacheStatus({
        showingCached: true,
        cachedAt: cachedDirectMessagesEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    loadDirectMessages(selectedDirectUserId, { silent: !!cachedDirectMessages }).catch((error) => {
      console.error('Failed to load direct messages:', error);
      if (!cachedDirectMessages) {
        setDirectMessages([]);
      }
      setDirectMessagesRefreshing(false);
    });
  }, [cacheKeys, isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive) return;
    setDirectPendingAttachments([]);
    setDirectNewMessage('');
  }, [isActive, selectedDirectUserId]);

  useEffect(() => {
    if (!isActive || !selectedDirectUserId) return undefined;

    const frameId = window.requestAnimationFrame(() => {
      const thread = directThreadRef.current;
      if (!thread) return;
      thread.scrollTop = thread.scrollHeight;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [directMessageItems.length, isActive, selectedDirectUserId]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]));
  };

  const createGroup = async () => {
    if (!groupName.trim() || selectedIds.length === 0) return;
    try {
      setFeedback('');
      const response = await groupAPI.createGroup(groupName.trim(), selectedIds);
      const created = response?.data;
      if (created) {
        setGroups((prev) => [created, ...prev.filter((group) => group.id !== created.id)]);
        setSelectedGroupId(created.id);
      } else {
        await syncGroups({ silent: true });
      }
      setGroupName('');
      setSelectedIds([]);
      setFeedback('Group created successfully.');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to create group.');
    }
  };

  const saveAddMembers = async (groupId) => {
    if (!addMemberSelection.length) return;
    try {
      setFeedback('');
      const response = await groupAPI.addMembers(groupId, addMemberSelection);
      const updated = response?.data;
      setGroups((prev) => prev.map((group) => (group.id === groupId ? updated : group)));
      setAddMemberSelection([]);
      setShowAddMemberPanel(false);
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to add members.');
    }
  };

  const sendMessage = async () => {
    if (!selectedGroupId || sendingMessage || uploadingAttachment) return;
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage && pendingAttachments.length === 0) return;
    setSendingMessage(true);

    try {
      const response = await groupAPI.sendMessage(selectedGroupId, {
        message: trimmedMessage,
        attachments: pendingAttachments,
      });
      const sent = response?.data;
      setMessages((prev) => (sent ? [...prev, sent] : prev));
      setNewMessage('');
      setPendingAttachments([]);
      await syncGroups({ silent: true });
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingMessage(false);
    }
  };

  const handleAttachmentSelect = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    setUploadingAttachment(true);
    try {
      const response = await fileAPI.uploadFiles(files);
      setPendingAttachments((prev) => mergeUniqueAttachments(prev, response?.data || []));
      setFeedback('');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to upload attachment.');
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleDirectAttachmentSelect = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    setUploadingDirectAttachment(true);
    try {
      const response = await fileAPI.uploadFiles(files);
      setDirectPendingAttachments((prev) => mergeUniqueAttachments(prev, response?.data || []));
      setFeedback('');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to upload attachment.');
    } finally {
      setUploadingDirectAttachment(false);
    }
  };

  const openAttachmentPicker = (mode, onSelect = handleAttachmentSelect) => {
    openSystemFilePicker({
      mode,
      onSelect,
    });
  };

  const updateMemberRole = async (memberId, role) => {
    if (!selectedGroupId) return;
    try {
      const response = await groupAPI.updateMemberRole(selectedGroupId, memberId, role);
      const updated = response?.data;
      setGroups((prev) => prev.map((group) => (group.id === selectedGroupId ? updated : group)));
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to update role.');
    }
  };

  const removeMember = async (memberId) => {
    if (!selectedGroupId) return;
    try {
      const response = await groupAPI.removeMember(selectedGroupId, memberId);
      const updated = response?.data;
      if (memberId === currentUserId) {
        await syncGroups({ keepSelected: false, silent: true });
      } else {
        setGroups((prev) => prev.map((group) => (group.id === selectedGroupId ? updated : group)));
      }
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to remove member.');
    }
  };

  const sendDirectMessage = async () => {
    if (!selectedDirectUserId || sendingDirectMessage || uploadingDirectAttachment) return;
    const trimmedMessage = directNewMessage.trim();
    if (!trimmedMessage && directPendingAttachments.length === 0) return;
    setSendingDirectMessage(true);

    try {
      const response = await directMessageAPI.sendMessage(selectedDirectUserId, {
        message: trimmedMessage,
        attachments: directPendingAttachments,
      });
      const sent = response?.data;
      setDirectMessages((prev) => (sent ? [...prev, sent] : prev));
      setDirectNewMessage('');
      setDirectPendingAttachments([]);
      await syncDirectData({ silent: true });
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingDirectMessage(false);
    }
  };

  const content = (
    <div className={`group-message-root group-message-root--${variant}`}>
      <div className="message-system-tabs">
        <button
          type="button"
          className={activeTab === 'groups' ? 'active' : ''}
          onClick={() => setActiveTab('groups')}
        >
          Group Chat
        </button>
        <button
          type="button"
          className={activeTab === 'direct' ? 'active' : ''}
          onClick={() => setActiveTab('direct')}
        >
          Individual Chat
        </button>
      </div>
      <div className="content-header">
        <h3>{activeTab === 'groups' ? 'Groups' : 'Individual Chat'}</h3>
        <button
          className="add-btn"
          onClick={() =>
            (activeTab === 'groups' ? syncGroups({ silent: true }) : syncDirectData({ silent: true })).catch(() => {})
          }
        >
          Refresh
        </button>
      </div>

      {feedback && <div className="group-message-feedback">{feedback}</div>}
      <CacheStatusBanner
        showingCached={activeTab === 'groups' ? groupsCacheStatus.showingCached : directCacheStatus.showingCached}
        isRefreshing={activeTab === 'groups' ? isRefreshing : directRefreshing}
        cachedAt={activeTab === 'groups' ? groupsCacheStatus.cachedAt : directCacheStatus.cachedAt}
        liveUpdatedAt={activeTab === 'groups' ? groupsCacheStatus.liveUpdatedAt : directCacheStatus.liveUpdatedAt}
        refreshingLabel={activeTab === 'groups' ? 'Refreshing latest groups...' : 'Refreshing latest direct chats...'}
        liveLabel={activeTab === 'groups' ? 'Groups list is up to date' : 'Direct chats are up to date'}
        cachedLabel={activeTab === 'groups' ? 'Showing cached groups' : 'Showing cached direct chats'}
      />

      {activeTab === 'groups' && (
      <div className="groups-shell">
        <div className="groups-sidebar">
          <div className="groups-create-card">
            <div className="groups-create-title">Create Group</div>
            <input
              className="groups-input"
              type="text"
              placeholder="Group name..."
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
            />
            <div className="groups-user-picker">
              {loading && <div>Loading employees...</div>}
              {!loading &&
                allUsers.map((groupUser) => (
                  <label key={groupUser.id} className="groups-user-option">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(groupUser.id)}
                      onChange={() => toggleSelected(groupUser.id)}
                    />
                    <span>
                      {groupUser.name} ({groupUser.department || 'N/A'})
                    </span>
                  </label>
                ))}
            </div>
            <button className="add-btn" onClick={createGroup} disabled={!groupName.trim() || selectedIds.length === 0}>
              + Create Group
            </button>
          </div>

          <div className="groups-list">
            {groups.length === 0 && <div className="group-message-info-card">No groups created yet.</div>}
            {groups.map((group) => (
              <button
                type="button"
                className={`group-thread-card ${selectedGroupId === group.id ? 'active' : ''}`}
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <div
                  className="group-thread-avatar"
                  style={{ '--group-avatar-hue': `${buildAvatarHue(group.name)}deg` }}
                >
                  {buildInitials(group.name)}
                </div>
                <div className="group-thread-copy">
                  <div className="group-thread-topline">
                    <div className="group-thread-name">{group.name}</div>
                    <div className="group-thread-meta">{group.memberCount} members</div>
                  </div>
                  <div className="group-thread-subline">
                    <span>Your role: {group.myRole}</span>
                    <span>{group.members?.slice(0, 2).map((member) => member.name).join(', ')}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="groups-chat-window">
          {!selectedGroup && (
            <div className="group-chat-empty">
              <div className="group-chat-empty-icon">#</div>
              <h4>Select a group to start chatting</h4>
              <p>Your group conversations will appear here in a WhatsApp-style layout.</p>
            </div>
          )}

          {selectedGroup && (
            <>
              <div className="group-chat-header">
                <div className="group-chat-summary">
                  <div
                    className="group-chat-header-avatar"
                    style={{ '--group-avatar-hue': `${buildAvatarHue(selectedGroup.name)}deg` }}
                  >
                    {buildInitials(selectedGroup.name)}
                  </div>
                  <div>
                    <div className="group-chat-title">{selectedGroup.name}</div>
                    <div className="group-chat-subtitle">
                      {selectedGroup.memberCount} members
                      {selectedGroupPreviewNames ? `, ${selectedGroupPreviewNames}` : ''}
                    </div>
                  </div>
                </div>
                <div className="group-chat-actions">
                  <span className="group-chat-badge">{selectedGroup.myRole}</span>
                  <div className="group-chat-menu-wrap" ref={groupMenuRef}>
                    <button
                      type="button"
                      className="group-chat-menu-trigger"
                      onClick={() => setShowGroupMenu((prev) => !prev)}
                    >
                      ...
                    </button>

                    {showGroupMenu && (
                      <div className="group-chat-menu">
                        {isSelectedGroupAdmin && (
                          <button
                            type="button"
                            className="group-chat-menu-action"
                            onClick={() => setShowAddMemberPanel((prev) => !prev)}
                          >
                            {showAddMemberPanel ? 'Close Add Members' : '+ Add Members'}
                          </button>
                        )}

                        {showAddMemberPanel && isSelectedGroupAdmin && (
                          <div className="group-add-members-panel group-add-members-panel-menu">
                            <div className="group-chat-menu-title">Add Members</div>
                            <div className="group-add-members-list">
                              {allUsers
                                .filter((groupUser) => !selectedGroup.members.some((member) => member.id === groupUser.id))
                                .map((groupUser) => (
                                  <label key={groupUser.id} className="groups-user-option">
                                    <input
                                      type="checkbox"
                                      checked={addMemberSelection.includes(groupUser.id)}
                                      onChange={() =>
                                        setAddMemberSelection((prev) =>
                                          prev.includes(groupUser.id)
                                            ? prev.filter((value) => value !== groupUser.id)
                                            : [...prev, groupUser.id]
                                        )
                                      }
                                    />
                                    <span>
                                      {groupUser.name} ({groupUser.department || 'N/A'})
                                    </span>
                                  </label>
                                ))}
                            </div>
                            <button className="add-btn" style={{ marginTop: '8px' }} onClick={() => saveAddMembers(selectedGroup.id)}>
                              Save Members
                            </button>
                          </div>
                        )}

                        <div className="group-chat-menu-section">
                          <div className="group-chat-menu-title">Members</div>
                          <div className="group-chat-menu-members">
                            {selectedGroup.members.map((member) => (
                              <div key={member.id} className="group-member-row group-member-row-menu">
                                <div className="group-member-main">
                                  <div
                                    className="group-member-avatar"
                                    style={{ '--group-avatar-hue': `${buildAvatarHue(member.name)}deg` }}
                                  >
                                    {buildInitials(member.name)}
                                  </div>
                                  <div>
                                    <div className="group-member-name">{member.name}</div>
                                    <div className="group-member-role-line">{member.role}</div>
                                  </div>
                                </div>
                                <div className="group-member-actions">
                                  {isSelectedGroupAdmin && member.id !== currentUserId && selectedGroup.createdBy !== member.id && (
                                    <>
                                      <button
                                        className="add-btn"
                                        onClick={() => updateMemberRole(member.id, member.role === 'admin' ? 'member' : 'admin')}
                                      >
                                        {member.role === 'admin' ? 'Demote' : 'Make Admin'}
                                      </button>
                                      <button className="add-btn" onClick={() => removeMember(member.id)}>
                                        Remove
                                      </button>
                                    </>
                                  )}
                                  {member.id === currentUserId && selectedGroup.createdBy !== currentUserId && (
                                    <button className="add-btn" onClick={() => removeMember(member.id)}>
                                      Leave
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="group-chat-body">
                <div className="group-chat-thread" ref={messageThreadRef}>
                  <CacheStatusBanner
                    showingCached={messageCacheStatus.showingCached}
                    isRefreshing={isMessagesRefreshing}
                    cachedAt={messageCacheStatus.cachedAt}
                    liveUpdatedAt={messageCacheStatus.liveUpdatedAt}
                    refreshingLabel="Refreshing latest conversation..."
                    liveLabel="Conversation is up to date"
                    cachedLabel="Showing cached conversation"
                  />
                  {messages.length === 0 && <div className="group-chat-empty-thread">No messages yet. Say hello to the group.</div>}
                  {messageItems.map((item) => {
                    if (item.type === 'separator') {
                      return (
                        <div key={item.id} className="group-chat-day-separator">
                          <span>{item.label}</span>
                        </div>
                      );
                    }

                    const message = item.message;
                    const mine = message.senderId === currentUserId;

                    return (
                      <div key={item.id} className={`group-chat-row ${mine ? 'mine' : 'theirs'}`}>
                        {!mine && (
                          <div
                            className="group-message-avatar"
                            style={{ '--group-avatar-hue': `${buildAvatarHue(message.senderName)}deg` }}
                          >
                            {buildInitials(message.senderName)}
                          </div>
                        )}
                        <div className={`group-message-bubble ${mine ? 'mine' : 'theirs'}`}>
                          {!mine && <div className="group-message-sender">{message.senderName}</div>}
                          {message.message && <div className="group-message-text">{message.message}</div>}
                          {!!message.attachments?.length && (
                            <div className="group-message-attachments">
                              <ChatAttachmentGallery attachments={message.attachments} />
                            </div>
                          )}
                          <div className="group-message-meta">
                            <span>{formatMessageTime(message.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="group-chat-composer">
                {!!pendingAttachments.length && (
                  <div className="group-chat-attachment-strip">
                    {pendingAttachments.map((attachment, index) => (
                      <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="group-chat-attachment-pill">
                        <span>{getAttachmentLabel(attachment)}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setPendingAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index))
                          }
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="group-chat-composer-shell">
                  <button
                    type="button"
                    className="group-chat-tool-btn"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAttachmentPicker('files');
                    }}
                    title="Attach files"
                    disabled={uploadingAttachment}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className="group-chat-tool-btn"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openAttachmentPicker('folder');
                    }}
                    title="Attach folder"
                    disabled={uploadingAttachment}
                  >
                    F
                  </button>
                  <input
                    className="groups-input group-chat-input"
                    type="text"
                    placeholder={uploadingAttachment ? 'Uploading attachment...' : 'Type a message'}
                    value={newMessage}
                    onChange={(event) => setNewMessage(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        sendMessage();
                      }
                    }}
                  />
                  <button
                    className="group-chat-send-btn"
                    onClick={sendMessage}
                    disabled={sendingMessage || uploadingAttachment || (!newMessage.trim() && pendingAttachments.length === 0)}
                  >
                    <span className={`group-chat-send-icon ${sendingMessage ? 'sending' : ''}`} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      )}
      {activeTab === 'direct' && (
        <div className="groups-shell">
          <div className="groups-sidebar">
            <div className="groups-create-card">
              <div className="groups-create-title">Start Individual Chat</div>
              <div className="group-message-info-card direct-helper-card">
                Choose a teammate from the list below to start or continue a one-to-one conversation.
              </div>
            </div>

            <div className="groups-list">
              {directLoading && <div className="group-message-info-card">Loading people...</div>}
              {!directLoading && directListItems.length === 0 && (
                <div className="group-message-info-card">No people available for direct chat yet.</div>
              )}
              {!directLoading && directListItems.map((item) => (
                <button
                  type="button"
                  className={`group-thread-card ${selectedDirectUserId === item.id ? 'active' : ''}`}
                  key={item.id}
                  onClick={() => setSelectedDirectUserId(item.id)}
                >
                  <div
                    className="group-thread-avatar"
                    style={{ '--group-avatar-hue': `${buildAvatarHue(item.name)}deg` }}
                  >
                    {buildInitials(item.name)}
                  </div>
                  <div className="group-thread-copy">
                    <div className="group-thread-topline">
                      <div className="group-thread-name">{item.name}</div>
                      <div className="group-thread-meta">{item.department || item.position || 'User'}</div>
                    </div>
                    <div className="group-thread-subline">
                      <span>{item.position || 'Member'}</span>
                      <span>{item.conversation?.lastMessagePreview || 'Start a conversation'}</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="groups-chat-window">
            {!selectedDirectUser && (
              <div className="group-chat-empty">
                <div className="group-chat-empty-icon">@</div>
                <h4>Select a person to start chatting</h4>
                <p>Your individual one-to-one conversations will appear here.</p>
              </div>
            )}

            {selectedDirectUser && (
              <>
                <div className="group-chat-header">
                  <div className="group-chat-summary">
                    <div
                      className="group-chat-header-avatar"
                      style={{ '--group-avatar-hue': `${buildAvatarHue(selectedDirectUser.name)}deg` }}
                    >
                      {buildInitials(selectedDirectUser.name)}
                    </div>
                    <div>
                      <div className="group-chat-title">{selectedDirectUser.name}</div>
                      <div className="group-chat-subtitle">
                        {selectedDirectUser.department || 'No department'}{selectedDirectUser.position ? `, ${selectedDirectUser.position}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="group-chat-actions">
                    <span className="group-chat-badge">Direct</span>
                  </div>
                </div>

                <div className="group-chat-body">
                  <div className="group-chat-thread" ref={directThreadRef}>
                    <CacheStatusBanner
                      showingCached={directMessageCacheStatus.showingCached}
                      isRefreshing={directMessagesRefreshing}
                      cachedAt={directMessageCacheStatus.cachedAt}
                      liveUpdatedAt={directMessageCacheStatus.liveUpdatedAt}
                      refreshingLabel="Refreshing latest direct messages..."
                      liveLabel="Conversation is up to date"
                      cachedLabel="Showing cached conversation"
                    />
                    {directMessages.length === 0 && (
                      <div className="group-chat-empty-thread">No direct messages yet. Start the conversation.</div>
                    )}
                    {directMessageItems.map((item) => {
                      if (item.type === 'separator') {
                        return (
                          <div key={item.id} className="group-chat-day-separator">
                            <span>{item.label}</span>
                          </div>
                        );
                      }

                      const message = item.message;
                      const mine = message.senderId === currentUserId;

                      return (
                        <div key={item.id} className={`group-chat-row ${mine ? 'mine' : 'theirs'}`}>
                          {!mine && (
                            <div
                              className="group-message-avatar"
                              style={{ '--group-avatar-hue': `${buildAvatarHue(message.senderName)}deg` }}
                            >
                              {buildInitials(message.senderName)}
                            </div>
                          )}
                          <div className={`group-message-bubble ${mine ? 'mine' : 'theirs'}`}>
                            {!mine && <div className="group-message-sender">{message.senderName}</div>}
                            {message.message && <div className="group-message-text">{message.message}</div>}
                            {!!message.attachments?.length && (
                              <div className="group-message-attachments">
                                <ChatAttachmentGallery attachments={message.attachments} />
                              </div>
                            )}
                            <div className="group-message-meta">
                              <span>{formatMessageTime(message.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="group-chat-composer">
                  {!!directPendingAttachments.length && (
                    <div className="group-chat-attachment-strip">
                      {directPendingAttachments.map((attachment, index) => (
                        <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="group-chat-attachment-pill">
                          <span>{getAttachmentLabel(attachment)}</span>
                          <button
                            type="button"
                            onClick={() =>
                              setDirectPendingAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index))
                            }
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="group-chat-composer-shell">
                    <button
                      type="button"
                      className="group-chat-tool-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openAttachmentPicker('files', handleDirectAttachmentSelect);
                      }}
                      title="Attach files"
                      disabled={uploadingDirectAttachment}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="group-chat-tool-btn"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        openAttachmentPicker('folder', handleDirectAttachmentSelect);
                      }}
                      title="Attach folder"
                      disabled={uploadingDirectAttachment}
                    >
                      F
                    </button>
                    <input
                      className="groups-input group-chat-input"
                      type="text"
                      placeholder={uploadingDirectAttachment ? 'Uploading attachment...' : 'Type a direct message'}
                      value={directNewMessage}
                      onChange={(event) => setDirectNewMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          sendDirectMessage();
                        }
                      }}
                    />
                    <button
                      className="group-chat-send-btn"
                      onClick={sendDirectMessage}
                      disabled={
                        sendingDirectMessage ||
                        uploadingDirectAttachment ||
                        (!directNewMessage.trim() && directPendingAttachments.length === 0)
                      }
                    >
                      <span className={`group-chat-send-icon ${sendingDirectMessage ? 'sending' : ''}`} />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const handleToggleMinimize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  if (variant === 'overlay') {
    if (!isOpen) return null;
    return (
      <div
        className={`group-message-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      >
        <div
          className={`group-message-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
          style={minimizedWindowStyle || undefined}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            className="group-message-modal-header"
            onClick={isMinimized ? () => setIsMinimized(false) : undefined}
          >
            <div className="group-message-modal-copy">
              <h3>Message System</h3>
              <p>Groups, conversations, and shared attachments</p>
            </div>
            <div className="group-message-window-controls">
              {!isMinimized && (
                <button
                  type="button"
                  className="group-message-window-btn"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleToggleMinimize();
                  }}
                  title="Minimize"
                >
                  ─
                </button>
              )}
              <button
                type="button"
                className="group-message-window-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleMaximize();
                }}
                title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
              >
                {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
              </button>
              <button
                type="button"
                className="group-message-modal-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose();
                }}
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>
          {!isMinimized && <div className="group-message-panel-body">{content}</div>}
        </div>
      </div>
    );
  }

  return content;
};

export default GroupMessagePanel;
