import { useMemo, useState } from 'react';
import FilePreviewModal from '../../../../../common/FilePreviewModal';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import GenerationTimelineView from './GenerationTimelineView';
import GenerationGalleryView from './GenerationGalleryView';
import GenerationPromptView from './GenerationPromptView';
import GenerationIntelligenceView from './GenerationIntelligenceView';
import { formatRelativeTime } from './chatgptCaptureUtils';
import { MEDIA_FILTERS, buildGenerations, displayName, typeLabel, formatLabel } from './mediaHelpers';

const VIEW_MODES = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'gallery', label: 'Gallery' },
  { key: 'prompts', label: 'Prompts' },
  { key: 'intelligence', label: 'Intelligence' },
];

// Grouped filter chips (Type / Source / Status) - references the same
// MEDIA_FILTERS predicates, just laid out by category for a cleaner bar.
const FILTER_GROUPS = [
  { label: 'Type', keys: ['all', 'images', 'videos'] },
  { label: 'Source', keys: ['generated', 'fetched'] },
  { label: 'Status', keys: ['stored', 'failed'] },
];
const FILTER_BY_KEY = Object.fromEntries(MEDIA_FILTERS.map((f) => [f.key, f]));

function matchesSearch(generation, query) {
  if (!query) return true;
  const haystack = [
    generation.promptText || '',
    generation.responseText || '',
    ...generation.media.map((m) => displayName(m)),
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

export default function GenerationWorkspace({
  media = [],
  messages = [],
  loading = false,
  contextOn = false,
  onContextChange,
}) {
  const [viewMode, setViewMode] = useState('timeline');
  const [activeFilter, setActiveFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [previewAsset, setPreviewAsset] = useState(null);
  // Type/Source/Status refinements are collapsed by default (progressive
  // disclosure) so the generations show right under the tabs.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filter = FILTER_BY_KEY[activeFilter] || MEDIA_FILTERS[0];
  const filteredMedia = useMemo(
    () => (activeFilter === 'all' ? media : media.filter(filter.predicate)),
    [media, activeFilter, filter]
  );

  // Unfiltered generations power the header counts (stable totals).
  const allGenerations = useMemo(() => buildGenerations(messages, media), [messages, media]);
  const counts = useMemo(() => {
    const real = allGenerations.filter((g) => !g.ungrouped);
    return {
      creations: real.length,
      prompts: real.filter((g) => g.promptText).length,
      assets: media.length,
    };
  }, [allGenerations, media]);

  const query = search.trim().toLowerCase();
  const generations = useMemo(() => {
    const built = buildGenerations(messages, filteredMedia);
    return query ? built.filter((g) => matchesSearch(g, query)) : built;
  }, [messages, filteredMedia, query]);

  // Metadata for the preview modal ("why does this image exist?").
  const previewMeta = useMemo(() => {
    if (!previewAsset) return null;
    const gen = allGenerations.find((g) => g.media.some((m) => m.id === previewAsset.id));
    const meta = [
      { label: 'Type', value: typeLabel(previewAsset) },
      { label: 'Format', value: formatLabel(previewAsset) },
    ];
    if (gen && !gen.ungrouped) {
      if (gen.promptText) meta.unshift({ label: 'Prompt', value: gen.promptText });
      meta.push({ label: 'Generation', value: `#${gen.number}` });
    }
    if (previewAsset.createdAt) meta.push({ label: 'Created', value: formatRelativeTime(previewAsset.createdAt) });
    return meta;
  }, [previewAsset, allGenerations]);

  if (loading) {
    return (
      <section className="cgpt-gen-section" aria-busy="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="cgpt-gen-card-inner loading">
            <SkeletonBlock width="55%" height={12} />
            <SkeletonBlock width="85%" height={12} style={{ marginTop: 10 }} />
            <div className="cgpt-gen-media-grid" style={{ marginTop: 12 }}>
              <SkeletonBlock width="100%" height={130} />
              <SkeletonBlock width="100%" height={130} />
            </div>
          </div>
        ))}
      </section>
    );
  }

  if (!media.length) return null; // text-only conversation -> no empty workspace

  return (
    <section className="cgpt-gen-section">
      {/* Header: title + summary counts */}
      <div className="cgpt-ws-header">
        <div className="cgpt-ws-title">
          <h5>AI Generations</h5>
          <div className="cgpt-ws-counts">
            <span><strong>{counts.creations}</strong> creations</span>
            <span><strong>{counts.prompts}</strong> prompts</span>
            <span><strong>{counts.assets}</strong> media assets</span>
          </div>
        </div>
        {onContextChange && (
          <label className="cgpt-context-toggle">
            <input type="checkbox" checked={contextOn} onChange={(e) => onContextChange(e.target.checked)} />
            <span className="cgpt-context-track" aria-hidden="true"><span className="cgpt-context-knob" /></span>
            <span className="cgpt-context-label">Conversation context</span>
          </label>
        )}
      </div>

      {/* Tabs + search */}
      <div className="cgpt-workspace-bar">
        <div className="cgpt-workspace-tabs" role="tablist" aria-label="Generation view mode">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              role="tab"
              aria-selected={viewMode === mode.key}
              className={`cgpt-workspace-tab${viewMode === mode.key ? ' active' : ''}`}
              onClick={() => setViewMode(mode.key)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="cgpt-ws-bar-actions">
          <button
            type="button"
            className={`cgpt-ws-filter-toggle${filtersOpen ? ' open' : ''}${activeFilter !== 'all' ? ' active' : ''}`}
            onClick={() => setFiltersOpen((prev) => !prev)}
            aria-expanded={filtersOpen}
          >
            <span aria-hidden="true">⚙</span> Filter
            {activeFilter !== 'all' && <span className="cgpt-ws-filter-dot" aria-hidden="true" />}
            <span className="cgpt-ws-filter-caret" aria-hidden="true">▾</span>
          </button>
          <div className="cgpt-ws-search">
            <span className="cgpt-ws-search-icon" aria-hidden="true">🔍</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search generations…"
              aria-label="Search generations by prompt, response, or media name"
            />
          </div>
        </div>
      </div>

      {/* Grouped filters — collapsed by default */}
      {filtersOpen && (
        <div className="cgpt-ws-filters">
          {FILTER_GROUPS.map((group) => (
            <div key={group.label} className="cgpt-ws-filter-group">
              <span className="cgpt-ws-filter-label">{group.label}</span>
              <div className="cgpt-media-filters" role="group" aria-label={`Filter by ${group.label}`}>
                {group.keys.map((key) => {
                  const f = FILTER_BY_KEY[key];
                  if (!f) return null;
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`cgpt-media-filter${activeFilter === key ? ' active' : ''}`}
                      aria-pressed={activeFilter === key}
                      onClick={() => setActiveFilter(key)}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {generations.length === 0 ? (
        <div className="cgpt-media-empty compact">
          <span className="cgpt-media-empty-icon" aria-hidden="true">🎨</span>
          <strong>{query ? 'No matching generations' : `No ${filter.label.toLowerCase()} generations`}</strong>
          <p>{query ? 'Try a different search term.' : 'Nothing matches this filter in the current conversation.'}</p>
          <button
            type="button"
            className="cgpt-media-action"
            onClick={() => { setActiveFilter('all'); setSearch(''); }}
          >
            Reset
          </button>
        </div>
      ) : (
        <div className="cgpt-workspace-view">
          {viewMode === 'timeline' && <GenerationTimelineView generations={generations} onOpen={setPreviewAsset} />}
          {viewMode === 'gallery' && <GenerationGalleryView generations={generations} onOpen={setPreviewAsset} />}
          {viewMode === 'prompts' && <GenerationPromptView generations={generations} />}
          {viewMode === 'intelligence' && <GenerationIntelligenceView generations={generations} />}
        </div>
      )}

      {previewAsset ? (
        <FilePreviewModal
          file={{
            url: previewAsset.url,
            mimetype: previewAsset.mimeType || 'image/jpeg',
            originalName: displayName(previewAsset),
            filename: displayName(previewAsset),
          }}
          title={displayName(previewAsset)}
          subtitle={`${typeLabel(previewAsset)} · ${formatLabel(previewAsset)} · ${formatRelativeTime(previewAsset.createdAt)}`}
          metadata={previewMeta}
          onClose={() => setPreviewAsset(null)}
        />
      ) : null}
    </section>
  );
}
