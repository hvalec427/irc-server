# IRC Server

A tiny IRC server written in TypeScript. Listens on port 6667 and supports basic IRC commands plus simple nickname auth and channel management.

## Getting Started

- Requirements: Node.js 18+
- Install deps: `yarn` (or `npm install`)
- Run in dev: `yarn dev` (or `npm run dev`)
- Connect: Use any IRC client to `localhost:6667`

## Environment (optional)

Create a `.env` file to override defaults:

```
ENABLE_KEEPALIVE=true
SERVER_HOSTNAME=irc.example.com
SERVER_VERSION=0.0.1
```

## Notes

- State persists to `state.json` in the project root.
- Try `HELP`, `AUTH REGISTER <password>`, `AUTH LOGIN <password>`, `/join #general`.
- Default host shown to clients is `SERVER_HOSTNAME`

## License

MIT

