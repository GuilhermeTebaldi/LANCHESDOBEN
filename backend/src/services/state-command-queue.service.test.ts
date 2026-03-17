import assert from 'node:assert/strict';
import test from 'node:test';

import {
  STATE_COMMAND_JOB_STATUS,
  isQueueableCommandType,
  isTerminalJobStatus,
  normalizeJobStatus,
} from './state-command-queue.service.js';

test('state command queue only enables conservative confirm-paid async rollout', () => {
  assert.equal(isQueueableCommandType('SALE_DRAFT_CONFIRM_PAID'), true);
  assert.equal(isQueueableCommandType('SALE_DRAFT_FINALIZE'), false);
  assert.equal(isQueueableCommandType('SALE_DRAFT_ADD_ITEM'), false);
  assert.equal(isQueueableCommandType('SALE_REGISTER'), false);
});

test('normalizeJobStatus keeps supported statuses and fails safe to FAILED', () => {
  assert.equal(normalizeJobStatus('PENDING'), STATE_COMMAND_JOB_STATUS.PENDING);
  assert.equal(normalizeJobStatus('PROCESSING'), STATE_COMMAND_JOB_STATUS.PROCESSING);
  assert.equal(normalizeJobStatus('RETRY'), STATE_COMMAND_JOB_STATUS.RETRY);
  assert.equal(normalizeJobStatus('COMPLETED'), STATE_COMMAND_JOB_STATUS.COMPLETED);
  assert.equal(normalizeJobStatus('FAILED'), STATE_COMMAND_JOB_STATUS.FAILED);
  assert.equal(normalizeJobStatus('UNKNOWN'), STATE_COMMAND_JOB_STATUS.FAILED);
});

test('isTerminalJobStatus marks only completed and failed as final', () => {
  assert.equal(isTerminalJobStatus('PENDING'), false);
  assert.equal(isTerminalJobStatus('PROCESSING'), false);
  assert.equal(isTerminalJobStatus('RETRY'), false);
  assert.equal(isTerminalJobStatus('COMPLETED'), true);
  assert.equal(isTerminalJobStatus('FAILED'), true);
});
