// Globals set by the classic scripts index.html loads before app.js:
// /socket.io/socket.io.js (io), /i18n.js (window.i18n) and /media-session.js
// (window.MediaSessionManager). Those two stay classic scripts. The types are
// deliberately loose until modules that use them are converted; tighten them
// then (io could come from socket.io-client's types: not verified yet).

declare global {
  // Socket.IO client factory from /socket.io/socket.io.js.
  function io(options?: Record<string, unknown>): any;

  interface I18n {
    init(): Promise<void>;
    t(key: string, params?: Record<string, unknown>): string;
    setLanguage(lang: string): Promise<void>;
    getLanguage(): string;
    getSupportedLanguages(): string[];
    updatePageTranslations(): void;
  }

  interface MediaSessionManagerApi {
    init(handlers: Record<string, (...args: any[]) => void>): void;
    updateTrack(track: { title?: string; artist?: string; thumbnail?: string; songId?: string | number }): void;
    updatePlaybackState(state: 'playing' | 'paused' | 'none'): void;
    updatePositionState(state: { duration?: number; position?: number; playbackRate?: number }): void;
    destroy(): void;
    isSupported(): boolean;
  }

  interface Window {
    i18n: I18n;
    MediaSessionManager: MediaSessionManagerApi;
  }

  var MediaSessionManager: MediaSessionManagerApi;
}

export {};
