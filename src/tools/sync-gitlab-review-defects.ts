import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import { z } from "zod";
import { loadAndValidateSession } from "../auth/session-manager.js";
import { isMcpError } from "../errors.js";
import {
  GitlabHttpClient,
  type GitlabListMergeRequestsOptions,
  type GitlabMrState,
} from "../gitlab/http-client.js";
import {
  buildGitlabMrPathFragment,
  buildGitlabNoteUrl,
  extractTopLevelReviewComments,
  type GitlabReviewCommentCandidate,
} from "../gitlab/mappers.js";
import { ISSUE_TYPE } from "../jira/constants.js";
import {
  buildCreateIssuePayload,
  createIssueFromFields,
} from "../jira/create-issue.js";
import {
  buildReviewDefectFields,
  DEFAULT_REVIEW_DEFECT_PROJECT_STAGE,
  GITLAB_NOTE_ID_MARKER_PREFIX,
  REVIEW_DEFECT_PROJECT_STAGE_KEYS,
  type ReviewDefectProjectStageKey,
} from "../jira/gitlab-review-defect.js";
import {
  loadGitlabProjectLinks,
  loadGitlabProjectLinksFromJson,
  type GitlabProjectLink,
} from "../jira/gitlab-project-map.js";
import {
  appendGitlabReviewDedupIds,
  buildGitlabReviewWatermarkKey,
  DEFAULT_GITLAB_REVIEW_DEDUP_FILE,
  getGitlabReviewWatermark,
  loadGitlabReviewDedupStore,
  saveGitlabReviewWatermark,
  watermarkUpdatedAfterIso,
} from "../jira/gitlab-review-dedup-store.js";
import { JiraHttpClient } from "../jira/http-client.js";
import {
  chunkArray,
  escapeJqlString,
  mapWithConcurrency,
  navigationHint,
  todayLocalDate,
  withHttpRetry,
} from "../utils.js";
import type { Config } from "../config.js";
import type { GitlabRawMergeRequest } from "../types/gitlab-api.js";
import type { JiraUserSearchResult } from "../types.js";

export const GITLAB_JIRA_EMAIL_DOMAIN = "runsystem.net";
export const GITLAB_MR_STATES = ["opened", "merged", "closed"] as const;

dayjs.extend(customParseFormat);

const GITLAB_DISCUSSION_CONCURRENCY = 8;
const JIRA_USER_RESOLVE_CONCURRENCY = 5;
const JIRA_CREATE_CONCURRENCY = 3;
const MR_BATCH_SIZE = 12;
const NOTE_BATCH_SIZE = 10;
const DEDUP_SEARCH_FIELDS = ["description"] as const;

const reviewDefectProjectStageEnum = REVIEW_DEFECT_PROJECT_STAGE_KEYS as [
  ReviewDefectProjectStageKey,
  ...ReviewDefectProjectStageKey[],
];

export { reviewDefectProjectStageEnum };

const syncDateInputSchema = z
  .string()
  .trim()
  .regex(/^(\d{4}-\d{2}-\d{2}|\d{8})$/, "date must be YYYY-MM-DD or YYYYMMDD")
  .transform(parseSyncDateInput);

export const syncGitlabReviewDefectsSchema = z
  .object({
  projectKey: z.string().min(1, "projectKey is required"),
  /** Which MRs to scan when mrIid is omitted. Default: merged. */
  mrState: z.enum(GITLAB_MR_STATES).optional().default("merged"),
  /** When set, process only this one MR IID (searched across configured GitLab links). */
  mrIid: z.number().int().positive().optional(),
  /** Inclusive start date (YYYY-MM-DD or YYYYMMDD). Ignored when mrIid is set. */
  dateFrom: syncDateInputSchema.optional(),
  /** Inclusive end date; defaults to today when dateFrom is set. Ignored when mrIid is set. */
  dateTo: syncDateInputSchema.optional(),
  /** When true, ignore watermark and list all MRs for mrState. */
  fullSync: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(true),
  userOverrides: z.record(z.string()).optional().default({}),
  /** Jira Project Stages (`customfield_10339`). Default: CODING. */
  projectStage: z
    .enum(reviewDefectProjectStageEnum)
    .optional()
    .default(DEFAULT_REVIEW_DEFECT_PROJECT_STAGE),
})
  .superRefine((data, ctx) => {
    if (data.dateFrom != null && data.dateTo != null && data.dateFrom > data.dateTo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dateFrom must be on or before dateTo",
        path: ["dateFrom"],
      });
    }
  });

export type SyncGitlabReviewDefectsInput = z.infer<typeof syncGitlabReviewDefectsSchema>;

interface NeedsUserMapping {
  candidate: GitlabReviewCommentCandidate;
  missingRoles: Array<"assignee" | "reporter">;
  attempted: {
    assigneeQuery: string;
    reporterQuery: string;
  };
}

interface ResolvedCandidate {
  candidate: GitlabReviewCommentCandidate;
  assigneeName: string;
  reporterName: string;
}

interface SkippedMrCandidate {
  mrIid: number;
  projectPath: string;
  noteCount: number;
  skippedBeforeFetch?: boolean;
  sampleKey?: string;
  sampleUrl?: string;
}

interface MrRef {
  projectPath: string;
  mrIid: number;
}

export interface MrDateWindow {
  startMs: number;
  endMs: number;
}

export interface LinkListScope {
  listOptions?: GitlabListMergeRequestsOptions;
  dateWindow?: MrDateWindow;
  scopeLabel: string;
  advanceWatermark: boolean;
}

/** Parse YYYY-MM-DD or YYYYMMDD into normalized YYYY-MM-DD. */
export function parseSyncDateInput(value: string): string {
  const trimmed = value.trim();
  if (/^\d{8}$/.test(trimmed)) {
    const normalized = `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
    if (!dayjs(normalized, "YYYY-MM-DD", true).isValid()) {
      throw new Error(`Invalid date: ${value}`);
    }
    return normalized;
  }
  if (!dayjs(trimmed, "YYYY-MM-DD", true).isValid()) {
    throw new Error(`Invalid date: ${value}`);
  }
  return trimmed;
}

export function buildMrDateWindow(dateFrom: string, dateTo: string): MrDateWindow {
  return {
    startMs: dayjs(dateFrom).startOf("day").valueOf(),
    endMs: dayjs(dateTo).endOf("day").valueOf(),
  };
}

export function mrMatchesDateWindow(
  mr: GitlabRawMergeRequest,
  mrState: GitlabMrState,
  window: MrDateWindow
): boolean {
  const ts = mrState === "merged" ? mr.merged_at : mr.updated_at;
  if (ts == null || ts === "") return false;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return false;
  return ms >= window.startMs && ms <= window.endMs;
}

export function resolveLinkListScope(input: {
  mrIid?: number;
  mrState: GitlabMrState;
  dateFrom?: string;
  dateTo?: string;
  fullSync: boolean;
  storedWatermark?: string;
}): LinkListScope {
  if (input.mrIid != null) {
    return {
      scopeLabel: `single MR !${input.mrIid}`,
      advanceWatermark: false,
    };
  }

  const effectiveDateTo = input.dateFrom != null ? (input.dateTo ?? todayLocalDate()) : input.dateTo;

  if (input.dateFrom != null && effectiveDateTo != null) {
    const dateWindow = buildMrDateWindow(input.dateFrom, effectiveDateTo);
    const listOptions: GitlabListMergeRequestsOptions = {
      updatedAfter: dayjs(input.dateFrom).startOf("day").toISOString(),
    };
    if (input.mrState !== "merged") {
      listOptions.updatedBefore = dayjs(effectiveDateTo).endOf("day").toISOString();
    }
    return {
      listOptions,
      dateWindow,
      scopeLabel: `mrState=${input.mrState} | dateFrom=${input.dateFrom} | dateTo=${effectiveDateTo}`,
      advanceWatermark: false,
    };
  }

  if (input.fullSync) {
    return {
      scopeLabel: `mrState=${input.mrState} | fullSync`,
      advanceWatermark: true,
    };
  }

  if (input.storedWatermark != null) {
    const updatedAfter = watermarkUpdatedAfterIso(input.storedWatermark);
    return {
      listOptions: { updatedAfter },
      scopeLabel: `mrState=${input.mrState} | incremental updated_after=${updatedAfter}`,
      advanceWatermark: true,
    };
  }

  return {
    scopeLabel: `mrState=${input.mrState} | initial full scan`,
    advanceWatermark: true,
  };
}

export async function handleSyncGitlabReviewDefects(
  rawInput: unknown,
  cfg: Config,
  options?: {
    gitlabProjectsFile?: string;
    gitlabDedupFile?: string;
  }
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const parsed = syncGitlabReviewDefectsSchema.safeParse(rawInput);
  if (!parsed.success) {
    const msg = parsed.error.errors.map((e) => e.message).join("; ");
    return errorContent(`Invalid input: ${msg}`);
  }

  const { projectKey, mrState, mrIid, dateFrom, dateTo, fullSync, dryRun, userOverrides, projectStage } =
    parsed.data;
  const gitlabProjectsJson = cfg.GITLAB_PROJECTS_JSON?.trim();
  const gitlabProjectsFile = options?.gitlabProjectsFile ?? cfg.GITLAB_PROJECTS_FILE;
  const gitlabDedupFile =
    options?.gitlabDedupFile ?? cfg.GITLAB_DEDUP_FILE ?? DEFAULT_GITLAB_REVIEW_DEDUP_FILE;
  const token = cfg.GITLAB_TOKEN?.trim();
  if (!token) {
    return errorContent(
      `[CONFIG_ERROR] GITLAB_TOKEN is required. Export GITLAB_TOKEN in your environment.`
    );
  }

  let sessionCookies;
  try {
    sessionCookies = await loadAndValidateSession(
      cfg.JIRA_SESSION_FILE,
      cfg.JIRA_BASE_URL,
      cfg.JIRA_VALIDATE_PATH
    );
  } catch (err: unknown) {
    if (isMcpError(err)) return authErrorContent(err.code, err.message);
    throw err;
  }

  try {
    const links = gitlabProjectsJson
      ? await loadGitlabProjectLinksFromJson(projectKey, gitlabProjectsJson)
      : await loadGitlabProjectLinks(projectKey, gitlabProjectsFile);
    const jira = new JiraHttpClient(cfg.JIRA_BASE_URL, sessionCookies);
    const localDedup = await loadGitlabReviewDedupStore(gitlabDedupFile);
    const userCache = new Map<string, JiraUserSearchResult | null>();
    const failed: string[] = [];

    const collected = await collectReviewComments({
      links,
      token,
      mrState,
      mrIid,
      dateFrom,
      dateTo,
      fullSync,
      jira,
      jiraBaseUrl: cfg.JIRA_BASE_URL,
      projectKey,
      gitlabDedupFile,
    });
    const skippedMrs: SkippedMrCandidate[] = [...collected.skippedMrs];
    failed.push(...collected.failed);

    const skippedDuplicate: GitlabReviewCommentCandidate[] = [];
    const pending: GitlabReviewCommentCandidate[] = [];

    for (const candidate of collected.candidates) {
      if (localDedup.has(candidate.dedupKey)) {
        skippedDuplicate.push(candidate);
      } else {
        pending.push(candidate);
      }
    }

    const jiraDuplicateKeys = await batchCheckNotesInJira(jira, projectKey, pending);
    const ready: GitlabReviewCommentCandidate[] = [];
    for (const candidate of pending) {
      if (jiraDuplicateKeys.has(candidate.dedupKey)) {
        skippedDuplicate.push(candidate);
      } else {
        ready.push(candidate);
      }
    }

    const needsUserMapping: NeedsUserMapping[] = [];
    const resolved: ResolvedCandidate[] = [];

    const uniqueQueries = new Map<string, string>();
    for (const candidate of ready) {
      for (const username of [candidate.mrAuthorUsername, candidate.commentAuthorUsername]) {
        const query = resolveQuery(username, userOverrides);
        uniqueQueries.set(query.toLowerCase(), query);
      }
    }

    await mapWithConcurrency(
      [...uniqueQueries.values()],
      JIRA_USER_RESOLVE_CONCURRENCY,
      async (query) => resolveJiraUser(jira, query, userCache)
    );

    for (const candidate of ready) {
      const assigneeQuery = resolveQuery(candidate.mrAuthorUsername, userOverrides);
      const reporterQuery = resolveQuery(candidate.commentAuthorUsername, userOverrides);
      const assignee = await resolveJiraUser(jira, assigneeQuery, userCache);
      const reporter = await resolveJiraUser(jira, reporterQuery, userCache);

      const missingRoles: Array<"assignee" | "reporter"> = [];
      if (!assignee?.name) missingRoles.push("assignee");
      if (!reporter?.name) missingRoles.push("reporter");

      if (missingRoles.length > 0) {
        needsUserMapping.push({
          candidate,
          missingRoles,
          attempted: { assigneeQuery, reporterQuery },
        });
        continue;
      }

      resolved.push({
        candidate,
        assigneeName: assignee!.name!,
        reporterName: reporter!.name!,
      });
    }

    const created: Array<{ key: string; url: string; dedupKey: string }> = [];
    const createFailed: string[] = [...failed];

    if (!dryRun) {
      const newlyCreatedIds: string[] = [];
      const createResults = await mapWithConcurrency(
        resolved,
        JIRA_CREATE_CONCURRENCY,
        async (item) => {
          const fields = buildReviewDefectFields(projectKey, item, projectStage);
          const result = await withHttpRetry(() =>
            createIssueFromFields(
              jira,
              cfg.JIRA_BASE_URL,
              ISSUE_TYPE.REVIEW_DEFECT,
              fields
            )
          );
          return {
            key: result.key,
            url: result.url,
            dedupKey: item.candidate.dedupKey,
            jiraIssueKeys: item.candidate.jiraIssueKeys,
          };
        }
      );

      for (const result of createResults) {
        if (result.ok) {
          const { key, url, dedupKey, jiraIssueKeys } = result.value;
          created.push({ key, url, dedupKey });
          newlyCreatedIds.push(result.value.dedupKey);
          for (const referencedJiraKey of jiraIssueKeys) {
            try {
              await withHttpRetry(() =>
                jira.linkIssues({
                  type: { name: "Relates" },
                  inwardIssue: { key },
                  outwardIssue: { key: referencedJiraKey },
                })
              );
            } catch (err: unknown) {
              createFailed.push(formatErr(`link ${key} -> ${referencedJiraKey}`, err));
            }
          }
        } else {
          const dedupKey =
            result.item.candidate?.dedupKey ?? `index:${result.index}`;
          createFailed.push(formatErr(`create ${dedupKey}`, result.error));
        }
      }
      await appendGitlabReviewDedupIds(newlyCreatedIds, gitlabDedupFile);

      const hasExplicitDateRange = dateFrom != null || dateTo != null;
      if (!hasExplicitDateRange) {
        const syncedAt = new Date().toISOString();
        for (const link of links) {
          const watermarkKey = buildGitlabReviewWatermarkKey(
            link.gitlabBaseUrl,
            link.projectPath,
            mrState
          );
          if (collected.failedWatermarkKeys.has(watermarkKey)) continue;
          const linkScope = collected.linkScopes.get(watermarkKey);
          if (linkScope?.advanceWatermark !== true) continue;
          await saveGitlabReviewWatermark(
            link.gitlabBaseUrl,
            link.projectPath,
            mrState,
            syncedAt,
            gitlabDedupFile
          );
        }
      }
    }

    const text = formatResult({
      projectKey,
      mrState,
      mrIid,
      scopeLabel: collected.scopeLabel,
      dryRun,
      projectStage,
      resolved,
      created,
      skippedMrs,
      skippedDuplicate,
      needsUserMapping,
      failed: createFailed,
    });

    return { content: [{ type: "text", text }] };
  } catch (err: unknown) {
    if (isMcpError(err)) {
      if (err.code === "CONFIG_ERROR") {
        return errorContent(`[CONFIG_ERROR] ${err.message}`);
      }
      return errorContent(`[${err.code}] ${err.message}`);
    }
    if (err instanceof Error) return errorContent(err.message);
    throw err;
  }
}

async function collectReviewComments(input: {
  links: GitlabProjectLink[];
  token: string;
  mrState: GitlabMrState;
  mrIid?: number;
  dateFrom?: string;
  dateTo?: string;
  fullSync: boolean;
  jira: Pick<JiraHttpClient, "searchIssues">;
  jiraBaseUrl: string;
  projectKey: string;
  gitlabDedupFile: string;
}): Promise<{
  candidates: GitlabReviewCommentCandidate[];
  failed: string[];
  skippedMrs: SkippedMrCandidate[];
  failedWatermarkKeys: Set<string>;
  linkScopes: Map<string, LinkListScope>;
  scopeLabel: string;
}> {
  const candidates: GitlabReviewCommentCandidate[] = [];
  const failed: string[] = [];
  const skippedMrs: SkippedMrCandidate[] = [];
  const failedWatermarkKeys = new Set<string>();
  const linkScopes = new Map<string, LinkListScope>();
  const scopeLabels: string[] = [];

  for (const link of input.links) {
    const watermarkKey = buildGitlabReviewWatermarkKey(
      link.gitlabBaseUrl,
      link.projectPath,
      input.mrState
    );
    const gitlab = new GitlabHttpClient(link.gitlabBaseUrl, input.token);
    let linkFailed = false;

    try {
      const storedWatermark =
        input.mrIid == null && input.dateFrom == null && input.dateTo == null && !input.fullSync
          ? await getGitlabReviewWatermark(
              link.gitlabBaseUrl,
              link.projectPath,
              input.mrState,
              input.gitlabDedupFile
            )
          : undefined;

      const linkScope = resolveLinkListScope({
        mrIid: input.mrIid,
        mrState: input.mrState,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        fullSync: input.fullSync,
        storedWatermark,
      });
      linkScopes.set(watermarkKey, linkScope);
      scopeLabels.push(`${link.name}: ${linkScope.scopeLabel}`);

      const mrs = await resolveMergeRequests(
        gitlab,
        link.projectPath,
        input.mrState,
        input.mrIid,
        linkScope
      );
      const dateFilteredMrs =
        linkScope.dateWindow != null
          ? mrs.filter((mr) => mrMatchesDateWindow(mr, input.mrState, linkScope.dateWindow!))
          : mrs;
      const validMrs = dateFilteredMrs.filter(
        (mr): mr is GitlabRawMergeRequest & { iid: number } => typeof mr.iid === "number"
      );
      if (validMrs.length === 0) continue;

      const mrRefs: MrRef[] = validMrs.map((mr) => ({
        projectPath: link.projectPath,
        mrIid: mr.iid,
      }));
      const mrDupMap = await batchCheckMrsInJira(input.jira, input.projectKey, mrRefs);

      const mrsToFetch = validMrs.filter((mr) => {
        const dup = mrDupMap.get(mrKey(link.projectPath, mr.iid));
        if (dup?.exists) {
          skippedMrs.push({
            mrIid: mr.iid,
            projectPath: link.projectPath,
            noteCount: 0,
            skippedBeforeFetch: true,
            sampleKey: dup.sampleKey,
            sampleUrl: dup.sampleUrl,
          });
          return false;
        }
        return true;
      });

      const fetchResults = await mapWithConcurrency(
        mrsToFetch,
        GITLAB_DISCUSSION_CONCURRENCY,
        async (mr) => {
          const discussions = await gitlab.listMergeRequestDiscussions(link.projectPath, mr.iid);
          return extractTopLevelReviewComments({
            name: link.name,
            gitlabBaseUrl: link.gitlabBaseUrl,
            jiraBaseUrl: input.jiraBaseUrl,
            projectPath: link.projectPath,
            mr,
            discussions,
          });
        }
      );

      for (const result of fetchResults) {
        if (result.ok) {
          candidates.push(...result.value);
          continue;
        }
        linkFailed = true;
        failed.push(
          formatErr(`MR !${result.item.iid} (${link.projectPath})`, result.error)
        );
      }
    } catch (err: unknown) {
      linkFailed = true;
      // For single-MR mode, 404 on one link is normal when multiple repos are configured.
      if (input.mrIid != null && isNotFound(err)) {
        continue;
      }
      failed.push(formatErr(`project ${link.projectPath}`, err));
    }

    if (linkFailed) {
      failedWatermarkKeys.add(watermarkKey);
    }
  }

  if (input.mrIid != null && candidates.length === 0 && failed.length === 0 && skippedMrs.length === 0) {
    failed.push(
      `MR !${input.mrIid} not found in any configured GitLab project for this Jira projectKey`
    );
  }

  const scopeLabel =
    input.mrIid != null
      ? `single MR !${input.mrIid}`
      : scopeLabels.length === 1
        ? scopeLabels[0]!.replace(/^[^:]+:\s*/, "")
        : scopeLabels.join("; ");

  return {
    candidates,
    failed,
    skippedMrs,
    failedWatermarkKeys,
    linkScopes,
    scopeLabel,
  };
}

async function resolveMergeRequests(
  gitlab: GitlabHttpClient,
  projectPath: string,
  mrState: GitlabMrState,
  mrIid: number | undefined,
  linkScope: LinkListScope
): Promise<GitlabRawMergeRequest[]> {
  if (mrIid != null) {
    const mr = await gitlab.getMergeRequest(projectPath, mrIid);
    return [mr];
  }
  return gitlab.listMergeRequests(projectPath, mrState, linkScope.listOptions);
}

function isNotFound(err: unknown): boolean {
  if (!isMcpError(err)) return false;
  const details = err.details as { status?: number } | undefined;
  return details?.status === 404;
}

export function resolveQuery(
  gitlabUsername: string,
  userOverrides: Record<string, string>
): string {
  const override = userOverrides[gitlabUsername]?.trim();
  if (override) return override;
  return `${gitlabUsername}@${GITLAB_JIRA_EMAIL_DOMAIN}`;
}

export async function resolveJiraUser(
  jira: Pick<JiraHttpClient, "findUsers">,
  query: string,
  cache: Map<string, JiraUserSearchResult | null>
): Promise<JiraUserSearchResult | null> {
  const key = query.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;

  const users = await withHttpRetry(() => jira.findUsers(query, 20));
  const exact =
    users.find(
      (u) =>
        (u.emailAddress != null && u.emailAddress.toLowerCase() === key) ||
        (u.name != null && u.name.toLowerCase() === key)
    ) ?? null;

  cache.set(key, exact);
  return exact;
}

function mrKey(projectPath: string, mrIid: number): string {
  return `${projectPath}|${mrIid}`;
}

async function batchCheckMrsInJira(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  mrs: MrRef[]
): Promise<Map<string, { exists: boolean; sampleKey?: string; sampleUrl?: string }>> {
  const result = new Map<string, { exists: boolean; sampleKey?: string; sampleUrl?: string }>();
  if (mrs.length === 0) return result;

  for (const chunk of chunkArray(mrs, MR_BATCH_SIZE)) {
    const chunkResult = await batchCheckMrsChunk(jira, projectKey, chunk);
    for (const [key, value] of chunkResult) {
      result.set(key, value);
    }
  }

  return result;
}

async function batchCheckMrsChunk(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  chunk: MrRef[]
): Promise<Map<string, { exists: boolean; sampleKey?: string; sampleUrl?: string }>> {
  const result = new Map<string, { exists: boolean; sampleKey?: string; sampleUrl?: string }>();
  for (const mr of chunk) {
    result.set(mrKey(mr.projectPath, mr.mrIid), { exists: false });
  }

  const fragments = chunk.map((mr) => ({
    mr,
    key: mrKey(mr.projectPath, mr.mrIid),
    fragment: buildGitlabMrPathFragment(mr.projectPath, mr.mrIid),
  }));

  const orClause = fragments
    .map((entry) => `text ~ "${escapeJqlString(entry.fragment)}"`)
    .join(" OR ");
  const jql = `project = ${projectKey} AND issuetype = ${ISSUE_TYPE.REVIEW_DEFECT} AND (${orClause})`;

  try {
    const searchResult = await searchIssuesWithRetry(jira, jql, chunk.length, DEDUP_SEARCH_FIELDS);
    if (searchResult.total < 1) return result;

    for (const issue of searchResult.issues) {
      const haystack = issueSearchHaystack(issue);
      for (const entry of fragments) {
        if (!haystack.includes(entry.fragment)) continue;
        const existing = result.get(entry.key);
        if (existing != null && !existing.exists) {
          result.set(entry.key, {
            exists: true,
            sampleKey: issue.key,
            sampleUrl: issue.url,
          });
        }
      }
    }

    const unresolved = fragments.filter((entry) => !result.get(entry.key)?.exists);
    if (unresolved.length > 0) {
      for (const entry of unresolved) {
        result.set(
          entry.key,
          await isMrAlreadyInJiraSingle(jira, projectKey, entry.mr.projectPath, entry.mr.mrIid)
        );
      }
    }
  } catch {
    for (const mr of chunk) {
      result.set(
        mrKey(mr.projectPath, mr.mrIid),
        await isMrAlreadyInJiraSingle(jira, projectKey, mr.projectPath, mr.mrIid)
      );
    }
  }

  return result;
}

async function isMrAlreadyInJiraSingle(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  projectPath: string,
  mrIid: number
): Promise<{ exists: boolean; sampleKey?: string; sampleUrl?: string }> {
  const fragment = buildGitlabMrPathFragment(projectPath, mrIid);
  const jql = `project = ${projectKey} AND issuetype = ${ISSUE_TYPE.REVIEW_DEFECT} AND text ~ "${escapeJqlString(fragment)}"`;
  try {
    const result = await searchIssuesWithRetry(jira, jql, 1);
    if (result.total < 1) return { exists: false };
    const first = result.issues[0];
    if (first == null) return { exists: true };
    return {
      exists: true,
      sampleKey: first.key,
      sampleUrl: first.url,
    };
  } catch {
    return { exists: false };
  }
}

async function batchCheckNotesInJira(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  candidates: GitlabReviewCommentCandidate[]
): Promise<Set<string>> {
  const foundKeys = new Set<string>();
  if (candidates.length === 0) return foundKeys;

  const entries = candidates.map((candidate) => ({
    dedupKey: candidate.dedupKey,
    markers: buildNoteMarkers(candidate),
  }));

  let unresolved = new Set(entries.map((entry) => entry.dedupKey));

  for (const chunk of chunkArray(entries, NOTE_BATCH_SIZE)) {
    await batchCheckNoteMarkerChunk(
      jira,
      projectKey,
      chunk,
      foundKeys,
      unresolved,
      0
    );
  }

  const legacyEntries = entries.filter((entry) => unresolved.has(entry.dedupKey));
  for (const chunk of chunkArray(legacyEntries, NOTE_BATCH_SIZE)) {
    await batchCheckNoteMarkerChunk(
      jira,
      projectKey,
      chunk,
      foundKeys,
      unresolved,
      1
    );
  }

  return foundKeys;
}

async function batchCheckNoteMarkerChunk(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  chunk: Array<{ dedupKey: string; markers: string[] }>,
  foundKeys: Set<string>,
  unresolved: Set<string>,
  markerIndex: number
): Promise<void> {
  const active = chunk.filter(
    (entry) => unresolved.has(entry.dedupKey) && entry.markers[markerIndex] != null
  );
  if (active.length === 0) return;

  const orClause = active
    .map((entry) => `text ~ "${escapeJqlString(entry.markers[markerIndex]!)}"`)
    .join(" OR ");
  const jql = `project = ${projectKey} AND issuetype = ${ISSUE_TYPE.REVIEW_DEFECT} AND (${orClause})`;

  try {
    const searchResult = await searchIssuesWithRetry(
      jira,
      jql,
      active.length,
      DEDUP_SEARCH_FIELDS
    );
    if (searchResult.total < 1) return;

    for (const issue of searchResult.issues) {
      const haystack = issueSearchHaystack(issue);
      for (const entry of active) {
        const marker = entry.markers[markerIndex]!;
        if (!haystack.includes(marker)) continue;
        foundKeys.add(entry.dedupKey);
        unresolved.delete(entry.dedupKey);
      }
    }

    const stillUnresolved = active.filter((entry) => unresolved.has(entry.dedupKey));
    for (const entry of stillUnresolved) {
      if (await isAlreadyInJiraSingle(jira, projectKey, entry, markerIndex)) {
        foundKeys.add(entry.dedupKey);
        unresolved.delete(entry.dedupKey);
      }
    }
  } catch {
    for (const entry of active) {
      if (!unresolved.has(entry.dedupKey)) continue;
      if (await isAlreadyInJiraSingle(jira, projectKey, entry, markerIndex)) {
        foundKeys.add(entry.dedupKey);
        unresolved.delete(entry.dedupKey);
      }
    }
  }
}

function buildNoteMarkers(candidate: GitlabReviewCommentCandidate): string[] {
  const noteUrl = buildGitlabNoteUrl(
    candidate.gitlabBaseUrl,
    candidate.projectPath,
    candidate.mrIid,
    candidate.noteId
  );
  return [
    `${GITLAB_NOTE_ID_MARKER_PREFIX} ${noteUrl}`,
    `${GITLAB_NOTE_ID_MARKER_PREFIX} ${candidate.dedupKey}`,
  ];
}

async function isAlreadyInJiraSingle(
  jira: Pick<JiraHttpClient, "searchIssues">,
  projectKey: string,
  entry: { dedupKey: string; markers: string[] },
  fromMarkerIndex = 0
): Promise<boolean> {
  for (let i = fromMarkerIndex; i < entry.markers.length; i++) {
    const marker = entry.markers[i]!;
    const jql = `project = ${projectKey} AND issuetype = ${ISSUE_TYPE.REVIEW_DEFECT} AND text ~ "${escapeJqlString(marker)}"`;
    try {
      const result = await searchIssuesWithRetry(jira, jql, 1);
      if (result.total > 0) return true;
    } catch {
      // try next marker format
    }
  }
  return false;
}

function issueSearchHaystack(issue: {
  summary: string;
  description?: string | null;
}): string {
  return [issue.summary, issue.description ?? ""].join("\n");
}

async function searchIssuesWithRetry(
  jira: Pick<JiraHttpClient, "searchIssues">,
  jql: string,
  limit: number,
  extraFields?: readonly string[]
): Promise<Awaited<ReturnType<JiraHttpClient["searchIssues"]>>> {
  return withHttpRetry(() => jira.searchIssues(jql, limit, 0, extraFields ? [...extraFields] : undefined));
}

function formatResult(input: {
  projectKey: string;
  mrState: GitlabMrState;
  mrIid?: number;
  scopeLabel: string;
  dryRun: boolean;
  projectStage: ReviewDefectProjectStageKey;
  resolved: ResolvedCandidate[];
  created: Array<{ key: string; url: string; dedupKey: string }>;
  skippedMrs: SkippedMrCandidate[];
  skippedDuplicate: GitlabReviewCommentCandidate[];
  needsUserMapping: NeedsUserMapping[];
  failed: string[];
}): string {
  const lines: string[] = [
    `# GitLab → Review Defect sync (${input.projectKey})`,
    "",
    `**Mode:** ${input.dryRun ? "dryRun (preview only)" : "apply (created issues)"}`,
    `**Scope:** ${input.scopeLabel}`,
    `**Project stage:** ${input.projectStage}`,
    "",
  ];

  if (input.dryRun) {
    lines.push(`## Candidates (${input.resolved.length})`, "");
    if (input.resolved.length === 0) {
      lines.push("_None ready to create._", "");
    } else {
      for (const item of input.resolved) {
        lines.push(
          formatCandidateBullet(input.projectKey, item, input.dryRun, input.projectStage)
        );
      }
      lines.push("");
    }
  } else {
    lines.push(`## Created (${input.created.length})`, "");
    if (input.created.length === 0) {
      lines.push("_No issues created._", "");
    } else {
      for (const c of input.created) {
        lines.push(`- **${c.key}** — ${c.url}`);
      }
      lines.push("");
    }
  }

  lines.push(`## Skipped MRs (already in Jira) (${input.skippedMrs.length})`, "");
  if (input.skippedMrs.length === 0) {
    lines.push("_None._", "");
  } else {
    for (const skipped of input.skippedMrs) {
      const issueRef =
        skipped.sampleKey != null
          ? skipped.sampleUrl != null
            ? ` | existing: **${skipped.sampleKey}** (${skipped.sampleUrl})`
            : ` | existing: **${skipped.sampleKey}**`
          : "";
      const noteLabel = skipped.skippedBeforeFetch
        ? "skipped before fetch"
        : `${skipped.noteCount} note(s) skipped`;
      lines.push(
        `- MR !${skipped.mrIid} (\`${skipped.projectPath}\`) — ${noteLabel}${issueRef}`
      );
    }
    lines.push("");
  }

  lines.push(`## Skipped duplicates (${input.skippedDuplicate.length})`, "");
  if (input.skippedDuplicate.length === 0) {
    lines.push("_None._", "");
  } else {
    for (const c of input.skippedDuplicate) {
      lines.push(`- \`${c.dedupKey}\` — MR !${c.mrIid}`);
    }
    lines.push("");
  }

  lines.push(`## Needs user mapping (${input.needsUserMapping.length})`, "");
  if (input.needsUserMapping.length === 0) {
    lines.push("_None._", "");
  } else {
    lines.push(
      "Ask the user for Jira username/email overrides, then re-call with `userOverrides`.",
      ""
    );
    for (const item of input.needsUserMapping) {
      const c = item.candidate;
      lines.push(
        `- MR !${c.mrIid} note ${c.noteId}: missing **${item.missingRoles.join(", ")}**`,
        `  - assignee tried: \`${item.attempted.assigneeQuery}\` (GitLab \`${c.mrAuthorUsername}\`)`,
        `  - reporter tried: \`${item.attempted.reporterQuery}\` (GitLab \`${c.commentAuthorUsername}\`)`,
        `  - preview: ${c.body.replace(/\s+/g, " ").slice(0, 120)}`,
        `  - MR: ${c.mrUrl}`
      );
    }
    lines.push("");
  }

  lines.push(`## Failed (${input.failed.length})`, "");
  if (input.failed.length === 0) {
    lines.push("_None._");
  } else {
    for (const f of input.failed) {
      lines.push(`- ${f}`);
    }
  }

  const hints: string[] = [];
  if (input.needsUserMapping.length > 0) {
    hints.push(
      `\`jira_sync_gitlab_review_defects({projectKey: "${input.projectKey}", dryRun: true, userOverrides: {"gitlabUser": "jira.user"}})\` after collecting overrides`
    );
  }
  if (input.dryRun && input.resolved.length > 0) {
    const scopeArgs =
      input.mrIid != null
        ? `, mrIid: ${input.mrIid}`
        : `, mrState: "${input.mrState}"`;
    hints.push(
      `\`jira_sync_gitlab_review_defects({projectKey: "${input.projectKey}", dryRun: false${scopeArgs}})\` after user confirms`
    );
  }
  if (hints.length === 0) {
    hints.push(
      `\`jira_search_issues({jql: "project = ${input.projectKey} AND issuetype = 10805 ORDER BY created DESC", limit: 10})\` to list Review Defects`
    );
  }

  return lines.join("\n") + navigationHint(...hints);
}

function formatCandidateBullet(
  projectKey: string,
  item: ResolvedCandidate,
  includePayload: boolean,
  projectStage: ReviewDefectProjectStageKey
): string {
  const c = item.candidate;
  const preview = c.body.replace(/\s+/g, " ").slice(0, 100);
  const lines = [
    `- **MR !${c.mrIid}** note ${c.noteId}: ${preview}`,
    `  - assignee: ${item.assigneeName} | reporter: ${item.reporterName} | duedate: ${c.dueDate} | projectStage: ${projectStage}`,
    `  - ${c.mrUrl}`,
    `  - note: ${buildGitlabNoteUrl(c.gitlabBaseUrl, c.projectPath, c.mrIid, c.noteId)}`,
    `  - dedup: \`${c.dedupKey}\``,
  ];
  if (c.jiraIssueKeys.length > 0) {
    lines.push(`  - Jira references: ${c.jiraIssueKeys.join(", ")}`);
  }
  if (includePayload) {
    const fields = buildReviewDefectFields(projectKey, item, projectStage);
    const payload = buildCreateIssuePayload(ISSUE_TYPE.REVIEW_DEFECT, fields);
    lines.push("  - create payload:", "```json", JSON.stringify(payload, null, 2), "```");
  }
  return lines.join("\n");
}

function formatErr(label: string, err: unknown): string {
  if (isMcpError(err)) {
    let msg = `${label}: [${err.code}] ${err.message}`;
    if (
      err.code === "JIRA_HTTP_ERROR" &&
      err.details != null &&
      typeof err.details === "object" &&
      "body" in err.details &&
      typeof (err.details as { body?: unknown }).body === "string"
    ) {
      msg += `\n  - response: ${(err.details as { body: string }).body}`;
    }
    return msg;
  }
  if (err instanceof Error) return `${label}: ${err.message}`;
  return `${label}: ${String(err)}`;
}

function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

function authErrorContent(code: string, message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `[${code}] ${message}` }],
  };
}
