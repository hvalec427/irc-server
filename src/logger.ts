import fs from "fs";
import path from "path";
import pino from "pino";

const logsDir = path.join(process.cwd(), "logs");
fs.mkdirSync(logsDir, { recursive: true });

export const ircLogger = pino(
    { base: null },
    pino.destination({ dest: path.join(logsDir, "irc.log"), append: true })
);

export const httpLogger = pino(
    { base: null },
    pino.destination({ dest: path.join(logsDir, "http.log"), append: true })
);
