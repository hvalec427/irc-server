import net from "net";

const usedNicks = new Set<string>();
const channels = new Map<string, Set<net.Socket>>();
const clientsByNick = new Map<string, net.Socket>();

const server = net.createServer((socket) => {
    let nick = "";
    let username = "";
    let realname = "";
    let registered = false;

    function send(line: string) {
        socket.write(line + "\r\n");
    }

    function tryRegister() {
        if (!registered && nick && username) {
            registered = true;
            send(`:irc-server 001 ${nick} :Serbus to my irc-server`);
        }
    }

    console.log("client connected");

    socket.on("data", (data) => {
        const lines = data.toString().split("\r\n");

        for (const line of lines) {
            if (!line) continue;

            console.log("received:", line);

            if (line.startsWith("PING")) {
                if (nick) {
                    send(`PONG ${nick}`);
                } else {
                    send("PONG :irc-server");
                }
            }

            if (line.startsWith("NICK ")) {
                const requestedNick = line.split(" ")[1].trim();

                if (usedNicks.has(requestedNick)) {
                    send(`:irc-server 433 * ${requestedNick} :Nickname already in use`);
                    continue;
                }

                if (nick) {
                    usedNicks.delete(nick);
                    clientsByNick.delete(nick);
                }

                nick = requestedNick;

                usedNicks.add(nick);
                clientsByNick.set(nick, socket);

                (socket as any).nick = nick;

                console.log("nickname set to:", nick);

                tryRegister();
            }

            if (line.startsWith("USER ")) {
                const parts = line.split(" ");

                username = parts[1].trim();
                realname = line.split(" :")[1]?.trim() ?? "";

                console.log("username set to:", username);
                console.log("realname set to:", realname);

                (socket as any).username = username;
                (socket as any).realname = realname;

                tryRegister();
            }

            if (line.startsWith("JOIN ")) {
                const channel = line.split(" ")[1].trim();

                if (!nick) {
                    send(":irc-server 451 * :You have not registered");
                    continue;
                }

                if (!channel.startsWith("#")) {
                    send(`:irc-server 403 ${nick} ${channel} :No such channel`);
                    continue;
                }

                if (!channels.has(channel)) {
                    channels.set(channel, new Set());
                }

                channels.get(channel)!.add(socket);
                for (const member of channels.get(channel)!) {
                    member.write(`:${nick}!${username}@localhost JOIN ${channel}\r\n`);
                }
                send(`:irc-server 331 ${nick} ${channel} :No topic is set`);
                const members = [...channels.get(channel)!]
                    .map((s) => (s as any).nick)
                    .filter(Boolean)
                    .join(" ");

                send(`:irc-server 353 ${nick} = ${channel} :${members}`);
                send(`:irc-server 366 ${nick} ${channel} :End of /NAMES list`);
            }

            if (line.startsWith("PART ")) {
                const channel = line.split(" ")[1]?.trim();

                if (!channel) continue;

                const members = channels.get(channel);

                if (!members || !members.has(socket)) {
                    send(`:irc-server 442 ${nick} ${channel} :You're not on that channel`);
                    continue;
                }

                for (const member of members) {
                    member.write(`:${nick}!${username}@localhost PART ${channel}\r\n`);
                }

                members.delete(socket);

                if (members.size === 0) {
                    channels.delete(channel);
                }
            }

            if (line.startsWith("PRIVMSG ")) {
                const target = line.split(" ")[1];
                const message = line.split(" :")[1];

                if (!nick || !username) {
                    send(":irc-server 451 * :You have not registered");
                    continue;
                }

                if (!target || !message) {
                    continue;
                }

                if (target.startsWith("#")) {
                    const members = channels.get(target);

                    if (!members) {
                        send(`:irc-server 403 ${nick} ${target} :No such channel`);
                        continue;
                    }

                    for (const member of members) {
                        member.write(
                            `:${nick}!${username}@localhost PRIVMSG ${target} :${message}\r\n`
                        );
                    }
                } else {
                    const recipient = clientsByNick.get(target);

                    if (!recipient) {
                        send(`:irc-server 401 ${nick} ${target} :No such nick`);
                        continue;
                    }

                    recipient.write(`:${nick}!${username}@localhost PRIVMSG ${target} :${message}\r\n`);
                    send(`:${nick}!${username}@localhost PRIVMSG ${target} :${message}`);
                }
            }

            if (line.startsWith("WHOIS ")) {
                const target = line.split(" ")[1]?.trim();

                if (!target) continue;

                const client = clientsByNick.get(target);

                if (!client) {
                    send(`:irc-server 401 ${nick} ${target} :No such nick`);
                    continue;
                }

                const username = (client as any).username ?? "unknown";
                const realname = (client as any).realname ?? "unknown";

                send(`:irc-server 311 ${nick} ${target} ${username} localhost * :${realname}`);
                send(`:irc-server 318 ${nick} ${target} :End of WHOIS list`);
            }
        }
    });

    socket.on("close", () => {
        if (nick) {
            usedNicks.delete(nick);
            clientsByNick.delete(nick);
        }

        for (const [channel, members] of channels) {
            if (members.has(socket)) {
                members.delete(socket);

                for (const member of members) {
                    member.write(`:${nick}!${username}@localhost QUIT :Client disconnected\r\n`);
                }

                if (members.size === 0) {
                    channels.delete(channel);
                }
            }
        }

        console.log(`${nick || "client"} disconnected`);
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});