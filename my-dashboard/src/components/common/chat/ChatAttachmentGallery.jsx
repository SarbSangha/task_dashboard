import React, { useEffect, useMemo, useState } from 'react';
import { getAttachmentDisplayName, getFileRelativePath } from '../../../utils/fileUploads';
import './ChatAttachmentGallery.css';

const FILES_API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function normalizePath(value) {
  return `${value || ''}`.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function getFolderRootName(attachment) {
  const relativePath = normalizePath(getFileRelativePath(attachment));
  if (!relativePath.includes('/')) return null;
  return relativePath.split('/')[0] || null;
}

function getFolderRelativeParts(attachment, folderName) {
  const relativePath = normalizePath(getFileRelativePath(attachment));
  if (!relativePath) {
    return [getAttachmentDisplayName(attachment)];
  }

  const parts = relativePath.split('/').filter(Boolean);
  return parts[0] === folderName ? parts.slice(1) : parts;
}

function buildAttachmentOpenUrl(attachment) {
  const params = new URLSearchParams();
  if (attachment?.path) params.set('path', attachment.path);
  else if (attachment?.url) params.set('url', attachment.url);
  return `${FILES_API_BASE}/api/files/open?${params.toString()}`;
}

function buildAttachmentDownloadUrl(attachment) {
  const params = new URLSearchParams();
  if (attachment?.path) params.set('path', attachment.path);
  else if (attachment?.url) params.set('url', attachment.url);
  if (attachment?.originalName || attachment?.filename) {
    params.set('filename', attachment.originalName || attachment.filename);
  }
  return `${FILES_API_BASE}/api/files/download?${params.toString()}`;
}

function buildFolderDownloadUrl(folderGroup) {
  const params = new URLSearchParams();
  folderGroup.attachments.forEach((attachment, index) => {
    if (attachment?.path) params.append('path', attachment.path);
    else if (attachment?.url) params.append('path', attachment.url);

    const relativePath = normalizePath(getFileRelativePath(attachment));
    params.append(
      'relative_path',
      relativePath || attachment?.originalName || attachment?.filename || `file-${index + 1}`
    );
  });
  params.set('name', folderGroup.name);
  return `${FILES_API_BASE}/api/files/download-folder?${params.toString()}`;
}

function isImageAttachment(attachment) {
  return `${attachment?.mimetype || ''}`.startsWith('image/');
}

function isVideoAttachment(attachment) {
  return `${attachment?.mimetype || ''}`.startsWith('video/');
}

function buildAttachmentItems(attachments = []) {
  const folderMap = new Map();
  const ordered = [];

  attachments.forEach((attachment, index) => {
    if (!attachment) return;
    const rootName = getFolderRootName(attachment);
    if (!rootName) {
      ordered.push({
        type: 'file',
        id: `file-${index}-${attachment.path || attachment.url || attachment.filename || attachment.originalName || 'attachment'}`,
        attachment,
      });
      return;
    }

    if (!folderMap.has(rootName)) {
      const folderItem = {
        type: 'folder',
        id: `folder-${index}-${rootName}`,
        name: rootName,
        attachments: [],
      };
      folderMap.set(rootName, folderItem);
      ordered.push(folderItem);
    }

    folderMap.get(rootName).attachments.push(attachment);
  });

  return ordered.map((item) => {
    if (item.type !== 'folder') return item;
    return {
      ...item,
      fileCount: item.attachments.length,
      subfolderCount: new Set(
        item.attachments
          .map((attachment) => getFolderRelativeParts(attachment, item.name))
          .filter((parts) => parts.length > 1)
          .map((parts) => parts[0])
      ).size,
    };
  });
}

function buildFolderTree(folderGroup) {
  const root = {
    name: folderGroup.name,
    path: '',
    folders: [],
    files: [],
  };
  const lookup = new Map([['', root]]);

  const ensureFolder = (parentPath, name) => {
    const nextPath = parentPath ? `${parentPath}/${name}` : name;
    if (lookup.has(nextPath)) return lookup.get(nextPath);
    const node = {
      name,
      path: nextPath,
      folders: [],
      files: [],
    };
    lookup.set(nextPath, node);
    lookup.get(parentPath || '').folders.push(node);
    return node;
  };

  folderGroup.attachments.forEach((attachment, index) => {
    const parts = getFolderRelativeParts(attachment, folderGroup.name);
    let currentNode = root;

    if (parts.length <= 1) {
      currentNode.files.push({
        id: attachment.path || attachment.url || attachment.filename || `root-file-${index}`,
        name: parts[0] || getAttachmentDisplayName(attachment),
        attachment,
      });
      return;
    }

    parts.forEach((part, partIndex) => {
      const isFile = partIndex === parts.length - 1;
      if (isFile) {
        currentNode.files.push({
          id: attachment.path || attachment.url || attachment.filename || `nested-file-${index}`,
          name: part,
          attachment,
        });
        return;
      }
      currentNode = ensureFolder(currentNode.path, part);
    });
  });

  const sortTree = (node) => {
    node.folders.sort((left, right) => left.name.localeCompare(right.name));
    node.files.sort((left, right) => left.name.localeCompare(right.name));
    node.folders.forEach(sortTree);
  };

  sortTree(root);
  return root;
}

function flattenFolderTree(node, depth = 0) {
  const items = [{ path: node.path, name: node.path ? node.name : node.name, depth }];
  node.folders.forEach((folder) => {
    items.push(...flattenFolderTree(folder, depth + 1));
  });
  return items;
}

function getNodeByPath(node, path) {
  if (node.path === path) return node;
  for (const folder of node.folders) {
    const result = getNodeByPath(folder, path);
    if (result) return result;
  }
  return null;
}

function AttachmentFileCard({ attachment }) {
  const openUrl = buildAttachmentOpenUrl(attachment);
  const downloadUrl = buildAttachmentDownloadUrl(attachment);
  const label = getAttachmentDisplayName(attachment);

  return (
    <div className="chat-attachment-card">
      {isImageAttachment(attachment) ? (
        <img className="chat-attachment-preview chat-attachment-preview-media" src={openUrl} alt={label} />
      ) : isVideoAttachment(attachment) ? (
        <video
          className="chat-attachment-preview chat-attachment-preview-media"
          src={openUrl}
          controls
          preload="none"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ) : (
        <div className="chat-attachment-icon">+</div>
      )}
      <div className="chat-attachment-copy">
        <span>{label}</span>
        <small>{attachment.mimetype || 'Attachment'}</small>
      </div>
      <div className="chat-attachment-actions">
        <a className="chat-attachment-action" href={openUrl} target="_blank" rel="noreferrer">
          Preview
        </a>
        <a className="chat-attachment-action" href={downloadUrl} target="_blank" rel="noreferrer">
          Download
        </a>
      </div>
    </div>
  );
}

function FolderPreviewModal({ folderGroup, onClose }) {
  const folderTree = useMemo(() => buildFolderTree(folderGroup), [folderGroup]);
  const treeItems = useMemo(() => flattenFolderTree(folderTree), [folderTree]);
  const [activePath, setActivePath] = useState('');

  useEffect(() => {
    setActivePath('');
  }, [folderGroup.id]);

  const activeNode = getNodeByPath(folderTree, activePath) || folderTree;
  const breadcrumbs = [folderGroup.name, ...activeNode.path.split('/').filter(Boolean)];

  return (
    <>
      <div className="chat-folder-preview-overlay" onClick={onClose} />
      <div className="chat-folder-preview-modal" role="dialog" aria-modal="true" aria-label={`${folderGroup.name} preview`}>
        <div className="chat-folder-preview-header">
          <div>
            <h3>{folderGroup.name}</h3>
            <p>{folderGroup.fileCount} files{folderGroup.subfolderCount ? ` • ${folderGroup.subfolderCount} subfolders` : ''}</p>
          </div>
          <div className="chat-folder-preview-header-actions">
            <a className="chat-folder-preview-download" href={buildFolderDownloadUrl(folderGroup)} target="_blank" rel="noreferrer">
              Download Folder
            </a>
            <button type="button" className="chat-folder-preview-close" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="chat-folder-preview-body">
          <aside className="chat-folder-tree">
            {treeItems.map((item) => (
              <button
                key={`${folderGroup.id}-${item.path || 'root'}`}
                type="button"
                className={`chat-folder-tree-item ${activePath === item.path ? 'active' : ''}`}
                style={{ paddingLeft: `${18 + item.depth * 18}px` }}
                onClick={() => setActivePath(item.path)}
              >
                <span className="chat-folder-tree-icon">📁</span>
                <span>{item.name}</span>
              </button>
            ))}
          </aside>
          <section className="chat-folder-content">
            <div className="chat-folder-breadcrumbs">
              {breadcrumbs.map((crumb, index) => (
                <span key={`${crumb}-${index}`}>
                  {index > 0 ? ' / ' : ''}
                  {crumb}
                </span>
              ))}
            </div>
            <div className="chat-folder-grid">
              {activeNode.folders.map((folder) => (
                <button key={folder.path} type="button" className="chat-folder-entry folder" onClick={() => setActivePath(folder.path)}>
                  <span className="chat-folder-entry-icon">📁</span>
                  <span className="chat-folder-entry-name">{folder.name}</span>
                  <small>{folder.folders.length} folders • {folder.files.length} files</small>
                </button>
              ))}
              {activeNode.files.map((file) => (
                <div key={file.id} className="chat-folder-entry file">
                  <span className="chat-folder-entry-icon">📄</span>
                  <div className="chat-folder-entry-copy">
                    <span className="chat-folder-entry-name">{file.name}</span>
                    <small>{file.attachment.mimetype || 'File'}</small>
                  </div>
                  <div className="chat-folder-entry-actions">
                    <a href={buildAttachmentOpenUrl(file.attachment)} target="_blank" rel="noreferrer">Preview</a>
                    <a href={buildAttachmentDownloadUrl(file.attachment)} target="_blank" rel="noreferrer">Download</a>
                  </div>
                </div>
              ))}
              {activeNode.folders.length === 0 && activeNode.files.length === 0 && (
                <div className="chat-folder-empty">This folder is empty.</div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function FolderAttachmentCard({ folderGroup, onPreview }) {
  return (
    <div className="chat-attachment-card folder">
      <div className="chat-attachment-folder-icon">📁</div>
      <div className="chat-attachment-copy">
        <span>{folderGroup.name}</span>
        <small>{folderGroup.fileCount} files{folderGroup.subfolderCount ? ` • ${folderGroup.subfolderCount} subfolders` : ''}</small>
      </div>
      <div className="chat-attachment-actions">
        <button type="button" className="chat-attachment-action" onClick={onPreview}>
          Preview
        </button>
        <a className="chat-attachment-action" href={buildFolderDownloadUrl(folderGroup)} target="_blank" rel="noreferrer">
          Download
        </a>
      </div>
    </div>
  );
}

export default function ChatAttachmentGallery({ attachments = [] }) {
  const items = useMemo(() => buildAttachmentItems(attachments), [attachments]);
  const [previewFolderId, setPreviewFolderId] = useState(null);

  const previewFolder = useMemo(
    () => items.find((item) => item.type === 'folder' && item.id === previewFolderId) || null,
    [items, previewFolderId]
  );

  useEffect(() => {
    if (previewFolderId && !items.some((item) => item.id === previewFolderId)) {
      setPreviewFolderId(null);
    }
  }, [items, previewFolderId]);

  if (!items.length) return null;

  return (
    <>
      <div className="chat-attachment-gallery">
        {items.map((item) =>
          item.type === 'folder' ? (
            <FolderAttachmentCard key={item.id} folderGroup={item} onPreview={() => setPreviewFolderId(item.id)} />
          ) : (
            <AttachmentFileCard key={item.id} attachment={item.attachment} />
          )
        )}
      </div>
      {previewFolder && <FolderPreviewModal folderGroup={previewFolder} onClose={() => setPreviewFolderId(null)} />}
    </>
  );
}
