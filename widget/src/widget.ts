/**
 * Instant Site Chat embeddable widget.
 *
 * Everything lives inside a shadow root: this gets pasted into pages with
 * hostile global CSS (`* { box-sizing: content-box }`, body font-size
 * overrides, z-index wars), and none of that may reach in, nor may these
 * styles leak out.
 */

interface Source { n: number; url: string; title: string; headingPath: string }

(function bootstrap(): void {
  const script = (document.currentScript as HTMLScriptElement | null)
    ?? document.querySelector<HTMLScriptElement>('script[data-session]');

  const sessionId = script?.dataset['session'] ?? '';
  if (!sessionId) {
    console.error('[kleio] widget needs a data-session attribute');
    return;
  }

  // The API is wherever this script came from.
  const apiOrigin = (() => {
    try { return new URL(script?.src ?? '').origin; }
    catch { return window.location.origin; }
  })();

  const CONTACT = 'https://kleiosoftware.com/book-a-call';

  const host = document.createElement('div');
  host.setAttribute('data-kleio-sitechat', '');
  // The host element itself is positioned; everything else is inside the shadow root.
  host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483000;';
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    :host {
      all: initial;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      --bg: #ffffff;
      --fg: #14181f;
      --muted: #5c6873;
      --rule: #d5dce2;
      --accent: #1b44d8;
      --card: #f4f6f8;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #161c24; --fg: #e6ecf2; --muted: #9aa7b3;
        --rule: #2c3742; --accent: #8aa4ff; --card: #1e262f;
      }
    }
    .wrap { position: fixed; bottom: 16px; right: 16px; display: flex; flex-direction: column;
            align-items: flex-end; gap: 10px; }
    button { font: inherit; cursor: pointer; }

    .launcher {
      width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--rule);
      background: var(--bg); color: var(--fg); display: grid; place-items: center;
      box-shadow: 0 4px 14px rgba(0,0,0,.14);
    }
    .launcher:hover { border-color: var(--accent); color: var(--accent); }

    .panel {
      width: min(370px, calc(100vw - 32px));
      height: min(520px, calc(100vh - 110px));
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--rule); border-radius: 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.18);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .panel[hidden] { display: none; }

    header { padding: 10px 12px; border-bottom: 1px solid var(--rule);
             display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .title { font-size: 13px; font-weight: 600; }
    .sub { font-size: 11px; color: var(--muted); }
    .x { background: none; border: 0; color: var(--muted); font-size: 20px; line-height: 1; padding: 2px 6px; }
    .x:hover { color: var(--fg); }

    .log { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; }
    .msg-user { align-self: flex-end; background: var(--accent); color: #fff;
                padding: 7px 11px; border-radius: 12px 12px 2px 12px; max-width: 85%; }
    .msg-bot { max-width: 92%; white-space: pre-wrap; }
    .err { color: #b23c26; font-size: 13px; }
    .empty { color: var(--muted); font-size: 13px; }

    .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .chip { font-size: 11px; border: 1px solid var(--rule); border-radius: 4px;
            padding: 2px 6px; color: var(--muted); text-decoration: none; }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    sup { color: var(--accent); font-size: 10px; }

    form { border-top: 1px solid var(--rule); padding: 9px; display: flex; gap: 7px; }
    input { flex: 1; font: inherit; padding: 8px 10px; border: 1px solid var(--rule);
            border-radius: 6px; background: var(--card); color: var(--fg); min-width: 0; }
    input:disabled { opacity: .6; }
    .send { border: 1px solid var(--rule); border-radius: 6px; background: var(--card);
            color: var(--fg); padding: 8px 12px; }
    .send:disabled { opacity: .4; cursor: default; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .notice { padding: 20px 16px; text-align: center; color: var(--muted); font-size: 13px; }
    .notice a { color: var(--accent); }

    @keyframes pop { from { opacity: 0; transform: translateY(6px); } }
    .panel:not([hidden]) { animation: pop .14s ease-out; }
    @media (prefers-reduced-motion: reduce) { .panel:not([hidden]) { animation: none; } }
  `;
  root.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="panel" hidden role="dialog" aria-modal="false" aria-label="Chat about this site">
      <header>
        <div>
          <div class="title">Ask about this site</div>
          <div class="sub"></div>
        </div>
        <button class="x" aria-label="Close chat">&times;</button>
      </header>
      <div class="log" role="log" aria-live="polite">
        <div class="empty">Ask a question about this site.</div>
      </div>
      <form>
        <input type="text" placeholder="Ask something" aria-label="Ask about this site" maxlength="1000" />
        <button class="send" type="submit">Ask</button>
      </form>
    </div>
    <button class="launcher" aria-label="Open chat" aria-expanded="false">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>
      </svg>
    </button>
  `;
  root.appendChild(wrap);

  const panel = root.querySelector('.panel') as HTMLDivElement;
  const launcher = root.querySelector('.launcher') as HTMLButtonElement;
  const closeBtn = root.querySelector('.x') as HTMLButtonElement;
  const log = root.querySelector('.log') as HTMLDivElement;
  const form = root.querySelector('form') as HTMLFormElement;
  const input = root.querySelector('input') as HTMLInputElement;
  const send = root.querySelector('.send') as HTMLButtonElement;
  const sub = root.querySelector('.sub') as HTMLDivElement;

  let expired = false;
  let busy = false;

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const scroll = (): void => { log.scrollTop = log.scrollHeight; };

  function showNotice(html: string): void {
    log.innerHTML = '';
    const n = el('div', 'notice');
    n.innerHTML = html;
    log.appendChild(n);
    input.disabled = true;
    send.disabled = true;
  }

  // Session state decides whether this is a working widget or an expiry notice.
  void (async () => {
    try {
      const res = await fetch(`${apiOrigin}/api/sessions/${sessionId}`);
      if (res.status === 410 || res.status === 404) {
        expired = true;
        showNotice(`This demo session has expired.<br><a href="${CONTACT}" target="_blank" rel="noopener">Talk to Kleio</a> about a permanent one.`);
        return;
      }
      const body = await res.json() as { domain?: string; pageCount?: number };
      if (body.domain) sub.textContent = `${body.pageCount ?? 0} pages from ${body.domain}`;
    } catch {
      // Leave the widget usable; a send will surface the real problem.
    }
  })();

  function renderAnswer(container: HTMLElement, text: string): void {
    container.textContent = '';
    for (const part of text.split(/(\[\d{1,2}\])/g)) {
      const m = /^\[(\d{1,2})\]$/.exec(part);
      if (m) container.appendChild(el('sup', undefined, m[1] as string));
      else container.appendChild(document.createTextNode(part));
    }
  }

  async function ask(question: string): Promise<void> {
    if (!question.trim() || busy || expired) return;
    busy = true;
    input.value = '';
    input.disabled = true;
    send.disabled = true;

    const emptyState = log.querySelector('.empty');
    if (emptyState) emptyState.remove();

    log.appendChild(el('div', 'msg-user', question));
    const bot = el('div', 'msg-bot');
    log.appendChild(bot);
    scroll();

    let answer = '';
    try {
      const res = await fetch(`${apiOrigin}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        bot.className = 'err';
        bot.textContent = body.message ?? 'That did not go through. Try again in a moment.';
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { bot.className = 'err'; bot.textContent = 'No response from the server.'; return; }

      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (frame: string): void => {
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length === 0) return;
        let payload: unknown;
        try { payload = JSON.parse(data.join('\n')); } catch { return; }

        if (event === 'token') {
          answer += (payload as { text: string }).text;
          renderAnswer(bot, answer);
          scroll();
        } else if (event === 'sources') {
          const sources = (payload as { sources: Source[] }).sources;
          if (sources.length === 0) return;
          const chips = el('div', 'chips');
          for (const s of sources) {
            const a = el('a', 'chip') as HTMLAnchorElement;
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = s.title;
            try { a.textContent = new URL(s.url).pathname || '/'; }
            catch { a.textContent = s.url; }
            chips.appendChild(a);
          }
          bot.appendChild(chips);
          scroll();
        } else if (event === 'error') {
          const e = el('div', 'err', (payload as { message: string }).message);
          bot.appendChild(e);
          scroll();
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          handle(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
      if (buffer.trim()) handle(buffer);
    } catch {
      bot.className = 'err';
      bot.textContent = 'The connection dropped. Try again.';
    } finally {
      busy = false;
      input.disabled = expired;
      send.disabled = expired;
      input.focus();
    }
  }

  // --- open / close, focus management ---

  function open(): void {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
    document.addEventListener('keydown', onKeydown, true);
  }

  function close(): void {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown, true);
    // Always the launcher. Reading document.activeElement does not work here:
    // while focus is inside the shadow root the document reports the host
    // element, which is not focusable, so restoring it would drop focus to the
    // top of the host page.
    launcher.focus();
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (panel.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;

    // Trap focus inside the open panel.
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = root.activeElement as HTMLElement | null;

    if (e.shiftKey && (active === first || active === null)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); void ask(input.value); });
})();
