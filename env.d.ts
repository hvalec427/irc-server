declare namespace NodeJS {
  interface ProcessEnv {
    ENABLE_KEEPALIVE: string; // "true" or "false"
    SERVER_HOSTNAME: string; // e.g., "irc.hvalec.com"
    SERVER_VERSION: string; // e.g., "0.0.1"
  }
}
