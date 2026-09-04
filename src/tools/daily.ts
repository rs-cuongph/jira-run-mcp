import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { z } from "zod";
import { loadAndValidateSession } from "../auth/session-manager.js";
import { isMcpError } from "../errors.js";
import { JiraHttpClient } from "../jira/http-client.js";
import { escapeJqlString, mapWithConcurrency, todayLocalDate } from "../utils.js";
import type { Config } from "../config.js";
import type { JiraIssueLinksResult, JiraIssueSummary } from "../types.js";

dayjs.extend(customParseFormat);

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;
const COMPLETED_STATUS_NAMES = new Set(["cancel", "resolved", "closed"]);
const SIGNAL_PATTERN = /blocked|blocker|blocking|blocked by|dependency|phụ thuộc|vướng/i;

export const jiraDailySchema = z.object({
  projectKey: z.string().trim().regex(PROJECT_KEY_PATTERN, "projectKey must be a Jira project key, e.g. PROJ"),
  epic: z.array(z.string().trim().regex(ISSUE_KEY_PATTERN, "epic must contain Jira issue keys, e.g. PROJ-123")).min(1).max(50).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => dayjs(value, "YYYY-MM-DD", true).isValid(), "date must be yyyy-MM-dd").default(todayLocalDate()),
  maxIssues: z.number().int().min(1).max(200).default(50),
  maxBlockers: z.number().int().min(1).max(50).default(20),
});

export type JiraDailyInput = z.infer<typeof jiraDailySchema>;

function baseJql(input: JiraDailyInput): string {
  const projectClause = `project = "${escapeJqlString(input.projectKey)}"`;
  if (!input.epic?.length) return projectClause;
  const epicKeys = input.epic.map((key) => `"${escapeJqlString(key)}"`).join(", ");
  return `${projectClause} AND "Epic Link" IN (${epicKeys})`;
}

const unresolved = `resolution = Unresolved AND statusCategory != Done AND status NOT IN ("Cancel", "Resolved", "Closed")`;

export function buildActiveJql(input: JiraDailyInput): string {
  return `${baseJql(input)} AND ${unresolved}`;
}

export function buildDueTodayJql(input: JiraDailyInput): string {
  return `${baseJql(input)} AND due = "${input.date}" AND ${unresolved}`;
}

export function buildOverdueJql(input: JiraDailyInput): string {
  return `${baseJql(input)} AND due < "${input.date}" AND ${unresolved}`;
}

export function buildRecentlyCompletedJql(input: JiraDailyInput): string {
  const start = dayjs(input.date).subtract(6, "day").format("YYYY-MM-DD");
  return `${baseJql(input)} AND resolved >= "${start}" AND resolved <= "${input.date}" AND statusCategory = Done`;
}

export function buildBugsThisWeekJql(input: JiraDailyInput): string {
  const daysFromMonday = (dayjs(input.date).day() + 6) % 7;
  const start = dayjs(input.date).subtract(daysFromMonday, "day").format("YYYY-MM-DD");
  return `${baseJql(input)} AND issuetype IN ("Bug", "Bug_Customer", "Leakage") AND created >= "${start}" AND created <= "${input.date}" AND status NOT IN ("Cancel")`;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type SearchBucket = { total: number; issues: JiraIssueSummary[] };

export interface JiraDailyCollection {
  input: JiraDailyInput;
  active: SearchBucket;
  dueToday: SearchBucket;
  overdue: SearchBucket;
  recentlyCompleted: SearchBucket;
  bugsThisWeek: SearchBucket;
  details: JiraIssueSummary[];
  blockers: BlockerRow[];
  linkFailures: number;
}

export async function collectJiraDaily(rawInput: unknown, cfg: Config): Promise<JiraDailyCollection> {
  const parsed = jiraDailySchema.safeParse(rawInput);
  if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.errors.map((e) => e.message).join("; ")}`);
  const input = parsed.data;
  const cookies = await loadAndValidateSession(cfg.JIRA_SESSION_FILE, cfg.JIRA_BASE_URL, cfg.JIRA_VALIDATE_PATH);
  const client = new JiraHttpClient(cfg.JIRA_BASE_URL, cookies);
  const queries = [buildActiveJql(input), buildDueTodayJql(input), buildOverdueJql(input), buildRecentlyCompletedJql(input), buildBugsThisWeekJql(input)];
  const buckets = await Promise.all(queries.map((jql) => client.searchIssues(jql, input.maxIssues, 0, ["description"])));
  const [active, dueToday, overdue, recentlyCompleted, bugsThisWeek] = buckets;
  const details = dedupeIssues([...active.issues, ...dueToday.issues, ...overdue.issues, ...recentlyCompleted.issues]);
  const blockerCandidates = dedupeIssues([...active.issues, ...dueToday.issues, ...overdue.issues, ...details.filter(hasTextSignal)]).slice(0, input.maxBlockers);
  const linkResults = await mapWithConcurrency(blockerCandidates, 5, (item) => client.getIssueLinks(item.key));
  const blockers = linkResults.flatMap((result) => result.ok ? classifySignals(result.item, result.value, input.date) : classifySignals(result.item, null, input.date));
  return { input, active, dueToday, overdue, recentlyCompleted, bugsThisWeek, details, blockers, linkFailures: linkResults.filter((result) => !result.ok).length };
}

export async function handleJiraDaily(rawInput: unknown, cfg: Config): Promise<ToolResult> {
  const parsed = jiraDailySchema.safeParse(rawInput);
  if (!parsed.success) return errorResult(`Invalid input: ${parsed.error.errors.map((e) => e.message).join("; ")}`);
  const input = parsed.data;

  let cookies;
  try {
    cookies = await loadAndValidateSession(cfg.JIRA_SESSION_FILE, cfg.JIRA_BASE_URL, cfg.JIRA_VALIDATE_PATH);
  } catch (error: unknown) {
    return errorResult(isMcpError(error) ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : "Authentication failed");
  }

  const client = new JiraHttpClient(cfg.JIRA_BASE_URL, cookies);
  const queries = [buildActiveJql(input), buildDueTodayJql(input), buildOverdueJql(input), buildRecentlyCompletedJql(input)];
  let buckets: SearchBucket[];
  try {
    buckets = await Promise.all(queries.map((jql) => client.searchIssues(jql, input.maxIssues, 0, ["description"])));
  } catch (error: unknown) {
    return errorResult(isMcpError(error) ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : "Jira search failed");
  }

  const [active, dueToday, overdue, recentlyCompleted] = buckets;
  const details = dedupeIssues([...active.issues, ...dueToday.issues, ...overdue.issues, ...recentlyCompleted.issues]);
  const blockerCandidates = dedupeIssues([...active.issues, ...dueToday.issues, ...overdue.issues, ...details.filter(hasTextSignal)]).slice(0, input.maxBlockers);
  const linkResults = await mapWithConcurrency(blockerCandidates, 5, (item) => client.getIssueLinks(item.key));
  const blockers = linkResults.flatMap((result) => result.ok ? classifySignals(result.item, result.value, input.date) : classifySignals(result.item, null, input.date));
  const linkFailures = linkResults.filter((result) => !result.ok).length;
  const report = formatReport(input, { active, dueToday, overdue, recentlyCompleted }, details, blockers, linkFailures);
  return { content: [{ type: "text", text: report }] };
}

function dedupeIssues(issues: JiraIssueSummary[]): JiraIssueSummary[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.key)) return false;
    seen.add(issue.key);
    return true;
  });
}

function isCompleted(issue: JiraIssueSummary): boolean {
  return issue.statusCategory?.toLowerCase() === "done" || COMPLETED_STATUS_NAMES.has(issue.status.toLowerCase());
}

function hasTextSignal(issue: JiraIssueSummary): boolean {
  return SIGNAL_PATTERN.test([issue.summary, issue.description ?? "", ...(issue.labels ?? [])].join(" "));
}

function parseProgress(issue: JiraIssueSummary): { percent: number; source: "WBSGantt" | "% Done" } | null {
  for (const [value, source] of [[issue.progressWbsGantt, "WBSGantt"], [issue.percentDone, "% Done"]] as const) {
    if (value == null) continue;
    const match = String(value).match(/-?\d+(?:\.\d+)?/);
    const percent = match ? Number(match[0]) : Number.NaN;
    if (Number.isFinite(percent) && percent >= 0 && percent <= 100) return { percent, source };
  }
  return null;
}

export type BlockerRow = { issue: JiraIssueSummary; source: string; severity: "High" | "Medium" | "Risk"; dependency: string };

function classifySignals(issue: JiraIssueSummary, links: JiraIssueLinksResult | null, date: string): BlockerRow[] {
  if (isCompleted(issue)) return [];
  const overdue = Boolean(issue.dueDate && issue.dueDate < date);
  const rows: BlockerRow[] = [];
  const dependencyLinks = links?.links.filter((link) => /is blocked by|blocks/i.test(link.relationship)) ?? [];
  if (dependencyLinks.length) rows.push({ issue, source: "Jira link", severity: overdue ? "High" : "Medium", dependency: dependencyLinks.map((link) => `${link.relationship} ${link.issueKey}`).join(", ") });
  if (hasTextSignal(issue)) rows.push({ issue, source: "Text heuristic", severity: overdue ? "High" : "Medium", dependency: "heuristic phrase/label" });
  if (overdue && dependencyLinks.length === 0 && !hasTextSignal(issue)) rows.push({ issue, source: "Overdue", severity: "Risk", dependency: "none" });
  if (dayjs(date).diff(dayjs(issue.updated), "day") >= 30 && !dependencyLinks.length && !hasTextSignal(issue) && !overdue) rows.push({ issue, source: "Stale", severity: "Risk", dependency: "none" });
  return rows;
}

function formatReport(input: JiraDailyInput, buckets: { active: SearchBucket; dueToday: SearchBucket; overdue: SearchBucket; recentlyCompleted: SearchBucket }, details: JiraIssueSummary[], blockers: BlockerRow[], linkFailures: number): string {
  const activeDetails = details.filter((issue) => !isCompleted(issue));
  const statusCounts = { "To Do": 0, "In Progress": 0, Done: 0 };
  for (const issue of details) {
    if (issue.statusCategory?.toLowerCase() === "done" || isCompleted(issue)) statusCounts.Done += 1;
    else if (issue.statusCategory?.toLowerCase().includes("progress") || /progress/i.test(issue.status)) statusCounts["In Progress"] += 1;
    else statusCounts["To Do"] += 1;
  }
  let weighted = 0; let weight = 0; let included = 0; let missingEstimate = 0; let missingProgress = 0;
  const sources = new Set<string>();
  for (const issue of activeDetails) {
    const progress = parseProgress(issue);
    if (issue.originalEstimateSeconds == null || issue.originalEstimateSeconds <= 0) { missingEstimate += 1; continue; }
    if (!progress) { missingProgress += 1; continue; }
    weighted += progress.percent * issue.originalEstimateSeconds; weight += issue.originalEstimateSeconds; included += 1; sources.add(progress.source);
  }
  const progressText = weight > 0 ? `${(weighted / weight).toFixed(1)}% (${included} issues; ${weight}s estimate weight)` : "N/A";
  const lines = [
    `# Jira Daily: ${input.projectKey} (${input.date})`, "",
    `**Executive summary:** ${buckets.active.total} active, ${statusCounts["In Progress"]} in progress, ${statusCounts.Done} done, ${buckets.dueToday.total} due today, ${buckets.overdue.total} overdue, ${buckets.recentlyCompleted.total} recently completed, ${blockers.length} blocker/risk item(s), weighted progress ${progressText}.`,
    `**Progress coverage:** sources ${sources.size ? [...sources].join(", ") : "none"}; excluded for missing estimate: ${missingEstimate}; missing progress: ${missingProgress}.`, "",
    "## Status and Progress", "", "| Category | Count |", "|---|---:|", `| To Do | ${statusCounts["To Do"]} |`, `| In Progress | ${statusCounts["In Progress"]} |`, `| Done | ${statusCounts.Done} |`, "",
    "## Due Today", "", issueTable(buckets.dueToday.issues, false, input.date), "",
    "## Overdue", "", issueTable(buckets.overdue.issues, true, input.date), "",
    "## Blockers & Risks", "", blockers.length ? "| Key | Source | Severity | Related dependency | Assignee | URL |\n|---|---|---|---|---|---|\n" + blockers.map((row) => `| ${row.issue.key} | ${row.source} | ${row.severity} | ${row.dependency} | ${row.issue.assignee ?? "Unassigned"} | ${row.issue.url} |`).join("\n") : "_No blockers or risks detected._", "",
    "## Analysis", "", analysis(buckets, details, input.date),
  ];
  if (linkFailures) lines.push(`_partial analysis: ${linkFailures} issue-link fetch(es) failed; base report retained._`);
  return lines.join("\n");
}

function issueTable(issues: JiraIssueSummary[], overdue: boolean, reportDate: string): string {
  if (!issues.length) return "_None._";
  const header = overdue ? "| Key | Summary | Status | Assignee | Priority | Progress | Days late | URL |" : "| Key | Summary | Status | Assignee | Priority | Progress | Due date | URL |";
  const divider = overdue ? "|---|---|---|---|---|---:|---|---|" : "|---|---|---|---|---|---:|---|---|";
  return header + "\n" + divider + "\n" + issues.filter((issue) => !isCompleted(issue)).map((issue) => {
    const progress = parseProgress(issue);
    const value = progress ? `${progress.percent}% (${progress.source})` : "N/A";
    const trailing = overdue ? `${issue.dueDate ? Math.max(0, dayjs(reportDate).diff(dayjs(issue.dueDate), "day")) : "N/A"}` : issue.dueDate ?? "N/A";
    return `| ${issue.key} | ${issue.summary} | ${issue.status} | ${issue.assignee ?? "Unassigned"} | ${issue.priority ?? "Unprioritized"} | ${value} | ${trailing} | ${issue.url} |`;
  }).join("\n");
}

function analysis(buckets: { active: SearchBucket; dueToday: SearchBucket; overdue: SearchBucket }, details: JiraIssueSummary[], date: string): string {
  const observations: string[] = [];
  if (buckets.dueToday.issues.some((issue) => !isCompleted(issue))) observations.push(`${buckets.dueToday.total} due-today item(s) are not done.`);
  if (buckets.overdue.total) observations.push(`${buckets.overdue.total} overdue item(s) need attention as of ${date}.`);
  const unassigned = details.filter((issue) => !isCompleted(issue) && !issue.assignee).length;
  if (unassigned) observations.push(`${unassigned} active detail item(s) have no assignee.`);
  return observations.length ? observations.map((item) => `- ${item}`).join("\n") : "_No data-supported observations._";
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
