/** One line per event. Never a body, a token, a proof or a username: the log is not a secret store. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
