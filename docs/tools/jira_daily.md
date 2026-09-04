# jira_daily

Return one read-only Markdown delivery report for a Jira project and report date.

## Input

| Field | Type | Default | Description |
|---|---|---:|---|
| `projectKey` | `string` | required | Jira project key such as `PROJ` |
| `epic` | `string[]` | omitted | Optional epic issue keys; when provided, only issues belonging to these epics are included |
| `date` | `string` | local today | Report date in `yyyy-MM-dd` format |
| `maxIssues` | `number` | `50` | Maximum issue details retained per search (1-200); Jira totals are retained |
| `maxBlockers` | `number` | `20` | Maximum candidate issues used for link/risk analysis (1-50) |

## Output

The report contains an executive summary, status/progress distribution, `Due Today`, `Overdue`, `Blockers & Risks`, and data-supported `Analysis` sections. Progress uses `Progress (WBSGantt)` first and `% Done` only as a fallback, then calculates a weighted mean using positive original estimates. Missing estimates/progress and issue-link fetch failures are called out explicitly. Text blocker signals are labelled as heuristics and are kept distinct from Jira dependency links.

Empty projects still return the full section structure with zero counts. Validation, authentication, Jira, and unexpected failures return MCP tool content with `isError: true`.

## Examples

```json
{ "projectKey": "PROJ" }
```

```json
{ "projectKey": "PROJ", "date": "2026-08-18", "maxIssues": 100, "maxBlockers": 10 }
```
