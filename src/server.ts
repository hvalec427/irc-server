import "dotenv/config";

import net from "net";
import bcrypt from "bcryptjs";
import { loadState, saveState, startPeriodicSaving } from "./state";

const ENABLE_KEEPALIVE = process.env.ENABLE_KEEPALIVE === "true";
const SERVER_HOSTNAME = process.env.SERVER_HOSTNAME || "irc.hvalec.com";
const SERVER_VERSION = process.env.SERVER_VERSION || "0.0.1";

const usedNicks = new Set<string>();
const channels = new Map<string, Set<net.Socket>>();
const clientsByNick = new Map<string, net.Socket>();
const topics = new Map<string, string>();
const inviteOnlyChannels = new Set<string>();
const channelInvites = new Map<string, Set<string>>();
const channelKeys = new Map<string, string>();
const channelLimits = new Map<string, number>();
const topicProtectedChannels = new Set<string>();
const accounts = new Map<string, string>();
const channelOperatorNames = new Map<string, Set<string>>();
const persistableChannels = new Set<string>();

loadState(
    accounts,
    topics,
    inviteOnlyChannels,
    topicProtectedChannels,
    channelKeys,
    channelLimits,
    channelOperatorNames,
    persistableChannels
);

startPeriodicSaving(() =>
    saveState(
        accounts,
        topics,
        inviteOnlyChannels,
        topicProtectedChannels,
        channelKeys,
        channelLimits,
        channelOperatorNames,
        persistableChannels
    )
);

function parseIrcLine(rawLine: string): { raw: string; command: string; params: string[] } | null {
    let line = rawLine.trim();

    if (line.startsWith("@")) {
        const i = line.indexOf(" ");
        if (i === -1) return null;
        line = line.slice(i + 1).trimStart();
    }

    const raw = line;
    const parts = line.split(" ").filter(Boolean);
    const command = parts.shift()?.toUpperCase();

    if (!command) return null;

    const trailingIndex = parts.findIndex((part) => part.startsWith(":"));
    if (trailingIndex !== -1) {
        const trailing = parts.slice(trailingIndex).join(" ").slice(1);
        return {
            raw,
            command,
            params: [...parts.slice(0, trailingIndex), trailing],
        };
    }

    return {
        raw,
        command,
        params: parts,
    };
}

const server = net.createServer((socket) => {
    let nick = "";
    let username = "";
    let realname = "";
    let registered = false;
    let awayMessage = "";

    (socket as any).channels = new Set<string>();
    (socket as any).signonTime = Date.now();
    // Track two separate timestamps:
    // - lastSeen: any inbound data (for keepalive/liveness)
    // - lastActivity: meaningful user actions (for WHOIS idle)
    (socket as any).lastSeen = Date.now();
    (socket as any).lastActivity = Date.now();

    function canUseNick() {
        if (!nick) return false;

        if (!accounts.has(nick)) return true;

        return (socket as any).account === nick;
    }

    function canSendMessage() {
        return canUseNick();
    }

    function userPrefix() {
        return `${nick}!${username}@${SERVER_HOSTNAME}`;
    }

    if (ENABLE_KEEPALIVE) {
        const interval = setInterval(() => {
            // Use lastSeen for liveness so automatic PING/PONG doesn't affect idle time
            if (Date.now() - (socket as any).lastSeen > 60_000) {
                socket.end();
                clearInterval(interval);
                return;
            }

            socket.write(`PING :${SERVER_HOSTNAME}\r\n`);
        }, 30_000);

        socket.on("close", () => {
            clearInterval(interval);
        });
    }

    function send(line: string) {
        if ((socket as any).writableEnded || socket.destroyed || !socket.writable) return;
        socket.write(line + "\r\n");
    }

    function defaultMotdLines(): string[] {
        return [
            `Serbus! Welcome to ${SERVER_HOSTNAME}.`,
            "A tiny IRC server for friendly chat.",
            "",
            "Quick start:",
            "- Pick a nick: /nick <name>",
            "- Register (optional): AUTH REGISTER <password>",
            "- Login: AUTH LOGIN <password>",
            "- Join a channel: /join #general",
            "- Help: HELP",
            "",
            "Rules:",
            "- Don't be a dick.",
            "",
            `Users online right now: ${clientsByNick.size}`,
            "",
            `Version ${SERVER_VERSION} — ${SERVER_HOSTNAME}`,
        ];
    }

    function sendMotd(nick: string) {
        const recipient = nick || "*";
        send(`:${SERVER_HOSTNAME} 375 ${recipient} :${SERVER_HOSTNAME} Message of the Day -`);
        for (const line of defaultMotdLines()) {
            send(`:${SERVER_HOSTNAME} 372 ${recipient} :${line}`);
        }
        send(`:${SERVER_HOSTNAME} 376 ${recipient} :End of /MOTD command`);
    }

    let disconnected = false;
    let quitReason: string | null = null;

    function tryRegister() {
        if (!registered && nick && username && realname) {
            registered = true;
            send(`:${SERVER_HOSTNAME} 001 ${nick} :Welcome to the IRC Network, ${nick}!${username}@${SERVER_HOSTNAME}`);
            send(`:${SERVER_HOSTNAME} 002 ${nick} :Your host is ${SERVER_HOSTNAME}, running version ${SERVER_VERSION}`);
            send(`:${SERVER_HOSTNAME} 003 ${nick} :This server was created just now`);
            send(`:${SERVER_HOSTNAME} 004 ${nick} ${SERVER_HOSTNAME} ${SERVER_VERSION} o o`);
            send(`:${SERVER_HOSTNAME} 005 ${nick} CHANTYPES=# CHANMODES=,k,l,itP PREFIX=(o)@ CASEMAPPING=rfc1459 NICKLEN=30 USERLEN=12 SAFELIST :are supported by this server`);
            send(`:${SERVER_HOSTNAME} 251 ${nick} :There are ${clientsByNick.size} users and 0 invisible on 1 servers`);
            send(`:${SERVER_HOSTNAME} 255 ${nick} :I have ${clientsByNick.size} clients and 1 servers`);
            send(
                `:${SERVER_HOSTNAME} NOTICE ${nick} :Tip: Register your nickname with AUTH REGISTER <password>`
            );
            sendMotd(nick);
        }
    }

    console.info("client connected");

    socket.on("data", async (data) => {
        const now = Date.now();
        // Any inbound data counts as "seen" for liveness
        (socket as any).lastSeen = now;
        const lines = data.toString().split("\r\n");

        for (const rawLine of lines) {
            const parsed = parseIrcLine(rawLine);
            if (!parsed) continue;

            const line = parsed.raw;
            const { command, params } = parsed;

            console.info("received:", line);

            // Only treat actual user messages as activity for idle tracking
            const activityCommands = new Set(["PRIVMSG", "NOTICE"]);
            if (activityCommands.has(command)) {
                (socket as any).lastActivity = now;
            }

            switch (command) {
                case "PING": {
                    if (nick) {
                        send(`PONG ${nick}`);
                    } else {
                        send(`PONG :${SERVER_HOSTNAME}`);
                    }
                    break;
                }

                case "PONG": {
                    // PONG keeps the connection alive but shouldn't reset idle
                    (socket as any).lastSeen = Date.now();
                    break;
                }

                case "HELP": {
                    if (!nick) {
                        send(`:${SERVER_HOSTNAME} 451 * :You must set NICK first`);
                        break;
                    }

                    const topic = (params[0]?.toUpperCase() ?? "").trim();

                    function notice(line: string) {
                        send(`:${SERVER_HOSTNAME} NOTICE ${nick} :${line}`);
                    }

                    if (!topic || topic === "COMMANDS" || topic === "LIST") {
                        notice("Custom commands available:");
                        notice("AUTH      — Register/login your nickname. See: HELP AUTH");
                        notice("SETNAME   — Set your real name. See: HELP SETNAME");
                        notice("MODE      — Channel modes (+i, +k, +l, +t, +o/-o, +P). See: HELP MODE");
                        notice("Note: Registered nicks must AUTH LOGIN before chatting or joining.");
                        break;
                    }

                    switch (topic) {
                        case "AUTH": {
                            notice("AUTH commands:");
                            notice("AUTH REGISTER <password>  — Register current nick");
                            notice("AUTH LOGIN <password>     — Authenticate as current nick");
                            notice("AUTH LOGOUT               — Log out");
                            notice("AUTH STATUS               — Show authentication status");
                            notice("AUTH DELETE               — Delete your registered account");
                            break;
                        }
                        case "SETNAME": {
                            notice("SETNAME <realname> — Set your real name (gecos)");
                            break;
                        }
                        case "MODE": {
                            notice("Channel MODE help:");
                            notice("MODE #chan +i | -i             — Invite-only toggle");
                            notice("MODE #chan +k <key> | -k       — Channel key (password)");
                            notice("MODE #chan +l <n> | -l         — User limit");
                            notice("MODE #chan +t | -t             — Only ops may set topic");
                            notice("MODE #chan +o <nick> | -o <nick> — Grant/revoke operator");
                            notice("MODE #chan +P | -P             — Persist channel (custom)");
                            break;
                        }
                        default: {
                            notice(`No help for topic: ${topic}`);
                            notice("Try: HELP AUTH | HELP SETNAME | HELP MODE | HELP");
                            break;
                        }
                    }

                    break;
                }

                case "MOTD": {
                    sendMotd(nick);
                    break;
                }

                case "TIME": {
                    const when = new Date();
                    const recipient = nick || '*';
                    // RFC 1459 RPL_TIME (391): "<server> :<string showing server's local time>"
                    send(`:${SERVER_HOSTNAME} 391 ${recipient} ${SERVER_HOSTNAME} :${when.toString()}`);
                    break;
                }

                case "VERSION": {
                    const recipient = nick || '*';
                    // RFC 1459 RPL_VERSION (351): "<version> <server> :<comments>"
                    const comment = `tiny IRC server`;
                    send(`:${SERVER_HOSTNAME} 351 ${recipient} ${SERVER_VERSION} ${SERVER_HOSTNAME} :${comment}`);
                    break;
                }

                case "CAP": {
                    const subcommand = params[0]?.toUpperCase();

                    if (subcommand === "LS") {
                        // We don't advertise any capabilities for now
                        send(`:${SERVER_HOSTNAME} CAP * LS :`);
                    } else if (subcommand === "REQ") {
                        // NAK all requests since we don't support any yet
                        send(`:${SERVER_HOSTNAME} CAP * NAK :${params.slice(1).join(" ")}`);
                    } else if (subcommand === "END") {
                        // No special handling needed
                    }

                    break;
                }

                case "NICK": {
                    const requestedNick = params[0]?.trim();

                    if (!requestedNick) {
                        send(`:${SERVER_HOSTNAME} 431 * :No nickname given`);
                        continue;
                    }
                    if (!/^[A-Za-z\[\]\\`_^{|}][A-Za-z0-9\[\]\\`_^{|}-]{0,29}$/.test(requestedNick) || requestedNick.startsWith("#") || requestedNick.startsWith(":") || requestedNick.includes(" ")) {
                        send(`:${SERVER_HOSTNAME} 432 * ${requestedNick} :Erroneus nickname`);
                        continue;
                    }
                    if (usedNicks.has(requestedNick)) {
                        send(`:${SERVER_HOSTNAME} 433 * ${requestedNick} :Nickname is already in use`);
                        continue;
                    }

                    const oldNick = nick;
                    if (oldNick) {
                        usedNicks.delete(oldNick);
                        clientsByNick.delete(oldNick);
                    }
                    nick = requestedNick;
                    usedNicks.add(nick);
                    clientsByNick.set(nick, socket);
                    (socket as any).nick = nick;

                    // If this is a mid-session nick change, broadcast it and update operator maps
                    if (oldNick) {
                        // Update channel operator name sets to keep permissions with the new nick
                        for (const [ch, names] of channelOperatorNames) {
                            if (names?.has(oldNick)) {
                                names.delete(oldNick);
                                names.add(nick);
                            }
                        }

                        const prefix = `${oldNick}!${username}@${SERVER_HOSTNAME}`;
                        const nickLine = `:${prefix} NICK :${nick}\r\n`;

                        // Send to self
                        if (!(socket as any).writableEnded && !socket.destroyed && socket.writable) {
                            socket.write(nickLine);
                        }
                        const joined = ((socket as any).channels ?? new Set<string>()) as Set<string>;
                        const recipients = new Set<net.Socket>();
                        for (const ch of joined) {
                            const members = channels.get(ch);
                            if (!members) continue;
                            for (const member of members) {
                                if (member === socket) continue;
                                recipients.add(member);
                            }
                        }
                        for (const member of recipients) {
                            if ((member as any).writableEnded || member.destroyed || !member.writable) continue;
                            member.write(nickLine);
                        }
                    }

                    if (accounts.has(nick)) {
                        delete (socket as any).account;

                        send(
                            `:${SERVER_HOSTNAME} NOTICE ${nick} :This nickname is registered. Use AUTH LOGIN <password>`
                        );
                    } else {
                        delete (socket as any).account;

                        send(
                            `:${SERVER_HOSTNAME} NOTICE ${nick} :Nickname ${nick} is not registered. Claim it with AUTH REGISTER <password>`
                        );
                    }

                    tryRegister();
                    break;
                }

                case "USER": {
                    if (registered) {
                        send(`:${SERVER_HOSTNAME} 462 ${nick || '*'} :You may not reregister`);
                        continue;
                    }

                    if (params.length < 4) {
                        send(`:${SERVER_HOSTNAME} 461 ${nick || '*'} USER :Not enough parameters`);
                        continue;
                    }

                    const usernameParam = params[0]?.trim() ?? "";
                    const realnameParam = params.slice(3).join(" ").trim();

                    if (!usernameParam || !realnameParam) {
                        send(`:${SERVER_HOSTNAME} 461 ${nick || '*'} USER :Not enough parameters`);
                        continue;
                    }

                    username = usernameParam;
                    realname = realnameParam;
                    (socket as any).username = username;
                    (socket as any).realname = realname;
                    tryRegister();
                    break;
                }

                case "SETNAME": {
                    const newRealname = params[0]?.trim();

                    if (!newRealname) {
                        send(`:${SERVER_HOSTNAME} 461 ${nick || '*'} SETNAME :Not enough parameters`);
                        break;
                    }

                    realname = newRealname;
                    (socket as any).realname = realname;

                    if (registered) {
                        send(`:${SERVER_HOSTNAME} NOTICE ${nick || '*'} :Your real name is now ${realname}`);
                    } else {
                        // If not yet registered, this may complete registration
                        tryRegister();
                    }

                    break;
                }

                case "AUTH": {
                    const subcommand = params[0]?.toUpperCase();
                    const password = params[1];

                    if (!nick) {
                        send(`:${SERVER_HOSTNAME} 451 * :You must set NICK first`);
                        continue;
                    }

                    switch (subcommand) {
                        case "REGISTER": {
                            if (!password) {
                                send(`:${SERVER_HOSTNAME} 461 ${nick} AUTH :Not enough parameters`);
                                continue;
                            }

                            if (accounts.has(nick)) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Account already exists for ${nick}`);
                                continue;
                            }

                            try {
                                const hash = await bcrypt.hash(password, 12);
                                accounts.set(nick, hash);
                            } catch (error) {
                                console.error("Failed to hash password:", error);
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Internal error hashing password`);
                                continue;
                            }
                            (socket as any).account = nick;

                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Account registered and authenticated as ${nick}`);
                            break;
                        }
                        case "LOGIN": {
                            if (!password) {
                                send(`:${SERVER_HOSTNAME} 461 ${nick} AUTH :Not enough parameters`);
                                continue;
                            }

                            const savedPassword = accounts.get(nick);

                            if (!savedPassword) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :No account registered for ${nick}`);
                                continue;
                            }

                            let authenticated = false;
                            try {
                                authenticated = await bcrypt.compare(password, savedPassword);
                            } catch (error) {
                                // Likely a legacy plaintext password stored; attempt direct compare
                                if (savedPassword === password) {
                                    authenticated = true;
                                    // Migrate to hashed password
                                    try {
                                        const newHash = await bcrypt.hash(password, 12);
                                        accounts.set(nick, newHash);
                                    } catch (e) {
                                        console.error("Failed to migrate plaintext password to hash:", e);
                                    }
                                } else {
                                    authenticated = false;
                                }
                            }

                            if (!authenticated) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Invalid password`);
                                continue;
                            }

                            (socket as any).account = nick;

                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :You are now authenticated as ${nick}`);
                            break;
                        }
                        case "LOGOUT": {
                            if ((socket as any).account !== nick) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :You are not authenticated`);
                                continue;
                            }

                            delete (socket as any).account;
                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :You are now logged out`);
                            break;
                        }
                        case "STATUS": {
                            if ((socket as any).account !== nick) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :You are not authenticated`);
                                continue;
                            }

                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Authenticated as ${nick}`);
                            break;
                        }
                        case "DELETE": {
                            if ((socket as any).account !== nick) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :You are not authenticated`);
                                continue;
                            }

                            if (!accounts.has(nick)) {
                                send(`:${SERVER_HOSTNAME} NOTICE ${nick} :No account registered for ${nick}`);
                                continue;
                            }

                            accounts.delete(nick);
                            delete (socket as any).account;
                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Account deleted for ${nick}`);
                            break;
                        }
                        default: {
                            send(`:${SERVER_HOSTNAME} NOTICE ${nick} :Usage: AUTH REGISTER <password> | AUTH LOGIN <password> | AUTH LOGOUT | AUTH STATUS | AUTH DELETE`);
                            break;
                        }

                    }

                    break;
                }

                case "AWAY": {
                    const message = params[0]?.trim();

                    if (message) {
                        awayMessage = message;
                        (socket as any).awayMessage = awayMessage;

                        send(`:${SERVER_HOSTNAME} 306 ${nick} :You have been marked as being away`);
                    } else {
                        awayMessage = "";
                        (socket as any).awayMessage = "";

                        send(`:${SERVER_HOSTNAME} 305 ${nick} :You are no longer marked as being away`);
                    }
                    break;
                }

                case "ISON": {
                    const requestedNicks = params.slice(1).map((n) => n.trim()).filter(Boolean);

                    const onlineNicks = requestedNicks.filter((n) => clientsByNick.has(n));

                    send(`:${SERVER_HOSTNAME} 303 ${nick} :${onlineNicks.join(" ")}`);
                    break;
                }

                case "JOIN": {
                    if (!canUseNick()) {
                        send(
                            `:${SERVER_HOSTNAME} NOTICE ${nick} :This nickname is registered. Use AUTH LOGIN <password>`
                        );
                        continue;
                    }

                    const channelsParam = params[0]?.trim();
                    if (!channelsParam) {
                        socket.write(`:${SERVER_HOSTNAME} 461 ${nick ?? "*"} JOIN :Not enough parameters\r\n`);
                        continue;
                    }

                    const keysParam = params[1]?.trim();
                    const channelNames = channelsParam
                        .split(",")
                        .map((c) => c.trim())
                        .filter((c) => c.length > 0);
                    const keys = (keysParam ? keysParam.split(",").map((k) => k.trim()) : []);

                    for (let i = 0; i < channelNames.length; i++) {
                        const channel = channelNames[i];
                        const providedKey = keys[i];

                        if (!channel.startsWith("#")) {
                            socket.write(`:${SERVER_HOSTNAME} 403 ${nick ?? "*"} ${channel} :No such channel\r\n`);
                            continue;
                        }
                        // RFC1459 forbids commas in channel names; guard against malformed inputs
                        if (channel.includes(",") || channel.includes(" ")) {
                            socket.write(`:${SERVER_HOSTNAME} 403 ${nick ?? "*"} ${channel} :No such channel\r\n`);
                            continue;
                        }

                        if (!channels.has(channel)) {
                            channels.set(channel, new Set());
                        }

                        if (channels.get(channel)!.has(socket)) {
                            continue;
                        }

                        const limit = channelLimits.get(channel);

                        if (limit && channels.get(channel)!.size >= limit) {
                            send(`:${SERVER_HOSTNAME} 471 ${nick} ${channel} :Cannot join channel (+l)`);
                            continue;
                        }

                        if (inviteOnlyChannels.has(channel)) {
                            const invites = channelInvites.get(channel);

                            if (!invites?.has(nick)) {
                                send(`:${SERVER_HOSTNAME} 473 ${nick} ${channel} :Cannot join channel (+i)`);
                                continue;
                            }
                        }

                        const requiredKey = channelKeys.get(channel);
                        if (requiredKey && providedKey !== requiredKey) {
                            send(`:${SERVER_HOSTNAME} 475 ${nick} ${channel} :Cannot join channel (+k)`);
                            continue;
                        }

                        channelInvites.get(channel)?.delete(nick);

                        channels.get(channel)!.add(socket);
                        (socket as any).channels.add(channel);

                        if ((channelOperatorNames.get(channel)?.size ?? 0) === 0) {
                            if (!channelOperatorNames.has(channel)) {
                                channelOperatorNames.set(channel, new Set<string>());
                            }
                            channelOperatorNames.get(channel)!.add(nick);
                        }
                        for (const member of channels.get(channel)!) {
                            member.write(`:${userPrefix()} JOIN ${channel}\r\n`);
                        }
                        const topic = topics.get(channel);

                        if (topic) {
                            send(`:${SERVER_HOSTNAME} 332 ${nick} ${channel} :${topic}`);
                        } else {
                            send(`:${SERVER_HOSTNAME} 331 ${nick} ${channel} :No topic is set`);
                        }

                        const members = [...channels.get(channel)!]
                            .map((s) => {
                                const memberNick = (s as any).nick;
                                if (!memberNick) return null;
                                const isOp = channelOperatorNames.get(channel)?.has(memberNick);
                                return `${isOp ? "@" : ""}${memberNick}`;
                            })
                            .filter(Boolean)
                            .join(" ");

                        send(`:${SERVER_HOSTNAME} 353 ${nick} = ${channel} :${members}`);
                        send(`:${SERVER_HOSTNAME} 366 ${nick} ${channel} :End of /NAMES list`);
                    }
                    break;
                }

                case "INVITE": {
                    const targetNick = params[0]?.trim();
                    const channel = params[1]?.trim();

                    if (!targetNick || !channel) continue;

                    const members = channels.get(channel);

                    if (!members) {
                        send(`:${SERVER_HOSTNAME} 403 ${nick} ${channel} :No such channel`);
                        continue;
                    }

                    if (!members.has(socket)) {
                        send(`:${SERVER_HOSTNAME} 442 ${nick} ${channel} :You're not on that channel`);
                        continue;
                    }

                    if (!channelOperatorNames.get(channel)?.has(nick)) {
                        send(`:${SERVER_HOSTNAME} 482 ${nick} ${channel} :You're not channel operator`);
                        continue;
                    }

                    const targetSocket = clientsByNick.get(targetNick);

                    if (!targetSocket) {
                        send(`:${SERVER_HOSTNAME} 401 ${nick} ${targetNick} :No such nick`);
                        continue;
                    }

                    if (!channelInvites.has(channel)) {
                        channelInvites.set(channel, new Set());
                    }

                    channelInvites.get(channel)!.add(targetNick);

                    targetSocket.write(
                        `:${userPrefix()} INVITE ${targetNick} :${channel}\r\n`
                    );

                    send(`:${SERVER_HOSTNAME} 341 ${nick} ${targetNick} ${channel}`);
                    break;
                }

                case "MODE": {
                    const target = params[0]?.trim();
                    const mode = params[1]?.trim();

                    if (!target) continue;

                    if (target.startsWith("#")) {
                        if (!channels.has(target)) {
                            send(`:${SERVER_HOSTNAME} 403 ${nick} ${target} :No such channel`);
                            continue;
                        }


                        if (!channelOperatorNames.get(target)?.has(nick)) {
                            send(`:${SERVER_HOSTNAME} 482 ${nick} ${target} :You're not channel operator`);
                            continue;
                        }

                        if (mode === "+i") {
                            inviteOnlyChannels.add(target);
                            send(`:${userPrefix()} MODE ${target} +i`);
                            continue;
                        }

                        if (mode === "-i") {
                            inviteOnlyChannels.delete(target);
                            send(`:${userPrefix()} MODE ${target} -i`);
                            continue;
                        }

                        if (mode === "+o") {
                            const targetNick = params[2]?.trim();

                            if (!targetNick) continue;

                            if (!channelOperatorNames.get(target)?.has(nick)) {
                                send(`:${SERVER_HOSTNAME} 482 ${nick} ${target} :You're not channel operator`);
                                continue;
                            }

                            const targetSocket = clientsByNick.get(targetNick);

                            if (!targetSocket || !channels.get(target)?.has(targetSocket)) {
                                send(`:${SERVER_HOSTNAME} 441 ${nick} ${targetNick} ${target} :They aren't on that channel`);
                                continue;
                            }

                            if (!channelOperatorNames.has(target)) {
                                channelOperatorNames.set(target, new Set<string>());
                            }
                            channelOperatorNames.get(target)!.add(targetNick);

                            for (const member of channels.get(target)!) {
                                member.write(
                                    `:${userPrefix()} MODE ${target} +o ${targetNick}\r\n`
                                );
                            }

                            continue;
                        }

                        if (mode === "-o") {
                            const targetNick = params[2]?.trim();

                            if (!targetNick) continue;


                            if (!channelOperatorNames.get(target)?.has(nick)) {
                                send(`:${SERVER_HOSTNAME} 482 ${nick} ${target} :You're not channel operator`);
                                continue;
                            }

                            const targetSocket = clientsByNick.get(targetNick);

                            if (!targetSocket || !channels.get(target)?.has(targetSocket)) {
                                send(`:${SERVER_HOSTNAME} 441 ${nick} ${targetNick} ${target} :They aren't on that channel`);
                                continue;
                            }

                            channelOperatorNames.get(target)?.delete(targetNick);

                            const names = channelOperatorNames.get(target) ?? new Set<string>();
                            if (names.size === 0) {
                                names.add(targetNick);
                                channelOperatorNames.set(target, names);
                                send(`:${SERVER_HOSTNAME} 482 ${nick} ${target} :Cannot remove last operator`);
                                continue;
                            }

                            for (const member of channels.get(target)!) {
                                member.write(
                                    `:${userPrefix()} MODE ${target} -o ${targetNick}\r\n`
                                );
                            }

                            continue;
                        }

                        if (mode === "+k") {
                            const key = params[2]?.trim();
                            if (!key) continue;

                            channelKeys.set(target, key);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} +k ${key}\r\n`);
                            }

                            continue;
                        }

                        if (mode === "-k") {
                            channelKeys.delete(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} -k\r\n`);
                            }

                            continue;
                        }

                        if (mode === "+l") {
                            const limit = Number(params[2]);

                            if (!Number.isInteger(limit) || limit <= 0) {
                                continue;
                            }

                            channelLimits.set(target, limit);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} +l ${limit}\r\n`);
                            }

                            continue;
                        }

                        if (mode === "-l") {
                            channelLimits.delete(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} -l\r\n`);
                            }

                            continue;
                        }

                        if (mode === "+t") {
                            topicProtectedChannels.add(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} +t\r\n`);
                            }

                            continue;
                        }

                        if (mode === "-t") {
                            topicProtectedChannels.delete(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} -t\r\n`);
                            }

                            continue;
                        }

                        if (mode === "+P") {
                            persistableChannels.add(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} +P\r\n`);
                            }

                            continue;
                        }

                        if (mode === "-P") {
                            persistableChannels.delete(target);

                            for (const member of channels.get(target)!) {
                                member.write(`:${userPrefix()} MODE ${target} -P\r\n`);
                            }

                            continue;
                        }

                        let modes = "";

                        if (inviteOnlyChannels.has(target)) modes += "i";
                        if (channelKeys.has(target)) modes += "k";
                        if (channelLimits.has(target)) modes += "l";
                        if (topicProtectedChannels.has(target)) modes += "t";
                        if (persistableChannels.has(target)) modes += "P";

                        send(`:${SERVER_HOSTNAME} 324 ${nick} ${target} +${modes}`);
                    }
                    break;
                }

                case "PART": {
                    const channel = params[0]?.trim();

                    if (!channel) continue;

                    const members = channels.get(channel);

                    if (!members) {
                        send(`:${SERVER_HOSTNAME} 403 ${nick} ${channel} :No such channel`);
                        continue;
                    }

                    if (!members.has(socket)) {
                        send(`:${SERVER_HOSTNAME} 442 ${nick} ${channel} :You're not on that channel`);
                        continue;
                    }

                    for (const member of members) {
                        member.write(`:${userPrefix()} PART ${channel}\r\n`);
                    }

                    members.delete(socket);
                    (socket as any).channels.delete(channel);

                    const names = channelOperatorNames.get(channel);
                    if (names?.has(nick)) {
                        names.delete(nick);
                    }
                    if ((channelOperatorNames.get(channel)?.size ?? 0) === 0 && members.size > 0) {
                        const next = members.values().next();
                        if (!next.done) {
                            const nextNick = (next.value as any).nick;
                            if (nextNick) {
                                if (!channelOperatorNames.has(channel)) {
                                    channelOperatorNames.set(channel, new Set<string>());
                                }
                                channelOperatorNames.get(channel)!.add(nextNick);
                            }
                        }
                    }

                    if (members.size === 0 && !persistableChannels.has(channel)) {
                        channels.delete(channel);
                    }
                    break;
                }

                case "LIST": {
                    send(`:${SERVER_HOSTNAME} 321 ${nick} Channel :Users Name`);

                    const allChannels = new Set<string>([
                        ...channels.keys(),
                        ...persistableChannels,
                    ]);

                    for (const channel of allChannels) {
                        const members = channels.get(channel) ?? new Set<net.Socket>();
                        const topic = topics.get(channel) ?? "No topic";
                        send(`:${SERVER_HOSTNAME} 322 ${nick} ${channel} ${members.size} :${topic}`);
                    }

                    send(`:${SERVER_HOSTNAME} 323 ${nick} :End of /LIST`);
                    break;
                }

                case "WHO": {
                    const target = params[0]?.trim();

                    if (!target) {
                        send(`:${SERVER_HOSTNAME} 315 ${nick} * :End of WHO list`);
                        break;
                    }

                    if (target.startsWith("#")) {
                        const members = channels.get(target);

                        if (!members) {
                            send(`:${SERVER_HOSTNAME} 403 ${nick} ${target} :No such channel`);
                            break;
                        }

                        for (const member of members) {
                            const memberNick = (member as any).nick;
                            const memberUsername = (member as any).username ?? "unknown";
                            const memberRealname = (member as any).realname ?? "unknown";
                            const isAway = Boolean((member as any).awayMessage);
                            const hereOrGone = isAway ? "G" : "H";

                            send(
                                `:${SERVER_HOSTNAME} 352 ${nick} ${target} ${memberUsername} ${SERVER_HOSTNAME} ${SERVER_HOSTNAME} ${memberNick} ${hereOrGone} :0 ${memberRealname}`
                            );
                        }

                        send(`:${SERVER_HOSTNAME} 315 ${nick} ${target} :End of WHO list`);
                        break;
                    }

                    {
                        const client = clientsByNick.get(target);
                        if (client) {
                            const cNick = (client as any).nick ?? target;
                            const cUser = (client as any).username ?? "unknown";
                            const cReal = (client as any).realname ?? "unknown";
                            const isAway = Boolean((client as any).awayMessage);
                            const hereOrGone = isAway ? "G" : "H";

                            send(
                                `:${SERVER_HOSTNAME} 352 ${nick} ${target} ${cUser} ${SERVER_HOSTNAME} ${SERVER_HOSTNAME} ${cNick} ${hereOrGone} :0 ${cReal}`
                            );
                        }

                        send(`:${SERVER_HOSTNAME} 315 ${nick} ${target} :End of WHO list`);
                        break;
                    }
                }

                case "TOPIC": {
                    const channel = params[0]?.trim();
                    const newTopic = params[1]?.trim();

                    if (!channel) continue;

                    const members = channels.get(channel);

                    if (!members) {
                        send(`:${SERVER_HOSTNAME} 403 ${nick} ${channel} :No such channel`);
                        continue;
                    }

                    if (!members.has(socket)) {
                        send(`:${SERVER_HOSTNAME} 442 ${nick} ${channel} :You're not on that channel`);
                        continue;
                    }

                    if (newTopic) {
                        if (topicProtectedChannels.has(channel) && !channelOperatorNames.get(channel)?.has(nick)) {
                            send(`:${SERVER_HOSTNAME} 482 ${nick} ${channel} :You're not channel operator`);
                            continue;
                        }

                        topics.set(channel, newTopic);

                        for (const member of members) {
                            member.write(`:${userPrefix()} TOPIC ${channel} :${newTopic}\r\n`);
                        }

                        continue;
                    }

                    const topic = topics.get(channel);

                    if (topic) {
                        send(`:${SERVER_HOSTNAME} 332 ${nick} ${channel} :${topic}`);
                    } else {
                        send(`:${SERVER_HOSTNAME} 331 ${nick} ${channel} :No topic is set`);
                    }
                    break;
                }

                case "KICK": {
                    const channel = params[0]?.trim();
                    const targetNick = params[1]?.trim();
                    const reason = params[2]?.trim() ?? "Kicked";

                    if (!channel || !targetNick) continue;

                    const members = channels.get(channel);

                    if (!members || !members.has(socket)) {
                        send(`:${SERVER_HOSTNAME} 442 ${nick} ${channel} :You're not on that channel`);
                        continue;
                    }

                    if (!channelOperatorNames.get(channel)?.has(nick)) {
                        send(`:${SERVER_HOSTNAME} 482 ${nick} ${channel} :You're not channel operator`);
                        continue;
                    }

                    const targetSocket = clientsByNick.get(targetNick);

                    if (!targetSocket || !members.has(targetSocket)) {
                        send(`:${SERVER_HOSTNAME} 441 ${nick} ${targetNick} ${channel} :They aren't on that channel`);
                        continue;
                    }

                    for (const member of members) {
                        member.write(`:${userPrefix()} KICK ${channel} ${targetNick} :${reason}\r\n`);
                    }

                    members.delete(targetSocket);
                    (targetSocket as any).channels?.delete(channel);

                    const names = channelOperatorNames.get(channel);
                    if (names?.has(targetNick)) {
                        names.delete(targetNick);
                    }
                    if ((channelOperatorNames.get(channel)?.size ?? 0) === 0 && members.size > 0) {
                        const next = members.values().next();
                        if (!next.done) {
                            const nextNick = (next.value as any).nick;
                            if (nextNick) {
                                if (!channelOperatorNames.has(channel)) {
                                    channelOperatorNames.set(channel, new Set<string>());
                                }
                                channelOperatorNames.get(channel)!.add(nextNick);
                            }
                        }
                    }
                    break;
                }

                case "NAMES": {
                    const channel = params[0]?.trim();

                    if (!channel || !channels.has(channel)) {
                        send(`:${SERVER_HOSTNAME} 366 ${nick} ${channel ?? "*"} :End of /NAMES list`);
                        continue;
                    }

                    const members = [...channels.get(channel)!]
                        .map((s) => {
                            const memberNick = (s as any).nick;
                            const isOp = channelOperatorNames.get(channel)?.has(memberNick);
                            return (isOp ? "@" : "") + memberNick;
                        })
                        .filter(Boolean)
                        .join(" ");

                    send(`:${SERVER_HOSTNAME} 353 ${nick} = ${channel} :${members}`);
                    send(`:${SERVER_HOSTNAME} 366 ${nick} ${channel} :End of /NAMES list`);
                    break;
                }

                case "PRIVMSG": {
                    if (!canSendMessage()) {
                        send(
                            `:${SERVER_HOSTNAME} NOTICE ${nick} :This nickname is registered. Use AUTH LOGIN <password>`
                        );
                        continue;
                    }

                    const [target, message] = params;

                    if (!registered) {
                        send(`:${SERVER_HOSTNAME} 451 * :You have not registered`);
                        continue;
                    }
                    if (!target) {
                        send(`:${SERVER_HOSTNAME} 411 ${nick} :No recipient given (PRIVMSG)`);
                        continue;
                    }
                    if (!message) {
                        send(`:${SERVER_HOSTNAME} 412 ${nick} :No text to send`);
                        continue;
                    }
                    if (target.startsWith("#")) {
                        const members = channels.get(target);
                        if (!members) {
                            send(`:${SERVER_HOSTNAME} 403 ${nick} ${target} :No such channel`);
                            continue;
                        }
                        if (!members.has(socket)) {
                            send(`:${SERVER_HOSTNAME} 404 ${nick} ${target} :Cannot send to channel`);
                            continue;
                        }
                        for (const member of members) {
                            if (member === socket) continue;
                            member.write(
                                `:${userPrefix()} PRIVMSG ${target} :${message}\r\n`
                            );
                        }
                    } else {
                        const recipient = clientsByNick.get(target);

                        if (!recipient) {
                            send(`:${SERVER_HOSTNAME} 401 ${nick} ${target} :No such nick`);
                            continue;
                        }
                        const awayMessage = (recipient as any).awayMessage ?? "";
                        if (awayMessage) {
                            send(`:${SERVER_HOSTNAME} 301 ${nick} ${target} :${awayMessage}`);
                        }

                        recipient.write(
                            `:${userPrefix()} PRIVMSG ${target} :${message}\r\n`
                        );
                    }
                    break;
                }

                case "NOTICE": {
                    if (!canSendMessage()) {
                        send(
                            `:${SERVER_HOSTNAME} NOTICE ${nick} :This nickname is registered. Use AUTH LOGIN <password>`
                        );
                        continue;
                    }

                    const [target, message] = params;
                    if (!target || !message) continue;
                    if (target.startsWith("#")) {
                        const members = channels.get(target);
                        if (!members) continue;
                        for (const member of members) {
                            if (member === socket) continue;
                            member.write(
                                `:${userPrefix()} NOTICE ${target} :${message}\r\n`
                            );
                        }
                    } else {
                        const recipient = clientsByNick.get(target);
                        if (!recipient) continue;
                        recipient.write(
                            `:${userPrefix()} NOTICE ${target} :${message}\r\n`
                        );
                    }
                    break;
                }

                case "WHOIS": {
                    const [target] = params;

                    if (!target) {
                        send(`:${SERVER_HOSTNAME} 431 ${nick} :No nickname given`);
                        continue;
                    }
                    const client = clientsByNick.get(target);

                    if (!client) {
                        send(`:${SERVER_HOSTNAME} 401 ${nick} ${target} :No such nick`);
                        continue;
                    }

                    const username = (client as any).username ?? "unknown";
                    const realname = (client as any).realname ?? "unknown";
                    const joinedChannels = [...(((client as any).channels) ?? new Set<string>())];
                    const awayMessage = (client as any).awayMessage ?? null;
                    const idleSeconds = Math.floor((Date.now() - ((client as any).lastActivity ?? Date.now())) / 1000);
                    const signonTime = Math.floor(((client as any).signonTime ?? Date.now()) / 1000);

                    send(`:${SERVER_HOSTNAME} 311 ${nick} ${target} ${username} ${SERVER_HOSTNAME} * :${realname}`);
                    if ((client as any).account) {
                        send(`:${SERVER_HOSTNAME} 330 ${nick} ${target} ${(client as any).account} :is logged in as`);
                    }

                    send(`:${SERVER_HOSTNAME} 312 ${nick} ${target} ${SERVER_HOSTNAME} :IRC server`);

                    if (joinedChannels.length > 0) {
                        send(`:${SERVER_HOSTNAME} 319 ${nick} ${target} :${joinedChannels.join(" ")}`);
                    }

                    send(`:${SERVER_HOSTNAME} 317 ${nick} ${target} ${idleSeconds} ${signonTime} :seconds idle, signon time`);

                    if (awayMessage) {
                        send(`:${SERVER_HOSTNAME} 301 ${nick} ${target} :${awayMessage}`);
                    }

                    send(`:${SERVER_HOSTNAME} 318 ${nick} ${target} :End of /WHOIS list`);
                    break;
                }

                case "LUSERS": {
                    const userCount = clientsByNick.size;
                    const channelCount = channels.size;

                    send(
                        `:${SERVER_HOSTNAME} 251 ${nick} :There are ${userCount} users and ${channelCount} channels`
                    );
                    break;
                }

                case "QUIT": {
                    quitReason = params[0]?.trim() ?? "Client quit";
                    socket.end();
                    break;
                }
            }

            if (![
                "PING", "PONG", "HELP", "MOTD", "TIME", "VERSION", "CAP", "NICK", "USER", "SETNAME", "AUTH", "AWAY", "ISON", "JOIN", "INVITE", "MODE", "PART", "LIST", "WHO", "TOPIC", "KICK", "NAMES", "PRIVMSG", "NOTICE", "WHOIS", "LUSERS", "QUIT"
            ].includes(command)) {
                send(`:${SERVER_HOSTNAME} 421 ${nick || '*'} ${command} :Unknown command`);
            }
        }
    });

    socket.on("close", () => {
        if (disconnected) return;
        disconnected = true;

        if (nick) {
            usedNicks.delete(nick);
            clientsByNick.delete(nick);
            delete (socket as any).account;
        }

        const reason = quitReason ?? "Client disconnected";

        for (const [channel, members] of channels) {
            if (!members.has(socket)) continue;

            members.delete(socket);
            (socket as any).channels?.delete(channel);

            for (const member of members) {
                if ((member as any).writableEnded || member.destroyed || !member.writable) continue;
                member.write(`:${userPrefix()} QUIT :${reason}\r\n`);
            }


            if (members.size === 0 && !persistableChannels.has(channel)) {
                channels.delete(channel);
            }
        }

        console.info(`${nick || "client"} disconnected`);
    });

    socket.on("error", (error) => {
        console.info(`socket error for ${nick || "unknown"}: ${error.message}`);
    });
});

const PORT = parseInt(process.env.PORT ?? "6667", 10);

server.listen(PORT, () => {
    console.info(`${SERVER_HOSTNAME} running on port ${PORT}`);
});
