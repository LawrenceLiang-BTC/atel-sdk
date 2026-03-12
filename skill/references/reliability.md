# Reliability: Callback / Result Push

## Symptom
Requester says "task finished but I did not receive callback/result".

## Check order

**With PM2:**

1) Executor received callback?
```bash
pm2 logs atel-executor --lines 200 --nostream | grep -n "Callback received"
```

2) Agent pushed result?
```bash
pm2 logs atel-agent --lines 300 --nostream | grep -n "result_pushed\|result_push_failed\|result_push_recovered"
```

**Without PM2:**

1) Check executor logs (if logging to file):
```bash
tail -n 200 executor.log | grep "Callback received"
```

2) Check agent logs (if running in foreground, check terminal output):
```bash
# If logging to file:
tail -n 300 atel-agent.log | grep "result_pushed\|result_push_failed\|result_push_recovered"
```

## Retry/queue model

ATEL agent now uses:
- multi-attempt retry with backoff
- durable queue for failed pushes
- background recovery flush

Queue file:
```bash
.atel/pending-result-pushes.json
```

## Recovery action

**With PM2:**
```bash
pm2 restart atel-agent
# wait ~15-30s for background queue flush
pm2 logs atel-agent --lines 200 --nostream | grep -n "task_audit_summary\|task_audit_failed\|result_push_recovered\|result_push_give_up"
```

**Without PM2:**
```bash
# Stop agent
lsof -i :3100 | grep LISTEN | awk '{print $2}' | xargs kill
# Restart
atel start 3100 2>&1 | tee atel-agent.log
# Wait ~15-30s, then check logs
grep "task_audit_summary\|task_audit_failed\|result_push_recovered\|result_push_give_up" atel-agent.log
```

## Notification semantics (after patch)

- Task completion notification now includes audit result.
- `Audit: PASS` means hash-chain audit passed (and anchor checks passed when required).
- `Audit: FAIL` means task may have executed but should be treated as audit failure until recovered.

## Operational rule

If remote relay registration is unstable, push may fail temporarily.
Do not treat first timeout as permanent failure.
