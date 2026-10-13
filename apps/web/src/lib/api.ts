import type { Message } from "@parley/shared";

export type User = { id: string; username: string };
export type Workspace = { id: string; name: string; role: "owner" | "member" };
export type Member = User & { role: "owner" | "member" };
export type ChannelSummary = {
  id: string;
  workspaceId: string;
  kind: "public" | "private" | "dm";
  name: string | null;
  lastSeq: number;
  joined: boolean;
  lastReadSeq: number;
  unread: number;
  dmUserId: string | null;
};
export type Page = { messages: Message[]; hasMore: boolean };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A typed client for the HTTP API. */
export class Api {
  constructor(
    private readonly base: string,
    private readonly token?: string,
  ) {}

  withToken(token: string): Api {
    return new Api(this.base, token);
  }

  private async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const res = await fetch(this.base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
    return data as T;
  }

  signup = (username: string, password: string) =>
    this.request<{ user: User; token: string }>("/auth/signup", { username, password });
  login = (username: string, password: string) =>
    this.request<{ user: User; token: string }>("/auth/login", { username, password });
  logout = () => this.request<void>("/auth/logout", undefined, "POST");
  me = () => this.request<{ user: User }>("/me");

  workspaces = () => this.request<{ workspaces: Workspace[] }>("/workspaces");
  createWorkspace = (name: string) => this.request<{ workspace: Workspace }>("/workspaces", { name });
  invite = (workspaceId: string, username: string) =>
    this.request<{ added: boolean }>(`/workspaces/${workspaceId}/members`, { username });
  members = (workspaceId: string) =>
    this.request<{ members: Member[] }>(`/workspaces/${workspaceId}/members`);

  channels = (workspaceId: string) =>
    this.request<{ channels: ChannelSummary[] }>(`/workspaces/${workspaceId}/channels`);
  createChannel = (workspaceId: string, name: string, kind: "public" | "private") =>
    this.request<{ channel: ChannelSummary }>(`/workspaces/${workspaceId}/channels`, { name, kind });
  openDm = (workspaceId: string, username: string) =>
    this.request<{ channel: ChannelSummary }>(`/workspaces/${workspaceId}/dms`, { username });
  join = (channelId: string) => this.request<{ joined: boolean }>(`/channels/${channelId}/join`, {});
  addToChannel = (channelId: string, username: string) =>
    this.request<{ added: boolean }>(`/channels/${channelId}/members`, { username });

  history = (channelId: string, before?: number, limit = 50) =>
    this.request<Page>(`/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ""}`);
  reads = (channelId: string) =>
    this.request<{ reads: { userId: string; lastReadSeq: number }[] }>(`/channels/${channelId}/reads`);
}
