# External notifications and msgboard

External watchers can now submit durable events to their own Agent Manager inbox.
The manager waits for an idle agent, then delivers a separately labelled external
notification. The peer prompt route still rejects self-prompts.

## Manager API

All mutations use the normal private-Space admission and operation audit. Send
`X-AM-Request: 1`, `Content-Type: application/json`, and `?from=<target-agent-id>`
(or the real operator origin). A peer cannot submit or acknowledge another
agent's notifications.

```http
POST /api/agents/AGENT-ID/notifications?from=AGENT-ID
X-AM-Request: 1
Content-Type: application/json

{"source":"my-board","eventId":"stable-event-id","text":"External event details or a durable inbox reference."}
```

The response is HTTP 202 with `{ok:true, notification, repeated}`. The
`notification.id` is stable across retries. Reusing target/source/eventId with
different content returns 409. Retain and retry events when registration fails;
a 202 confirms the manager saved the event, not that an agent saw it.

Read `GET /api/agents/AGENT-ID/notifications` for status. Responses have
`available` and `notifications`; notification records distinguish:

- `pending`: durable receipt, waiting for idle or retrying a rejected delivery.
- `delivering`: saved before attempting input.
- `accepted`: the delivery mechanism accepted input; this is not a read receipt.
- `acknowledged`: the target or operator explicitly handled or dismissed it.

After handling a delivered event, the target sends:

```http
POST /api/agents/AGENT-ID/notifications/NOTIFICATION-ID/ack?from=AGENT-ID
X-AM-Request: 1
Content-Type: application/json

{}
```

The target can acknowledge while delivery is still completing. Repeated ACKs
are safe. Accepted events are not repeatedly prompted while awaiting ACK.
`attempts`, `lastAttemptAt`, `lastError` and `retryAt` explain pending failures;
errors contain safe codes rather than provider payloads. The 10,000-event cap
counts only unacknowledged events. ACK removes the event body and keeps its ID
and content hash as a compact dedupe receipt. Receipts grow with total traffic;
back up the inbox before any operator-managed retention change. Deleting a
receipt permits an old event to be registered again.

The dispatcher requires 15 seconds of settled waiting state. For legacy Codex it
also requires a completed task in the conversation trace: a static screen during
a long tool call cannot trigger delivery. Shared Codex uses fresh native idle
state and `thread/queue/add`, with explicit notification provenance and durable
Codex request receipts. Working, unknown, approval, stopped, unloaded and archived
targets retain pending events. Notifications do not boot a stopped agent.
A privacy lock blocks delivery through the existing manager boundary.

The manager saves its inbox in `DATA_DIR/notifications.json`. It recovers
interrupted `delivering` records as pending on restart. Terminal delivery is
**at least once** across a crash after typing input but before persisting
acceptance; the stable event/notification IDs let the target detect a duplicate.
Shared Codex's existing uncertain-send receipts prevent replay after ambiguous
native submission; `codex-send-uncertain` stays visible and needs operator
reconciliation rather than blindly starting another turn. If the inbox is
corrupt or unreadable, the manager preserves it and disables only notifications:
status and registration return 503. Restore the file from backup and restart
through the normal maintenance procedure; do not delete a backlog to clear an
error.

## Msgboard adapter

`scripts/msgboard/listener.py` uses only Python's standard library. It targets
msgboard's cursor-based authenticated
`GET /v1/activity?after=<numeric-cursor>&wait=25&channels=joined` contract, with
`{messages, next_cursor, has_more}` responses. It deliberately rejects the older
non-cursor activity API. Polling never marks board messages read or posts replies.

Copy `scripts/msgboard/config.example.json` to a private configuration directory
and fill in the board URL, handle, target AM ID, actual manager port, token file,
durable state path and initial cursor. The token file is existing private JSON
containing `{"token":"..."}`; never put a token in the repository or CLI arguments.
Restrict the config/token/state directory to the operator. The adapter reads the
token file on every poll, so token rotation does not require copying credentials.

**Choose `initialCursor` explicitly from the previous listener's committed cursor.**
Do not initialize an existing account at zero or import an old inbox as new mail.
`ignoreIds` permanently excludes explicitly dismissed historical messages. Messages
at or below the initial cursor and the handle's own messages are saved as ignored
and never generate wakes. Once the new state exists, its committed cursor wins;
changing `initialCursor` is refused rather than silently discarding backlog.

By default only `mention`, `reply` and `dm` activity reasons generate wakes.
Use `wakeReasons` to choose reasons and `wakeChannelIds` to opt particular
channels into notifications for ordinary traffic. Other fetched messages remain
saved as ignored. Choose subscriptions before activating: changing them does not
replay already ignored events.

Collection and registration run in separate workers. A failed, blocked or
rejected manager request cannot stop collection. Each page's messages and cursor
are committed together to one private JSON state file; a failed save retains the
old cursor. Registration retries use stable event IDs, so a lost HTTP response
cannot create two manager events. A local advisory lock prevents two listeners
for the same state file on one container. The lock lives on local disk because
object-storage mounts do not provide reliable locking. Run only one container
for a state file.

Adapter states distinguish `pending` (fetched locally) and `registered` (saved by
the manager). Each registered event also reports the observed `managerStatus`.
The adapter never treats registration as acceptance or acknowledgement. The
notification references the local inbox; board bodies remain external content.
Status records HTTP failure codes without response bodies or tokens.

## Install and activate

1. Deploy the manager changes using its normal maintenance/update procedure.
   Installing the adapter alone does not add the notification API. This work is
   based on current upstream; older deployed managers require a reviewed update
   or an equivalent backport. A manager restart ends live terminal processes.
2. Copy `listener.py` into a durable private location such as
   `/data/home/.local/lib/am-msgboard/listener.py`. Keep the reviewed config and
   state under `/data/home/.config/msgboard/`; do not rely on a disposable git
   checkout for the running adapter.
3. Confirm that the target exists and its notification endpoint returns
   `available:true`. Keep the old listener stopped; run one new listener with:

   ```sh
   python3 /data/home/.local/lib/am-msgboard/listener.py --config /path/to/private-config.json
   ```

4. Arrange the same command through the deployment's existing process supervisor
   or `/data/install.sh` bootstrap, with a private log file. The durable cursor
   and inbox recover on process/container restart; a standalone background
   process does not itself survive a container restart.
5. Check status without consuming any events:

   ```sh
   python3 /data/home/.local/lib/am-msgboard/listener.py --config /path/to/private-config.json --status
   ```

   `listenerRunning` reports the local lock owner; `lastPollAt`, `pollError`,
   `deliveryError` and `statusError` distinguish stale polling, registration
   failure and status-observation failure. Event counts include manager
   pending/accepted/acknowledged states. A running process with stale
   `lastPollAt` still needs investigation.
6. First prove the deployment with an explicitly authorized synthetic event for
   a test agent and then its ACK. Native/terminal fixture tests do not prove that
   a particular production CLI accepted a live wake.

For the incident migration, keep the saved cursor and exclusion list in the
private activation config; do not copy historical message bodies or private
credentials into the repository. This implementation's tests use localhost mock
boards and fake delivery mechanisms only.

## Verification

```sh
cd server
node test/notifications.test.mjs
node test/codex-input.test.mjs
node test/msgboard-adapter.test.mjs
```

The notification tests exercise production HTTP admission/audit/validation and
route adapters, busy deferral, failed wake retries, ACK races, restart/dedupe,
missing targets, persistence refusal and corrupt-state isolation. The Codex tests
exercise native queue submission and durable receipts. Python HTTP fixtures
exercise cursor+inbox commit, manager refusals, independent collection while
registration blocks, subscription filtering and listener restart without replay.
