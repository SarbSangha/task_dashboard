import { useState } from 'react';
import { buildFileThumbnailUrl, buildFileDownloadUrl } from '../../../../../../utils/fileLinks';
import { isVideo, displayName, formatLabel, toFile } from './mediaHelpers';

// Presentational media tile shared by the timeline + gallery views. Lazy
// thumbnail via the existing /api/files/thumbnail endpoint (object-fit cover),
// graceful fallback icon on error. `subtitle`/`badge`/`caption` are optional
// (the gallery uses them to show the prompt preview + generation number).
export default function MediaTile({ asset, onOpen, subtitle, badge, caption }) {
  const [failed, setFailed] = useState(false);
  const file = toFile(asset);
  const name = displayName(asset);
  const video = isVideo(asset);
  const thumbUrl = buildFileThumbnailUrl(file, 480);
  const downloadUrl = buildFileDownloadUrl(file, name);

  return (
    <div className="cgpt-gen-tile">
      <button type="button" className="cgpt-gen-tile-thumb" onClick={() => onOpen(asset)} aria-label={`Preview ${name}`}>
        {video ? (
          <span className="cgpt-media-thumb-video" aria-hidden="true">▶</span>
        ) : failed || !thumbUrl ? (
          <span className="cgpt-media-thumb-fallback" aria-hidden="true">🖼</span>
        ) : (
          <img src={thumbUrl} alt={name} loading="lazy" decoding="async" onError={() => setFailed(true)} />
        )}
        <span className="cgpt-media-type-badge">{video ? 'Video' : formatLabel(asset)}</span>
        {badge ? <span className="cgpt-gen-tile-badge">{badge}</span> : null}
        {asset.status === 'failed' && <span className="cgpt-gen-tile-failed" title="Capture failed">!</span>}
      </button>
      <div className="cgpt-gen-tile-foot">
        <span className="cgpt-gen-tile-name" title={subtitle || name}>{subtitle || name}</span>
        {caption ? <span className="cgpt-gen-tile-caption">{caption}</span> : null}
        <div className="cgpt-gen-tile-actions">
          <button type="button" className="cgpt-media-action" onClick={() => onOpen(asset)}>Preview</button>
          {downloadUrl ? <a className="cgpt-media-action" href={downloadUrl} target="_blank" rel="noreferrer">Download</a> : null}
        </div>
      </div>
    </div>
  );
}
