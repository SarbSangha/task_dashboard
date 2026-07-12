import React, { useCallback, useEffect, useState } from 'react';
import { generationRecordsAPI } from '../../../../../services/api';
import { getGenerationMediaKind, truncateText, formatGenerationDate } from './klingMedia';

const PAGE_SIZE = 24;

export default function KlingUnclaimedExplorer({ onOpenGeneration }) {
  const [generations, setGenerations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [claimingIds, setClaimingIds] = useState(() => new Set());
  const [claimError, setClaimError] = useState('');

  const loadPage = useCallback(async (requestOffset) => {
    setLoading(true);
    setError('');
    try {
      const response = await generationRecordsAPI.search({
        ownership_status: 'unknown',
        sort: 'latest',
        limit: PAGE_SIZE,
        offset: requestOffset,
      });
      setGenerations(Array.isArray(response?.data) ? response.data : []);
      setHasMore(Boolean(response?.pagination?.hasMore));
    } catch (fetchError) {
      console.error('Failed to load unclaimed Kling generations:', fetchError);
      setError('Could not load unclaimed generations right now.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(offset);
  }, [loadPage, offset]);

  const handlePrevious = useCallback(() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE)), []);
  const handleNext = useCallback(() => setOffset((prev) => prev + PAGE_SIZE), []);

  const handleClaim = useCallback(async (generation) => {
    setClaimingIds((prev) => new Set(prev).add(generation.id));
    setClaimError('');
    try {
      await generationRecordsAPI.claim(generation.id);
      setGenerations((prev) => prev.filter((item) => item.id !== generation.id));
    } catch (claimRequestError) {
      console.error('Failed to claim Kling generation:', claimRequestError);
      setClaimError(
        claimRequestError?.response?.data?.detail || 'Could not claim this generation right now.'
      );
    } finally {
      setClaimingIds((prev) => {
        const next = new Set(prev);
        next.delete(generation.id);
        return next;
      });
    }
  }, []);

  return (
    <div className="kling-projects-explorer">
      <div className="kling-unclaimed-intro">
        Generations reconciliation recovered without a known owner. If one of these is yours, claim it.
      </div>

      {claimError && <div className="kling-state kling-state-error">{claimError}</div>}
      {error && <div className="kling-state kling-state-error">{error}</div>}
      {!error && loading && <div className="kling-state">Loading unclaimed generations...</div>}
      {!error && !loading && generations.length === 0 && (
        <div className="kling-state">No unclaimed generations right now.</div>
      )}

      {!error && !loading && generations.length > 0 && (
        <>
          <div className="kling-projects-grid">
            {generations.map((generation) => {
              const mediaKind = getGenerationMediaKind(generation);
              const isClaiming = claimingIds.has(generation.id);
              return (
                <div className="kling-project-card kling-unclaimed-card" key={generation.id}>
                  <button
                    type="button"
                    className="kling-unclaimed-card-body-btn"
                    onClick={() => onOpenGeneration?.(generation)}
                  >
                    <div className="kling-user-card-header">
                      <span className={`type-badge ${mediaKind}`}>{mediaKind}</span>
                      <div className="kling-user-card-heading">
                        <h4 className="kling-project-card-title">{generation.modelLabel || 'Unknown model'}</h4>
                        <span className="kling-user-card-department">{formatGenerationDate(generation.createdAt)}</span>
                      </div>
                    </div>
                    <div className="kling-project-card-body">
                      <p className="kling-project-card-description">
                        {truncateText(generation.promptText, 90) || 'No prompt captured'}
                      </p>
                      <div className="kling-project-card-stats">
                        <span>{Math.round(generation.creditsBurned || 0)} credits</span>
                        <span>{generation.resolutionLabel || generation.durationLabel || ''}</span>
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="kling-unclaimed-claim-btn"
                    disabled={isClaiming}
                    onClick={() => handleClaim(generation)}
                  >
                    {isClaiming ? 'Claiming...' : 'This was done by me'}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="kling-projects-pagination">
            <button type="button" onClick={handlePrevious} disabled={offset === 0}>
              Previous
            </button>
            <span>Page {Math.floor(offset / PAGE_SIZE) + 1}</span>
            <button type="button" onClick={handleNext} disabled={!hasMore}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
