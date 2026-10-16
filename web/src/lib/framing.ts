// Second line of defence against clickjacking, behind the server's CSP
// `frame-ancestors` (server/src/framing.js). If something strips that header,
// or a browser ignores it, the app still refuses to render its interface inside
// a page it doesn't trust, and offers to open itself in its own tab instead.
//
// Who is trusted: the app's own origin, the Hub page that embeds a Space, and
// whatever extra origins the server allows (`frameAncestors` in /api/info).
// Every ancestor must be trusted, not just the parent: a trusted page framing
// an untrusted one framing the app is still an untrusted embed.

export const HUB_ORIGIN = 'https://huggingface.co';

type FrameWindow = Pick<Window, 'self' | 'top' | 'parent' | 'location' | 'origin'>;

export type FrameEnv = {
  win: FrameWindow;
  /** document.referrer: who loaded this frame, used only when nothing better exists. */
  referrer: string;
};

const originOf = (url: string): string | null => {
  try { const o = new URL(url).origin; return o === 'null' ? null : o; } catch { return null; }
};

export const isFramed = (win: FrameWindow): boolean => {
  try { return win.top !== win.self; } catch { return true; }
};

// The ancestors' origins, nearest first. null = at least one couldn't be identified.
export function ancestorOrigins({ win, referrer }: FrameEnv): string[] | null {
  if (!isFramed(win)) return [];
  // Chromium and WebKit list every ancestor's origin ("null" for opaque ones).
  const listed = (win.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (listed && typeof listed.length === 'number') return Array.from({ length: listed.length }, (_, i) => listed.item(i) || 'null');
  // Elsewhere (older Firefox): same-origin ancestors can be read directly.
  try { return readableAncestors(win, referrer); } catch { return null; }
}

function readableAncestors(win: FrameWindow, referrer: string): string[] | null {
  const out: string[] = [];
  let w: FrameWindow = win;
  for (let depth = 0; depth < 32 && w !== w.top; depth++) {
    const parent = w.parent as FrameWindow;
    try {
      const origin = parent.location.origin;
      if (typeof origin !== 'string') throw new Error('unreadable');
      out.push(origin);
    } catch {
      // A cross-origin ancestor can't be read. One case is identifiable anyway,
      // the Hub's own embed: our direct parent is the top, and it loaded us.
      // Only a page sharing an origin with one of a frame's ancestors may
      // navigate it, so with a single ancestor the referrer names that parent,
      // ourselves, or nobody. Ourselves or nobody, and anything deeper, stay
      // unidentified.
      if (w !== win || parent !== win.top) return null;
      const from = originOf(referrer);
      if (!from || from === win.location.origin) return null;
      out.push(from);
      return out;
    }
    w = parent;
  }
  return w === w.top ? out : null;
}

// Origins trusted to frame the app before /api/info answers: itself, plus the
// Hub when it is served as a Space.
export function defaultTrusted(win: FrameWindow): string[] {
  const trusted = [win.location.origin];
  if (/\.hf\.space$/i.test(win.location.hostname)) trusted.push(HUB_ORIGIN);
  return trusted;
}

export type FrameVerdict = 'top' | 'trusted' | 'untrusted';

export function frameVerdict(env: FrameEnv, trusted: readonly string[]): FrameVerdict {
  if (!isFramed(env.win)) return 'top';
  // A sandboxed frame without allow-same-origin runs at an opaque origin. That
  // is never how the app is embedded on purpose (the Hub's Space page allows
  // same-origin), but it is how Hub-hosted user content frames other Spaces.
  if (env.win.origin === 'null') return 'untrusted';
  const ancestors = ancestorOrigins(env);
  if (!ancestors) return 'untrusted';
  const allowed = new Set(trusted);
  return ancestors.every((origin) => allowed.has(origin)) ? 'trusted' : 'untrusted';
}

// The same page as a top-level tab, minus any one-time Hub sign-in token.
export function standaloneUrl(href: string): string {
  try {
    const url = new URL(href);
    url.searchParams.delete('__sign');
    return url.toString();
  } catch { return href; }
}
