import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAndValidateSession } from "../auth/session-manager.js";
import { GitlabHttpClient } from "../gitlab/http-client.js";
import { JiraHttpClient } from "../jira/http-client.js";
import {
  appendGitlabReviewDedupIds,
  getGitlabReviewWatermark,
  loadGitlabReviewDedupStore,
  loadGitlabReviewWatermarks,
  saveGitlabReviewWatermark,
} from "../jira/gitlab-review-dedup-store.js";
import {
  loadGitlabProjectLinks,
  loadGitlabProjectLinksFromJson,
} from "../jira/gitlab-project-map.js";
import {
  handleSyncGitlabReviewDefects,
  mrMatchesDateWindow,
  parseSyncDateInput,
  resolveLinkListScope,
  resolveQuery,
  syncGitlabReviewDefectsSchema,
} from "../tools/sync-gitlab-review-defects.js";

const mockConfig = {
  JIRA_BASE_URL: "https://jira.example.com",
  JIRA_SESSION_FILE: ".jira/session.json",
  JIRA_VALIDATE_PATH: "/rest/api/2/myself" as const,
  ATTACHMENT_WORKSPACE: "downloads",
  GITLAB_PROJECTS_FILE: ".jira/gitlab-projects.json",
  GITLAB_DEDUP_FILE: ".jira/gitlab-review-defects.json",
  GITLAB_PROJECTS_JSON: undefined,
  LOG_LEVEL: "info" as const,
  PLAYWRIGHT_HEADLESS: false as const,
  PLAYWRIGHT_BROWSER: "chromium" as const,
  GITLAB_TOKEN: "glpat-test",
};

vi.mock("../auth/session-manager.js", () => ({
  loadAndValidateSession: vi.fn(),
}));

vi.mock("../jira/http-client.js", () => ({
  JiraHttpClient: vi.fn(),
}));

vi.mock("../gitlab/http-client.js", () => ({
  GitlabHttpClient: vi.fn(),
}));

describe("syncGitlabReviewDefectsSchema", () => {
  it("defaults dryRun to true, mrState to merged, and projectStage to CODING", () => {
    const parsed = syncGitlabReviewDefectsSchema.parse({ projectKey: "PROJ" });
    expect(parsed.dryRun).toBe(true);
    expect(parsed.mrState).toBe("merged");
    expect(parsed.userOverrides).toEqual({});
    expect(parsed.projectStage).toBe("CODING");
  });

  it("accepts mrState opened/closed and mrIid", () => {
    expect(
      syncGitlabReviewDefectsSchema.parse({ projectKey: "PROJ", mrState: "opened" }).mrState
    ).toBe("opened");
    expect(
      syncGitlabReviewDefectsSchema.parse({ projectKey: "PROJ", mrState: "closed" }).mrState
    ).toBe("closed");
    expect(
      syncGitlabReviewDefectsSchema.parse({ projectKey: "PROJ", mrIid: 42 }).mrIid
    ).toBe(42);
  });

  it("rejects empty projectKey", () => {
    expect(syncGitlabReviewDefectsSchema.safeParse({ projectKey: "" }).success).toBe(false);
  });

  it("accepts compact dateFrom YYYYMMDD and rejects invalid date order", () => {
    expect(
      syncGitlabReviewDefectsSchema.parse({
        projectKey: "PROJ",
        dateFrom: "20260801",
      }).dateFrom
    ).toBe("2026-08-01");

    expect(
      syncGitlabReviewDefectsSchema.safeParse({
        projectKey: "PROJ",
        dateFrom: "2026-08-10",
        dateTo: "2026-08-01",
      }).success
    ).toBe(false);
  });
});

describe("parseSyncDateInput + resolveLinkListScope", () => {
  it("parses YYYYMMDD and resolves date-range scope", () => {
    expect(parseSyncDateInput("20260801")).toBe("2026-08-01");
    const scope = resolveLinkListScope({
      mrState: "merged",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-14",
      fullSync: false,
    });
    expect(scope.scopeLabel).toContain("dateFrom=2026-08-01");
    expect(scope.listOptions?.updatedAfter).toBeDefined();
    expect(scope.listOptions?.updatedBefore).toBeUndefined();
    expect(scope.advanceWatermark).toBe(false);
  });

  it("uses watermark overlap for incremental scope", () => {
    const scope = resolveLinkListScope({
      mrState: "merged",
      fullSync: false,
      storedWatermark: "2026-08-14T12:00:00.000Z",
    });
    expect(scope.scopeLabel).toContain("incremental updated_after=");
    expect(scope.listOptions?.updatedAfter).toBe("2026-08-12T12:00:00.000Z");
    expect(scope.advanceWatermark).toBe(true);
  });

  it("filters merged MRs by merged_at window", () => {
    const window = {
      startMs: new Date("2026-08-01T00:00:00").getTime(),
      endMs: new Date("2026-08-31T23:59:59.999").getTime(),
    };
    expect(
      mrMatchesDateWindow(
        { merged_at: "2026-08-02T10:00:00.000Z" },
        "merged",
        window
      )
    ).toBe(true);
    expect(
      mrMatchesDateWindow(
        { merged_at: "2026-07-31T10:00:00.000Z" },
        "merged",
        window
      )
    ).toBe(false);
  });
});

describe("resolveQuery", () => {
  it("builds email from GitLab username", () => {
    expect(resolveQuery("thanhnn", {})).toBe("thanhnn@runsystem.net");
  });

  it("prefers userOverrides", () => {
    expect(resolveQuery("thanhnn", { thanhnn: "thanh.nguyen" })).toBe("thanh.nguyen");
  });
});

describe("gitlab project map + dedup store", () => {
  it("loads links for a project key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitlab-map-"));
    const file = join(dir, "gitlab-projects.json");
    await writeFile(
      file,
      JSON.stringify({
        PROJ: [
          {
             name: "  app  ",
             gitlabBaseUrl: "https://gitlab.example.com/",
             projectPath: "/group/app/",
          },
        ],
      }),
      "utf8"
    );

    const links = await loadGitlabProjectLinks("PROJ", file);
    expect(links).toEqual([
      { name: "app", gitlabBaseUrl: "https://gitlab.example.com", projectPath: "group/app" },
    ]);
  });

  it("requires a non-empty repository name and trims it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitlab-map-validation-"));
    const file = join(dir, "gitlab-projects.json");
    const baseLink = {
      gitlabBaseUrl: "https://gitlab.example.com",
      projectPath: "group/app",
    };

    for (const name of [undefined, "", "   "]) {
      await writeFile(file, JSON.stringify({ PROJ: [{ ...baseLink, name }] }), "utf8");
      await expect(loadGitlabProjectLinks("PROJ", file)).rejects.toThrow("Invalid GitLab project map");
    }

    await writeFile(file, JSON.stringify({ PROJ: [{ ...baseLink, name: "  app  " }] }), "utf8");
    await expect(loadGitlabProjectLinks("PROJ", file)).resolves.toEqual([
      { name: "app", ...baseLink },
    ]);
  });

  it("loads links from GITLAB_PROJECTS_JSON payload", async () => {
    const links = await loadGitlabProjectLinksFromJson(
      "PROJ",
      JSON.stringify({
        PROJ: [
          {
            name: " app ",
            gitlabBaseUrl: "https://gitlab.example.com/",
            projectPath: "/group/app/",
          },
        ],
      })
    );

    expect(links).toEqual([
      { name: "app", gitlabBaseUrl: "https://gitlab.example.com", projectPath: "group/app" },
    ]);
  });

  it("fails on malformed GITLAB_PROJECTS_JSON payload", async () => {
    await expect(loadGitlabProjectLinksFromJson("PROJ", "{")).rejects.toThrow(
      "Invalid JSON in GITLAB_PROJECTS_JSON"
    );
  });

  it("appends dedup ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitlab-dedup-"));
    const file = join(dir, "dedup.json");
    await appendGitlabReviewDedupIds(["a", "b"], file);
    await appendGitlabReviewDedupIds(["b", "c"], file);
    const ids = await loadGitlabReviewDedupStore(file);
    expect([...ids].sort()).toEqual(["a", "b", "c"]);
  });

  it("preserves watermarks when appending dedup ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitlab-dedup-watermark-"));
    const file = join(dir, "dedup.json");
    await saveGitlabReviewWatermark(
      "https://gitlab.example.com",
      "group/app",
      "merged",
      "2026-08-14T09:00:00.000Z",
      file
    );
    await appendGitlabReviewDedupIds(["note-1"], file);
    expect(await loadGitlabReviewDedupStore(file)).toEqual(new Set(["note-1"]));
    expect(await getGitlabReviewWatermark("https://gitlab.example.com", "group/app", "merged", file)).toBe(
      "2026-08-14T09:00:00.000Z"
    );
  });

  it("preserves processed ids when saving watermark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gitlab-dedup-watermark-ids-"));
    const file = join(dir, "dedup.json");
    await appendGitlabReviewDedupIds(["x"], file);
    await saveGitlabReviewWatermark(
      "https://gitlab.example.com",
      "group/app",
      "merged",
      "2026-08-15T09:00:00.000Z",
      file
    );
    expect(await loadGitlabReviewDedupStore(file)).toEqual(new Set(["x"]));
    expect(await loadGitlabReviewWatermarks(file)).toEqual({
      "https://gitlab.example.com|group/app|merged": "2026-08-15T09:00:00.000Z",
    });
  });
});

describe("handleSyncGitlabReviewDefects", () => {
  let mockFindUsers: ReturnType<typeof vi.fn>;
  let mockSearchIssues: ReturnType<typeof vi.fn>;
  let mockCreateIssue: ReturnType<typeof vi.fn>;
  let mockLinkIssues: ReturnType<typeof vi.fn>;
  let mockListMrs: ReturnType<typeof vi.fn>;
  let mockGetMr: ReturnType<typeof vi.fn>;
  let mockListDiscussions: ReturnType<typeof vi.fn>;
  let mapFile: string;
  let dedupFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindUsers = vi.fn();
    mockSearchIssues = vi.fn().mockResolvedValue({ total: 0, issues: [] });
    mockCreateIssue = vi.fn();
    mockLinkIssues = vi.fn().mockResolvedValue({ linkId: "link-1" });
    mockListMrs = vi.fn();
    mockGetMr = vi.fn();
    mockListDiscussions = vi.fn();

    vi.mocked(loadAndValidateSession).mockResolvedValue({ cookieHeader: "c" });
    vi.mocked(JiraHttpClient).mockImplementation(
      () =>
        ({
          findUsers: mockFindUsers,
          searchIssues: mockSearchIssues,
          createIssue: mockCreateIssue,
          linkIssues: mockLinkIssues,
        }) as never
    );
    vi.mocked(GitlabHttpClient).mockImplementation(
      () =>
        ({
          listMergeRequests: mockListMrs,
          getMergeRequest: mockGetMr,
          listMergeRequestDiscussions: mockListDiscussions,
        }) as never
    );

    const dir = await mkdtemp(join(tmpdir(), "sync-gitlab-"));
    mapFile = join(dir, "gitlab-projects.json");
    dedupFile = join(dir, "dedup.json");
    await mkdir(dir, { recursive: true });
    await writeFile(
      mapFile,
      JSON.stringify({
        PROJ: [
          {
             name: "app",
             gitlabBaseUrl: "https://gitlab.example.com",
             projectPath: "group/app",
          },
        ],
      }),
      "utf8"
    );

    mockListMrs.mockResolvedValue([
      {
        iid: 42,
        title: "Fix login",
        web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
        author: { username: "thanhnn" },
      },
    ]);
    mockListDiscussions.mockResolvedValue([
      {
        id: "d1",
        notes: [
          {
            id: 10,
            body: "Please fix null check",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
          },
          {
            id: 11,
            body: "reply ignored",
            system: false,
            created_at: "2026-07-15T11:00:00.000Z",
            author: { username: "thanhnn" },
          },
        ],
      },
    ]);
  });

  it("returns CONFIG_ERROR when GITLAB_TOKEN missing", async () => {
    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ" },
      { ...mockConfig, GITLAB_TOKEN: undefined }
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GITLAB_TOKEN");
  });

  it("dryRun lists candidates and does not create", async () => {
    mockListMrs.mockResolvedValue([
      {
        iid: 42,
        title: "Fix login",
        web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
        author: { username: "thanhnn" },
        description: "Related to PROJ-9",
      },
    ]);
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("dryRun");
    expect(result.content[0].text).toContain("mrState=opened");
    expect(result.content[0].text).toContain("Candidates");
    expect(result.content[0].text).toContain("Please fix null check");
    expect(result.content[0].text).toContain("create payload");
    expect(result.content[0].text).toContain('"issuetype"');
    expect(result.content[0].text).toContain('[Review Code][app][MR !42]');
    expect(result.content[0].text).toContain("Jira references: PROJ-9");
    expect(mockListMrs).toHaveBeenCalledWith("group/app", "opened", undefined);
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockLinkIssues).not.toHaveBeenCalled();
  });

  it("uses cfg GitLab file paths when options are omitted", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "opened" },
      { ...mockConfig, GITLAB_PROJECTS_FILE: mapFile, GITLAB_DEDUP_FILE: dedupFile }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("Candidates");
    expect(mockListMrs).toHaveBeenCalledWith("group/app", "opened", undefined);
  });

  it("uses GITLAB_PROJECTS_JSON when provided in config", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "opened" },
      {
        ...mockConfig,
        GITLAB_PROJECTS_JSON: JSON.stringify({
          PROJ: [
            {
              name: "json-repo",
              gitlabBaseUrl: "https://gitlab.example.com",
              projectPath: "group/app",
            },
          ],
        }),
      }
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("[Review Code][json-repo][MR !42]");
    expect(mockListMrs).toHaveBeenCalledWith("group/app", "opened", undefined);
  });

  it("processes a single MR when mrIid is set", async () => {
    mockListMrs.mockResolvedValue([]);
    mockGetMr.mockResolvedValue({
      iid: 7,
      title: "One MR",
      web_url: "https://gitlab.example.com/group/app/-/merge_requests/7",
      author: { username: "thanhnn" },
    });
    mockListDiscussions.mockResolvedValue([
      {
        id: "d1",
        notes: [
          {
            id: 99,
            body: "Single MR comment",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
    ]);
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrIid: 7 },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("single MR !7");
    expect(result.content[0].text).toContain("Single MR comment");
    expect(mockGetMr).toHaveBeenCalledWith("group/app", 7);
    expect(mockListMrs).not.toHaveBeenCalled();
  });

  it("returns needsUserMapping when lookup fails", async () => {
    mockFindUsers.mockResolvedValue([]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("Needs user mapping");
    expect(result.content[0].text).toContain("thanhnn@runsystem.net");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("skips an entire MR when Jira already has Review Defects for that MR", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockSearchIssues.mockImplementation(async (jql: string) => {
      if (jql.includes("/group/app/-/merge_requests/42")) {
        return {
          total: 1,
          issues: [
            {
              key: "PROJ-77",
              summary: "[Review Code][app][MR !42] existing",
              status: "Open",
              issueType: "Review Defect",
              assignee: null,
              priority: null,
              created: "",
              updated: "",
              dueDate: null,
              url: "https://jira.example.com/browse/PROJ-77",
              description:
                "gitlab-note-id: https://gitlab.example.com/group/app/-/merge_requests/42#note_1",
              originalEstimate: null,
              remainingEstimate: null,
              timeSpent: null,
              defectOwner: null,
              planStartDate: null,
              actualStartDate: null,
              actualEndDate: null,
              severity: null,
              defectOrigin: null,
              percentDone: null,
              typeOfWork: null,
            },
          ],
        };
      }
      return { total: 0, issues: [] };
    });

    const dryRunResult = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(dryRunResult.content[0].text).toContain("Candidates (0)");
    expect(dryRunResult.content[0].text).toContain("Skipped MRs (already in Jira)");
    expect(dryRunResult.content[0].text).toContain("MR !42");
    expect(dryRunResult.content[0].text).toContain("skipped before fetch");
    expect(dryRunResult.content[0].text).toContain("PROJ-77");
    expect(mockListDiscussions).not.toHaveBeenCalled();

    const applyResult = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(applyResult.content[0].text).toContain("Created (0)");
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockListDiscussions).not.toHaveBeenCalled();
  });

  it("checks MR existence only once per MR even with multiple notes", async () => {
    mockListDiscussions.mockResolvedValue([
      {
        id: "d1",
        notes: [
          {
            id: 10,
            body: "Top-level note one",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
      {
        id: "d2",
        notes: [
          {
            id: 12,
            body: "Top-level note two",
            system: false,
            created_at: "2026-07-15T12:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
    ]);
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockSearchIssues.mockResolvedValue({ total: 0, issues: [] });

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    const mrScopeCalls = mockSearchIssues.mock.calls.filter(([jql]) =>
      (jql as string).includes("/group/app/-/merge_requests/42") &&
      !(jql as string).includes("#note_")
    );
    expect(mrScopeCalls).toHaveLength(1);
    expect(mockListDiscussions).toHaveBeenCalledTimes(1);
  });

  it("apply continues on partial create failures and only dedups successes", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockListDiscussions.mockResolvedValue([
      {
        id: "d1",
        notes: [
          {
            id: 10,
            body: "First comment",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
      {
        id: "d2",
        notes: [
          {
            id: 12,
            body: "Second comment",
            system: false,
            created_at: "2026-07-15T12:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
    ]);
    mockCreateIssue
      .mockResolvedValueOnce({
        id: "1",
        key: "PROJ-101",
        url: "https://jira.example.com/browse/PROJ-101",
      })
      .mockRejectedValueOnce(new Error("create failed"));

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("PROJ-101");
    expect(result.content[0].text).toContain("Failed (1)");
    expect(mockCreateIssue).toHaveBeenCalledTimes(2);
    const ids = await loadGitlabReviewDedupStore(dedupFile);
    expect(ids.has("https://gitlab.example.com|group/app|42|10")).toBe(true);
    expect(ids.has("https://gitlab.example.com|group/app|42|12")).toBe(false);
  });

  it("apply creates Review Defect and updates local dedup", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockCreateIssue.mockResolvedValue({
      id: "1",
      key: "PROJ-100",
      url: "https://jira.example.com/browse/PROJ-100",
    });

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("PROJ-100");
    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect(mockLinkIssues).not.toHaveBeenCalled();
    const payload = mockCreateIssue.mock.calls[0]?.[0] as {
      fields: Record<string, unknown>;
    };
    expect(payload.fields.customfield_10339).toEqual({ value: "Coding" });
    expect(payload.fields.summary).toBe("[Review Code][app][MR !42] Please fix null check");
    const ids = await loadGitlabReviewDedupStore(dedupFile);
    expect(ids.has("https://gitlab.example.com|group/app|42|10")).toBe(true);
  });

  it("apply links the created Review Defect to every Jira reference in the MR description", async () => {
    mockListMrs.mockResolvedValue([
      {
        iid: 42,
        title: "Fix login",
        web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
        author: { username: "thanhnn" },
        description:
          "See PROJ-9, https://jira.example.com/browse/ABC-2, and PROJ-9 again.",
      },
    ]);
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockCreateIssue.mockResolvedValue({
      id: "1",
      key: "PROJ-100",
      url: "https://jira.example.com/browse/PROJ-100",
    });

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("PROJ-100");
    expect(mockLinkIssues).toHaveBeenCalledTimes(2);
    expect(mockLinkIssues).toHaveBeenNthCalledWith(1, {
      type: { name: "Relates" },
      inwardIssue: { key: "PROJ-100" },
      outwardIssue: { key: "PROJ-9" },
    });
    expect(mockLinkIssues).toHaveBeenNthCalledWith(2, {
      type: { name: "Relates" },
      inwardIssue: { key: "PROJ-100" },
      outwardIssue: { key: "ABC-2" },
    });
  });

  it("reports link failures while keeping the created issue and local dedup", async () => {
    mockListMrs.mockResolvedValue([
      {
        iid: 42,
        title: "Fix login",
        web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
        author: { username: "thanhnn" },
        description: "PROJ-9",
      },
    ]);
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockCreateIssue.mockResolvedValue({
      id: "1",
      key: "PROJ-100",
      url: "https://jira.example.com/browse/PROJ-100",
    });
    mockLinkIssues.mockRejectedValue(new Error("link failed"));

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "opened" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("Created (1)");
    expect(result.content[0].text).toContain("Failed (1)");
    expect(result.content[0].text).toContain("link PROJ-100 -> PROJ-9: link failed");
    expect(
      await loadGitlabReviewDedupStore(dedupFile)
    ).toEqual(new Set(["https://gitlab.example.com|group/app|42|10"]));
  });

  it("skips duplicates from local store", async () => {
    await appendGitlabReviewDedupIds(
      ["https://gitlab.example.com|group/app|42|10"],
      dedupFile
    );
    mockFindUsers.mockResolvedValue([]);

    const result = await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(result.content[0].text).toContain("Skipped duplicates");
    expect(result.content[0].text).toContain("group/app|42|10");
  });

  it("uses updated_after when watermark exists", async () => {
    await saveGitlabReviewWatermark(
      "https://gitlab.example.com",
      "group/app",
      "merged",
      "2026-08-14T12:00:00.000Z",
      dedupFile
    );
    mockFindUsers.mockResolvedValue([]);

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "merged" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(mockListMrs).toHaveBeenCalledWith("group/app", "merged", {
      updatedAfter: "2026-08-12T12:00:00.000Z",
    });
  });

  it("fullSync ignores watermark for listing", async () => {
    await saveGitlabReviewWatermark(
      "https://gitlab.example.com",
      "group/app",
      "merged",
      "2026-08-14T12:00:00.000Z",
      dedupFile
    );
    mockFindUsers.mockResolvedValue([]);

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "merged", fullSync: true },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(mockListMrs).toHaveBeenCalledWith("group/app", "merged", undefined);
  });

  it("dateFrom filters merged MRs client-side", async () => {
    mockListMrs.mockResolvedValue([
      {
        iid: 50,
        title: "In range",
        merged_at: "2026-08-02T10:00:00.000Z",
        author: { username: "thanhnn" },
      },
      {
        iid: 51,
        title: "Out of range",
        merged_at: "2026-07-01T10:00:00.000Z",
        author: { username: "thanhnn" },
      },
    ]);
    mockFindUsers.mockResolvedValue([]);

    await handleSyncGitlabReviewDefects(
      {
        projectKey: "PROJ",
        dryRun: true,
        mrState: "merged",
        dateFrom: "20260801",
      },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );

    expect(mockListMrs).toHaveBeenCalledWith(
      "group/app",
      "merged",
      expect.objectContaining({ updatedAfter: expect.any(String) })
    );
    expect(mockListDiscussions).toHaveBeenCalledTimes(1);
    expect(mockListDiscussions).toHaveBeenCalledWith("group/app", 50);
  });

  it("advances watermark on successful apply but not on dryRun", async () => {
    mockFindUsers.mockImplementation(async (query: string) => [
      {
        name: query,
        key: query,
        displayName: query,
        emailAddress: query,
        active: true,
      },
    ]);
    mockCreateIssue.mockResolvedValue({
      id: "1",
      key: "PROJ-100",
      url: "https://jira.example.com/browse/PROJ-100",
    });

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: true, mrState: "merged" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(
      await getGitlabReviewWatermark(
        "https://gitlab.example.com",
        "group/app",
        "merged",
        dedupFile
      )
    ).toBeUndefined();

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "merged" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(
      await getGitlabReviewWatermark(
        "https://gitlab.example.com",
        "group/app",
        "merged",
        dedupFile
      )
    ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not advance watermark when collection fails or date range is used", async () => {
    mockFindUsers.mockResolvedValue([]);
    mockListDiscussions.mockRejectedValue(new Error("discussions failed"));

    await handleSyncGitlabReviewDefects(
      { projectKey: "PROJ", dryRun: false, mrState: "merged" },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(
      await getGitlabReviewWatermark(
        "https://gitlab.example.com",
        "group/app",
        "merged",
        dedupFile
      )
    ).toBeUndefined();

    mockListDiscussions.mockResolvedValue([
      {
        id: "d1",
        notes: [
          {
            id: 10,
            body: "Please fix null check",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
          },
        ],
      },
    ]);

    await handleSyncGitlabReviewDefects(
      {
        projectKey: "PROJ",
        dryRun: false,
        mrState: "merged",
        dateFrom: "20260801",
      },
      mockConfig,
      { gitlabProjectsFile: mapFile, gitlabDedupFile: dedupFile }
    );
    expect(
      await getGitlabReviewWatermark(
        "https://gitlab.example.com",
        "group/app",
        "merged",
        dedupFile
      )
    ).toBeUndefined();
  });
});
