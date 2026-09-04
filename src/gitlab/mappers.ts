import type {
  GitlabRawDiscussion,
  GitlabRawMergeRequest,
  GitlabRawNote,
} from "../types/gitlab-api.js";

export interface GitlabReviewCommentCandidate {
  jiraIssueKeys: string[];
  dedupKey: string;
  noteId: number;
  discussionId: string;
  body: string;
  createdAt: string;
  dueDate: string;
  commentAuthorUsername: string;
  mrAuthorUsername: string;
  mrIid: number;
  mrTitle: string;
  mrUrl: string;
  filePath: string | null;
  line: number | null;
  gitlabBaseUrl: string;
  projectPath: string;
  name: string;
}

export function buildDedupKey(
  gitlabBaseUrl: string,
  projectPath: string,
  mrIid: number,
  noteId: number
): string {
  const base = gitlabBaseUrl.replace(/\/$/, "");
  return `${base}|${projectPath}|${mrIid}|${noteId}`;
}

/** Clickable GitLab MR note URL for Jira description (`…/merge_requests/{iid}#note_{id}`). */
export function buildGitlabNoteUrl(
  gitlabBaseUrl: string,
  projectPath: string,
  mrIid: number,
  noteId: number
): string {
  const base = gitlabBaseUrl.replace(/\/$/, "");
  return `${base}/${projectPath}/-/merge_requests/${mrIid}#note_${noteId}`;
}

export function buildGitlabMrPathFragment(projectPath: string, mrIid: number): string {
  return `/${projectPath}/-/merge_requests/${mrIid}`;
}

const JIRA_ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;
const JIRA_REFERENCE_TOKEN_PATTERN = /https?:\/\/[^\s]+|[A-Z][A-Z0-9_]+-\d+/g;

/** Extract Jira issue keys mentioned in an MR description for one Jira instance. */
export function parseJiraIssueKeys(
  description: string | null | undefined,
  jiraBaseUrl: string
): string[] {
  if (!description?.trim()) return [];

  const base = new URL(jiraBaseUrl.replace(/\/+$/, ""));
  const basePath = base.pathname.replace(/\/+$/, "");
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const match of description.matchAll(JIRA_REFERENCE_TOKEN_PATTERN)) {
    const token = match[0];
    const key =
      token.startsWith("http://") || token.startsWith("https://")
        ? parseJiraBrowseUrl(token, base.origin, basePath)
        : token;
    if (key == null || !JIRA_ISSUE_KEY_PATTERN.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return keys;
}

function parseJiraBrowseUrl(token: string, baseOrigin: string, basePath: string): string | null {
  const cleaned = token.replace(/[),.;!?\]}>]+$/g, "");
  try {
    const url = new URL(cleaned);
    if (url.origin !== baseOrigin) return null;
    const prefix = `${basePath}/browse/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const key = url.pathname.slice(prefix.length);
    return key.includes("/") ? null : key;
  } catch {
    return null;
  }
}

/**
 * Extract top-level human discussion notes from an MR.
 * Ignores replies (notes after the first) and system notes.
 */
export function extractTopLevelReviewComments(input: {
  name: string;
  gitlabBaseUrl: string;
  jiraBaseUrl: string;
  projectPath: string;
  mr: GitlabRawMergeRequest;
  discussions: GitlabRawDiscussion[];
}): GitlabReviewCommentCandidate[] {
  const mrIid = input.mr.iid;
  if (typeof mrIid !== "number") return [];

  const mrAuthorUsername = input.mr.author?.username?.trim() ?? "";
  const mrTitle = input.mr.title?.trim() ?? "";
  const mrUrl = input.mr.web_url?.trim() ?? "";
  const jiraIssueKeys = parseJiraIssueKeys(input.mr.description, input.jiraBaseUrl);
  const results: GitlabReviewCommentCandidate[] = [];

  for (const discussion of input.discussions) {
    const notes = discussion.notes ?? [];
    if (notes.length === 0) continue;

    const top = notes[0];
    if (!isHumanTopLevelNote(top)) continue;

    const noteId = top.id;
    if (typeof noteId !== "number") continue;

    const body = (top.body ?? "").trim();
    if (!body) continue;

    const createdAt = top.created_at ?? "";
    const dueDate = toDueDate(createdAt);
    const commentAuthorUsername = top.author?.username?.trim() ?? "";
    if (!commentAuthorUsername || !mrAuthorUsername) continue;

    const filePath = top.position?.new_path ?? top.position?.old_path ?? null;
    const line = top.position?.new_line ?? top.position?.old_line ?? null;

    results.push({
      jiraIssueKeys,
      dedupKey: buildDedupKey(input.gitlabBaseUrl, input.projectPath, mrIid, noteId),
      noteId,
      discussionId: discussion.id ?? String(noteId),
      body,
      createdAt,
      dueDate,
      commentAuthorUsername,
      mrAuthorUsername,
      mrIid,
      mrTitle,
      mrUrl,
      filePath,
      line: typeof line === "number" ? line : null,
      gitlabBaseUrl: input.gitlabBaseUrl.replace(/\/$/, ""),
      projectPath: input.projectPath,
      name: input.name,
    });
  }

  return results;
}

function isHumanTopLevelNote(note: GitlabRawNote): boolean {
  if (note.system === true) return false;
  if (!note.body || !note.body.trim()) return false;
  return true;
}

function toDueDate(iso: string): string {
  if (!iso) return "";
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
  return match?.[1] ?? "";
}
