import { useRef, useState } from 'react';
import { providerCardAdminAPI } from '../../services/api';
import { usePermissions } from '../../hooks/usePermissions';
import AdminCreditsEditor from './AdminCreditsEditor';
import '../leftsidebar/compofleftsidebar/trending/kling/KlingGenerationDrawer.css';

// The "Admin" section of a provider capture card's detail drawer: replace the
// card's media with an uploaded file, remove that upload again, enter / edit
// the card's credits, or delete the card. Provider-generic twin of
// KlingGenerationDrawer's admin section; the backend is
// routers/provider_card_admin_router.py.

const MAX_UPLOAD_BYTES = 90 * 1024 * 1024;

// Mirrors CARD_PROVIDERS in provider_card_admin_router.py; creditField is the
// card's credit value (CARD_CREDIT_COLUMNS in utils/admin_card_credits.py),
// wholeCredits where that column is an integer.
const PROVIDERS = {
  freepik: { name: 'Freepik', kinds: ['image', 'video'], creditField: 'creditsCharged' },
  higgsfield: { name: 'Higgsfield', kinds: ['image', 'video'], creditField: 'creditsUsed' },
  heygen: { name: 'HeyGen', kinds: ['video'], creditField: 'creditsUsed' },
  suno: { name: 'Suno', kinds: ['audio'], creditField: 'creditsUsed', wholeCredits: true },
  elevenlabs: { name: 'ElevenLabs', kinds: ['audio'], creditField: 'creditsUsed', wholeCredits: true },
  envato: { name: 'Envato', kinds: ['image', 'video', 'audio'], creditField: 'creditsBadge' },
  flow: { name: 'Flow', kinds: ['image', 'video'], creditField: 'creditsUsed', wholeCredits: true },
};

const KIND_ACCEPT = {
  image: 'image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif',
  video: 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov',
  audio: 'audio/mpeg,audio/wav,audio/mp4,audio/ogg,.mp3,.wav,.m4a,.ogg',
};

const KIND_NOUN = { image: 'Image', video: 'Video', audio: 'Audio' };

export default function AdminCardActions({ provider, generation, onUpdated, onDeleted }) {
  const { isAdmin } = usePermissions();
  const fileInputRef = useRef(null);
  const [pending, setPending] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState('');

  const config = PROVIDERS[provider];
  if (!isAdmin || !config || !generation?.id) return null;

  const noun = config.kinds.length === 1 ? KIND_NOUN[config.kinds[0]] : 'Media';
  const adminMedia = generation.adminMedia;

  const handleFileSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('File is larger than 90 MB.');
      return;
    }
    setPending('upload');
    setUploadProgress(0);
    setError('');
    try {
      const response = await providerCardAdminAPI.uploadMedia(provider, generation.id, file, { onProgress: setUploadProgress });
      if (response?.data) onUpdated?.(response.data);
    } catch (uploadError) {
      setError(uploadError?.response?.data?.detail || `Could not upload the ${noun.toLowerCase()}.`);
    } finally {
      setPending('');
    }
  };

  const handleRemove = async () => {
    if (!window.confirm(`Remove the uploaded ${noun.toLowerCase()}? The card goes back to the captured one, if there is one.`)) return;
    setPending('remove');
    setError('');
    try {
      const response = await providerCardAdminAPI.removeMedia(provider, generation.id);
      if (response?.data) onUpdated?.(response.data);
    } catch (removeError) {
      setError(removeError?.response?.data?.detail || `Could not remove the ${noun.toLowerCase()}.`);
    } finally {
      setPending('');
    }
  };

  const handleDelete = async () => {
    if (!window.confirm(`Delete this card? It will disappear from ${config.name} for everyone.`)) return;
    setPending('delete');
    setError('');
    try {
      await providerCardAdminAPI.deleteGeneration(provider, generation.id);
      onDeleted?.(generation.id);
    } catch (deleteError) {
      setError(deleteError?.response?.data?.detail || 'Could not delete the card.');
      setPending('');
    }
  };

  return (
    <div className="kling-drawer-section kling-drawer-admin">
      <h4>Admin</h4>
      {adminMedia && (
        <p className="kling-drawer-inline-note">
          Showing uploaded {KIND_NOUN[adminMedia.kind]?.toLowerCase() || 'media'}
          {adminMedia.fileName ? ` "${adminMedia.fileName}"` : ''}.
        </p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={config.kinds.map((kind) => KIND_ACCEPT[kind]).join(',')}
        hidden
        onChange={handleFileSelected}
      />
      <div className="kling-drawer-actions">
        <button
          type="button"
          className="kling-drawer-action-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={Boolean(pending)}
        >
          {pending === 'upload' ? `Uploading... ${uploadProgress}%` : `Replace ${noun}`}
        </button>
        {adminMedia && (
          <button type="button" className="kling-drawer-action-btn" onClick={handleRemove} disabled={Boolean(pending)}>
            {pending === 'remove' ? 'Removing...' : `Remove Uploaded ${noun}`}
          </button>
        )}
        <button
          type="button"
          className="kling-drawer-action-btn kling-drawer-danger-btn"
          onClick={handleDelete}
          disabled={Boolean(pending)}
        >
          {pending === 'delete' ? 'Deleting...' : 'Delete Card'}
        </button>
      </div>
      {error && <p className="kling-drawer-inline-error">{error}</p>}

      <h4>Credits</h4>
      <AdminCreditsEditor
        currentCredits={generation[config.creditField]}
        adminCredits={generation.adminCredits}
        whole={config.wholeCredits}
        onSave={async (value) => {
          const response = await providerCardAdminAPI.setCredits(provider, generation.id, value);
          if (response?.data) onUpdated?.(response.data);
        }}
        onReset={async () => {
          const response = await providerCardAdminAPI.resetCredits(provider, generation.id);
          if (response?.data) onUpdated?.(response.data);
        }}
      />
    </div>
  );
}
