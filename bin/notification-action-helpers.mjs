export function getDirectExecutableActions(eventType, recommendedActions) {
  if (!Array.isArray(recommendedActions) || recommendedActions.length === 0) return [];

  if (eventType === 'order_accepted') {
    return recommendedActions.filter((action) =>
      action?.type === 'cli' &&
      action?.action === 'approve_plan' &&
      Array.isArray(action.command) &&
      action.command[0] === 'atel'
    );
  }

  return [];
}

export function shouldSkipAgentHook(eventType, directExecutionSucceeded) {
  return eventType === 'order_accepted' && directExecutionSucceeded;
}

export function shouldUseGatewaySession(eventType) {
  return [
    'p2p_task',
    'milestone_plan_confirmed',
    'milestone_submitted',
    'milestone_verified',
    'milestone_rejected',
  ].includes(eventType);
}

export function normalizeGatewayBind(bind) {
  if (!bind) return '127.0.0.1';
  if (bind === 'loopback' || bind === 'localhost') return '127.0.0.1';
  if (bind === '0.0.0.0' || bind === '::' || bind === '::1') return '127.0.0.1';
  return bind;
}

function normalizeIndex(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeResult(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function buildAgentCallbackAction(eventType, payload, body) {
  if (eventType === 'p2p_task') {
    const taskId = payload?.taskId;
    if (!taskId) return { ok: false, error: 'missing_task_id' };
    const result = normalizeResult(body?.result || body?.summary);
    if (!result) return { ok: false, error: 'missing_result' };
    return {
      ok: true,
      action: {
        type: 'local_result',
        action: 'complete_p2p_task',
        taskId,
        result,
      },
    };
  }

  const orderId = payload?.orderId;
  if (!orderId) return { ok: false, error: 'missing_order_id' };

  if (eventType === 'milestone_plan_confirmed') {
    const result = normalizeResult(body?.result || body?.summary);
    if (!result) return { ok: false, error: 'missing_result' };
    const index = normalizeIndex(payload?.milestoneIndex, 0);
    return {
      ok: true,
      action: {
        type: 'cli',
        action: 'submit_milestone',
        command: ['atel', 'milestone-submit', orderId, String(index), '--result', result],
      },
    };
  }

  if (eventType === 'milestone_verified') {
    if (payload?.allComplete) return { ok: false, skipped: true, reason: 'all_complete' };
    const result = normalizeResult(body?.result || body?.summary);
    if (!result) return { ok: false, error: 'missing_result' };
    const index = normalizeIndex(payload?.currentMilestone, 0);
    return {
      ok: true,
      action: {
        type: 'cli',
        action: 'submit_milestone',
        command: ['atel', 'milestone-submit', orderId, String(index), '--result', result],
      },
    };
  }

  if (eventType === 'milestone_rejected') {
    const result = normalizeResult(body?.result || body?.summary);
    if (!result) return { ok: false, error: 'missing_result' };
    const index = normalizeIndex(payload?.milestoneIndex, 0);
    return {
      ok: true,
      action: {
        type: 'cli',
        action: 'resubmit',
        command: ['atel', 'milestone-submit', orderId, String(index), '--result', result],
      },
    };
  }

  if (eventType === 'milestone_submitted') {
    const index = normalizeIndex(payload?.milestoneIndex, 0);
    const decision = String(body?.decision || '').trim().toLowerCase();
    if (decision === 'pass' || decision === 'approve' || decision === 'approved') {
      return {
        ok: true,
        action: {
          type: 'cli',
          action: 'pass',
          command: ['atel', 'milestone-verify', orderId, String(index), '--pass'],
        },
      };
    }

    if (decision === 'reject' || decision === 'rejected' || decision === 'fail' || decision === 'failed') {
      const reason = normalizeResult(body?.reason || body?.rejectReason || body?.summary);
      if (!reason) return { ok: false, error: 'missing_reject_reason' };
      return {
        ok: true,
        action: {
          type: 'cli',
          action: 'reject',
          command: ['atel', 'milestone-verify', orderId, String(index), '--reject', reason],
        },
      };
    }

    return { ok: false, error: 'missing_decision' };
  }

  return { ok: false, skipped: true, reason: 'event_not_supported' };
}
