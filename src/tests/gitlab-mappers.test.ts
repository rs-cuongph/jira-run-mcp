import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  buildGitlabNoteUrl,
  extractTopLevelReviewComments,
  parseJiraIssueKeys,
} from "../gitlab/mappers.js";
import type { GitlabRawDiscussion, GitlabRawMergeRequest } from "../types/gitlab-api.js";

const mr: GitlabRawMergeRequest = {
  iid: 42,
  title: "Fix login",
  web_url: "https://gitlab.example.com/group/app/-/merge_requests/42",
  author: { username: "thanhnn" },
  description: "Relates to PROJ-2 and https://jira.example.com/browse/PROJ-1",
};

describe("buildDedupKey", () => {
  it("normalizes trailing slash on base URL", () => {
    expect(buildDedupKey("https://gitlab.example.com/", "group/app", 1, 99)).toBe(
      "https://gitlab.example.com|group/app|1|99"
    );
  });
});

describe("buildGitlabNoteUrl", () => {
  it("builds clickable MR note URL with hash fragment", () => {
    expect(
      buildGitlabNoteUrl(
        "https://devops.runsystem.info/",
        "dno/du2/microcopy-e-learning-system",
        93,
        1625816
      )
    ).toBe(
      "https://devops.runsystem.info/dno/du2/microcopy-e-learning-system/-/merge_requests/93#note_1625816"
    );
  });
});

describe("parseJiraIssueKeys", () => {
  const jiraBaseUrl = "https://jira.example.com";

  it("extracts plain Jira issue keys", () => {
    expect(parseJiraIssueKeys("Fixes PROJ-123 and ABC_1-7", jiraBaseUrl)).toEqual([
      "PROJ-123",
      "ABC_1-7",
    ]);
  });

  it("extracts full Jira browse URLs from the configured Jira base", () => {
    expect(
      parseJiraIssueKeys(
        "See https://jira.example.com/browse/PROJ-123?focusedCommentId=1#comment-1",
        jiraBaseUrl
      )
    ).toEqual(["PROJ-123"]);
  });

  it("preserves first appearance order and removes duplicates", () => {
    expect(
      parseJiraIssueKeys(
        "PROJ-2 https://jira.example.com/browse/PROJ-1 PROJ-2 PROJ-1",
        jiraBaseUrl
      )
    ).toEqual(["PROJ-2", "PROJ-1"]);
  });

  it("ignores invalid keys and URLs from another Jira base", () => {
    expect(
      parseJiraIssueKeys(
        "bad proj-1 ABC- invalid https://other.example.com/browse/PROJ-9 https://jira.example.com/issues/PROJ-8",
        jiraBaseUrl
      )
    ).toEqual([]);
  });
});

describe("extractTopLevelReviewComments", () => {
  it("keeps top-level human notes and ignores replies and system notes", () => {
    const discussions: GitlabRawDiscussion[] = [
      {
        id: "d1",
        notes: [
          {
            id: 10,
            body: "Please fix null check",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: { username: "reviewer1" },
            position: { new_path: "src/a.ts", new_line: 12 },
          },
          {
            id: 11,
            body: "Will do",
            system: false,
            created_at: "2026-07-15T11:00:00.000Z",
            author: { username: "thanhnn" },
          },
        ],
      },
      {
        id: "d2",
        notes: [
          {
            id: 20,
            body: "added 1 commit",
            system: true,
            created_at: "2026-07-15T09:00:00.000Z",
            author: { username: "thanhnn" },
          },
        ],
      },
      {
        id: "d3",
        notes: [
          {
            id: 30,
            body: "Another defect",
            system: false,
            created_at: "2026-07-16T08:00:00.000Z",
            author: { username: "reviewer2" },
          },
        ],
      },
    ];

    const result = extractTopLevelReviewComments({
      name: "app",
      gitlabBaseUrl: "https://gitlab.example.com",
      jiraBaseUrl: "https://jira.example.com",
      projectPath: "group/app",
      mr,
      discussions,
    });

    expect(result).toHaveLength(2);
    expect(result[0].noteId).toBe(10);
    expect(result[0].name).toBe("app");
    expect(result[0].commentAuthorUsername).toBe("reviewer1");
    expect(result[0].mrAuthorUsername).toBe("thanhnn");
    expect(result[0].jiraIssueKeys).toEqual(["PROJ-2", "PROJ-1"]);
    expect(result[0].dueDate).toBe("2026-07-15");
    expect(result[0].filePath).toBe("src/a.ts");
    expect(result[0].line).toBe(12);
    expect(result[1].noteId).toBe(30);
    expect(result.every((c) => c.noteId !== 11 && c.noteId !== 20)).toBe(true);
  });

  it("skips notes without author usernames", () => {
    const discussions: GitlabRawDiscussion[] = [
      {
        id: "d1",
        notes: [
          {
            id: 1,
            body: "orphan",
            system: false,
            created_at: "2026-07-15T10:00:00.000Z",
            author: {},
          },
        ],
      },
    ];

    expect(
      extractTopLevelReviewComments({
        name: "app",
        gitlabBaseUrl: "https://gitlab.example.com",
        jiraBaseUrl: "https://jira.example.com",
        projectPath: "group/app",
        mr,
        discussions,
      })
    ).toHaveLength(0);
  });
});
