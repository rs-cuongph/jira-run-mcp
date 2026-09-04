# jira_sync_gitlab_review_defects

Sync top-level review comments from GitLab merge requests into Jira **Review Defect** issues (`issuetype` id `10805`).

## When to Use

1. Configure GitLab links for the Jira project:
   - Preferred (MCP): set `GITLAB_PROJECTS_JSON` in MCP `env` as stringified JSON (same shape as `.jira/gitlab-projects.json`)
   - Fallback: GitLab projects file (see `.jira/gitlab-projects.json.example`). Default path:
   - source checkout: `.jira/gitlab-projects.json`
   - npm/npx install: `~/.jira/jira-mcp/gitlab-projects.json`
   You can override with `GITLAB_PROJECTS_FILE`.
2. Export `GITLAB_TOKEN` with `read_api` (or `api`) scope (or set it in `.env` at `<repo>/.env` for source checkout, or `~/.jira/jira-mcp/.env` for npm/npx install).
   Note: MCP clients pass environment variables via `env`; custom blocks like `"config": { ... }` are ignored by the server process.
3. Choose scope: `mrState` for many MRs, or `mrIid` for one MR.
4. Call with `dryRun: true` (default) to preview candidates.
5. If `needsUserMapping` appears, ask the user for Jira usernames/emails and re-call with `userOverrides`.
6. After confirmation, call with `dryRun: false` to create issues.

## Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectKey` | `string` | ✅ | Jira project key (must have entries in `GITLAB_PROJECTS_JSON` or the configured GitLab projects file) |
| `mrState` | `"opened" \| "merged" \| "closed"` | ❌ | Default `merged`. Which MRs to scan when `mrIid` is omitted |
| `mrIid` | `number` | ❌ | Process only this one MR IID (searched across configured GitLab links). When set, `mrState` is ignored |
| `dryRun` | `boolean` | ❌ | Default `true`. Preview only when true; create when `false` |
| `userOverrides` | `Record<string, string>` | ❌ | GitLab username → Jira username or email |
| `projectStage` | `string` | ❌ | Jira Project Stages key. Default `CODING`. Examples: `BASIC_DESIGN`, `DETAIL_DESIGN`, `TEST_UT` |
| `dateFrom` | `string` | ❌ | Inclusive start date (`YYYY-MM-DD` or `YYYYMMDD`, e.g. `20260801`). Filters by `merged_at` when `mrState=merged`, else `updated_at`. Ignored when `mrIid` is set |
| `dateTo` | `string` | ❌ | Inclusive end date; defaults to today when `dateFrom` is set. Ignored when `mrIid` is set |
| `fullSync` | `boolean` | ❌ | Default `false`. When `true`, ignore incremental watermark and list all MRs for `mrState` |

## Behaviour

- Scope by `mrState` **or** a single `mrIid`, optionally narrowed by `dateFrom`/`dateTo`
- **Incremental sync (default):** stores a per-repo watermark in the dedup JSON (`watermarks` key). Subsequent runs pass GitLab `updated_after` with a 2-day overlap. Watermark advances only after a successful apply (`dryRun: false`) with no GitLab collection failures for that repo
- **Date range:** explicit historical window; does not read or advance the watermark
- **`fullSync: true`:** ignores watermark for listing; advances watermark after successful apply
- Only **top-level** human discussion notes (ignores replies and system notes)
- Reads Jira references from each MR description. References may be plain issue keys (for example `PROJ-123`) or `/browse/PROJ-123` URLs on the configured Jira base URL. References are kept in first-seen order and duplicates are removed; URLs from another Jira base or invalid keys are ignored.
- On apply, each created Review Defect is linked to every referenced Jira issue with the `Relates` link type (`relates to` in Jira), from the Review Defect to the referenced issue. Dry-run shows the references that would be linked and does not create issues or links.
- MR-level safety check: if Jira already has any Review Defect mentioning `/{projectPath}/-/merge_requests/{mrIid}`, the tool skips **all** notes from that MR **before** fetching GitLab discussions (fast path)
- Performance: GitLab discussion fetches run with bounded concurrency (default 8); Jira dedup searches and issue creates are batched / pooled to avoid N+1 API calls
- Apply uses the same create-issue validation path as `jira_create_issue` / `jira_preview_create_issue` (`buildCreateIssuePayload` + `createIssueFromFields`)
- Dedup via Jira text search for `gitlab-note-id: <MR note URL>` (e.g. `…/merge_requests/93#note_1625816`) **and** a local dedup store. Default path:
  - source checkout: `.jira/gitlab-review-defects.json`
  - npm/npx install: `~/.jira/jira-mcp/gitlab-review-defects.json`
  Override with `GITLAB_DEDUP_FILE`.
- Assignee = MR author (`{username}@runsystem.net` → Jira lookup)
- Reporter = comment author (same email rule)
- Due date = comment created date (`YYYY-MM-DD`)
- Project Stages (`customfield_10339`) = `CODING` by default; override with `projectStage` (e.g. `BASIC_DESIGN`)
- Summary format: `[Review Code][<repository name>][MR !<IID>] <comment review>`, truncated to 180 characters
- If creating a Review Defect succeeds but one of its Jira links fails, the issue remains in **Created**, the note remains recorded in local dedup, and the failed link is listed separately in **Failed** as `link <createdKey> -> <referencedKey>: ...`.

## Output sections

- Candidates / Created
- Skipped MRs (already in Jira)
- Skipped duplicates
- Needs user mapping
- Failed

## Errors

| Case | Resolution |
|------|------------|
| Missing `GITLAB_TOKEN` | `export GITLAB_TOKEN=…` (or set it in the matching `.env`) |
| No mapping for project | Update `GITLAB_PROJECTS_JSON`, or edit your GitLab projects file (`GITLAB_PROJECTS_FILE` or default path) |
| Session expired | `npm run jira-auth-login` |
| GitLab 401/403 | Check token scopes |

## Configuration example

```json
{
  "PROJ": [
    {
      "name": "app-frontend",
      "gitlabBaseUrl": "https://gitlab.example.com",
      "projectPath": "group/app-frontend"
    }
  ]
}
```

## Examples

Scan open MRs:

```json
{
  "projectKey": "ME",
  "mrState": "opened",
  "dryRun": true
}
```

One MR:

```json
{
  "projectKey": "ME",
  "mrIid": 42,
  "dryRun": true
}
```

Closed MRs + apply with overrides:

```json
{
  "projectKey": "ME",
  "mrState": "closed",
  "dryRun": false,
  "userOverrides": {
    "thanhnn": "thanhnn@runsystem.net",
    "reviewer1": "alice.smith"
  }
}
```

Merged MRs from a start date (compact `YYYYMMDD`):

```json
{
  "projectKey": "UNI",
  "mrState": "merged",
  "dateFrom": "20260801",
  "dryRun": true
}
```
