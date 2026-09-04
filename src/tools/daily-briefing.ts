import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { z } from "zod";
import { loadAndValidateSession } from "../auth/session-manager.js";
import { isMcpError } from "../errors.js";
import { JiraHttpClient } from "../jira/http-client.js";
import type { Config } from "../config.js";
import type { JiraIssue, JiraIssueSummary } from "../types.js";
import { todayLocalDate } from "../utils.js";
import { collectJiraDaily, type JiraDailyCollection } from "./daily.js";

const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;
dayjs.extend(customParseFormat);

const OVERALL_LABEL = {
  Red: "🔴 / cần xử lý ngay",
  Amber: "🟠 / cần theo dõi",
  Green: "🟢 / ổn",
} as const;

type OverallStatus = keyof typeof OVERALL_LABEL;
type ConcernKind = "jira-link" | "heuristic" | "overdue" | "due-today" | "stale" | "missing-owner" | "missing-progress";

export const jiraDailyBriefingSchema = z.object({
  projectKey: z.string().trim().regex(PROJECT_KEY_PATTERN, "projectKey must be a Jira project key, e.g. PROJ"),
  epic: z.array(z.string().trim().regex(ISSUE_KEY_PATTERN, "epic must contain Jira issue keys, e.g. PROJ-123")).min(1).max(50).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => dayjs(value, "YYYY-MM-DD", true).isValid(), "date must be yyyy-MM-dd").default(todayLocalDate()),
  maxConcerns: z.number().int().min(1).max(20).default(5),
  audience: z.string().trim().min(1).default("project manager"),
});

export type JiraDailyBriefingInput = z.infer<typeof jiraDailyBriefingSchema>;
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type Concern = {
  issue: JiraIssueSummary;
  severity: "High" | "Medium" | "Risk";
  rank: number;
  kind: ConcernKind;
  dependency?: string;
};
type WeightedProgress = { label: string; line: string };
type EpicDisplay = { key: string; name: string; url: string };

export async function handleJiraDailyBriefing(rawInput: unknown, cfg: Config): Promise<ToolResult> {
  const parsed = jiraDailyBriefingSchema.safeParse(rawInput);
  if (!parsed.success) return { content: [{ type: "text", text: `Invalid input: ${parsed.error.errors.map((e) => e.message).join("; ")}` }], isError: true };
  const input = parsed.data;
  try {
    const data = await collectJiraDaily({ projectKey: input.projectKey, epic: input.epic, date: input.date, maxBlockers: input.maxConcerns }, cfg);
    const concerns = rankConcerns(data, input.date).slice(0, input.maxConcerns);
    const evidence = await fetchEvidence(concerns, cfg);
    const epics = await fetchEpics(input.epic, cfg);
    return { content: [{ type: "text", text: renderBriefing(input, data, concerns, evidence, epics) }] };
  } catch (error: unknown) {
    const message = isMcpError(error) ? `[${error.code}] ${error.message}` : error instanceof Error ? error.message : "Unable to produce a reliable Jira briefing";
    return { content: [{ type: "text", text: `Không thể tạo briefing đáng tin cậy từ Jira: ${message}` }], isError: true };
  }
}

async function fetchEpics(epicKeys: string[] | undefined, cfg: Config): Promise<{ items: EpicDisplay[]; failures: number }> {
  if (!epicKeys?.length) return { items: [], failures: 0 };
  const fallback = (key: string): EpicDisplay => ({ key, name: key, url: `${cfg.JIRA_BASE_URL.replace(/\/$/, "")}/browse/${key}` });
  let client: JiraHttpClient;
  try {
    const cookies = await loadAndValidateSession(cfg.JIRA_SESSION_FILE, cfg.JIRA_BASE_URL, cfg.JIRA_VALIDATE_PATH);
    client = new JiraHttpClient(cfg.JIRA_BASE_URL, cookies);
  } catch {
    return { items: epicKeys.map(fallback), failures: epicKeys.length };
  }
  const results = await Promise.allSettled(epicKeys.map((key) => client.getIssue(key)));
  const items: EpicDisplay[] = [];
  results.forEach((result, index) => {
    if (result.status !== "fulfilled") {
      items.push(fallback(epicKeys[index]));
      return;
    }
    const epic = result.value;
    items.push({ key: epic.key, name: epic.epicName?.trim() || epic.summary || epic.key, url: epic.url });
  });
  return { items, failures: results.filter((result) => result.status === "rejected").length };
}

async function fetchEvidence(concerns: Concern[], cfg: Config): Promise<Map<string, JiraIssue>> {
  if (!concerns.length) return new Map();
  const cookies = await loadAndValidateSession(cfg.JIRA_SESSION_FILE, cfg.JIRA_BASE_URL, cfg.JIRA_VALIDATE_PATH);
  const client = new JiraHttpClient(cfg.JIRA_BASE_URL, cookies);
  const results = await Promise.all(concerns.map(async (concern) => [concern.issue.key, await client.getIssue(concern.issue.key)] as const));
  return new Map(results);
}

function renderBriefing(input: JiraDailyBriefingInput, data: JiraDailyCollection, concerns: Concern[], evidence: Map<string, JiraIssue>, epics: { items: EpicDisplay[]; failures: number }): string {
  const overall: OverallStatus = concerns.some((item) => item.severity === "High") ? "Red" : concerns.length ? "Amber" : "Green";
  const done = data.details.filter(isDone).length;
  const inProgress = data.details.filter((item) => /progress/i.test(item.status) && !isDone(item)).length;
  const weighted = weightedProgress(data.details);
  const lines = [
    `## Daily brief ${input.projectKey} · ${formatDisplayDate(input.date)}`,
    "",
    `**Tổng quan:** ${OVERALL_LABEL[overall]}`,
    ...(epics.items.length ? ["", "**Epic:**", ...epics.items.map((epic) => `[${escapeMarkdownLabel(epic.key)}:${escapeMarkdownLabel(epic.name)}](${epic.url})`)] : []),
    "",
    "| KPI | Giá trị |",
    "|---|---:|",
    `| Active | ${data.active.total} |`,
    `| In Progress | ${inProgress} |`,
    `| Hoàn thành | ${done} |`,
    `| Đến hạn hôm nay | ${data.dueToday.total} |`,
    `| Quá hạn | ${data.overdue.total} |`,
    `| Bug trong tuần | ${data.bugsThisWeek.total} |`,
    `| Weighted progress | ${escapeTableCell(weighted.line)} |`,
    "",
    "### Cần chú ý",
    "",
    "| Issue | Tín hiệu | Trạng thái | Owner |",
    "|---|---|---|---|",
  ];
  if (!concerns.length) {
    lines.push("| _Không có tín hiệu rủi ro từ dữ liệu Jira hiện tại._ | | | |");
  } else {
    for (const concern of concerns) {
      lines.push(formatConcernLine(concern, evidence.get(concern.issue.key)));
    }
  }
  lines.push("", "### Chốt hôm nay", "");
  const actions = actionItems(data, concerns, weighted);
  if (actions.length) {
    actions.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
  }
  if (data.linkFailures) {
    lines.push("", `Tra cứu dependency lỗi: ${data.linkFailures}; số liệu gốc vẫn giữ nguyên.`);
  }
  if (epics.failures) {
    lines.push("", `Tra cứu epic lỗi: ${epics.failures}; số liệu gốc vẫn giữ nguyên.`);
  }
  return lines.join("\n");
}

function rankConcerns(data: JiraDailyCollection, date: string): Concern[] {
  const rows: Concern[] = [];
  const linked = new Map<string, (typeof data.blockers)[number]>();
  for (const row of data.blockers) {
    const existing = linked.get(row.issue.key);
    if (!existing || row.source === "Jira link") linked.set(row.issue.key, row);
  }
  for (const issue of data.details) {
    if (isDone(issue)) continue;
    const overdue = Boolean(issue.dueDate && issue.dueDate < date);
    const dueToday = issue.dueDate === date;
    const stale = dayjs(date).diff(dayjs(issue.updated), "day") >= 30;
    const link = linked.get(issue.key);
    let concern: Concern | null = null;
    if (link?.source === "Jira link") {
      concern = { issue, severity: overdue ? "High" : "Medium", rank: overdue ? 0 : 1, kind: "jira-link", dependency: link.dependency };
    } else if (link?.source === "Text heuristic") {
      concern = { issue, severity: overdue ? "High" : "Medium", rank: overdue ? 0 : 1, kind: "heuristic" };
    } else if (overdue) {
      concern = { issue, severity: "Risk", rank: 2, kind: "overdue" };
    } else if (dueToday) {
      concern = { issue, severity: "Risk", rank: 3, kind: "due-today" };
    } else if (stale) {
      concern = { issue, severity: "Risk", rank: 4, kind: "stale" };
    } else if (!issue.assignee) {
      concern = { issue, severity: "Risk", rank: 5, kind: "missing-owner" };
    } else if (!issue.progressWbsGantt && !issue.percentDone) {
      concern = { issue, severity: "Risk", rank: 6, kind: "missing-progress" };
    }
    if (concern) rows.push(concern);
  }
  return rows.sort((a, b) => a.rank - b.rank || a.issue.key.localeCompare(b.issue.key));
}

function formatConcernLine(concern: Concern, detail: JiraIssue | undefined): string {
  const status = detail?.status ?? concern.issue.status;
  const owner = detail?.assignee ?? concern.issue.assignee;
  const ownerText = owner?.trim() ? owner : "chưa có owner";
  return `| ${issueMarkdownLink(concern.issue)} — ${escapeTableCell(concern.issue.summary)} | ${escapeTableCell(concernSignal(concern))} | ${escapeTableCell(status)} | ${escapeTableCell(ownerText)} |`;
}

function concernSignal(concern: Concern): string {
  switch (concern.kind) {
    case "jira-link":
      return `dependency Jira đã xác nhận: ${concern.dependency ?? "đã xác nhận"}`;
    case "heuristic":
      return "blocker heuristic";
    case "overdue":
      return concern.issue.dueDate ? `quá hạn từ ${formatShortDate(concern.issue.dueDate)}` : "quá hạn";
    case "due-today":
      return "đến hạn hôm nay";
    case "stale":
      return `stale: không cập nhật từ ${formatShortDate(concern.issue.updated)}`;
    case "missing-owner":
      return "thiếu owner";
    case "missing-progress":
      return "thiếu progress";
  }
}

function actionItems(data: JiraDailyCollection, concerns: Concern[], weighted: WeightedProgress): string[] {
  const items: string[] = [];
  if (data.overdue.total) {
    items.push(`Xác nhận owner và kế hoạch phục hồi cho ${data.overdue.total} issue quá hạn.`);
  }
  const blocker = concerns.find((item) => item.kind === "jira-link" || item.kind === "heuristic");
  if (blocker) {
    items.push(`Làm rõ blocker và hành động tiếp theo của ${issueMarkdownLink(blocker.issue)}.`);
  }
  if (data.dueToday.total) {
    items.push("Kiểm tra issue đến hạn hôm nay và cập nhật trạng thái trước cuối ngày.");
  }
  if (data.details.length && (weighted.label === "N/A" || weighted.label === "0,0%")) {
    items.push(`Xác minh chỉ số weighted progress đang hiển thị ${weighted.label}.`);
  }
  return items;
}

function isDone(issue: JiraIssueSummary): boolean {
  return issue.statusCategory?.toLowerCase() === "done" || /^(cancel|resolved|closed)$/i.test(issue.status);
}

function weightedProgress(issues: JiraIssueSummary[]): WeightedProgress {
  let weighted = 0;
  let weight = 0;
  for (const issue of issues) {
    if (isDone(issue) || !issue.originalEstimateSeconds || issue.originalEstimateSeconds <= 0) continue;
    const raw = issue.progressWbsGantt ?? issue.percentDone;
    const value = raw == null ? Number.NaN : Number(String(raw).match(/-?\d+(?:\.\d+)?/)?.[0]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) {
      weighted += value * issue.originalEstimateSeconds;
      weight += issue.originalEstimateSeconds;
    }
  }
  if (!weight) return { label: "N/A", line: "N/A" };
  const label = `${(weighted / weight).toFixed(1).replace(".", ",")}%`;
  if (label === "0,0%") {
    return { label, line: `${label} (kiểm tra estimate/dữ liệu)` };
  }
  return { label, line: label };
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n|\r/g, "<br>");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&").replace(/\r?\n|\r/g, " ");
}

function issueMarkdownLink(issue: { key: string; url: string }): string {
  return `[${issue.key}](${issue.url})`;
}

function formatDisplayDate(isoDate: string): string {
  return dayjs(isoDate).format("DD/MM/YYYY");
}

function formatShortDate(isoDate: string): string {
  return dayjs(isoDate).format("DD/MM");
}
