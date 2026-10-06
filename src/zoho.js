/**
 * Zoho Sprints API client: OAuth token refresh + authenticated requests.
 *
 * Auth model: a Self Client in the Zoho API Console issues a long-lived
 * refresh token. We exchange it for a ~1h access token and cache that in
 * memory, refreshing shortly before expiry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Access tokens are cached on disk as well as in memory. Zoho rate-limits the
 * refresh endpoint ("You have made too many requests continuously"), and every
 * server restart would otherwise burn one refresh — which adds up fast when a
 * client restarts the process per session.
 */
// Resolved lazily: entry points load .env after this module is imported.
function cacheFile() {
  return process.env.ZOHO_TOKEN_CACHE
    ? path.resolve(process.env.ZOHO_TOKEN_CACHE)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.token-cache.json');
}

function readCache(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    if (raw?.key !== key) return null; // credentials changed; ignore stale entry
    if (!raw.token || !(raw.expiresAt > Date.now() + 60_000)) return null;
    return { token: raw.token, expiresAt: raw.expiresAt };
  } catch {
    return null;
  }
}

function writeCache(key, entry) {
  try {
    const file = cacheFile();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ key, ...entry }), { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic, so a concurrent reader never sees a partial file
  } catch {
    // A read-only or full disk just means we refresh more often.
  }
}

/** Identifies which credentials a cached token belongs to, without storing them. */
function cacheKey(cfg) {
  return (cfg.tld ?? '') + ':' + String(cfg.refreshToken ?? '').slice(-12);
}

/** Data-center TLD -> host pair. Zoho keeps accounts and API on the same DC. */
function hosts(tld) {
  return {
    accounts: `https://accounts.zoho.${tld}`,
    api: `https://sprintsapi.zoho.${tld}`,
  };
}

export class ZohoSprintsError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message);
    this.name = 'ZohoSprintsError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export class ZohoSprintsClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.tld           Data center TLD, e.g. "in", "com", "eu".
   * @param {string} [cfg.clientId]
   * @param {string} [cfg.clientSecret]
   * @param {string} [cfg.refreshToken]
   * @param {string} [cfg.accessToken] Short-lived token; bypasses refresh. Testing only.
   * @param {string} [cfg.teamId]      Default workspace (team) ID.
   * @param {string} [cfg.projectId]   Default project ID.
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.host = hosts(cfg.tld);
    /** @type {{token: string, expiresAt: number} | null} */
    this._token = null;
    this._inFlight = null;

    if (cfg.accessToken) {
      // Treat a supplied access token as valid for its nominal hour. If it is
      // already stale the first call 401s and we surface that plainly.
      this._token = { token: cfg.accessToken, expiresAt: Date.now() + 55 * 60_000 };
    }
  }

  /** True when we can mint fresh tokens rather than relying on a static one. */
  get canRefresh() {
    const { clientId, clientSecret, refreshToken } = this.cfg;
    return Boolean(clientId && clientSecret && refreshToken);
  }

  async accessToken() {
    if (this._token && this._token.expiresAt > Date.now() + 60_000) {
      return this._token.token;
    }
    // A token cached by a previous process is still good; reusing it avoids
    // spending a refresh (and Zoho rate-limits those).
    if (this.canRefresh) {
      const cached = readCache(cacheKey(this.cfg));
      if (cached) {
        this._token = cached;
        return cached.token;
      }
    }
    if (!this.canRefresh) {
      if (this._token) return this._token.token; // static token, possibly expired
      throw new ZohoSprintsError(
        'No credentials. Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN ' +
          '(or ZOHO_ACCESS_TOKEN for a one-off test).',
      );
    }
    // Collapse concurrent refreshes into one request.
    if (!this._inFlight) {
      this._inFlight = this._refresh().finally(() => {
        this._inFlight = null;
      });
    }
    return this._inFlight;
  }

  async _refresh() {
    const url = `${this.host.accounts}/oauth/v2/token`;
    const body = new URLSearchParams({
      refresh_token: this.cfg.refreshToken,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: 'refresh_token',
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ZohoSprintsError(`Token endpoint returned non-JSON (HTTP ${res.status})`, {
        status: res.status,
        body: text.slice(0, 500),
        url,
      });
    }

    // Zoho returns HTTP 200 with an "error" field on failure.
    if (!res.ok || json.error || !json.access_token) {
      throw new ZohoSprintsError(
        `Token refresh failed: ${json.error ?? `HTTP ${res.status}`}. ` +
          tokenHint(json.error, this.cfg.tld),
        { status: res.status, body: json, url },
      );
    }

    this._token = {
      token: json.access_token,
      expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    };
    writeCache(cacheKey(this.cfg), this._token);
    return this._token.token;
  }

  /**
   * Authenticated call against the Sprints API.
   * @param {object} opts
   * @param {'GET'|'POST'|'PUT'|'DELETE'} [opts.method]
   * @param {string} opts.path            Path after /zsapi, e.g. "teams/".
   * @param {Record<string,string|number|undefined>} [opts.query]
   * @param {Record<string,string|number|undefined>} [opts.form]  Form-encoded body.
   * @param {boolean} [opts.retryOn401]
   */
  async request({ method = 'GET', path, query, form, retryOn401 = true }) {
    const token = await this.accessToken();
    const url = new URL(`${this.host.api}/zsapi/${String(path).replace(/^\/+/, '')}`);
    // The token must only ever reach Zoho's API host. zoho_request takes a
    // model-supplied path, so refuse anything that resolves elsewhere.
    if (url.origin !== this.host.api || !url.pathname.startsWith('/zsapi/')) {
      throw new ZohoSprintsError('Refusing request outside ' + this.host.api + '/zsapi/');
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    /** @type {RequestInit} */
    const init = {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        Accept: 'application/json',
      },
    };
    if (form) {
      const body = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (v !== undefined && v !== null && v !== '') body.set(k, String(v));
      }
      init.body = body;
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    const res = await fetch(url, init);

    // An expired cached token shows up as 401; drop it and retry once.
    if (res.status === 401 && retryOn401 && this.canRefresh) {
      this._token = null;
      return this.request({ method, path, query, form, retryOn401: false });
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 2000) };
    }

    if (!res.ok) {
      throw new ZohoSprintsError(
        `Zoho Sprints API ${method} ${url.pathname} failed (HTTP ${res.status})`,
        { status: res.status, body: data, url: url.toString() },
      );
    }
    return data;
  }
}

function tokenHint(error, tld) {
  switch (error) {
    case 'Access Denied':
      return 'Usually Zoho rate-limiting the refresh endpoint after repeated calls. ' +
        'Wait a few minutes; the cached access token covers normal use in the meantime.';
    case 'invalid_client':
      return 'Client ID/secret do not match, or they were created in a different data center ' +
        `than accounts.zoho.${tld}.`;
    case 'invalid_code':
      return 'The grant token expired (they last ~10 minutes) or was already used once. Generate a new one.';
    case 'invalid_grant':
      return 'The refresh token is revoked or belongs to a different client. Generate a new one.';
    default:
      return `Check that the Self Client was created at api-console.zoho.${tld}.`;
  }
}

/** Reads configuration from the environment. */
export function clientFromEnv(env = process.env) {
  return new ZohoSprintsClient({
    tld: env.ZOHO_TLD || 'com',
    clientId: env.ZOHO_CLIENT_ID,
    clientSecret: env.ZOHO_CLIENT_SECRET,
    refreshToken: env.ZOHO_REFRESH_TOKEN,
    accessToken: env.ZOHO_ACCESS_TOKEN,
    teamId: env.ZOHO_TEAM_ID,
    projectId: env.ZOHO_PROJECT_ID,
  });
}

/**
 * Decodes Zoho Sprints' columnar responses.
 *
 * Zoho returns records as `{ <thingJObj>: { id: [v0, v1, ...] }, <thing_prop>:
 * { fieldName: index } }` rather than as arrays of objects. This rebuilds
 * ordinary objects, with the record's map key exposed as `id`.
 *
 * @param {object} data      Parsed response body.
 * @param {string} jObjKey   e.g. "projectJObj"
 * @param {string} propKey   e.g. "project_prop"
 * @returns {Array<object>|null} null when the expected keys are absent.
 */
export function decodeColumnar(data, jObjKey, propKey) {
  const rows = data?.[jObjKey];
  const props = data?.[propKey];
  if (!rows || !props || typeof rows !== 'object' || typeof props !== 'object') return null;

  const entries = Object.entries(props); // [fieldName, index]
  return Object.entries(rows).map(([id, values]) => {
    const out = { id };
    for (const [field, index] of entries) out[field] = values?.[index];
    return out;
  });
}
