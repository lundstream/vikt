/**
 * Types for `@marsaud/smb2`, which ships none (D130).
 *
 * Only the surface `backup-smb.ts` uses is declared. The rest of the library
 * exists and is deliberately not typed here: a declaration file that describes
 * more than the code calls is a second API to keep in step with the first, and
 * this one is hand-written from the module's own source.
 */
declare module "@marsaud/smb2" {
  import type { Writable } from "node:stream";

  type Callback<T> = (error: Error | null, value: T) => void;

  export default class SMB2 {
    constructor(options: {
      /** `\\host\share`. The constructor throws if it does not match that. */
      share: string;
      domain?: string;
      username?: string;
      password?: string;
      /** Milliseconds. The library's own default is 5000. */
      autoCloseTimeout?: number;
      packetConcurrency?: number;
    });

    createWriteStream(path: string, callback: Callback<Writable>): void;
    unlink(path: string, callback: (error: Error | null) => void): void;
    readdir(path: string, callback: Callback<string[]>): void;
    mkdir(path: string, callback: (error: Error | null) => void): void;
    exists(path: string, callback: Callback<boolean>): void;
    stat(path: string, callback: Callback<{ birthtime: Date; mtime: Date; size: number }>): void;
    disconnect(): void;
  }
}
