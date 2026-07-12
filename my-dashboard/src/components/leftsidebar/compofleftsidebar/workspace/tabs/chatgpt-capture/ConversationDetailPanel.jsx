import { useCallback, useEffect, useMemo, useState } from 'react';
import ConversationChatView from './ConversationChatView';
import ConversationHeaderCard from './ConversationHeaderCard';
import ConversationTimelineLog from './ConversationTimelineLog';
import RawEventsList from './RawEventsList';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { normalizeApiError } from './chatgptCaptureUtils';

const VIEW_TABS = [
  { key: 'conversation', label: 'Conversation' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'raw', label: 'Raw Events' },
];

export default function ConversationDetailPanel({ conversationId, onClose, emptyStateMode = 'conversation' }) {
  const [viewTab, setViewTab] = useState('conversation');

  const [timelineEvents, setTimelineEvents] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');

  const [conversationDetail, setConversationDetail] = useState(null);
  const [conversationDetailLoading, setConversationDetailLoading] = useState(false);
  const [conversationDetailError, setConversationDetailError] = useState('');

  const [conversationMessages, setConversationMessages] = useState(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState('');

  const [conversationAttachments, setConversationAttachments] = useState([]);

  const loadTimeline = useCallback(async (id) => {
    if (!id) return;
    setTimelineLoading(true);
    setTimelineError('');
    try {
      const response = await chatgptCaptureAPI.listEvents({ conversation_id: id, limit: 200 });
      // API returns newest-first; a timeline/chat view reads naturally oldest-first.
      setTimelineEvents([...response.data].reverse());
    } catch (error) {
      setTimelineError(normalizeApiError(error, 'Unable to load this conversation’s events.'));
    } finally {
      setTimelineLoading(false);
    }
  }, []);

  const loadConversationDetail = useCallback(async (id) => {
    if (!id) return;
    setConversationDetailLoading(true);
    setConversationDetailError('');
    try {
      const response = await chatgptCaptureAPI.getConversation(id);
      setConversationDetail(response.data);
    } catch (error) {
      setConversationDetailError(normalizeApiError(error, 'Unable to load this conversation.'));
    } finally {
      setConversationDetailLoading(false);
    }
  }, []);

  const loadConversationMessages = useCallback(async (id) => {
    if (!id) return;
    setMessagesLoading(true);
    setMessagesError('');
    try {
      const response = await chatgptCaptureAPI.getConversationMessages(id, { limit: 200 });
      setConversationMessages(response.data);
    } catch (error) {
      setMessagesError(normalizeApiError(error, 'Unable to load this conversation’s messages.'));
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  const loadConversationAttachments = useCallback(async (id) => {
    if (!id) return;
    try {
      const response = await chatgptCaptureAPI.getConversationAttachments(id);
      setConversationAttachments(response.data || []);
    } catch {
      // Supplementary media, not core capture data - a failed fetch here just
      // means no image previews for this conversation, never an error banner
      // over the conversation itself.
      setConversationAttachments([]);
    }
  }, []);

  useEffect(() => {
    if (!conversationId) return;
    setViewTab('conversation');
    loadTimeline(conversationId);
    loadConversationDetail(conversationId);
    loadConversationMessages(conversationId);
    loadConversationAttachments(conversationId);
  }, [conversationId, loadTimeline, loadConversationDetail, loadConversationMessages, loadConversationAttachments]);

  const eventsById = useMemo(() => new Map(timelineEvents.map((event) => [event.id, event])), [timelineEvents]);
  const isTimelineTruncated = Boolean(
    conversationDetail && conversationDetail.eventCount > timelineEvents.length
  );

  if (!conversationId) {
    return (
      <div className="chatgpt-capture-panel chatgpt-capture-detail-panel">
        <div className="chatgpt-capture-empty-state">
          {emptyStateMode === 'user' ? (
            <>
              <strong>Select a user</strong>
              <p>Choose a person on the left to see their captured ChatGPT conversations.</p>
            </>
          ) : (
            <>
              <strong>Select a conversation</strong>
              <p>Choose a conversation on the left to see what was captured - the prompt, the response, and any images or files.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="chatgpt-capture-panel chatgpt-capture-detail-panel">
      <div className="chatgpt-capture-detail-sticky-head">
        <div className="chatgpt-capture-panel-subhead">
          <button type="button" className="chatgpt-capture-back-btn" onClick={onClose}>
            ← Back to conversations
          </button>
          <div className="chatgpt-capture-view-tabs" role="tablist" aria-label="Conversation view">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={viewTab === tab.key}
                className={`chatgpt-capture-view-tab${viewTab === tab.key ? ' active' : ''}`}
                onClick={() => setViewTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <ConversationHeaderCard
          detail={conversationDetail}
          loading={conversationDetailLoading}
          error={conversationDetailError}
        />
      </div>

      {!timelineLoading && !timelineError && isTimelineTruncated && (
        <p className="chatgpt-capture-inline-note">
          Showing the most recent {timelineEvents.length} of {conversationDetail.eventCount} events for this conversation.
        </p>
      )}

      {viewTab === 'conversation' && (
        <ConversationChatView
          messages={conversationMessages?.messages}
          truncated={conversationMessages?.truncated}
          totalEvents={conversationMessages?.totalEvents}
          eventsById={eventsById}
          storedAttachments={conversationAttachments}
          ownerName={conversationDetail?.ownerName}
          loading={messagesLoading}
          error={messagesError}
        />
      )}

      {viewTab === 'timeline' && (
        <ConversationTimelineLog events={timelineEvents} loading={timelineLoading} error={timelineError} />
      )}

      {viewTab === 'raw' && (
        <RawEventsList
          events={timelineEvents}
          loading={timelineLoading}
          error={timelineError}
          emptyTitle="No events"
          emptyBody="Nothing has been captured for this conversation."
        />
      )}
    </div>
  );
}
