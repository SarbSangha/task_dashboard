import React, { useState, useMemo } from 'react';
import './Outbox.css';
import OutboxTaskCard from './OutboxTaskCard';

const FILTERS = ['All Dispatched', 'Awaiting Acceptance', 'Needs Reimprovement', 'Drafts'];

const mockOutboxTasks = [
  {
    id: 1,
    title: 'Tork dense Alpha',
    project: 'Project Alpha',
    recipientName: 'John Smith',
    status: 'Working',
    sentTime: 'Sent 10:51am',
    sentDate: 'Sent 201.00 Afn. MM 20B90',
    action: 'Accepted'
  }
];

const Outbox = () => {
  const [activeFilter, setActiveFilter] = useState('All Dispatched');
  const [expandedTaskId, setExpandedTaskId] = useState(null);

  const filteredTasks = useMemo(() => {
    if (activeFilter === 'All Dispatched') return mockOutboxTasks;
    return mockOutboxTasks.filter((t) => t.action === activeFilter);
  }, [activeFilter]);

  const handleCardClick = (id) => {
    setExpandedTaskId((prev) => (prev === id ? null : id));
  };

  return (
    <section className="outbox-section">
      <div className="outbox-header-row">
        <h2 className="outbox-title">MY OUTBOX</h2>

        <div className="outbox-filters">
          {FILTERS.map((filter) => (
            <button
              key={filter}
              className={`outbox-filter-btn ${activeFilter === filter ? 'active' : ''}`}
              onClick={() => {
                setActiveFilter(filter);
                setExpandedTaskId(null);
              }}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>

      <div className="outbox-grid">
        {filteredTasks.map((task) => (
          <OutboxTaskCard
            key={task.id}
            task={task}
            isExpanded={expandedTaskId === task.id}
            onClick={handleCardClick}
          />
        ))}
      </div>
    </section>
  );
};

export default Outbox;
