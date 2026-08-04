# Research Findings — Wikipedia Search Engine

> **Provenance.** Produced by a 13-agent deep-research workflow (6 research tracks, each
> adversarially verified, then synthesized) run 2026-08-02. 2.1M tokens, 831 tool calls,
> 0 agent errors, **0 rate-limit events** — so the `research-methodology` rate-limit
> false-refute trap does not apply to this run; refutations here are real.
>
> **Independently re-verified by the lead agent (not taken on trust):**
> `https://dumps.wikimedia.org/other/cirrus_search_index/20260726/index_name=simplewiki_content/`
> contains exactly one part file, `simplewiki_content-20260726-00000.json.bz2`,
> **551,960,029 bytes**, dated 26-Jul-2026, plus a 0-byte `_SUCCESS`. Confirmed 2026-08-02.
> Weekly dated dirs present: 20260705, 20260712, 20260719, 20260726.
>
> Claims below carry their original provenance, including every `REFUTED` and `UNVERIFIED`
> flag. Per CLAUDE.md non-negotiable #1, a figure without a source is not a figure.
> This is the **research** artifact; the design doc (non-negotiable #3) derives from it.

---

## 1. Executive verdict

**Feasible; execution risk, not research risk.** Every core algorithm — inverted index, BM25,
PageRank, SPIMI, VByte, BlockMax-WAND — is Tier A on one Bun process against Simple English
Wikipedia. The link-graph track was proved end-to-end: 282,900 articles, 12,879,453 edges,
55.6 MiB CSR, PageRank convergence reproduced to the digit by an independent verifier.

**The biggest risk is not code — it is that you have no relevance judgments.** Kamphuis et al.
found eight BM25 variants statistically indistinguishable on end-to-end effectiveness, and
BM25S vs Elasticsearch differ by 2.3 nDCG points *from tokenization alone*. A working nDCG
number therefore cannot tell you your BM25 is correct, and a wrong BM25 will look fine.
Correctness must come from score-level golden vectors and property tests, not evaluation.
**Build the test harness before the ranker.**

**The one scope decision: take pre-extracted text and never write a wikitext parser.**
Templates expand to content that is not in the dump (Wikidata lookups return `""`; Scribunto
executes Lua), so no offline parser can be correct by construction. This is the largest sink
in every prior project.

---

## 2. The corpus decision

### The dossier contradicted itself three ways

| Track | Recommended | Incompatible with |
|---|---|---|
| `dump-ingestion` | simplewiki multistream XML (381 MB) + saxes | leaves wikitext extraction "out of scope" |
| `wikitext-parsing` | `wikimedia/structured-wikipedia` parquet (34.6 GiB enwiki) | **has no simplewiki — English and French only** |
| `prior-art` | CirrusSearch enwiki_content (39.29 GB bz2, 64 files) | budgets index against a corpus 3.7× smaller |
| `link-graph` | simplewiki pagelinks SQL (153.4 MB, 4 dumps) | — |

Two tracks picked simplewiki; one picked a format that does not exist for simplewiki.

### The constraint that decides it

We rejected Common Crawl because a *slice* leaks rank mass into dangling nodes. A 3-shard slice
of `structured-wikipedia` has **the same defect** — 86 arbitrary shards of 7.6M enwiki rows means
most links point out of the set. For PageRank to mean anything the corpus must be a **complete
wiki**. The only complete wiki that is Tier A is Simple English Wikipedia.

### Recommendation: `simplewiki_content` Cirrus dump + 4 simplewiki SQL dumps

| Artifact | Size | Source |
|---|---|---|
| `simplewiki_content-20260726-00000.json.bz2` | **551,960,029 B (526.4 MiB)**, single part file | HEAD, re-verified by lead |
| decompressed | ≈ **2.83 GB** JSON (5.12× measured on a 3 MB prefix) | derived |
| `pagelinks`+`linktarget`+`page`+`redirect` | 81,807,159 + 37,056,050 + 33,076,929 + 1,454,825 = **153,394,963 B** | dossier, re-measured by verifier |

Measured over 1,645 documents:

- **es_bulk format** — alternating `{"index":{"_id":N}}` action line + document line. Skip every other line.
- **All 1,645 docs `namespace: 0`.** Redirects are folded into the target's `redirect[]` array, not separate stubs. This deletes the `ns===0 && !redirect` filter that discards 49.2% of `pages-articles`.
- Field presence: `text`/`title`/`category`/`heading`/`redirect`/`auxiliary_text`/`outgoing_link`/`popularity_score` **100%**; `incoming_links` 99.5%; `opening_text` **78.3%**; `page_type` 56.9%; `defaultsort` 34.8%.
- Byte shares: `source_text` **33.1%** (raw wikitext you never touch), `text` 14.5%, `template` 12.4%, `outgoing_link` 10.5%.
- Mean `text` = **1,296 chars/doc** → ~**370–410 MB clean text**, ~70M tokens (cross-checked vs `Special:Statistics` 69,557,872 words as of 2026-08-02 — a **live counter**, record as of-date).

**Why it wins:** zero parsing stage; complete wiki so PageRank is meaningful; ships Wikipedia's
own production field set mapping 1:1 onto CirrusSearch's tuned weights (`title 20, redirect 15,
category 8, heading 5, opening_text 3, text 1, auxiliary_text 0.5` —
`CirrusSearch@b5ff901:extension.json`); 526 MiB single file, no multistream offset index needed.

**Fallbacks:** (a) simplewiki multistream XML + a ~30-line balanced-brace stripper (84–93% token
recall / 97–98% precision vs wtf_wikipedia — *researcher's own unpublished implementation,
explicitly NOT reproducible by the verifier; indicative only*); (b) `enwiki_content` shard 0,
text only, no link graph.

**Do not plan around:** abstract dumps (404 since Feb 2025, Phabricator T382069); Enterprise HTML
dumps (frozen since 20250320); `mediawiki_content_current` (no multistream index → no random access).

---

## 3. The phased plan

**Ordering principle: correctness before quality before speed.** Runtime/corpus risk is in
Phase 0; knowing-you-are-right risk is in Phases 3–4. Performance work comes last because it is
the only work with a free correctness oracle — the pre-optimization implementation.

### Phase 0 — Corpus & runtime ground truth
- **Mechanism:** streaming ingest under a bounded memory budget; es_bulk line-pair parsing
- **Stage/half:** pre-pipeline · neither
- **Tier:** A — *breaks at B:* one 526 MiB file has no shard boundary; enwiki is 64 files
- **Deliverable:** `bun run ingest` prints doc count, ns histogram, mean/median `text` length, field-presence rates, peak RSS. A pinned dated corpus on disk.
- **Verify:** doc count lands near **282,900** (near 397,196 = redirect stubs leaked; near 557,308 = wrong index). Field-presence reproduces above ±1%. Memory harness **with a negative control**: 200 MB × 6 passes through `node:fs` (must stay flat) *and* `Bun.file().stream()` (must leak ~214 MB/pass). If no leak, you're on Linux and Trap R1 doesn't apply — record which.
- **Effort:** 3–5 evenings · **Depends on:** nothing

### Phase 1 — The analyzer
- **Mechanism:** NFKC → case folding → tokenization → stopword policy → optional Porter stemming. One function, both sides.
- **Stage/half:** document processing · **matching**
- **Tier:** A — *breaks:* not at scale; it breaks *across engines*, which is why every cross-engine comparison later is analyzer-bound
- **Deliverable:** `analyze(text): {term, position}[]` + a 100-doc golden fixture in the repo
- **Verify:** the non-negotiable **as an executable property test** — `analyze(s)` from the document path and the query path must return identical arrays over random corpus strings. Token count must equal the `fieldLength` handed to BM25; assert at the call site. Unicode fixtures (`Çöl Qala`); read bytes explicitly as UTF-8, never through a shell pipe.
- **Effort:** 3–5 evenings · **Depends on:** Phase 0

### Phase 2 — Inverted index + boolean retrieval
- **Mechanism:** dictionary → postings sorted by docID; **merge-join intersection**; galloping for skewed lists
- **Stage/half:** index construction + serving · **matching**
- **Tier:** A in-memory — *breaks at B:* postings exceed RAM; dictionary → on-disk FST; segments needed
- **Deliverable:** `bun run index`, `bun run query "a AND b"`. Report unique terms, total postings, RSS.
- **Verify:** intersection oracle — 500 random 2-term queries, merge-join output must **equal** a brute-force `Set` filter (exact set equality). Build-time assertions: postings strictly increasing, no duplicates, `df === postings.length`. Dictionary memory: `Map<string,…>` costs **231–261 B/entry** (researcher and verifier within 1%); flat UTF-8 blob + `Int32Array` offsets measured **58.7–70 B/term peak**, **~15.5 B/term retained**. Assert your dictionary RSS is under the flat-layout budget.
- **Effort:** 5–8 evenings · **Depends on:** Phase 1

### Phase 3 — BM25 + top-k
- **Mechanism:** BM25, Lucene form — `score = idf · tf/(tf + k1·((1−b) + b·dl/avgdl))`, `idf = log(1 + (N − df + 0.5)/(df + 0.5))`; top-k min-heap
- **Stage/half:** ranking · **ranking**
- **Tier:** A, exact `Uint32Array` doc lengths (4 MB/M docs) — *breaks at B:* norms must compress. Do **not** copy Lucene's `SmallFloat.intToByte4` now: 11.111% max length error, permanently blocks score-diffing. (Lucene's stated motive is a 256-entry precomputation cache, not memory; Kamphuis measured that speed benefit negligible — 52 vs 55 ms/topic — and suggested Lucene store exact lengths.)
- **Deliverable:** ranked results with `explain()` decomposing idf / tf-component / length-norm
- **Verify — three rungs, in order:**
  1. **Property tests** (how Lucene validates its own BM25, `BaseSimilarityTestCase.doTestScoring`): finite; ≥ 0; ≤ `score(tf=∞) = idf`; monotone non-decreasing in `tf`; non-increasing in `dl`; non-increasing in `df`; `explain().value === score()` exactly.
  2. **Golden vectors you compute yourself** — no published BM25 test vectors exist (`TestBM25Similarity` has zero score assertions). Both researcher and verifier independently reproduced: `N=1000, df=50, tf=3, dl=90, avgdl=100, k1=1.2, b=0.75` → `K=1.11`, `idf=2.9867814430339066`, `tf-component=0.7299270072992701`, **`score=2.180132440170735`** (`4.796291368375616` with `(k1+1)`). Plus boundaries `df=0`, `df=N`, `tf=0`, `dl=0`, `b=0`, `b=1`, `k1=0`.
  3. **Differential vs `bm25s` `method="lucene"`**, k1/b set explicitly on both sides (bm25s defaults k1=1.5), tokenization pinned both sides.
- **Effort:** 4–6 evenings · **Depends on:** Phase 2

### Phase 4 — Evaluation harness
- **Mechanism:** **nDCG@k, trec_eval convention** — `DCG@k = Σ rel_i / log2(i+1)` discounted at every rank, linear gain, **iDCG from the qrels** sorted descending truncated at k, return 0 (not NaN) when iDCG = 0
- **Stage/half:** cross-cutting · measures **ranking**
- **Tier:** A
- **Deliverable:** `bun run eval` over TREC-format run + qrels; a 30–50 query hand-judged simplewiki qrel set (pooled top-20 across your own variants, graded 0–3)
- **Verify:** same run+qrels through `trec_eval`/`pytrec_eval`, agree to **1e-6** — the only unambiguous check, since three nDCG conventions share one name. Zero-relevant topic yields 0, not NaN. **Honesty constraint in the doc:** a self-judged qrel set is a *relative* instrument, valid for A/B between your own variants, invalid as an absolute number — and per Kamphuis + BM25S, end-to-end nDCG **cannot** distinguish correct BM25 from subtly-wrong BM25. Phase 3 golden vectors are the correctness tool; this is the quality tool. Optional absolute anchor: index BEIR SciFact/NQ as a **separate** index vs published BM25 nDCG@10 (NQ 0.329, SciFact 0.665, HotpotQA 0.603) — those are **Anserini at k1=0.9/b=0.4 with Anserini's analyzer**, so matching requires matching the analysis chain.
- **Effort:** 4–6 evenings + a weekend judging · **Depends on:** Phase 3

### Phase 5 — PageRank on the link graph
- **Mechanism:** power iteration with damping + **rank-one dangling-node fix**. `P̄ = P + avᵀ`, `Ḡ = αP̄ + (1−α)evᵀ`; operationally `base = (1−d)/N + d·m/N` where `m` = summed rank of zero-out-degree nodes. CSR (`rowPtr`, `col`, `outdeg`).
- **Stage/half:** ranking, query-independent prior · **ranking**
- **Tier:** A for simplewiki (**55.6 MiB**, byte-exact 58,307,416 B) *and* A for full enwiki (849.9 MiB CSR at LAW enwiki-2025 sizing) — *breaks at B:* only the unfiltered all-namespace graph (~1.7–2.1 B rows — **explicitly an unverified extrapolation**)
- **Deliverable:** `bun run pagerank` → rank vector keyed by page_id + top-1000 titles, consumed as a ranking prior
- **Verify — five checks, all reproduced by an independent verifier:**
  1. **Parser vs live ground truth:** simplewiki page 223430 (Barack Obama) = **969** ns-0 outlinks via `api.php?action=query&prop=links&plnamespace=0&pllimit=max` with continuation. `Cat` (2815) = **253**.
  2. **`sum(PR) ≈ 1` asserted every iteration** (measured 1.000000000001). Catches every dangling-node bug; without the fix each iteration destroys `d·m = 0.172%` of mass.
  3. **Convergence marks:** L1 < 1e-4 @ 24, < 1e-6 @ 41, < 1e-8 @ 62, < 1e-10 @ 86, < 1e-12 @ 110 — all five reproduced exactly. **Do NOT write "numerically stalled at 123" — REFUTED**; the verifier was still decreasing smoothly at iteration 200 (6.448e-20).
  4. **Template-contamination fingerprint as an oracle:** two independent implementations landed on the identical top-8 — `Wayback_Machine, United_States, International_Standard_Book_Number, France, Geographic_coordinate_system, United_Kingdom, Internet_Movie_Database, Digital_Object_Identifier`. Matching top-8 means your namespace filtering and redirect resolution match.
  5. **Edge accounting:** 13,085,755 raw → resolve one hop → **197,724 duplicates** removed (**not 206,144 — REFUTED**) → **8,409 self-loops** after resolution (8,251 newly created, 158 pre-existing) → 169 broken-redirect drops → **12,879,453 unique edges**, avg out-degree 45.53, 1,655 dangling (0.59%). Total shrinkage = 206,144 = 197,724 + 8,251 + 169.
- **Effort:** 6–10 evenings · **Depends on:** Phase 0 (dumps), Phase 4 (to *measure* whether the prior helps)

### Phase 6 — BM25F + signal combination
- **Mechanism:** **fold per-field evidence into one pseudo-frequency, then saturate once.** `t̃f = Σ_s v_s · tf_s / B_s` where `B_s = (1−b_s) + b_s·sl_s/avsl_s`, then `t̃f / (k1 + t̃f) · idf`
- **Stage/half:** ranking · **ranking**
- **Tier:** A — *breaks at B:* per-field `avsl_s` and `docCount` must be maintained per segment and merged
- **Deliverable:** multi-field scoring over `title / redirect / category / heading / opening_text / text / auxiliary_text` seeded with CirrusSearch production weights (20/15/8/5/3/1/0.5), combined with the Phase-5 prior, measured against Phase 4
- **Verify:** **the ceiling property test** — as `tf → ∞` a single term's contribution must converge to exactly `idf` (2.9868). If it converges to `idf·Σv_s` (17.92 — **6×**) you are summing per-field BM25 scores instead of folding. Assert the denominator is plain `k1 + t̃f` (writing `k1·B + t̃f` double-applies length normalization and survives casual review). Assert `N` is **field-scoped** and `avgdl` is per-field. Never expose a `scoreField()` returning per-field BM25 — the only thing a caller does with it is add them up.
- **Effort:** 4–6 evenings · **Depends on:** Phases 3, 4, 5

### Phase 7 — Positional postings + phrase queries
- **Mechanism:** positional postings; positional intersection (docID merge → position-list merge with offset constraint)
- **Stage/half:** index construction + serving · **matching**
- **Tier:** A→B pressure — *breaks at B:* per IR-book §2.4.2 positions make Boolean intersection `Θ(T)` in total tokens rather than `Θ(N)` in documents; index grows 2–4×
- **Deliverable:** `"exact phrase"` queries + a **published size table** (docIDs-only vs +freqs vs +positions on this corpus)
- **Verify:** phrase oracle — brute-force positional scan over raw `text` returns the identical doc set. Size: expect ~1.85× more entries positional vs not (IR-book Table 5.1 case-folding row: 96,969,056 vs 179,158,204). **Do NOT use "freqs adds ~2%" — REFUTED**; GitLab's 2% and 33% apply to disjoint field sets. **This measurement is the one genuinely novel artifact of the project** — four sources fail to answer it for four different reasons (RCV1 is 2009 newswire; GitLab conflates field sets; the Elastic 1.17× figure is an ES index *with `_source`* over a dump duplicating content as `text` + `source_text` — **REFUTED as a raw-text ratio**; Pyserini sizes are `-storeRaw`). Publish it.
- **Effort:** 4–6 evenings · **Depends on:** Phase 2

### Phase 8 — SPIMI spill + external merge + immutable segments
- **Mechanism:** **SPIMI** (accumulate, spill sorted block on budget trip, merge blocks); immutable segments + background merge
- **Stage/half:** index construction · **matching** (build side)
- **Tier:** **A → B bridge** — this is where you *become* Tier B. *Breaks at C:* MapReduce/Percolator distribution, snapshot isolation
- **Deliverable:** on-disk segmented index outliving the process, built under a declared RSS ceiling
- **Verify:** **merge equivalence** — merged on-disk index must produce postings byte-identical to the Phase-2 in-memory build for the same corpus. Free, total oracle. Spill must actually fire: assert peak RSS under budget via `process.memoryUsage.rss()` or `bun:jsc memoryUsage().current` (they agree exactly). **Never `heapUsed`** — reported 128 MB against 291 MB real RSS. Build CSR by two-pass counting, not by sorting packed 64-bit keys: at 181M edges the key-sort buffer is 1.45 GB with a 2.9 GB doubling spike, larger than the finished 724 MB structure.
- **Effort:** 8–12 evenings — the largest phase · **Depends on:** Phases 2, 7

### Phase 9 — Posting compression
- **Mechanism:** delta gaps + **VByte**, then **group varint**; the decode-bound trade-off (byte-aligned beats tighter bit-level on the serving path)
- **Stage/half:** posting compression · **matching** (storage)
- **Tier:** B
- **Deliverable:** compressed segments + a `ns/int` decode-rate benchmark
- **Verify:** round-trip `decode(encode(x)) === x` for random sorted lists incl. empty, single element, docID 0, max gap. **Scores after compression bit-identical to before** — any drift is a decoder bug, not rounding. Report against the RCV1 anchor: compressed docID-only postings were 101 MB (gamma) / 116 MB (VByte) against **960 MB of text** = **10.5–12%**. Do *not* quote the book's headline 3% — measured against a 3600 MB collection that is mostly XML markup.
- **Effort:** 4–6 evenings · **Depends on:** Phase 8

### Phase 10 — Skip lists, block-max, WAND / BlockMax-WAND
- **Mechanism:** `nextGEQ` forward seek, skip pointers, per-block max scores, **WAND** and **BlockMax-WAND** dynamic pruning
- **Stage/half:** index serving · **matching *and* ranking** — where the two halves fuse
- **Tier:** B — *breaks at C:* doc-partitioned shards across machines, serving tree, tail amplification `1−(1−p)^N`, hedged/tied requests
- **Deliverable:** top-k that scores a fraction of candidate postings, with a documents-scored counter
- **Verify:** **the safety property** — WAND's top-k must be *exactly equal* (same docIDs, same scores) to exhaustive DAAT over the same query set. Not "similar", not "same top 3". Exact. If not, your block-max upper bounds are wrong. Measure documents-scored before/after; pruning that doesn't reduce the count isn't pruning. Latency: Brown CSCI 1580's ≤10 s/query as the embarrassing-first-pass ceiling; Lucene's 192.474 QPS two-high-frequency AND (~5.2 ms) is aspirational but **divide first** — that run uses `SEARCH_CONCURRENCY=8` intra-query threads with `numConcurrentQueries=1`, `topN=100`. Not a single-threaded number. **Optionally simulate Tier C:** split into N in-process shards + merger; learn fan-out/merge and cross-shard score normalization without a network.
- **Effort:** 8–12 evenings · **Depends on:** Phases 3, 8, 9

### Optional Phase 11 — Query processing
Spell correction (Levenshtein automaton ∩ term FST; noisy-channel scoring) and prefix autocomplete
over the term FST. Good algorithms, orthogonal to the core. Only after Phase 10 ships.

---

## 4. The traps

### Runtime (Bun) — all reproduced first-hand

| # | Trap | Phase | Avoidance |
|---|---|---|---|
| R1 | `Bun.file().stream()` **leaks ~214 MB per 200 MB pass**; `Bun.gc(true)` does not reclaim it (native memory, invisible to every JS heap metric) | 0, 8 | Use `node:fs` `createReadStream` or a `readSync` positional loop — both measured flat. **CARRY FORWARD:** #17228 *closed* 2026-05-13, not reproducible on Linux x64; #26321 says "Only observed on Windows". **Linux status UNVERIFIED.** |
| R2 | **No enforceable heap cap.** `--max-old-space-size`, `--smol`, `BUN_JSC_forceRAMSize` all silently ignored — four configs completed at ~1559 MB. The OOM killer is your only limit. | 8 | Own RSS budget + SPIMI spill trigger. **CARRY FORWARD:** PR #34924 is *open, not merged*. Write "until #34924 lands", not "permanent property". |
| R3 | `BunFile.slice(a,b).stream()` **ignores slice bounds** (#8718, closed *not planned*). `.size`/`.bytes()` are correct, so the object looks right in review. | 0 | `fs.readSync(fd, buf, 0, len, position)`. **Correction:** `new Response(slice).arrayBuffer()` returns *correct* bytes — only the `getReader()` path is broken. The byte counts (4,925,632 / 5,411,392) are machine-dependent, not constants. |
| R4 | `Bun.mmap` throws `TODOError: mmapFile is not supported on Windows`, and `typeof Bun.mmap === 'function'` **lies** | 8 | Gate on `process.platform`, never `typeof`. Even on Linux, truncating a mapped file segfaults the process — live hazard during segment merge. |
| R5 | `heapUsed` under-reports ~2.3× (128 MB vs 291 MB RSS); `estimateShallowMemoryUsageOf` returns 32 B for a 1M-entry Map | 0, 8 | RSS or `bun:jsc memoryUsage().current` only. Measure each memory shape in an **isolated process** — sequential RSS deltas in one process produced negative per-term costs. |
| R6 | **`Int32Array` is NOT 2.05× faster than `number[]` — REFUTED.** Monomorphic 1.13×; polymorphic `Int32Array` was **1.45× SLOWER** | 2, 9, 10 | Keep `Int32Array` — the **~1.9× memory** win is confirmed (4.75 vs 9.36 B/elem) and is the real justification. The performance rule is different: **keep the hot intersection call site monomorphic.** |

### Corpus

| # | Trap | Phase | Avoidance |
|---|---|---|---|
| C1 | Cirrus dumps are **es_bulk** — half the lines are `{"index":{"_id":N}}` | 0 | Skip alternating lines |
| C2 | **Fields are omitted, not zeroed** — `incoming_links` 99.5%, `opening_text` 78.3%, `page_type` 56.9%, `defaultsort` 34.8% | 0, 6 | Default explicitly at read time. Never `doc.incoming_links.length` unguarded |
| C3 | **33.1% of the download is `source_text`** — the raw wikitext you were told you'd never touch. Expansion 5.12× | 0 | Discard at parse; never materialize. Budget disk for the compressed file only |
| C4 | Abstract dumps **gone** (404, T382069); Enterprise HTML frozen Mar 2025; legacy XML deprecated, replacement has no index | 0 | Every "index Wikipedia abstracts" tutorial points at a dead URL. Build against a *stream-offset abstraction*, not a file format |
| C5 | XML fallback: `<revision><id>` **overwrites page `<id>`** without depth tracking; depth constant is **2 for an isolated stream fragment but 3 on the full-file path** | 0 | Derive depth from parse mode; hardcoding re-introduces the bug the check exists to prevent |
| C6 | Index-line titles contain colons (`552:11:Wikipedia:Administrators`) | 0 | Split on the **first two** colons only |
| C7 | `Special:Statistics` is a **live counter** (283,877 → 283,878 → moving) | 0 | Record as an of-date figure |

### Link graph

| # | Trap | Phase | Avoidance |
|---|---|---|---|
| L1 | **`pagelinks` post-MW 1.43 has only `(pl_from, pl_from_namespace, pl_target_id)`** — `pl_namespace`/`pl_title` are gone. Every pre-2024 tutorial is broken. | 5 | Download `linktarget` + `page` + `redirect` too. `linktarget` is append-only with stale ids — join *through* pagelinks, never iterate it as a node list |
| L2 | **83% of distinct ns-0 link targets are red links** (1,716,536 of 2,061,749) | 5 | Drop them, or N triples and every one is dangling |
| L3 | Redirect pages appear as **sources** (140,454 rows) — the `#REDIRECT` link is a real pagelink | 5 | Filter `page_is_redirect` on the source or every redirect launders rank through a 1-outlink node |
| L4 | Post-resolution work is **three steps**; the PK `(pl_from, pl_target_id)` protects none (it dedupes on the *pre*-resolution target) | 5 | resolve one hop → **dedupe** → **drop self-loops**, in that order. Don't chase chains: MediaWiki refuses double redirects; only 5 exist in simplewiki |
| L5 | Brin & Page's dangling treatment ("remove then add back") is wrong — Langville & Meyer: *"we are certain that the removal of dangling nodes is not a fair procedure."* And **the 1998 paper contradicts itself**: `PR(A) = (1−d) + d·Σ(…)` sums to N, but the next sentence claims 1 | 5 | Use the normalized form + rank-one fix. Reference shape: `nayuki:Pagerank.java:122-135` |
| L6 | **Do not validate against LAW's arc counts.** LAW enwiki-2023 = 165M arcs vs pagelinks-ns0 ~477M, implying LAW is wikitext-derived. Their page never says. **OPEN QUESTION, not a fact.** | 5 | You'd "fail" a test that was never comparable. Likewise WikiLinkGraphs retains resolved redirects as orphan nodes, so its N is not an article count |
| L7 | **Citation defects to fix before sign-off:** there is no Langville & Meyer "Eq. (5.1)" — it is equation (1) *inside* §5.1; page numbers 343–346 belong to the published *Internet Mathematics* version, not the 34-page preprint; the subdominant-eigenvalue result is **Kamvar & Haveliwala's**, reported by L&M | 5 | Cite-or-label is mandatory here. Fix all three |
| L8 | **Template contamination changes the ranking, not just the size.** pagelinks yields 3.36× more edges than wikitext (45.53 vs 13.55 avg out-degree) because navboxes and citation templates count → ISBN and "Geographic coordinate system" outrank real topics | 5 | Simultaneously a *validation oracle* (the L8 fingerprint) and a *quality defect*. Decide explicitly and write it in the design doc |

### Ranking / evaluation

| # | Trap | Phase | Avoidance |
|---|---|---|---|
| B1 | **Absolute BM25 scores are not comparable across engines.** ES = 2.2× Lucene at k1=1.2, because ES's "BM25" is `LegacyBM25Similarity`, restoring `(k1+1)` via `scorer(boost * (1 + k1), …)` | 3 | Never diff absolute scores against an ES `_explain`. Also **scope the claim**: Lucene 8.0 MIGRATE says ordering "is typically preserved *unless multiple fields with different similarities are involved*" — so "(k1+1) can't change ranking" holds only for uniform-k1 single-similarity, which stops being true in Phase 6 |
| B2 | **Unguarded RSJ IDF goes negative at exactly `df = N/2`.** N=1000: df=499 → +0.003996, df=500 → 0, df=501 → −0.003996, df=999 → −6.50 | 3 | Use `log(1 + …)`. Otherwise a >50%-frequency term *penalises* documents containing it — a ranking inversion. The 0.5 pseudo-counts are a **separate** fix (they prevent ±∞ at df=0/df=N); they do not prevent negativity |
| B3 | **Four default parameter sets in the wild.** Lucene/ES 1.2/0.75; Anserini/Pyserini/BEIR 0.9/0.4; bm25s 1.5/0.75; Okapi original 1.2–2.0/0.6–0.75. **The BEIR paper misattributes 0.9/0.4 as "the default Lucene parameters"** — they are Anserini's | 3, 4 | Print parameters into run metadata every run |
| B4 | **Wikipedia-specific parameter leakage.** k1=0.9/b=0.4 come from tuning on the **INEX 2008 Wikipedia collection** (Trotman et al., SIGIR 2012 OSIR) — a genuine reason to prefer them here, but reporting them as "we tuned these" would be false, and using them while evaluating on Wikipedia is mild leakage | 3, 4 | Cite Trotman et al.; report both parameter sets |
| B5 | **Summing per-field BM25 raises the per-term ceiling from `idf` (2.987) to `idf·Σv_s` (17.92)** — a keyword stuffed across title/heading/anchor beats a document matching the whole query, the exact pathology BM25 exists to prevent | 6 | Fold first, saturate once. Test the ceiling |
| B6 | **`t̃f / (k1·B + t̃f)` double-applies length normalization** — `B_s` already divided `tf` inside the sum | 6 | Denominator is plain `k1 + t̃f`. Survives casual review because it looks like BM25 |
| B7 | **nDCG has three incompatible conventions with one name.** J&K 2002 does not discount below the log base; trec_eval discounts at every rank; LTR uses `2^rel − 1` gain (**this third one flagged UNVERIFIED — carry the flag**) | 4 | Implement trec_eval's, cite it in the code comment, validate against `pytrec_eval` |
| B8 | **iDCG must come from the qrels, not your run.** Building it by sorting *your retrieved results* makes a bad system score 1.0 whenever it returns nothing relevant in an unlucky order | 4 | Sort the qrels descending, truncate at k |
| B9 | **Rank-level agreement proves nothing about formula correctness.** Kamphuis found no significant difference across eight BM25 variants; BM25S 39.7 vs ES 42.0 on BEIR attributed to *tokenization* | 4 | End-to-end nDCG passes happily with a wrong IDF, missing length normalization, or swapped k1/b. **Kamphuis's evidence base is three TREC newswire collections with AP and P@30 at k1=0.9/b=0.4 — not Wikipedia, not nDCG@10.** Extrapolation unlicensed by the source |
| B10 | **Brown CSCI 1580 is not an oracle.** Corpus at `/course/cs158/data/part1/` — internal path, no public URL. No reference implementation. Part 1 says *"We will not grade the speed of your code."* | 4, 10 | Lift the milestone *structure*; expect no grader and no corpus |
| B11 | **BEIR datasets are their own corpora with their own doc IDs.** DBPedia-entity is entity abstracts, not article text | 4 | Validating against BEIR means indexing BEIR. It validates scorer + analyzer, not the shipped pipeline |

---

## 5. What to explicitly NOT build

1. **A crawler.** The corpus is a dump. Read Mercator/IRLbot for frontier/politeness/DRUM ideas; build nothing. *(Patterson: "The really hard problem with crawlers is to perform dynamic duplicate elimination." You get that free.)*
2. **A wikitext parser on the critical path.** Provably not fully solvable offline: Sweble — *"the Wikitext language is defined by the MediaWiki parser itself"* and it *"requires global parser state and can therefore be considered a context-sensitive language."* Measured: `Bun (software)`'s `latest release version` returns `""` because it lives in Wikidata; Scribunto runs arbitrary Lua. *(Contradiction named: MediaWiki's own `Markup_spec` calls wikicode context-free — but that page is marked obsolete, "mainly active 2006-2010", and concedes no formal spec is complete. Side with Sweble: peer-reviewed, later, backed by a working implementation.)* **Optional side quest only:** a ~30-line balanced-brace state machine as a deliberate exercise, benchmarked against the Cirrus `text` field as ground truth. Never `{{[^{}]*}}` — measured leaking `| logo = | genre =` into the document head.
3. **Semantic / vector / ANN retrieval.** Embedding quality is the ceiling; ANN is only speed. You'd be evaluating someone else's embedding model, not learning IR.
4. **LTR / LambdaMART.** Needs labeled training data and click logs you won't have. Read `paper-lambdamart-ltr` for the cascade idea; the cascade is Phase 10's pruning, not a GBDT.
5. **Behavioral ranking signals.** Established decision (web-search style). **But** the house R-SCALE rule says instrument from day one if ever used — so from Phase 3, append `{ts, query, rankedDocIds, clickedDocId}` to a JSONL. ~20 lines, preserves the option, builds no feature store.
6. **Distributed sharding, serving trees, hedged/tied requests.** Tier C. *Simulate* doc-partitioned shards in-process in Phase 10; skip the network.
7. **Percolator / incremental indexing.** Segments + background merge (Phase 8) is the Tier-B answer.
8. **mmap-backed segments** (Trap R4).
9. **Lucene's `SmallFloat` one-byte norm** (Phase 3 tier note).
10. **`k3` query-side saturation.** Lucene ships it disabled (`-1f`); only matters for long queries with repeated terms.
11. **A pure-JS bzip2 decoder in the hot path.** Neither Bun nor Node has bzip2 anywhere (0 matches for `/bz/i` in both `Bun.*` and `node:zlib`). `Bun.spawn(['bzip2','-dc',file])` measured 8.66–9.1 MB/s vs 4.7–4.9 MB/s for `unbzip2-stream`.
12. **Config systems, plugin loaders, analyzer frameworks** (CLAUDE.md non-negotiable #5). One analyzer function, hardcoded weights.
13. **Lucene or Elasticsearch as a runtime dependency** — that defeats the project. But **do** install `bm25s` and `pytrec_eval` as *test-only* oracles. Write that distinction down.

*Named contradiction:* Patterson says *"Don't do page rank initially. Actually don't do it at all."* She was optimizing for shipping a product with a small team. This project optimizes for learning, and PageRank is the marquee algorithm. Her advice still binds on **order** — which is why PageRank is Phase 5, after BM25 and after the evaluation harness, not Phase 1.

---

## 6. Open questions before Phase 1

1. **Windows or Linux build machine?** The `Bun.file().stream()` leak, `Bun.mmap` `TODOError`, and GC crash reports are all Windows-observed; a Bun member closed #17228 unable to reproduce on Linux x64. **Linux status UNVERIFIED.** Changes Traps R1 and R4 from hard constraints to re-test items.
2. **Which dated dump do you pin?** Cirrus measured at `20260726`; dossier measured simplewiki SQL at `2026-07-02` / enwiki `20260701`. `latest/` moves. Pin both to the *same* vintage or the link graph and text corpus disagree about which pages exist.
3. **pagelinks or wikitext for the link graph?** pagelinks: 12,879,453 edges, avg 45.53, fully verified pipeline, but template-contaminated (ISBN/coordinates top the ranking). Wikitext: 3,833,031 edges, avg 13.55, "United States" on top — but needs the parser you just decided not to build. **Third option this synthesis surfaced:** the Cirrus dump ships `outgoing_link` per document (10.5% of bytes) — MediaWiki's own link extraction. Worth checking in Phase 0 whether it matches pagelinks or wikitext semantics; that would give a clean wikitext-quality graph with no parser. **UNVERIFIED — not compared this run.**
4. **Evaluation substrate?** Hand-judged simplewiki qrels (relative only), BEIR as a separate scorer oracle (absolute, validates only the scorer), or both? Must be settled before **Phase 3**, not Phase 4 — it determines whether `explain()` and score-level diffing are load-bearing.
5. **Reported default: k1=1.2/b=0.75 or k1=0.9/b=0.4?** And do you accept the INEX-2008-Wikipedia leakage argument (Trap B4)?
6. **Positions in v1 or deferred?** Brown ships them in Part 1. Cost: 2–4× index size, Boolean intersection `Θ(N) → Θ(T)`. Phase 7 assumes deferred; moving it earlier is defensible.
7. **Latency budget, or is "runs" enough?** Without one, Phases 9 and 10 have no exit criterion.
8. **Confirm in Phase 0** (only 1,645 docs sampled): the full parse lands near **282,900** docs and no redirect stubs appear as separate documents. The sample was 100% ns-0 with `redirect[]` folded onto targets — but that is a 0.5% sample.

---

*Measurements taken during the research run and not present in the source dossier:
`simplewiki_content` existence, size (551,960,029 B), single-file layout, 5.12× decompression
ratio, es_bulk format confirmation, per-field presence rates, byte shares, mean `text` length
(1,296 chars/doc). The size and single-file layout were **independently re-verified by the lead
agent** against the live dumps server on 2026-08-02. All other figures carry their dossier
provenance including every REFUTED and UNVERIFIED flag.*
