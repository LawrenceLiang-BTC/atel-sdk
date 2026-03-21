import { describe, expect, it } from 'vitest';
import { buildAgentCallbackAction, getDirectExecutableActions, shouldSkipAgentHook } from '../bin/notification-action-helpers.mjs';

describe('notification direct actions', () => {
  it('directly executes approve_plan for order_accepted', () => {
    const actions = [
      { type: 'cli', action: 'view_plan', command: ['atel', 'milestone-status', 'ord-1'] },
      { type: 'cli', action: 'approve_plan', command: ['atel', 'milestone-feedback', 'ord-1', '--approve'] },
    ];

    expect(getDirectExecutableActions('order_accepted', actions)).toEqual([
      { type: 'cli', action: 'approve_plan', command: ['atel', 'milestone-feedback', 'ord-1', '--approve'] },
    ]);
  });

  it('does not directly execute content-generation milestone actions', () => {
    const actions = [
      { type: 'cli', action: 'submit_milestone', command: ['atel', 'milestone-submit', 'ord-1', '0', '--result', '<你的交付内容>'] },
    ];

    expect(getDirectExecutableActions('milestone_plan_confirmed', actions)).toEqual([]);
  });

  it('skips chat-agent hook after direct order_accepted execution succeeds', () => {
    expect(shouldSkipAgentHook('order_accepted', true)).toBe(true);
    expect(shouldSkipAgentHook('order_accepted', false)).toBe(false);
    expect(shouldSkipAgentHook('milestone_plan_confirmed', true)).toBe(false);
  });

  it('builds milestone submit action from gateway callback result', () => {
    expect(buildAgentCallbackAction('milestone_plan_confirmed', { orderId: 'ord-1', milestoneIndex: 0 }, { result: '完成的M0内容' })).toEqual({
      ok: true,
      action: {
        type: 'cli',
        action: 'submit_milestone',
        command: ['atel', 'milestone-submit', 'ord-1', '0', '--result', '完成的M0内容'],
      },
    });
  });

  it('builds pass/reject verify actions from gateway callback decision', () => {
    expect(buildAgentCallbackAction('milestone_submitted', { orderId: 'ord-1', milestoneIndex: 2 }, { decision: 'pass' })).toEqual({
      ok: true,
      action: {
        type: 'cli',
        action: 'pass',
        command: ['atel', 'milestone-verify', 'ord-1', '2', '--pass'],
      },
    });

    expect(buildAgentCallbackAction('milestone_submitted', { orderId: 'ord-1', milestoneIndex: 2 }, { decision: 'reject', reason: '需要补充引用来源' })).toEqual({
      ok: true,
      action: {
        type: 'cli',
        action: 'reject',
        command: ['atel', 'milestone-verify', 'ord-1', '2', '--reject', '需要补充引用来源'],
      },
    });
  });
});
