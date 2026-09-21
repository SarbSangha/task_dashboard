import './render-smoke.stubs.js';
import { captured } from './axios-capture.js';
import { taskAPI } from '../src/services/api.js';

async function main() {
const checks = [];
const check = (name, cond) => checks.push([name, cond]);

await taskAPI.createTask({
  title: 'T', description: 'd', projectName: 'P', customerName: 'C',
  taskType: 'task', taskTag: 'Audio', priority: 'medium', toDepartment: 'CONTENT',
  assigneeIds: [7], approverIds: [15], approvalMode: 'all', submissionMode: 'all',
  links: [], attachments: [],
});
check('plain task: approverIds reach the request', JSON.stringify(captured.last?.data?.approverIds) === '[15]');
check('plain task: approvalMode reaches the request', captured.last?.data?.approvalMode === 'all');

await taskAPI.createTask({
  title: 'W', toDepartment: 'CONTENT', taskTag: 'Audio', assigneeIds: [],
  approverIds: [], approvalMode: 'any', links: [], attachments: [],
  workflow: { enabled: true, finalApprovalRequired: true, stages: [
    { order: 1, title: 'S1', assigneeIds: [7], approverIds: [15], approvalMode: 'any', approvalRequired: true },
  ] },
});
const st = captured.last?.data?.workflow?.stages?.[0];
check('workflow stage: approverIds reach the request', JSON.stringify(st?.approverIds) === '[15]');
check('workflow stage: approvalMode reaches the request', st?.approvalMode === 'any');

await taskAPI.createTask({
  title: 'N', toDepartment: 'CONTENT', taskTag: 'Audio', assigneeIds: [7],
  links: [], attachments: [],
});
check('no approver chosen: sends empty list, not undefined', JSON.stringify(captured.last?.data?.approverIds) === '[]');

let failed = 0;
for (const [n, ok] of checks) { console.log((ok ? '  ok  ' : '  FAIL  ') + n); if (!ok) failed++; }
console.log(failed ? `\n${failed} of ${checks.length} FAILED` : `\n${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
}
main();
