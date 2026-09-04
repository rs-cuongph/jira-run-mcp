# `jira_daily` — Design Spec

**Date:** 2026-08-18  
**Status:** Draft — pending user review

## Goal

Add a read-only MCP tool named `jira_daily` that returns a single Markdown
report for one Jira project and report date. The report combines project
counts, status distribution, due and overdue work, progress, dependency and
blocker signals, short analysis, and navigation hints.

## Requirements

1. Input is a Jira `projectKey`, with optional `date`, `maxIssues`, and
   `maxBlockers`.
2. `date` uses `yyyy-MM-dd` and defaults to `todayLocalDate()`.
3. `maxIssues` defaults to 50 and is limited to 1–200. `maxBlockers` defaults
   to 20 and is limited to 1–50.
4. The tool only reads Jira and does not require write confirmation.
5. All validation, authentication, Jira, and unexpected business errors are
   returned with `isError: true`.

## Completion and scope rules

An issue is treated as complete when either its `statusCategory` is `done` or
its status name (case-insensitive) is one of `Cancel`, `Resolved`, or `Closed`.
The active, due-today, and overdue scopes exclude these completed issues.

The report uses four project/date-scoped searches:

- Active issues: unresolved issues not in the completed status set.
- Due today: unresolved issues whose due date equals the report date.
- Overdue: unresolved issues whose due date is before the report date.
- Recently completed: issues resolved/closed/Cancel in the seven days
  ending on the report date, used as a progress baseline.

Jira result totals are retained for counts even when the returned issue detail
is limited by `maxIssues`. Detail rows and analysis operate on the bounded,
deduplicated issue set.

## Architecture

`jira_daily` is an orchestration tool over the existing HTTP and mapping
layers. It must not access Playwright or browser state.

| Layer | Responsibility |
|---|---|
| `src/tools/daily.ts` | Zod schema, four JQL builders, parallel searches, progress/blocker analysis, Markdown formatting, error handling |
| `src/jira/http-client.ts` | Existing search and issue-link HTTP calls; add only the fields/method support required by the report |
| `src/jira/mappers.ts` | Map raw Jira fields to normalized search summaries |
| `src/types.ts` | Stable normalized summary fields used by tools |
| `src/types/jira-api.ts` | Raw Jira search and issue-link response shapes |
| `src/utils.ts` | Existing `todayLocalDate`, `navigationHint`, and bounded-concurrency helper |
| `src/server.ts` | Register the `jira_daily` MCP tool |

Before changing shared symbols, run GitNexus impact analysis for
`JiraHttpClient`, `searchIssues`, the summary mapper, and `createMcpServer`.
If any report is HIGH or CRITICAL, reassess the change before editing. After
implementation, run `detect_changes()` and confirm only expected symbols and
execution flows changed.

## Search fields and normalized data

Extend `SEARCH_FIELDS`, raw API types, the mapper, and `JiraIssueSummary` with:

- `statusCategory` (the Jira status category key/name needed for distribution);
- `labels`;
- `description` for text-based blocker signals;
- `customfield_11919` as `progressWbsGantt`;
- `customfield_10338` as `percentDone`.

Existing status, assignee, priority, dates, time tracking, URL, and estimate
fields remain available. Missing optional values normalize to `null` or an
empty array consistently with existing mapper conventions.

## Progress calculation

Per issue, parse `Progress (WBSGantt)` first and fall back to `% Done` only
when WBSGantt is absent or unusable. Preserve the selected source for display.
Do not calculate a synthetic issue percentage from time estimates.

The report's total project progress is a weighted mean:

```text
sum(issueProgressPercent * originalEstimateSeconds)
----------------------------------------------------
       sum(originalEstimateSeconds)
```

Only issues with a valid positive `originalEstimate` and usable progress are
included. The report shows the resulting percentage, number of included
issues, and total estimate weight. It also reports issues excluded because of
missing estimate or progress. If no valid sample exists, total progress is
`N/A` rather than an inferred value.

The status/progress table uses `statusCategory` for To Do, In Progress, and
Done distribution, plus progress source and missing-data counts. Estimate and
time-tracking details are shown only when Jira supplies them.

## Blocker and risk analysis

Select at most `maxBlockers` candidate issues from active, due, overdue, and
text-signal sets. Fetch issue links with the existing `getIssueLinks()` method
using the shared bounded-concurrency helper. Do not fetch comments or
changelogs for the whole project in v1.

Each reported item records its signal source:

1. An issue link whose relation is `is blocked by` or `blocks`.
2. Summary, description, or labels containing `blocked`, `blocker`,
   `blocking`, `blocked by`, `dependency`, `phụ thuộc`, or `vướng`.
3. An unresolved issue that is overdue.
4. An active issue that is stale or has not been updated for a long period.

Severity is assigned as follows:

- **High:** dependency link or blocker phrase combined with overdue status.
- **Medium:** dependency or text signal without overdue status.
- **Risk:** stale or overdue without a clear dependency link.

The output must distinguish heuristic text signals from actual Jira links and
may show more than one signal for the same issue. Link-fetch failures are
reported as partial analysis data when possible and do not discard the base
project report.

## JQL and concurrency

Build all JQL through small testable helpers. Quote/escape the project key and
date values using the existing Jira query conventions. Run the four searches
with `Promise.all` after authentication. Use the search `total` values for
summary counts and bounded issue arrays for detail output.

## Markdown output

The output has this order:

1. Project/date header.
2. Executive summary with total issues, active, in progress, done, due today,
   overdue, blocker/risk count, and weighted total project progress.
3. Status and progress table.
4. `Due Today` table: key, summary, status, assignee, priority, progress,
   due date, URL.
5. `Overdue` table with days late.
6. `Blockers & Risks` table with key, source signal, severity, related
   dependency, assignee, and URL.
7. `Analysis` with only data-supported observations: due-today items not done,
   overdue concentration by assignee/status, missing assignee/progress,
   multiple dependencies, and WBSGantt versus `% Done` differences.
8. A final `navigationHint()` pointing to relevant tools such as
   `jira_get_issue`, `jira_get_issue_links`, `jira_get_issue_history`,
   `jira_search_issues`, and `jira_find_stale_issues`.

Empty projects must return the complete section structure with zero counts and
no error.

## Registration and documentation

- Register `jira_daily` in `createMcpServer()` with the input schema and
  read-only description.
- Add `docs/tools/jira_daily.md` with purpose, inputs, output sections, and
  examples.
- Update README's tool list and reference section.
- Add an implementation plan under `docs/superpowers/plans/` after this spec is
  approved.

## Testing

Add `src/tests/daily.test.ts` covering:

- valid project key and default local date;
- invalid project key, date, and limits;
- exact active, due-today, overdue, and seven-day completed JQL;
- parallel search calls and correct total/detail merging;
- WBSGantt priority and `% Done` fallback;
- weighted total progress, coverage, and `N/A` with no valid sample;
- status-category distribution and completed-status exclusions;
- blocker detection from links, text, overdue, and stale signals;
- `maxIssues`/`maxBlockers` bounds without corrupting totals;
- complete Markdown sections and navigation hint;
- auth/Jira failures as `isError: true`;
- empty project and missing optional fields;
- partial issue-link failure preserving the base report.

Verification commands:

```bash
npx tsc --noEmit
npx vitest run
```

## Out of scope

- Jira writes, transitions, comments, or confirmation flows.
- Project-wide comments/changelog retrieval.
- Synthetic progress derived solely from time tracking.
- Background scheduling or persisted report snapshots.
