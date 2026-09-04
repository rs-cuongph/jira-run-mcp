# jira_daily_briefing

Produce a fixed-format Vietnamese delivery briefing for one Jira project. The tool is stateless and read-only: it uses the existing `jira_daily` data collection, then fetches details only for the highest-impact concerns.

## Input

| Field | Type | Default | Description |
|---|---|---:|---|
| `projectKey` | `string` | required | Jira project key, for example `PROJ` |
| `epic` | `string[]` | omitted | Optional epic issue keys; when provided, only issues belonging to these epics are included |
| `date` | `string` | local today | Report date in `yyyy-MM-dd` format |
| `maxConcerns` | `number` | `5` | Maximum concerns and issue-evidence lookups (1-20) |
| `audience` | `string` | `project manager` | Audience label (kept for compatibility; not shown in the briefing) |

## Output

The output starts with `## Daily brief <PROJECT> · <DD/MM/YYYY>` and one overall-status line. When `epic` is provided, an `Epic` block follows the overall-status line with one markdown link per line in the form `[KEY:Epic Name](url)`. It then contains a compact KPI table with `Active`, `In Progress`, `Hoàn thành`, `Đến hạn hôm nay`, `Quá hạn`, `Bug trong tuần`, and `Weighted progress`, followed by a concern table with `Issue`, `Tín hiệu`, `Trạng thái`, and `Owner`. The `Cần chú ý` section is always a Markdown table: keep its header, separator, and every concern row intact. `Bug trong tuần` counts issues created from Monday through the report date whose issue type is `Bug`, `Bug_Customer`, or `Leakage`; status `Cancel` is excluded. Issue keys are markdown links `[KEY](url)`. Confirmed Jira dependency links are distinguished from heuristic text signals, and table cells escape pipes and line breaks from Jira data.

Overall status uses emoji instead of color words:

- `🔴 / cần xử lý ngay` — high-impact confirmed dependency or overdue dependency
- `🟠 / cần theo dõi` — material overdue, stale, heuristic, or missing-data signals
- `🟢 / ổn` — no material signal, including empty projects (weighted progress `N/A`)

Authentication or search failures return `isError: true`; the tool never fabricates a briefing. Epic detail lookup failures retain the epic key as a fallback and are disclosed in a one-line note after the actions. Partial dependency lookups are disclosed in a one-line note after the actions. The `### Chốt hôm nay` heading is always present, but action rows are emitted only when a matching signal exists. No comments, transitions, worklogs, approvals, or other Jira writes are performed. The output ends after the actions or the partial-lookup note; it has no read-only footer or navigation hint.

When forwarding the result through `post-message.sh`, pass the tool's Markdown output through unchanged (apart from the mention handled by the script). Do not rewrite the `Cần chú ý` rows as bullet points or otherwise flatten the table.

## Example

```json
{
  "projectKey": "PROJ",
  "date": "2026-08-18",
  "maxConcerns": 5,
  "audience": "project manager"
}
```
