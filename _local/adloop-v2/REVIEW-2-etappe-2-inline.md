# Etappe 2 adversarial review

Reviewed `95942cc..6ef383f` with a different model under the five lenses in
the private review protocol. Findings were handled as follows.

## Accepted

1. **Raw `paging.next` could copy an access token into Postgres and object
   storage.** Graph responses are now recursively redacted after validation
   but before persistence; pagination still uses the validated in-memory
   response.
2. **Terminal sync failures left account readiness at `syncing`.** Partial
   runs now move `base_facts` to a stable error code, while cancellation
   returns it to `optional_pending`.
3. **A full page write held the job row lock long enough to block
   heartbeats.** Each insight row is now a separate fenced transaction and
   the page cursor is checkpointed only after all rows commit.
4. **The login request endpoint exposed whether an address exists after
   repeated requests.** Rate-limited and unknown addresses now return the
   same `202 code_requested` response.
5. **Meta `error_user_msg` prose crossed the backend/frontend language
   boundary.** The Graph error object still carries it to internal callers,
   but persisted/API status contains only stable codes, numeric details,
   and `fbtrace_id`.
6. **The generic run endpoint bypassed account selection.**
   `meta_insight_sync` can only be submitted through
   `/api/meta/sync/refresh`.

## Rejected

1. **Add `insight_window` and derive `net_new_reach`.** The local
   `PROMPT-etappe-2.md` says this, but the submitted run Auftrag explicitly
   says "`net_new_reach` comes from Meta, it is not calculated" and defines
   no `insight_window`; it also says the submitted Auftrag wins conflicts.
   The implementation follows the submitted contract and records the live
   API contradiction in `DECISIONS.md` and `README.md`.
2. **Remove `net_new_reach` and add a live field-contract test.** Same
   conflict. This run has no Meta credentials, and its acceptance table
   requires recorded fixtures. A live sync is honestly blocked until the
   coordinator resolves the source-field contradiction.
3. **Store each nested attribution window as a separate observation.** The
   submitted contract requires a canonical attribution *set* and the
   deduplicated total Meta supplies for that set; summing nested singleton
   windows is explicitly forbidden. The implementation stores that combined
   set and total.

## Result

All accepted findings were fixed and covered by the existing fixture,
boundary, or full-suite verification. The unresolved `net_new_reach`
contract is a product-spec blocker for live Meta acceptance, not something
the implementation can safely guess around.
