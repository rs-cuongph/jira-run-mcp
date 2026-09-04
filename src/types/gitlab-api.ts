// ---------------------------------------------------------------------------
// Raw GitLab REST API response shapes (mirrors API payloads)
// ---------------------------------------------------------------------------

export interface GitlabRawUser {
  id?: number;
  username?: string;
  name?: string;
  state?: string;
}

export interface GitlabRawMergeRequest {
  id?: number;
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  web_url?: string;
  author?: GitlabRawUser;
  updated_at?: string;
  merged_at?: string | null;
}

export interface GitlabRawPosition {
  new_path?: string | null;
  old_path?: string | null;
  new_line?: number | null;
  old_line?: number | null;
}

export interface GitlabRawNote {
  id?: number;
  body?: string;
  system?: boolean;
  created_at?: string;
  author?: GitlabRawUser;
  type?: string | null;
  position?: GitlabRawPosition | null;
}

export interface GitlabRawDiscussion {
  id?: string;
  individual_note?: boolean;
  notes?: GitlabRawNote[];
}
