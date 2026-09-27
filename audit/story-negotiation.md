# Story/negotiation audit

Assigned manifest: 153 paths, all fully reviewed (136 here, 17 delegated with provenance in supplemental ledgers). Seven supplemental documents were fully reviewed. The findings below preserve the audit evidence; each disposition records the authorized implementation or explicit retained invariant. Implementation is shared with root/common/match agents; no commits were made.

Verification: final cues/market/settling run passed 87 tests. Finance/scouting/settling passed in their focused batch; its cues fixture failure was corrected and included in the final 87. Onboarding opening and leap-year boundary subset passed 4 tests. Scoped ESLint passed. Root owns final whole-repository gates. Changes to schemas and model inputs use the root-managed version bump.

## SN-01 — P1 design mismatch: closed persuasion taxonomy still owns meaning

**Disposition — Implemented: removed the closed claim enum, truth/lie scoring, per-kind allowance and obsolete persuasion test. Pitch now stores bounded free-text notes; GM returns normalized judgment against a financial anchor ±20 percentage points.**

Confirmed behavior in domain/src/negotiation/persuasion.ts and engine/src/negotiation/market/persuasion.ts: ten fixed kinds, including other (cannot open latitude); starting_role at line 150 is deemed a lie if a currently stronger positional player exists, although schema means a future starting promise; project_lead requires top-three OVR; last_chance is age>=33 or contract<=1y; fame>=60; top-four-or-Europe means trophy push. Invalid mapped claims deduct 1.4, each fresh validated kind opens 12 percentage points. Negotiation GM heard.claims uses the same closed schema. This is not contextual continuous judgment, and the starting-role predicate is not factual validation. A single valid kind already exceeds the 5% minimum acceptance floor (explicitly tested), so displayed accumulated latitude looks continuous but the basic acceptance guard is effectively on/off.
Reduction: retain real financial/contract anchors and range validation; let GM ground structured reasoning in actual facts and commitments. Remove kind-specific truth/lie scoring and kind-count allowance together, not just their descriptions. Preserve id/ownership/amount/expiry, duplicate settlement, agreed conditions and promise registration tests. persuasion.test.ts is entirely the old policy contract and should be replaced/removed with that policy; keep only any extracted history interval/query invariants genuinely reused elsewhere. Detailed transfer.md still documents this taxonomy; broad vision is ahead of behavior, not all docs.

## SN-02 — P2 confirmed bug: compatriot verifies the player as their own teammate

**Disposition — Removed with SN-01: no compatriot predicate survives, so the self-teammate bug has no executable path.**

engine/src/negotiation/market/persuasion.ts:125-130 compatriotIn finds any user player with matching homegrownCountry, without excluding player.id. During renewals this includes the target themself. A sole matching-origin player therefore earns verified compatriot and latitude without another teammate. Minimal repair excludes target ID if closed predicate survives; targeted existing persuasion test should use an own player with unique homegrownCountry. Also label says same nationality while field means training/homegrown country: separate semantic conflation, not necessarily a new storage-field request.

## SN-03 — P1 design reduction: story pressure ladder is still executable

**Disposition — Implemented: removed pressure state, accumulator, topic ladder, step field, automatic leaks/requests and approach-rate harness. GM opens a fact-validated scene through record_incident; invalid requests are atomic.**

engine/src/story/world/approach.ts:339 DAILY_GAIN, 537 APPROACH_TOPIC_ORDER; app/workflows/story/world/approach.ts:625 driftPressure, 650 openApproach. Saved pressure accumulates per fixed issue kind, multiplies leader weight, selects greatest normalized overflow and fixed topic order, then chooses scene, leaks at step 4 and creates transfer request at terminal step. Speaking relieves/retains pressure by fixed 75% carry and cooldown. These are scene/character judgments, beyond keeping deterministic ledgers. Reduce to actual issues/promises/history, actual opened scene and bounded reaction; GM chooses whom/when/why within duplicate/authority/date guards. Do not remove transfer ownership/contract finance invariants with ladder tests. Detailed people.md still documents the ladder.

## SN-04 — P2 confirmed code/meaning mismatch: startedRecently counts substitutes

**Disposition — Removed with SN-03: startedRecently no longer drives pressure or scene selection. No test preserves the obsolete substitute heuristic.**

engine/src/story/world/approach.ts:52-62 promises a recent starter but reads result.homeLineup/awayLineup. Actual starters are separate match fields. This feeds minutes pressure relief. If ladder remains, read starter fields; if removed, do not add a test that immortalizes this obsolete heuristic.

## SN-05 — P3 stale comments around new social reaction

**Disposition — Implemented: removed comments describing deleted ladders, stance tables and claim scoring; current continuous reaction and explicit scene contracts are documented.**

app/workflows/story/world/approach.ts causesToday comment says bad relationships multiply pressure, but only leaderWeightOf is applied. respondToApproach comment says LLM chooses stance and core effect table determines response, but implementation receives continuous ReactionSchema and applySocialReaction. Remove stale historical claims; do not reintroduce removed relationship multipliers to satisfy them. Several comments mention deleted owner-demand pathways.

## SN-06 — P2 simplification candidate: mood priority ladder hides underlying facts

**Disposition — Implemented: moodFactsOf independently collects concurrent actual facts and all current issues. Only the UI moodOf summary slices two cards. Ability, position, fitness, adaptation and form information remains.**

app/workflows/story/players/mood.ts builds priority cards, returns only facts.slice(0, MOOD_FACT_LIMIT). Injury, grievance, demotion, settling, afterglow, familiarity, condition, fatigue, mentoring, departures, contracts, numbers, hierarchy all compete in a fixed hierarchy. UI summaries legitimately need bounded size, but same chosen cards used as character input substitute engine salience for GM judgment. Preserve readable abilities/positions/roles/fitness/adaptation/form and the authoritative fact queries; separate compact display from GM fact access, avoid a new aggregate emotion score. No claim every branch is redundant.

## SN-07 — P2 confirmed residual catalog reconstruction

**Disposition — Implemented: root reuses the kickoff catalog; negotiation builds its catalog once per turn and passes the map into interpreted callbacks, eliminating per-call construction.**

agents/src/app/gm-tools.ts:662-663 readAtKickoff calls buildToolSpecs again; app/workflows/negotiation/negotiation-gm.ts:91 does the same for table orders. buildGmTools already constructs a shared specList/map. Catalog source is shared, but not one construction. Inject current correctly-optioned catalog instead. Do not flatten domain authorization or accidentally lose deferNegotiationIds; measure benefit, no invented LOC savings.

## SN-08 — P2 confirmed success-status mismatch for interpreted operations

**Disposition — Implemented: negotiation interpreter success is applied>0 from shared applyOps outcomes, not nonempty proposed operations.**

common/orders-ops.ts applyOps discards each result.ok and returns void. gm-tools.ts:1953/1976 training/market unconditionally return ok:true after parsing; tactic at 1926 and negotiation-gm.ts:100 use hasOps instead of executed success. A nonempty set of invalid commands is reported successful, even though messages contain rejection. Unresolved-only training/market output also returns success. Preserve per-command validation and partial progress; aggregate actual applied/rejected counts and return appropriate status. Add one existing mock test for all-failed and partial-failed batches, not strings for every message.

## SN-09 — P2 prompt unit mismatch

**Disposition — Implemented by root plus domain comment cleanup: model and ledger currency is £.**

agents/src/app/gm-tools.ts:1089 request_board.amount describes monetary requests as 원 (won), while all finance values and rendered formatMoney are £. This is model input, not harmless code comment. Fix unit to £ and follow project game-version policy if changed. Domain board-request.ts comments also say 원; comments should match ledger currency.

## SN-10 — P2 confirmed malformed validation paths

**Disposition — Implemented by root in common/tool-schema with nested-path regression coverage.**

agents/src/common/tool-schema.ts:139 inputError joins field path elements using "../index". Nested invalid args produce nonsensical path strings, harming the model retry guidance this function exists to supply. Use a meaningful field separator. Add a focused nested-path test in existing schema suite if needed; no new test file.

## SN-11 — P3 duplicated form vocabulary

**Disposition — Implemented: training-rater imports the shared formLabel vocabulary.**

agents/src/story/training-rater.ts:131 hardcodes form >0.2/<-0.2 and good/bad/normal labels, while formLabel owns form vocabulary elsewhere. Reuse owner rule if same meaning is intended; preserve numeric form in trainer context if useful. Candidate, not proof current output incorrect.

## SN-12 — P2 expectations still rendered from tier-derived offer code

**Disposition — Implemented: current boardAgenda expectations feed coach context; historical tier recruitment benchmarks remain explicitly reference facts. Manager renewal is now an explicit review_board.renewal decision within the 90-day contract window; the clock only expires contracts.**

agents/src/negotiation/context.ts:43 offerExpectation renders offer.expectationCode/target. It labels this as expectation in offerSeat. Recruiting club's benchmark can be legitimate, but must not silently become current agreed boardAgenda. The completed manager-market audit distinguishes recruitment benchmarks from current agreed expectations. This context.ts use alone does not prove a bug; SN-24 identifies the confirmed current-agenda divergence.

## SN-13 — P1 confirmed contradictory current docs after board rewrite

**Disposition — Implemented: finance/career/people/transfer docs describe the current board command and scene contracts; obsolete automatic owner-demand/reputation passages removed.**

Full-read docs/story/career.md: §5 correctly specifies boardAgenda free-text GM review. Later §5.1 still describes reviewUserSeat auto-warning after 75-day grace; §5.3 refers to removed §5.2 and archetype-generated owner demands (+3/-6); end §6 says warnings count/digest and standing(warnings) card, and §7 says expectations come only from tier table. docs/story/board.md explicitly removes archetype tasks, pressure/warning counters and makes GM warning/dismiss continuous bounded review. The stale documentation sections were corrected as listed under SN-37. domain/src/negotiation/board-request.ts top comment likewise describes removed BoardDemand as live state. Do not restore old code to satisfy stale docs.

## SN-14 — P1 simplification candidate: personality still decides attention and economics

**Disposition — Implemented: coaches receive all available factual cue categories without archetype attention or rotation. Agent price/patience/delay/ultimatum profiles removed; character context remains in GM input. Existing player growth/settling/position/fitness rules are retained as player simulation.**

`packages/engine/src/app/workflows/story/players/coach-cues.ts` COACH_EYE maps six coach archetypes to disjoint fact readers, then rotates by date and recent speakers. A coach without a recognized archetype gets only training/loan reports; injury/tired starters, prospects and dressing-room facts are not equally available in their coach feed. `packages/engine/src/negotiation/market/agent-profile.ts` maps empire/lawyer/hardballer to fixed asking-price, patience, delay and ultimatum parameters. These are remaining executable personality tables, not removed by the continuous social reaction refactor. Preserve abilities, fatigue, positions, contracts and budget anchors; expose compact factual evidence and let contextual AI select salience/judgment. Keep deterministic tests for facts and monetary guardrails; delete archetype policy assertions only with replacement policy.

## SN-15 — P2 confirmed capability bug: dialogue signing promises cannot carry a position

**Disposition — Implemented: dialogue PromiseInput and both callers carry position; root exposed it in tool schemas.**

`packages/agents/src/app/gm-tools.ts` promiseArg advertises every PROMISE_KINDS member, including signing, but carries only kind/days/number. `packages/engine/src/story/commands/talk.ts` PromiseInput and app talk/approach callers likewise omit position. `packages/engine/src/negotiation/players/promises.ts` promiseBlock rejects signing unless position is valid. Thus a signing promise through team_talk/respond_to_approach is invariably rejected, while deal terms can express it. Either expose validated position end-to-end or restrict the advertised dialogue kinds; retain the validation and add a focused existing-suite boundary case.

## SN-16 — P2 behavior/policy candidate: a successful named talk resolves unrelated grievances

**Disposition — Implemented: team talks use continuous ReactionSchema axes; only explicitly named current issue reasons are removed. Validation precedes any mutation; group praise cannot silently clear unrelated grievances.**

`packages/engine/src/app/workflows/story/commands/talk.ts` removes every issue belonging to heard named players whenever outcome is in RESOLVING_OUTCOMES. There is no issue/topic reference. Contract, overload and broken-promise issues therefore disappear alongside neglect/minutes issues after any positively ruled private talk. The skill text currently says broadly that grievances resolve on positive morale; this is a broad rule, not automatically a regression. Prefer GM-identified issue IDs with ownership validation if resolution is intended to be contextual. Retain issue ownership/idempotence tests, avoid encoding blanket deletion anew.

## SN-17 — resolved verification: target and team bounds are per axis

**Disposition — Verified, no bug: social reaction bounds are per axis. Retained and documented; no total-vector clamp introduced.**

`recordIncident` in story/commands/talk.ts passes INCIDENT_MORALE_BOUND=6 to `applySocialReaction` in story/world/social.ts. Team and named-target axes both affect a target, so {team:1,target:1} may produce +12 morale-equivalent before form clamping. Full-read people.md explicitly documents per-axis ±6 and the target receiving both changes. This is documented behavior, not a confirmed cap violation. The initial bug suspicion is retracted; retain per-axis validation and overall form-clamp tests.

## SN-18 — P2 design mismatch candidate: openings resolve by action category

**Disposition — Implemented: implicit touchOpenings removed. record_incident resolves explicit current opening IDs only after validating every ID; atomic rejection and historical resolution tested.**

`packages/engine/src/story/people/openings.ts` touchOpenings closes active openings whenever subject/kind matches an action, and writes the generic completed explanation. It cannot distinguish a meaningful resolution from an unrelated chat with the same person or a merely submitted board request. Architecture describes GM contextual completion. Replace implicit completion with an explicit validated opening-resolution decision if openings are intended as persistent unresolved stories; retain identity/duplicate guards. Do not add more action-kind heuristics.

## SN-19 — P1 confirmed bug: capacity-blocked scouting mission cannot be retried

**Disposition — Implemented: a waiting scouting mission can retry after capacity frees, preserving its ID and avoiding duplicates; regression added to scouting.test.**

`packages/engine/src/negotiation/commands/scouting.ts` scoutMission finds a duplicate across activeMissions AND waitingMissions, returning false before checking freeScoutSlots. When a capacity-blocked request is saved with dueOn=null, the user is told to call again once a slot is free, but that exact retry always hits this duplicate return. There is no automatic dispatch. Reuse the waiting record and start it when capacity permits; preserve active duplicate rejection, condition identity and queue expiry. Add a focused case to existing scouting.test.ts for blocked→slot frees→same request dispatches without duplicate id/record. This is distinct from narrative heuristic removal.

## SN-20 — P2 confirmed UI observation leak: proposal form exposes true valuation

**Disposition — Implemented: proposal and loan displayed valuations use observedMarketValue; true values remain only internal settlement anchors.**

`packages/engine/src/negotiation/market/proposal.ts` proposalViewOf returns marketValueOf, not observedMarketValue. Consumer search shows apps/web/domains/negotiation/ui/proposal-form.tsx:648 renders that value and :523 uses it for default buyout clause. This bypasses valuation fog for an unscouted target even though scouting/search views use observedMarketValue. Asking-price negotiation anchors may legitimately be exact quotes; displayed market valuation should share the observation rule. Root independently confirmed both UI consumers. Keep fog consistency tests; do not remove readable abilities or valuation information.

## SN-21 — P2 confirmed invariant contradiction: historical persona cards use current relationships

**Disposition — Implemented: historical characterEntryOf returns the immutable base entry, while current injected cards can include live relationships. Root owns the relationship/mentoring history regression.**

`packages/engine/src/story/people/people-directory.ts` characterEntryOf reconstructs a historical card then calls withRelations(state,...), which reads current mentoringRelations and tierRelations. Comments promise immutable card bytes and explicitly omit current memories for cache stability. Relationship changes therefore retroactively change old rendered cards. Prefer immutable injection-time relationship content or separate current relationship facts/reinjection; avoid adding an additional scoring system. withRelations also still describes the removed archetype-axis layer although only mentoring/tier layers remain. Add a focused test that changing today's relationship cannot alter an already injected historical card if that remains the cache contract.

## SN-22 — P2 confirmed state-edge bug: old buyback rights revive after resale and return

**Disposition — Implemented: buyback rights are derived only from each player’s latest nonloan transfer, preventing older rights from reviving after resale and return.**

`packages/engine/src/negotiation/market/clauses.ts` liveBuyBacks accepts every unexercised, unexpired historical clause whose original destination equals current contractOwnerOf. If the player leaves that destination then returns before expiry, the old right becomes live again. Current ownership cannot prove continuous ownership. Same file's liveSellOnOf already restricts the clause to the latest arrival; use an equivalent transfer-lineage validity rule for buyback. Retain contractual expiry/exercise/money tests and cover resale→return in an existing file. exerciseBuyBack also checks only transferBudget, not budgetFrozen or wage room; that separate question needs comparison to the documented contractual exception, so it is not asserted as a bug here.

## SN-23 — P2 confirmed observation leak: coach prospect cues expose exact potential

**Disposition — Implemented: coach prospects use observed potential ranges, not exact hidden potential.**

`packages/engine/src/story/players/coach-cues.ts` prospectsOf sorts by attributes.potential and prospects prints exact potential in GM factual input. Scouting specifies potential remains an observed band even for own players. Use the shared observed-potential representation for both ordering and display; preserve useful development and ability facts.

## SN-24 — P2 confirmed competing expectation source in coach cues

**Disposition — Implemented: coach expectation cues read current boardAgenda plus actual standings.**

`packages/engine/src/story/players/coach-cues.ts` expectation labels tier-derived boardExpectation.target as the board expectation, ignoring current GM-authored boardAgenda. The club_loyalist cue can therefore contradict the active negotiated goal. Use active agenda or explicitly label the derived number as a general competitive benchmark. This strengthens SN-12 beyond legitimate recruitment benchmarking.

## SN-25 — P2 confirmed ordering assumption in financial recent form

**Disposition — Implemented: financial recent-form windows sort completed matches by date/id before slicing; input arrays are not mutated.**

`packages/engine/src/negotiation/finance/finance.ts` matchdayRevenue uses filtered state.matches.slice(-5), and recentWinRates keeps the last encountered N results. Neither sorts by played date. Cup fixtures are appended as rounds are created, so insertion order does not represent chronology. Sort completed relevant matches by date before applying the window, sharing a chronological query where available. Preserve the revenue formulas and test a deliberately interleaved cup/league fixture history rather than adding a policy test.

## SN-26 — P2 confirmed missing wage revalidation in AI arrivals

**Disposition — Implemented: planned AI wages reserve existing queued arrivals; transfers, loans and free-agent arrivals recheck current wage room and frozen finances at execution. Exact monetary and ownership rules retained; common/root added guard regressions.**

`negotiation/market/ai-market.ts` planning checks wage room but tracks only spent fees and headcounts. Multiple queued offers may each fit alone but jointly exceed the wage ceiling; settle revalidates cash/budget/headcount but neither transfer nor loan wage room. The actual signed wage also applies marketBias.wage absent in planning (market-only league exception is intentional). `departures.ts` free-agent pickSuitor/signWithClub likewise has no wage-room gate. Root fully read relevant tests and confirms no queue/current wage boundary assertions. Share actual prospective wage calculation and revalidate at mutation time; retain deterministic background simulation and add queue competition boundary to existing suite.

## SN-27 — P1 reduction candidate: contextual negotiation judgment still largely encoded as scores

**Disposition — Implemented: removed contextual age/loyalty/playing-time/status/term/morale/reputation score tables from deal odds. Financial anchors and eligibility remain; bounded continuous GM judgment handles motives and persuasion.**

`negotiation/market/market.ts` buy/renew/release/loan probability functions assign fixed age branches, loyalty multipliers, OVR-derived starting opportunity, archetype-selected shirt desire and generic satisfaction contributions before a sigmoid. These are executable contextual judgments, separate from valid monetary anchors, eligibility, contract and financial ledgers. Prefer a small deterministic monetary/eligibility boundary plus validated continuous contextual AI adjustment with factual dossier. Keep monotonic monetary/ledger tests and player information; remove social-policy assertions only with their replaced rules. Do not claim every deterministic market formula is obsolete.

## SN-28 — P2 confirmed normal offer ignores squad status in counterparty anchor

**Disposition — Implemented: pending offer squadStatus, pitch and prior notes travel to counterparty and delayed-response calculations. Status still persists in settlement rather than becoming a fixed preference bonus.**

`negotiation/market/counterparty.ts` counterpartyAnchor passes pending offer fee/wage/years into dealOdds but omits squadStatus. buy/renew in market.ts apply squadStatusContribution only when supplied, so normal counterparty anchor misses the offered status axis; personalAnchor correctly supplies it. Pass the same full offer facts for both paths and preserve bound tests. Root found existing market squadStatus tests exercise dealOdds directly, without asserting the eventual response or settlement.

SN-20 extension: market.ts loanOdds returns true marketValue directly for all knowledge levels while setting fuzzy as a label only. Buying view applies fuzzMoney, so quoting the same target as loan can bypass observed valuation. Apply shared observation semantics to displayed valuation while allowing actual quoted contract terms.

## SN-29 — P2 confirmed reference resolution bug in manager offer counter and acceptance

**Disposition — Implemented: exact ID first, then current open unexpired club offer, then historical error fallback, in both counter and accept.**

`negotiation/market/manager-market.ts` counterManagerOffer first finds any matching offer by id/club name and only afterward checks status/expiry. Root confirms `app/workflows/negotiation/market/manager-market.ts:615` acceptManagerOffer has the same ordering before via/status checks. Offers persist across spells, so an earlier accepted/expired offer for the same club masks its later open offer when referenced by club name. Select current eligible offers before historical fallback, preserving precise ID semantics. Root found no existing old-expired-before-open by-club-name boundary test. Same manager-market source has stale stance/bold interview comments although settleInterview consumes continuous leverage; a note says ceiling for any positive leverage although amount can be below ceiling.

## SN-30 — P2 confirmed misleading unemployed snapshot after resignation

**Disposition — Implemented: unemployed GM input distinguishes expired, resigned, moved and sacked.**

`agents/src/app/gm-input.ts` buildUnemployedNote renders expired as contract expiry and every other Dismissal.kind as sacked. resigned is valid state, so a voluntary resignation is sent to GM as dismissal. Use shared MANAGER_EXIT_KO or exhaustive mapping; existing history/snapshot test file can host this semantic boundary.

SN-05 extension: story/world/press.ts and app press workflow comments still say unattended conferences incur a reputation cost, while declinePendingPress now records only status/narrative. declinePress defaults to reason-only reaction and applies no automatic penalty. domain press-facts still has orphan owner-demand comments and warnings renderer branch. Clarify present continuous reaction behavior, remove truly unused branches only after reference check.

## SN-31 — P2 confirmed lost persuasion facts in delayed response

**Disposition — Implemented: delayed response and counterparty retain offer facts; describeNegotiation now also passes payment, status, terms, pitch, prior notes and personal agreement to the displayed odds.**

`negotiation/market/negotiation.ts` sendOffer computes odds using prior pitched reasons, but respondOffer rebuilds DealTerms without pitch/squadStatus; counterpartyAnchor also omits them. describeNegotiation omits further payment/terms/personal facts. The GM sees a different anchor after submitting identical terms. Share one full offer-to-DealTerms projection, retaining approved facts through response and display; bound tests remain valuable.

## SN-32 — P2 confirmed open-talks precontract mismatch

**Disposition — Implemented: an empty same-kind negotiation is converted to first validated offer mode, preserving its identity; in-window and closed-window precontract paths remain legal. Match agent added regression.**

`negotiation/market/negotiation.ts` openTalks allows the precontract eligibility path but always stores precontract:false. A subsequent zero-fee precontract sendOffer conflicts with that open normal negotiation. Store the actual deal mode or explicitly support converting the open table after validation. Cover openTalks→precontract sendOffer in the existing negotiation suite.

## SN-33 — P2 confirmed loan-in skips origin cleanup

**Disposition — Implemented: incoming loans run common departure cleanup at lender before moving the player, clearing lender tactics/lineup state.**

`negotiation/market/negotiation.ts` executeLoanIn moves player.teamId without releaseFromTactics/clearDepartedState. App executeDeal regular transfer and executeSale release original placement, but loan-in can leave the departed player in lender tactics. Apply common departure cleanup before moving; preserve lender ownership contract and loan return information.

## SN-34 — P2 confirmed agreed personal role is dropped after club agreement

**Disposition — Implemented: personal agreement role is copied to the accepted round before signing; match agent asserts round and signed-contract role.**

`negotiation/market/negotiation.ts` answerPersonal after feeAgreed copies weeklyWage and contractYears into accepted round, but omits personal.squadStatus. `app/workflows/negotiation/market/negotiation.ts` executeDeal subsequently derives contract status from agreedSquadStatus, which reads that accepted round, not personal agreement. Carry the agreed role into final accepted terms; test fee agreement→personal role acceptance→actual contract in existing suite. This is separate from missing probability input SN-28.

## SN-35 — P2 documentation and test reduction

**Disposition — Implemented with root: seed-owned/persona strings and redundant test contracts reduced. Historical/current identity guards retained. Corrected fixture premise: createTestGame already caches and clones.**

people-directory.test.ts has valuable identity/depth/injection guards; remove fixed-seed Messi OVR<82 and Arsenal seed-specific manager-name expectations from generic behavior cases if catalog updates keep triggering churn. mock-gm.test.ts preserves actual catalog dispatch/clock/negotiation transitions, but repeated grammar/string assertions and costly onboarding extra seeded worlds can be reduced; keep one mock real-path contract smoke and silent-record/history boundary assertions. The original audit did not delete tests; the implementation disposition above records subsequent authorized changes.
Full-read people.md retains PLAYER_ARCHETYPE_TRAITS patience/professionalism/settling/number, owner reinvestment, rivalVoiceOf, pressure ladder and numberWish tables. Follow-up source verification confirms these remain executable; they are NOT stale documentation. Distinguish them from removed social-reaction matrices and private-contribution reputation policy. Exact docs-only corrections are recorded under SN-37.

## SN-36 — P2 test simplification candidates, preserve numerical contracts

**Disposition — Implemented with match agent: sampled growth assertions moved/reduced as balance measurements; training test simplification preserves numerical/calendar/mass/settlement invariants. No duplicate fixture cache added because shared helper already provides it.**

Growth-curve tests keep potential/1..99 bounds, aging sign boundaries, order-independent seeded axis selection, mental-only mentoring, loan-return ownership/logging and mass conservation. The 8000-seed frequency ratio, 3000-seed personal axis comparisons, 1500-seed mentoring growth and explicit seasonal growth bands are balance-harness candidates, not deterministic regression definitions.
Settling tests call createTestGame(11) independently for most cases; build once and clone per case. Keep return-vs-new-arrival lineage, daily event idempotence, fog/progress and bound tests. Remove stale closeOff relation setup from negative-talk cases when it no longer affects the tested transition.
Training-plan tests recreate entire worlds for dozens of calendar cases, duplicate addDays/diffDays utilities, and simulate270 days for cup/reschedule invariant checks. Prefer a compact fixture with appended/shifted cup dates plus one integration entry point; move seasonal menu balance/count ratios to harness. The explicit “old save missing menuId” case contradicts no-save-migrations policy in purpose; verify whether menuId absence is legitimate current data before removing fallback. Preserve custom-order overrides, rest persistence, past-date atomicity and growth mass conservation.
Training-report keeps valuable bounded/idempotent settlement, per-player allowed axes, full/partial interval scaling, report-ledger consistency, potential caps and position conversion. Repeated createTestGame calls and trainOneWeek tick orchestration are replaceable with shared base+clones/direct TrainingBrief fixtures for pure settlement cases. Keep one actual tick→brief integration. Some describes share mutable state/cursors across cases; avoid cross-case order dependence while optimizing fixtures.

## SN-37 — completed documentation reconciliation (four edited paths)

**Disposition — Completed and superseded by implementation reconciliation: people, career, transfer and finance describe present behavior; board reviewed without an unnecessary edit. Story/negotiation README plus relevant common LLM and balance docs updated for new contracts.**

- `docs/story/people.md`: removed the obsolete owner-archetype automatic reputation column for private funding; kept executable owner reinvestment, player traits, rival voices and pressure policies documented. Clarified that relationship tiers supply GM context and do not multiply social effects/pressure.
- `docs/story/career.md`: replaced old reviewUserSeat 75-day/warning-count/automatic-dismissal descriptions with boardAgenda/review_board and prior-date warning guard; removed the deleted owner-demand comparison table and +3/−6 policy; clarified financial requests versus narrative board expectations; corrected departure-card fields to kind, optional position, required reference target/expectationCode; corrected club-local cleanup and current-agenda ownership.
- `docs/negotiation/finance.md`: removed automatic frozen-budget/debt/relegation owner-sale-demand claims; corrected friendly away expenses to zero, current league scaling description and request currency to £; removed the defunct 2% owner-wage-freeze comparison and stale cleanup references.
- `docs/negotiation/transfer.md`: corrected blocked-move threshold to 85% market value and departure fact source to transfer reason codes; removed nonexistent board-sale pricing factor and automatic user-manager warning/position/faith thresholds; removed obsolete warning constants; documented mandate opening cap as per invocation (normal daily tick once), matching actual local counter and test behavior.
  `docs/story/board.md` was fully reviewed and unchanged. These are present-behavior corrections, not implementation of the reduction candidates. Prettier completed for the four edited files. These initial documentation corrections preceded the authorized implementation and verification recorded above.

## SN-38 — delegated test review synthesis (attributed)

**Disposition — Implemented across root/common/match ownership: test policy/distribution cleanup, current manager renewal and continuous reaction fixtures, negotiation cooldown/mandate titles/helper consolidation and retained transaction invariants. Final gate results are root-owned.**

Root/common/match fully read the 17 reassigned files; their coverage ledgers retain attribution. Root: ai-market seasonal transfer/loan-count and fee bands belong in balance harnesses, while money/squad/ownership/determinism remain regression tests. Departures preserve severance/loan ownership/return boundaries; repeated labels and world fixtures can shrink. Manager-market contains cross-it mutable state and duplicate declined interview inputs; some titles still claim board changes while asserting unchanged. Scouting lacks waiting mission retry after freed capacity. GM-input history stability mutates memories only, missing relationship/mentoring mutation (SN-21); onboarding mocks retain removed attributes. Skill-descriptions validates argument names against the union across all tools, so a property belonging only to a different tool passes; hardcoded tool counts and >24 agent-list checks duplicate shape policy, while adapter/schema invariants matter.
Common auditor: cues contains unused target/code fixture parameters; mood 60-day market-frequency and persona 300-seed age/archetype frequency sweeps are harness/data-quality candidates. Persona/press seed-name and archetype-specific expectations should use synthetic or data-derived fixtures; retain bounds/target resolution/queues/windows/ledger tests.
Match auditor: negotiation.test.ts around4323 labels the mandate cap per day but calls runMandates twice on the same date and expects two openings; actual openByPolicy resets its local count per call, now documented accurately. The cooldown case around1620 rejects an offer, generates for20 days, advances60 more, but never generates afterward; it does not test cooldown re-entry despite its title. Retain transactional ownership/money/contract/boundary checks and add only the missing boundary assertion when addressing a corresponding bug.

### SN-35/36 implementation follow-up — match owner

Full-read growth-curve/training-plan/training-report reductions completed: frequency and seasonal bands now live in existing youth-development harness descriptor; shared cached-world fixtures retained, mutable cross-case state/cursor removed; week settlement uses direct trained-session fixtures while daily tick integration remains; shared date helpers replace duplicate arithmetic; 270-day training sweep replaced by explicit distant cup insertion plus existing postpone and real match/tick transitions. Obsolete missing-menu old-save test removed (fallback absent). Bounds, axes order, mental-only mentoring, ownership, idempotence, allowed axes, full/partial scaling, potential and growth-ledger mass contracts retained. Existing training-report focused run passes; growth/training-plan focused pass. Medical tests consolidated into negotiation file; shirt-number invariants common/attributes, development focus training-plan. Negotiation167/167 pass after obsolete archetype/term-count economic oracles removed and cooldown29/30, precontract first offer, agreed personal role, continuous judgment boundaries added.
