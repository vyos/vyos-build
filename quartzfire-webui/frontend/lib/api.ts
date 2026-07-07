// Central API helpers for talking to the QuartzFire backend (axum).
//
// Auth is an httpOnly cookie set by the backend after it verifies the
// credentials against the users configured on VyOS. The browser calls /api on
// its OWN origin, so the cookie is first-party and sent automatically. JS can't
// read the token; the only client-side session state is a non-sensitive cached
// user (for display). The server is the real enforcement — every /api route,
// including the VyOS proxy, requires a valid session.

export const API = "/api";

const USER_KEY = "quartzfire-user";

export interface AuthUserInfo {
  username: string;
  role: string;
}

export function setUser(user: AuthUserInfo): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getCurrentUser(): AuthUserInfo | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUserInfo) : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(USER_KEY);
}

/// Bounce to the login page (which lives at the site root).
function redirectToLogin(): void {
  if (typeof window !== "undefined" && window.location.pathname !== "/") {
    window.location.href = "/";
  }
}

export async function login(username: string, password: string): Promise<AuthUserInfo> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let message = "Invalid username or password.";
    if (res.status !== 401) {
      try {
        const body = await res.json();
        if (body?.error) message = body.error;
      } catch {}
    }
    throw new Error(message);
  }
  // Session is set via httpOnly cookie; the body is the user (for display).
  const user = (await res.json()) as AuthUserInfo;
  setUser(user);
  return user;
}

/// Confirm the session with the backend (cookie is invisible to JS) and refresh
/// the cached user. Rejects when there is no valid session.
export async function fetchMe(): Promise<AuthUserInfo> {
  const user = await apiFetch<AuthUserInfo>("/auth/me");
  setUser(user);
  return user;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" });
  } catch {}
  clearSession();
}

/// Authenticated JSON fetch against the backend. On a 401 clears the session
/// and bounces to the login page (enforcement is real on the server).
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    clearSession();
    redirectToLogin();
    throw new Error("Session expired. Please sign in again.");
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ── VyOS API proxy ────────────────────────────────────────────────────────────

/// Call a VyOS HTTP API endpoint through the authenticated backend proxy.
/// We send only the `data` form field; the backend injects the `key` field
/// server-side so it never reaches the browser.
export async function vyosApi<T = unknown>(endpoint: string, data: unknown): Promise<T> {
  const body = new URLSearchParams();
  body.set("data", JSON.stringify(data));
  const res = await fetch(`${API}/${endpoint.replace(/^\//, "")}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.status === 401) {
    clearSession();
    redirectToLogin();
    throw new Error("Session expired. Please sign in again.");
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}
