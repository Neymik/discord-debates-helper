import type { BotConfig } from "./config.js";

export interface CreatedSession {
  id: string;
  fileDir: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Thin typed wrapper over the Plan 2 HTTP API, always sending the bot Bearer token. */
export class ApiClient {
  constructor(private readonly cfg: Pick<BotConfig, "apiBaseUrl" | "botApiToken">) {}

  private async post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.cfg.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.botApiToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  /** POST /api/link/redeem → 200 { telegram_user_id, display_name } | 404. */
  async redeemLink(input: {
    code: string;
    discord_user_id: string;
    discord_username: string;
  }): Promise<{ telegram_user_id: number; display_name: string } | null> {
    const res = await this.post("/api/link/redeem", input);
    if (res.status === 404) return null;
    if (!res.ok) throw new ApiError(`redeem failed: ${res.status}`, res.status);
    return (await res.json()) as { telegram_user_id: number; display_name: string };
  }

  /** POST /api/recordings/sessions → 201 session | 409 active_session_exists. */
  async createSession(input: {
    started_by_discord_user_id: string;
    voice_channel_id: string;
    voice_channel_name: string;
    guild_id: string;
  }): Promise<{ ok: true; session: CreatedSession } | { ok: false; conflict: true }> {
    const res = await this.post("/api/recordings/sessions", input);
    if (res.status === 409) return { ok: false, conflict: true };
    if (res.status !== 201) throw new ApiError(`createSession failed: ${res.status}`, res.status);
    const session = (await res.json()) as CreatedSession;
    return { ok: true, session };
  }

  /** POST /api/recordings/sessions/:id/files */
  async registerFile(
    sessionId: string,
    input: {
      discord_user_id: string;
      discord_username: string;
      file_path: string;
      duration_sec: number;
      size_bytes: number;
    },
  ): Promise<void> {
    const res = await this.post(`/api/recordings/sessions/${sessionId}/files`, input);
    if (!res.ok) throw new ApiError(`registerFile failed: ${res.status}`, res.status);
  }

  /** POST /api/recordings/sessions/:id/complete */
  async completeSession(sessionId: string): Promise<void> {
    const res = await this.post(`/api/recordings/sessions/${sessionId}/complete`, {});
    if (!res.ok) throw new ApiError(`completeSession failed: ${res.status}`, res.status);
  }
}
