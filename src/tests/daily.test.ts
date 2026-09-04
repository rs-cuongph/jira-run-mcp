import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "../errors.js";
import {
  buildActiveJql,
  buildBugsThisWeekJql,
  buildDueTodayJql,
  buildOverdueJql,
  buildRecentlyCompletedJql,
  handleJiraDaily,
  jiraDailySchema,
} from "../tools/daily.js";

const { mockLoadSession, mockSearchIssues, mockGetIssueLinks } = vi.hoisted(() => ({
  mockLoadSession: vi.fn(),
  mockSearchIssues: vi.fn(),
  mockGetIssueLinks: vi.fn(),
}));

vi.mock("../auth/session-manager.js", () => ({ loadAndValidateSession: mockLoadSession }));
vi.mock("../jira/http-client.js", () => ({
  JiraHttpClient: class {
    searchIssues = mockSearchIssues;
    getIssueLinks = mockGetIssueLinks;
  },
}));

const config = {
  JIRA_BASE_URL: "https://jira.example.com",
  JIRA_SESSION_FILE: ".jira/session.json",
  JIRA_VALIDATE_PATH: "/rest/api/2/myself",
} as never;

const issue = (key: string, overrides: Record<string, unknown> = {}) => ({
  key,
  summary: `${key} summary`,
  status: "In Progress",
  statusCategory: "indeterminate",
  issueType: "Task",
  assignee: "Alice",
  priority: "High",
  created: "2026-08-01",
  updated: "2026-08-17",
  dueDate: null,
  url: `https://jira.example.com/browse/${key}`,
  labels: [],
  description: null,
  originalEstimate: "1h",
  originalEstimateSeconds: 3600,
  remainingEstimate: null,
  timeSpent: null,
  defectOwner: null,
  planStartDate: null,
  actualStartDate: null,
  actualEndDate: null,
  severity: null,
  defectOrigin: null,
  progressWbsGantt: null,
  percentDone: null,
  typeOfWork: null,
  ...overrides,
});

describe("jiraDailySchema", () => {
  it("defaults date and limits", () => {
    expect(jiraDailySchema.parse({ projectKey: "PROJ" })).toMatchObject({
      projectKey: "PROJ", maxIssues: 50, maxBlockers: 20,
    });
  });

  it("rejects invalid keys, dates, and bounds", () => {
    expect(jiraDailySchema.safeParse({ projectKey: "bad" }).success).toBe(false);
    expect(jiraDailySchema.safeParse({ projectKey: "PROJ", date: "2026-8-1" }).success).toBe(false);
    expect(jiraDailySchema.safeParse({ projectKey: "PROJ", maxIssues: 201 }).success).toBe(false);
    expect(jiraDailySchema.safeParse({ projectKey: "PROJ", maxBlockers: 0 }).success).toBe(false);
    expect(jiraDailySchema.safeParse({ projectKey: "PROJ", epic: ["bad"] }).success).toBe(false);
    expect(jiraDailySchema.safeParse({ projectKey: "PROJ", epic: [] }).success).toBe(false);
  });
});

describe("daily JQL builders", () => {
  it("builds exact project/date-scoped searches", () => {
    const input = { projectKey: "PROJ", date: "2026-08-18", maxIssues: 50, maxBlockers: 20 };
    expect(buildActiveJql(input)).toBe('project = "PROJ" AND resolution = Unresolved AND statusCategory != Done AND status NOT IN ("Cancel", "Resolved", "Closed")');
    expect(buildDueTodayJql(input)).toBe('project = "PROJ" AND due = "2026-08-18" AND resolution = Unresolved AND statusCategory != Done AND status NOT IN ("Cancel", "Resolved", "Closed")');
    expect(buildOverdueJql(input)).toBe('project = "PROJ" AND due < "2026-08-18" AND resolution = Unresolved AND statusCategory != Done AND status NOT IN ("Cancel", "Resolved", "Closed")');
    expect(buildRecentlyCompletedJql(input)).toBe('project = "PROJ" AND resolved >= "2026-08-12" AND resolved <= "2026-08-18" AND statusCategory = Done');
    expect(buildBugsThisWeekJql(input)).toBe('project = "PROJ" AND issuetype IN ("Bug", "Bug_Customer", "Leakage") AND created >= "2026-08-17" AND created <= "2026-08-18" AND status NOT IN ("Cancel")');
  });

  it("scopes every query to multiple epics when provided", () => {
    const input = { projectKey: "PROJ", epic: ["PROJ-10", "PROJ-20"], date: "2026-08-18", maxIssues: 50, maxBlockers: 20 };
    const epicClause = ' AND "Epic Link" IN ("PROJ-10", "PROJ-20")';
    expect(buildActiveJql(input)).toContain(epicClause);
    expect(buildDueTodayJql(input)).toContain(epicClause);
    expect(buildOverdueJql(input)).toContain(epicClause);
    expect(buildRecentlyCompletedJql(input)).toContain(epicClause);
    expect(buildBugsThisWeekJql(input)).toContain(epicClause);
  });
});

describe("handleJiraDaily", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSession.mockResolvedValue({ cookieHeader: "sid=abc" });
    mockSearchIssues
      .mockResolvedValueOnce({ total: 3, issues: [issue("PROJ-1", { progressWbsGantt: "50" })] })
      .mockResolvedValueOnce({ total: 1, issues: [issue("PROJ-2", { dueDate: "2026-08-18" })] })
      .mockResolvedValueOnce({ total: 1, issues: [issue("PROJ-3", { dueDate: "2026-08-17" })] })
      .mockResolvedValueOnce({ total: 2, issues: [issue("PROJ-4", { status: "Closed", statusCategory: "done" })] });
    mockGetIssueLinks.mockResolvedValue({ issueKey: "PROJ-3", links: [] });
  });

  it("runs four searches in parallel, retains totals, and renders sections", async () => {
    const result = await handleJiraDaily({ projectKey: "PROJ", date: "2026-08-18" }, config);
    expect(mockSearchIssues).toHaveBeenCalledTimes(4);
    expect(result.isError).toBeUndefined();
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("# Jira Daily: PROJ (2026-08-18)");
    expect(text).toContain("Due Today");
    expect(text).toContain("Overdue");
    expect(text).toContain("Blockers & Risks");
    expect(text).toContain("Analysis");
    expect(text).toContain("50.0%");
    expect(text).toContain("3 active");
    expect(text).toContain("2 recently completed");
  });

  it("prefers WBSGantt and falls back to percent done for weighted progress", async () => {
    mockSearchIssues.mockReset();
    mockSearchIssues
      .mockResolvedValueOnce({ total: 2, issues: [issue("PROJ-1", { progressWbsGantt: "25", originalEstimateSeconds: 3600 }), issue("PROJ-2", { percentDone: "75", originalEstimateSeconds: 7200 })] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] });
    const result = await handleJiraDaily({ projectKey: "PROJ", date: "2026-08-18", maxBlockers: 1 }, config);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("58.3%");
    expect(text).toContain("WBSGantt");
    expect(text).toContain("% Done");
  });

  it("preserves the base report when issue-link analysis partially fails", async () => {
    mockGetIssueLinks.mockRejectedValue(new McpError("JIRA_HTTP_ERROR", "link unavailable"));
    const result = await handleJiraDaily({ projectKey: "PROJ", date: "2026-08-18" }, config);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("partial");
    expect(result.content[0]?.text).toContain("# Jira Daily");
  });

  it("returns auth and Jira failures as tool errors", async () => {
    mockLoadSession.mockRejectedValueOnce(new McpError("AUTH_REQUIRED", "No session"));
    const auth = await handleJiraDaily({ projectKey: "PROJ" }, config);
    expect(auth.isError).toBe(true);
    mockLoadSession.mockResolvedValue({ cookieHeader: "sid=abc" });
    mockSearchIssues.mockReset();
    mockSearchIssues.mockRejectedValue(new McpError("JIRA_HTTP_ERROR", "down"));
    const jira = await handleJiraDaily({ projectKey: "PROJ" }, config);
    expect(jira.isError).toBe(true);
  });
});
