import React from 'react';

export default function TasksTab() {
  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>All Tasks</h3>
        <button className="add-btn">+ Add Task</button>
      </div>
      <div className="tasks-list">
        <div className="task-item">
          <input type="checkbox" className="task-checkbox" />
          <div className="task-details">
            <div className="task-title">Update documentation</div>
            <div className="task-meta">Due: Today • Priority: High</div>
          </div>
        </div>
        <div className="task-item">
          <input type="checkbox" className="task-checkbox" />
          <div className="task-details">
            <div className="task-title">Review pull requests</div>
            <div className="task-meta">Due: Tomorrow • Priority: Medium</div>
          </div>
        </div>
        <div className="task-item completed">
          <input type="checkbox" className="task-checkbox" checked readOnly />
          <div className="task-details">
            <div className="task-title">Fix login bug</div>
            <div className="task-meta">Completed yesterday</div>
          </div>
        </div>
      </div>
    </div>
  );
}
