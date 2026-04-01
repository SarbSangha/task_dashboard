import { SkeletonBlock } from './Skeleton';

const SECTION_CARD_STYLE = {
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 12,
};

function OverviewSkeleton() {
  return (
    <>
      <div className="overview-grid" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="overview-card">
            <SkeletonBlock width={46} height={46} rounded />
            <div style={{ flex: 1, display: 'grid', gap: 10 }}>
              <SkeletonBlock width={52} height={28} />
              <SkeletonBlock width="52%" height={12} />
            </div>
          </div>
        ))}
      </div>

      <div className="recent-activity" aria-hidden="true">
        <SkeletonBlock width={144} height={18} style={{ marginBottom: 16 }} />
        <div className="activity-list">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="activity-item">
              <SkeletonBlock width={28} height={28} rounded />
              <div style={{ flex: 1, display: 'grid', gap: 8 }}>
                <SkeletonBlock width={index % 2 === 0 ? '78%' : '64%'} height={12} />
                <SkeletonBlock width="46%" height={12} />
              </div>
              <SkeletonBlock width={52} height={12} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ProjectsSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="projects-toolbar">
        <SkeletonBlock height={44} rounded />
        <SkeletonBlock width="42%" height={12} />
      </div>

      <div className="projects-live-layout">
        <div className="projects-grid">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="project-card">
              <div className="project-header">
                <SkeletonBlock width={index % 2 === 0 ? '58%' : '46%'} height={18} />
                <SkeletonBlock width={84} height={24} rounded />
              </div>
              <div style={{ display: 'grid', gap: 10 }}>
                <SkeletonBlock width="44%" height={12} />
                <SkeletonBlock width="100%" height={12} />
                <SkeletonBlock width="72%" height={12} />
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
                <SkeletonBlock width={86} height={20} rounded />
                <SkeletonBlock width={104} height={20} rounded />
                <SkeletonBlock width={72} height={20} rounded />
              </div>
              <div style={{ display: 'grid', gap: 8, marginTop: 16 }}>
                <SkeletonBlock width="100%" height={6} rounded />
                <SkeletonBlock width="56%" height={12} />
              </div>
            </div>
          ))}
        </div>

        <div className="project-folder-panel">
          <div className="project-folder-panel-header">
            <div style={{ flex: 1, display: 'grid', gap: 10 }}>
              <SkeletonBlock width={112} height={22} rounded />
              <SkeletonBlock width="46%" height={24} />
              <SkeletonBlock width="68%" height={12} />
            </div>
            <SkeletonBlock width={88} height={28} rounded />
          </div>

          <div className="project-folder-summary">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="overview-card compact">
                <div style={{ display: 'grid', gap: 10, width: '100%' }}>
                  <SkeletonBlock width={44} height={26} />
                  <SkeletonBlock width="60%" height={12} />
                </div>
              </div>
            ))}
          </div>

          <div className="project-task-list">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="project-task-item">
                <div className="project-task-main" style={{ flex: 1, display: 'grid', gap: 10 }}>
                  <SkeletonBlock width={index % 2 === 0 ? '60%' : '74%'} height={14} />
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <SkeletonBlock width={104} height={20} rounded />
                    <SkeletonBlock width={88} height={20} rounded />
                  </div>
                </div>
                <div className="project-task-side" style={{ minWidth: 120 }}>
                  <SkeletonBlock width={70} height={22} rounded />
                  <SkeletonBlock width={86} height={12} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamSkeleton() {
  return (
    <div className="team-grid" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="team-member-card">
          <SkeletonBlock width={50} height={50} rounded />
          <div style={{ flex: 1, display: 'grid', gap: 8 }}>
            <SkeletonBlock width={index % 2 === 0 ? '58%' : '70%'} height={14} />
            <SkeletonBlock width="44%" height={12} />
            <SkeletonBlock width="36%" height={12} />
          </div>
          <SkeletonBlock width={32} height={32} rounded />
        </div>
      ))}
    </div>
  );
}

function CompanySkeleton() {
  return (
    <div aria-hidden="true">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 10,
          marginBottom: 14,
        }}
      >
        {Array.from({ length: 5 }).map((_, index) => (
          <div
            key={index}
            style={{
              ...SECTION_CARD_STYLE,
              padding: '10px 16px',
            }}
          >
            <SkeletonBlock width={`${60 + (index % 3) * 10}%`} height={14} />
          </div>
        ))}
      </div>

      <div className="team-grid">
        {Array.from({ length: 8 }).map((_, index) => (
          <div key={index} className="team-member-card company-member-card">
            <SkeletonBlock width={50} height={50} rounded />
            <div style={{ flex: 1, display: 'grid', gap: 8 }}>
              <SkeletonBlock width={index % 2 === 0 ? '60%' : '74%'} height={14} />
              <SkeletonBlock width="46%" height={12} />
              <SkeletonBlock width="38%" height={12} />
            </div>
            <SkeletonBlock width={32} height={32} rounded />
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyticsSkeleton() {
  return (
    <div className="analytics-grid" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="analytics-card">
          <SkeletonBlock width="52%" height={14} style={{ marginBottom: 16 }} />
          <SkeletonBlock width="34%" height={38} style={{ marginBottom: 12 }} />
          <SkeletonBlock width={index % 2 === 0 ? '64%' : '72%'} height={12} />
        </div>
      ))}

      <div className="analytics-card analytics-card-wide">
        <SkeletonBlock width={132} height={14} style={{ marginBottom: 18 }} />
        <div className="analytics-mini-grid">
          {Array.from({ length: 3 }).map((_, index) => (
            <div key={index} className="analytics-mini-stat">
              <SkeletonBlock width="54%" height={12} style={{ marginBottom: 12 }} />
              <SkeletonBlock width="36%" height={30} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceSkeleton({ variant = 'overview' }) {
  if (variant === 'projects') return <ProjectsSkeleton />;
  if (variant === 'team') return <TeamSkeleton />;
  if (variant === 'company') return <CompanySkeleton />;
  if (variant === 'analytics') return <AnalyticsSkeleton />;
  return <OverviewSkeleton />;
}
