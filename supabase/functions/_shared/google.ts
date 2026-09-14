/** Thin wrappers over the Google APIs this integration touches. Read-only. */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** Thrown when the grant is gone for good — revoked, expired, or consent pulled. */
export class GrantRevokedError extends Error {}

/** Thrown when a syncToken is no longer usable and a full resync is required. */
export class SyncTokenExpiredError extends Error {}

function clientCredentials() {
  const id = Deno.env.get("GOOGLE_CLIENT_ID");
  const secret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  if (!id || !secret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set");
  }
  return { id, secret };
}

export async function exchangeCode(code: string, redirectUri: string) {
  const { id, secret } = clientCredentials();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const body = await res.text();
  if (!res.ok) throw new GoogleApiError("Code exchange failed", res.status, body);

  const json = JSON.parse(body) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
    expires_in: number;
  };

  // Without offline access and a forced consent Google omits this, and the
  // integration would work until the first access token expires and then stop.
  if (!json.refresh_token) {
    throw new Error(
      "Google returned no refresh token. Re-consent with access_type=offline and prompt=consent.",
    );
  }
  return json;
}

/**
 * Access tokens are deliberately not cached. They live an hour, a refresh is one
 * request, and syncs are infrequent — caching would add a second credential at
 * rest to save almost nothing.
 */
export async function accessTokenFrom(refreshToken: string): Promise<string> {
  const { id, secret } = clientCredentials();

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
      grant_type: "refresh_token",
    }),
  });

  const body = await res.text();
  if (!res.ok) {
    // invalid_grant means the user revoked access, changed password, or the
    // token aged out in Testing mode. Retrying will never help.
    if (body.includes("invalid_grant")) {
      throw new GrantRevokedError("Google refresh token is no longer valid");
    }
    throw new GoogleApiError("Token refresh failed", res.status, body);
  }

  return (JSON.parse(body) as { access_token: string }).access_token;
}

async function calendarFetch(accessToken: string, path: string, init?: RequestInit) {
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 410) throw new SyncTokenExpiredError("syncToken expired");

  if (!res.ok) {
    throw new GoogleApiError(
      `Calendar API ${path} failed`,
      res.status,
      await res.text(),
    );
  }
  return res.json();
}

export async function listCalendars(accessToken: string) {
  const json = (await calendarFetch(accessToken, "/users/me/calendarList")) as {
    items?: { id: string; summary?: string; primary?: boolean; selected?: boolean }[];
  };
  return json.items ?? [];
}

export type EventsPage = {
  items?: unknown[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export async function listEvents(
  accessToken: string,
  calendarId: string,
  opts: { syncToken?: string | null; pageToken?: string | null },
): Promise<EventsPage> {
  const params = new URLSearchParams({
    singleEvents: "true", // expand recurrences into instances
    maxResults: "250",
  });

  // timeMin/timeMax are rejected alongside syncToken, so the whole calendar is
  // synced and the planning window is applied when rendering.
  if (opts.syncToken) params.set("syncToken", opts.syncToken);
  if (opts.pageToken) params.set("pageToken", opts.pageToken);

  return (await calendarFetch(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
  )) as EventsPage;
}

export async function watchCalendar(
  accessToken: string,
  calendarId: string,
  channel: { id: string; address: string; token: string },
) {
  return (await calendarFetch(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: "POST",
      body: JSON.stringify({
        id: channel.id,
        type: "web_hook",
        address: channel.address,
        token: channel.token,
      }),
    },
  )) as { id: string; resourceId: string; expiration?: string };
}

export async function stopChannel(
  accessToken: string,
  channelId: string,
  resourceId: string,
) {
  const res = await fetch(`${CALENDAR_API}/channels/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: channelId, resourceId }),
  });
  // A channel that is already gone is not an error worth propagating.
  if (!res.ok && res.status !== 404) {
    throw new GoogleApiError("channels.stop failed", res.status, await res.text());
  }
}
