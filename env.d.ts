declare namespace NodeJS {
  interface ProcessEnv {
    ENABLE_KEEPALIVE: string; // "true" or "false"
    SERVER_HOSTNAME: string; // e.g., "irc.hvalec.com"
  }
}
