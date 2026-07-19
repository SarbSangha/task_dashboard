import { useMemo } from 'react';
import MediaTile from './MediaTile';
import { formatRelativeTime } from './chatgptCaptureUtils';

function dateKey(value) {
  if (!value) return 'Undated';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Undated';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(d);
}

function promptPreview(gen) {
  if (gen.ungrouped) return 'Ungrouped media';
  if (!gen.promptText) return 'Prompt not captured';
  return gen.promptText.length > 70 ? `${gen.promptText.slice(0, 70)}…` : gen.promptText;
}

// Media-first view, but grouped by DATE -> GENERATION so the prompt->output
// relationship is preserved (not a flat wall of images). Reuses the same
// generations the timeline computed - no extra media loading.
export default function GenerationGalleryView({ generations, onOpen }) {
  const dateGroups = useMemo(() => {
    const groups = new Map();
    for (const gen of generations) {
      const key = dateKey(gen.responseTime || gen.media[0]?.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(gen);
    }
    return Array.from(groups.entries());
  }, [generations]);

  if (generations.length === 0) {
    return (
      <div className="cgpt-media-empty compact">
        <span className="cgpt-media-empty-icon" aria-hidden="true">🖼</span>
        <strong>No generated media yet</strong>
        <p>Images and videos created by ChatGPT appear here.</p>
      </div>
    );
  }

  return (
    <div className="cgpt-gallery">
      {dateGroups.map(([date, gens]) => (
        <div key={date} className="cgpt-gallery-dategroup">
          <div className="cgpt-gallery-date">{date}</div>
          {gens.map((gen) => (
            <div key={gen.ungrouped ? 'ungrouped' : `${gen.index}-${gen.anchorMs}`} className="cgpt-gallery-gen">
              <div className="cgpt-gallery-gen-head">
                <span className="cgpt-gen-index">{gen.ungrouped ? 'Ungrouped media' : `Generation #${gen.number}`}</span>
                <span className="cgpt-gallery-gen-prompt" title={gen.promptText || ''}>{promptPreview(gen)}</span>
                <span className="cgpt-gen-head-spacer" />
                <span className="cgpt-gen-metachip">{gen.media.length}</span>
              </div>
              <div className="cgpt-gallery-grid">
                {gen.media.map((asset) => (
                  <MediaTile key={asset.id} asset={asset} onOpen={onOpen} caption={gen.responseTime ? formatRelativeTime(gen.responseTime) : undefined} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
