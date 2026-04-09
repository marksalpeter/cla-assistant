# Merge Group Webhook Reliability

## Sprint Checklist

- [x] [1 — `merge_group`: late ack + tests](#action-item-1--merge_group-late-ack--tests)
- [x] [2 — Circuit breaker: `merge_group` handler](#action-item-2--circuit-breaker-merge_group-handler)

---

## Problem Statement

[Issue #520](https://github.com/cla-assistant/cla-assistant/issues/520) documents a long-standing
failure mode: GitHub delivers a webhook, receives HTTP 200, considers it done — but the background
processing (MongoDB queries, GitHub API calls) silently fails. The PR is left stuck with no CLA
status update. Users must manually trigger a recheck. This happens at scale (kyma-project, algorand,
grafana, etc.) and is consistently reproducible under load or GitHub API rate limiting.

**Root cause:** The `merge_group` webhook handler sends `res.status(200)` immediately, then does
all async work fire-and-forget. Any failure after the ack is invisible to GitHub, so it never retries.

---

## Architecture Reference

| Role | File |
|---|---|
| Webhook router | `src/server/src/app.js:266-308` |
| Merge group handler | `src/server/src/webhooks/merge_group.js` |
| Status update service | `src/server/src/services/status.js` |
| Merge group test | `src/tests/server/webhooks/merge_group.js` ← new file |

**GitHub webhook retry behavior:** GitHub retries a webhook after 30 seconds if it receives a
non-2xx response, with further retries at increasing intervals. Returning 500 on failure is strictly
better than returning 200 — GitHub will self-heal.

---

## Design Notes

### Late ack

The early `res.status(200)` in the handler is the direct cause of silent failures. The fix is
straightforward: remove it, await all work, return 200 on success and 500 on any error. No logic
changes — only response timing.

### `createStatus` error propagation

`createStatus` in `status.js` was silently swallowing GitHub API errors. Fixed to re-throw after
logging so `updateForMergeQueue` failures surface as 500s.

### Circuit breaker

`opossum` is the Node.js standard for circuit breaking (Netflix/Red Hat). It handles both a
per-call timeout and circuit state in one.

The webhook-level breaker wraps `processMergeGroup` (extracted named function, required by opossum).
When DB queries or GitHub API calls repeatedly fail, the circuit trips. New requests fail immediately
with 500 — causing GitHub to retry — until `resetTimeout: 30000` elapses (aligned with GitHub's
retry interval), at which point the circuit goes half-open and tries one request.

MongoDB connection timeouts (`serverSelectionTimeoutMS`, `socketTimeoutMS`, `maxPoolSize`) should
be configured in the connection URI by operators — hardcoding them in app code risks overriding
deployment-specific tuning.

---

## Test Plan Detail

### New file: `src/tests/server/webhooks/merge_group.js`

Follows the same Mocha/Sinon patterns as the `pull_request` test.

**Test data:**
```js
const testReq = {
    args: {
        action: 'checks_requested',
        repository: { owner: { login: 'octocat' }, id: 1296269, name: 'Hello-World', private: false },
        merge_group: { head_commit: { id: 'abc123sha' } }
    }
}
```

**Stubs:** `cla.getLinkedItem`, `status.updateForMergeQueue`, `logger.error/warn/info`

**Tests — action item 1 (8 total):**

| Test | Verifies |
|---|---|
| `accepts: checks_requested + public repo` | `accepts()` → true |
| `accepts: rejects private repo` | `private == true` → false |
| `accepts: rejects non-checks_requested action` | `action: 'merged'` → false |
| `handle: returns 200 after updating merge queue status` | happy path, `updateForMergeQueue` called |
| `handle: returns 500 if getLinkedItem throws` | error → 500 |
| `handle: returns 500 if updateForMergeQueue throws` | error → 500 |
| `handle: returns 200 and skips update if nullCla` | `item.gist = null` → 200, no update |
| `handle: returns 200 and skips update if repo is excluded` | `isRepoExcluded` → 200, no update |

**Additional test — action item 2 (circuit breaker):**

| Test | Verifies |
|---|---|
| `handle: returns 500 if circuit breaker is open` | `breaker.open()` → 500 |

Plus `breaker.close()` added to `afterEach`.

---

## What This Does NOT Change

- `pull_request.js` handler or its tests
- Internal logic of `updateForMergeQueue`, `cla.check`
- `ping.js` — no change needed, it does no async work
- The legacy `/github/webhook/:repo` route — handlers are shared, benefits automatically
- Any client-side code

---

## Success Criteria

- `merge_group` webhooks that previously failed silently now return 500 → GitHub retries after 30s
- Under sustained DB or API stress: circuit trips → fast 500s → GitHub retries → system recovers → circuit closes
- `npm test` passes

---

## Action Item 1 — `merge_group`: Late Ack + Tests

**Commit message:**
```
fix(merge_group): return 500 on failure so GitHub retries

The merge_group handler was acking with HTTP 200 before doing any work,
causing silent failures under load (cla-assistant/cla-assistant#520).

Remove the early ack. Await all processing. Return 200 only on success,
500 on any error so GitHub retries after 30s.

Also fix createStatus in status.js to re-throw GitHub API errors so
updateForMergeQueue failures actually surface.

Adds full test coverage for the merge_group handler — none existed before.
```

**Files:**
- `src/server/src/webhooks/merge_group.js`
- `src/server/src/services/status.js`
- `src/tests/server/webhooks/merge_group.js` ← new file

**Changes to `merge_group.js`:**
- Remove `res.status(200).send('OK - Will be working on it')` from line 24
- Await all work inside the existing `try` block
- Add `return res.status(200).send('OK')` at end of `try`
- Change `logger.warn(e)` in `catch` to `logger.error(e)` + `return res.status(500).send('Internal Server Error')`

**Changes to `status.js`:**
- `createStatus` catch block: add `throw error` after `logger.warn` so GitHub API failures propagate

**Deploy:** Safe alone. `merge_group` is lower traffic than `pull_request`. Silent failures now
return 500 — GitHub retries. No regression possible on the success path.

---

## Action Item 2 — Circuit Breaker: `merge_group` Handler

**Commit message:**
```
fix(merge_group): add opossum circuit breaker to shed load under sustained failures

Under sustained DB or API stress, the merge_group handler now trips a circuit
breaker after repeated failures rather than accepting unbounded load. New requests
fail-fast with 500 (causing GitHub to retry after 30s) until the system recovers,
at which point the circuit closes automatically.

Addresses the rate-limit failure mode identified in cla-assistant/cla-assistant#520.
```

**Files:**
- `package.json` — add `"opossum": "^8.1.0"`
- `src/server/src/webhooks/merge_group.js`
- `src/tests/server/webhooks/merge_group.js`

**Changes to `merge_group.js`:**

Extract the `try` block body into a named `async function processMergeGroup(args)` (required by
opossum). Add circuit breaker:

```js
const CircuitBreaker = require('opossum')

const breaker = new CircuitBreaker(processMergeGroup, {
    timeout: 25000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    volumeThreshold: 3
})
breaker.on('open',     () => logger.error('merge_group circuit breaker OPEN'))
breaker.on('halfOpen', () => logger.info('merge_group circuit breaker HALF-OPEN'))
breaker.on('close',    () => logger.info('merge_group circuit breaker CLOSED'))
```

Replace the inline work in `handle` with `await breaker.fire(args)`.
Export `breaker`: `module.exports = { accepts, handle, breaker }`.

**Test updates:** `breaker.close()` in `afterEach`, one new circuit-open test.

**Deploy:** Safe last. Under normal load invisible. Under sustained failures, sheds load and
returns errors fast.
