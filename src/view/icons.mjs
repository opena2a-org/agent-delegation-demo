// Lucide icons (ISC licence), inlined as SVG: circle check, triangle alert,
// circle minus and info. Every icon is aria-hidden; the words beside it carry
// the meaning.

const svg = (width, paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

export const ICON = Object.freeze({
  ok: svg('2.25', '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  warn: svg('2.25', '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  neutral: svg('2.25', '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>'),
  info: svg('2', '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
});
