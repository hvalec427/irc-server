import net from "net";

const usedNicks = new Set<string>();
const channels = new Map<string, Set<net.Socket>>();

const server = net.createServer((socket) => {
    let nick = "";
    let username = "";
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
                }

                nick = requestedNick;
                usedNicks.add(nick);
                (socket as any).nick = nick;

                console.log("nickname set to:", nick);

                tryRegister();
            }

            if (line.startsWith("USER ")) {
                username = line.split(" ")[1].trim();
                console.log("username set to:", username);
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
        }
    });

    socket.on("close", () => {
        if (nick) {
            usedNicks.delete(nick);
        }

        console.log(`${nick || "client"} disconnected`);
    });
});

server.listen(6667, () => {
    console.log("irc-server running on port 6667");
});