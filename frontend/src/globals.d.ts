// Globals set by the classic scripts index.html loads before app.js:
// /socket.io/socket.io.js (io), /shared/i18n.js (window.i18n) and
// /shared/media-session.js (window.MediaSessionManager). The last two are
// classic scripts compiled from shared/i18n.ts and shared/media-session.ts.
//
// io is typed from socket.io-client (a root devDependency pinned to the version
// the server's socket.io bundles in /socket.io/socket.io.js), with the event
// maps of shared/types.ts.
import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './shared/types.ts';

declare global {
  /** The app's socket: events typed by shared/types.ts. */
  type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

  // Socket.IO client factory from /socket.io/socket.io.js.
  function io(options?: Partial<ManagerOptions & SocketOptions>): AppSocket;

  interface I18n {
    /** Detects and loads the language; resolves to it. */
    init(): Promise<string>;
    t(key: string, replacements?: Record<string, string | number>): string;
    /** false for an unsupported language. */
    setLanguage(lang: string): Promise<boolean>;
    getLanguage(): string;
    getSupportedLanguages(): string[];
    updatePageTranslations(): void;
  }

  interface MediaSessionHandlers {
    onPlay?: () => void;
    onPause?: () => void;
    onNext?: () => void;
    onPrevious?: () => void;
    onSeekTo?: (seconds: number) => void;
  }

  interface MediaSessionTrack {
    title?: string;
    artist?: string | null;
    thumbnail?: string | null;
    songId?: string | number | null;
  }

  interface MediaSessionManagerApi {
    init(handlers?: MediaSessionHandlers | null): void;
    updateTrack(track: MediaSessionTrack | null | undefined): void;
    updatePlaybackState(state: MediaSessionPlaybackState): void;
    updatePositionState(state: { duration: number; position?: number; playbackRate?: number }): void;
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
