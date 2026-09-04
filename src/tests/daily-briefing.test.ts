import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "../errors.js";
import { handleJiraDailyBriefing, jiraDailyBriefingSchema } from "../tools/daily-briefing.js";

const { mockLoadSession, mockSearchIssues, mockGetIssue, mockGetIssueLinks } = vi.hoisted(() => ({
  mockLoadSession: vi.fn(),
  mockSearchIssues: vi.fn(),
  mockGetIssue: vi.fn(),
  mockGetIssueLinks: vi.fn(),
}));

vi.mock("../auth/session-manager.js", () => ({ loadAndValidateSession: mockLoadSession }));
vi.mock("../jira/http-client.js", () => ({
  JiraHttpClient: class {
    searchIssues = mockSearchIssues;
    getIssue = mockGetIssue;
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
  progressWbsGantt: "50",
  percentDone: null,
  typeOfWork: null,
  ...overrides,
});

describe("jiraDailyBriefingSchema", () => {
  it("defaults date, concern limit, and audience", () => {
    expect(jiraDailyBriefingSchema.parse({ projectKey: "PROJ" })).toMatchObject({
      projectKey: "PROJ", maxConcerns: 5, audience: "project manager",
    });
    expect(jiraDailyBriefingSchema.parse({ projectKey: "PROJ", epic: ["PROJ-10", "PROJ-20"] }).epic).toEqual(["PROJ-10", "PROJ-20"]);
  });

  it("rejects invalid project keys and concern limits", () => {
    expect(jiraDailyBriefingSchema.safeParse({ projectKey: "bad" }).success).toBe(false);
    expect(jiraDailyBriefingSchema.safeParse({ projectKey: "PROJ", date: "2026-02-30" }).success).toBe(false);
    expect(jiraDailyBriefingSchema.safeParse({ projectKey: "PROJ", maxConcerns: 0 }).success).toBe(false);
    expect(jiraDailyBriefingSchema.safeParse({ projectKey: "PROJ", maxConcerns: 21 }).success).toBe(false);
    expect(jiraDailyBriefingSchema.safeParse({ projectKey: "PROJ", epic: ["bad"] }).success).toBe(false);
  });
});

describe("handleJiraDailyBriefing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadSession.mockResolvedValue({ cookieHeader: "sid=abc" });
    mockSearchIssues
      .mockResolvedValueOnce({ total: 2, issues: [issue("PROJ-1", { description: "blocked by API" }), issue("PROJ-2", { dueDate: "2026-08-17" })] })
      .mockResolvedValueOnce({ total: 1, issues: [issue("PROJ-3", { dueDate: "2026-08-18" })] })
      .mockResolvedValueOnce({ total: 1, issues: [issue("PROJ-2", { dueDate: "2026-08-17" })] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 3, issues: [] });
    mockGetIssue.mockImplementation(async (key: string) => issue(key));
    mockGetIssueLinks.mockImplementation(async (key: string) => ({ issueKey: key, links: [] }));
  });

  it("renders the fixed Vietnamese briefing and limits evidence calls", async () => {
    const result = await handleJiraDailyBriefing({ projectKey: "PROJ", date: "2026-08-18", maxConcerns: 2 }, config);
    expect(result.isError).toBeUndefined();
    expect(mockSearchIssues).toHaveBeenCalledTimes(5);
    expect(mockGetIssue).toHaveBeenCalledTimes(2);
    const text = result.content[0]?.text ?? "";
    for (const heading of ["## Daily brief PROJ · 18/08/2026", "**Tổng quan:** 🟠 / cần theo dõi", "### Chốt hôm nay"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("| KPI | Giá trị |");
    expect(text).toContain("| Active | 2 |");
    expect(text).toContain("| In Progress | 3 |");
    expect(text).toContain("| Hoàn thành | 0 |");
    expect(text).toContain("| Đến hạn hôm nay | 1 |");
    expect(text).toContain("| Quá hạn | 1 |");
    expect(text).toContain("| Bug trong tuần | 3 |");
    expect(text).toContain("| Weighted progress | 50,0% |");
    expect(text).toContain("| Issue | Tín hiệu | Trạng thái | Owner |");
    expect(text).toContain("[PROJ-1](https://jira.example.com/browse/PROJ-1)");
    expect(text).toContain("[PROJ-2](https://jira.example.com/browse/PROJ-2)");
    expect(text).toContain("blocker heuristic");
    expect(text).toContain("quá hạn từ 17/08");
    const concernSection = text.slice(text.indexOf("### Cần chú ý"), text.indexOf("### Chốt hôm nay"));
    const concernRows = concernSection.split("\n").filter((line) => line.startsWith("| "));
    expect(concernRows).toHaveLength(3);
    expect(concernRows[0]).toBe("| Issue | Tín hiệu | Trạng thái | Owner |");
    for (const row of concernRows) {
      expect(row).toMatch(/^\| .*\|$/);
    }
    const concernCells = concernRows.slice(1).map((row) => row.slice(2, -1).split(" | ").map((cell) => cell.trim()));
    expect(concernCells).toHaveLength(2);
    expect(concernCells[0]).toEqual([
      "[PROJ-1](https://jira.example.com/browse/PROJ-1) — PROJ-1 summary",
      "blocker heuristic",
      "In Progress",
      "Alice",
    ]);
    expect(concernCells[1]).toEqual([
      "[PROJ-2](https://jira.example.com/browse/PROJ-2) — PROJ-2 summary",
      "quá hạn từ 17/08",
      "In Progress",
      "Alice",
    ]);
    expect(text).not.toContain("Chỉ đọc; Jira không bị thay đổi.");
    expect(text).not.toContain("💡 **Next:**");
    expect(text).not.toContain('`jira_get_issue({issueKey: "<key>"})`');
    expect(text).not.toContain('`jira_get_issue_links({issueKey: "<key>"})`');
    expect(text).not.toContain("Overall: Amber");
    expect(text).not.toContain("## Daily Delivery Briefing");
    expect(text.indexOf("## Daily brief")).toBeLessThan(text.indexOf("### Cần chú ý"));
    expect(text.indexOf("### Cần chú ý")).toBeLessThan(text.indexOf("### Chốt hôm nay"));
    expect(text.trimEnd()).toMatch(/### Chốt hôm nay[\s\S]*\.$/);
  });

  it("passes multiple epics to the daily collection without changing the format", async () => {
    mockGetIssue.mockImplementation(async (key: string) => issue(key, {
      issueType: "Epic",
      epicName: key === "PROJ-10" ? "Payments" : "Checkout",
      summary: key === "PROJ-10" ? "Payments summary" : "Checkout summary",
    }));
    const result = await handleJiraDailyBriefing({ projectKey: "PROJ", epic: ["PROJ-10", "PROJ-20"], date: "2026-08-18" }, config);
    expect(result.isError).toBeUndefined();
    expect(mockSearchIssues).toHaveBeenCalledTimes(5);
    for (const [jql] of mockSearchIssues.mock.calls) {
      expect(jql).toContain('"Epic Link" IN ("PROJ-10", "PROJ-20")');
    }
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("**Epic:**\n[PROJ-10:Payments](https://jira.example.com/browse/PROJ-10)\n[PROJ-20:Checkout](https://jira.example.com/browse/PROJ-20)");
    expect(text.indexOf("[PROJ-10:Payments]")).toBeLessThan(text.indexOf("[PROJ-20:Checkout]"));
  });

  it("escapes concern table cells", async () => {
    mockSearchIssues.mockReset();
    mockSearchIssues
      .mockResolvedValueOnce({ total: 1, issues: [issue("PROJ-1", { summary: "blocked | API\nnext" })] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] })
      .mockResolvedValueOnce({ total: 0, issues: [] });
    const result = await handleJiraDailyBriefing({ projectKey: "PROJ", date: "2026-08-18" }, config);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("blocked \\| API<br>next");
  });

  it("returns Green and N/A progress for an empty project", async () => {
    mockSearchIssues.mockReset();
    mockSearchIssues.mockResolvedValue({ total: 0, issues: [] });
    const result = await handleJiraDailyBriefing({ projectKey: "PROJ", date: "2026-08-18" }, config);
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("## Daily brief PROJ · 18/08/2026");
    expect(text).toContain("**Tổng quan:** 🟢 / ổn");
    expect(text).toContain("| Weighted progress | N/A |");
    expect(text).toContain("Không có tín hiệu rủi ro từ dữ liệu Jira hiện tại.");
    expect(text).toContain("### Chốt hôm nay");
    expect(text).not.toContain("Không có việc cần chốt từ dữ liệu Jira hiện tại.");
    expect(text).not.toContain("💡 **Next:**");
    expect(text).not.toContain("Overall: Green");
    expect(mockGetIssue).not.toHaveBeenCalled();
  });

  it("returns an error for authentication and search failures", async () => {
    mockLoadSession.mockRejectedValueOnce(new McpError("AUTH_REQUIRED", "No session"));
    expect((await handleJiraDailyBriefing({ projectKey: "PROJ" }, config)).isError).toBe(true);
    mockLoadSession.mockResolvedValue({ cookieHeader: "sid=abc" });
    mockSearchIssues.mockReset();
    mockSearchIssues.mockRejectedValue(new McpError("JIRA_HTTP_ERROR", "down"));
    expect((await handleJiraDailyBriefing({ projectKey: "PROJ" }, config)).isError).toBe(true);
  });
});
